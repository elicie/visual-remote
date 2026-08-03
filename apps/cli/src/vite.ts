import { resolve } from "node:path";
import type { Plugin, UserConfig } from "vite";
import {
  BridgeAlreadyRunningError,
  isProcessAlive,
  type BridgeInstanceRecord,
} from "@visual-remote/bridge-core";
import {
  startAttachBridge,
  type RunningBridge,
} from "./bridge.js";

export interface VisualRemoteViteOptions {
  cwd?: string;
  bridgeHost?: string;
  bridgePort?: number;
}

interface ViteBridgeReference {
  gatewayUrl: string;
  openUrl?: string;
  ownedBridge?: RunningBridge;
}

function projectRoot(config: UserConfig, configuredRoot?: string): string {
  if (configuredRoot !== undefined) return resolve(configuredRoot);
  return resolve(process.cwd(), typeof config.root === "string" ? config.root : ".");
}

function upstreamUrl(config: UserConfig): string {
  const protocol = config.server?.https ? "https" : "http";
  const port = config.server?.port ?? 5173;
  return `${protocol}://127.0.0.1:${port}`;
}

function isLiveBridgeInstance(
  instance: BridgeInstanceRecord | undefined,
  repoRoot: string,
): instance is BridgeInstanceRecord {
  return (
    instance !== undefined
    && instance.repoRoot === repoRoot
    && isProcessAlive(instance.pid)
  );
}

async function startOrReuseBridge(
  options: VisualRemoteViteOptions,
  config: UserConfig,
): Promise<ViteBridgeReference> {
  const cwd = projectRoot(config, options.cwd);
  try {
    const ownedBridge = await startAttachBridge(
      {
        upstream: upstreamUrl(config),
        ...(options.bridgeHost === undefined
          ? {}
          : { host: options.bridgeHost }),
        ...(options.bridgePort === undefined
          ? {}
          : { listen: options.bridgePort }),
      },
      { cwd },
    );
    return {
      gatewayUrl: ownedBridge.gatewayUrl,
      openUrl: ownedBridge.openUrl,
      ownedBridge,
    };
  } catch (error) {
    if (!(error instanceof BridgeAlreadyRunningError)) throw error;
    if (isLiveBridgeInstance(error.instance, error.repoRoot)) {
      return { gatewayUrl: error.instance.gatewayUrl };
    }
    throw error;
  }
}

export function visualRemote(options: VisualRemoteViteOptions = {}): Plugin {
  let bridgePromise: Promise<ViteBridgeReference> | undefined;
  let pairingUrlAnnounced = false;

  const closeBridge = async (): Promise<void> => {
    if (bridgePromise === undefined) return;
    const bridge = await bridgePromise.catch(() => undefined);
    await bridge?.ownedBridge?.close();
  };

  return {
    name: "visual-remote",
    apply: "serve",
    enforce: "pre",
    async config(config) {
      bridgePromise ??= startOrReuseBridge(options, config);
      const bridge = await bridgePromise;
      bridge.ownedBridge?.gateway.server.unref();
      return {
        server: {
          proxy: {
            "/_visual": {
              target: bridge.gatewayUrl,
              ws: true,
            },
          },
        },
      };
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (html.includes("/_visual/client.js")) return html;
        return [
          {
            tag: "script",
            attrs: {
              src: "/_visual/client.js",
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },
    configureServer(server) {
      if (!pairingUrlAnnounced && bridgePromise !== undefined) {
        pairingUrlAnnounced = true;
        void bridgePromise.then((bridge) => {
          server.config.logger.info(
            bridge.openUrl === undefined
              ? `[visual-remote] Reusing Bridge: ${bridge.gatewayUrl}`
              : `[visual-remote] Pair: ${bridge.openUrl}`,
          );
        });
      }
      server.httpServer?.once("close", () => {
        void closeBridge();
      });
    },
    async closeBundle() {
      await closeBridge();
    },
  };
}

export default visualRemote;
