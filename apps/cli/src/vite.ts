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

interface SharedViteBridge {
  bridge: Promise<ViteBridgeReference>;
  users: number;
  closing?: Promise<void>;
}

interface ViteBridgeLease {
  bridge: ViteBridgeReference;
  release(): Promise<void>;
}

// Config reloads can evaluate another copy of this module before the old server closes.
const bridgesKey = Symbol.for("visual-remote.vite.bridges");
const bridgeState = globalThis as typeof globalThis & {
  [bridgesKey]?: Map<string, SharedViteBridge>;
};
const bridges = bridgeState[bridgesKey] ??= new Map<string, SharedViteBridge>();

async function acquireBridge(
  options: VisualRemoteViteOptions,
  config: Pick<UserConfig, "root" | "server">,
): Promise<ViteBridgeLease> {
  const root = projectRoot(config, options.cwd);
  let shared = bridges.get(root);
  if (shared?.closing !== undefined) {
    await shared.closing;
    return acquireBridge(options, config);
  }
  if (shared === undefined) {
    shared = { bridge: startOrReuseBridge(options, config), users: 0 };
    bridges.set(root, shared);
  }
  const entry = shared;
  entry.users += 1;
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    releasePromise ??= (async () => {
      entry.users -= 1;
      if (entry.users !== 0) return;
      entry.closing = (async () => {
        try {
          const bridge = await entry.bridge.catch(() => undefined);
          await bridge?.ownedBridge?.close();
        } finally {
          bridges.delete(root);
        }
      })();
      await entry.closing;
    })();
    return releasePromise;
  };
  try {
    return { bridge: await entry.bridge, release };
  } catch (error) {
    await release();
    throw error;
  }
}

function projectRoot(config: Pick<UserConfig, "root">, configuredRoot?: string): string {
  if (configuredRoot !== undefined) return resolve(configuredRoot);
  return resolve(process.cwd(), typeof config.root === "string" ? config.root : ".");
}

function upstreamUrl(config: Pick<UserConfig, "server">): string {
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
  config: Pick<UserConfig, "root" | "server">,
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
  let pairingUrlAnnounced = false;

  return {
    name: "visual-remote",
    apply: "serve",
    enforce: "pre",
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
    async configureServer(server) {
      // Each server owns a lease, even when restart reuses this plugin object.
      const serverLease = await acquireBridge(options, server.config);
      const { bridge } = serverLease;
      bridge.ownedBridge?.gateway.server.unref();
      server.config.server.proxy ??= {};
      server.config.server.proxy["/_visual"] = {
        target: bridge.gatewayUrl,
        ws: true,
      };
      if (!pairingUrlAnnounced) {
        pairingUrlAnnounced = true;
        server.config.logger.info(
          bridge.openUrl === undefined
            ? `[visual-remote] Reusing Bridge: ${bridge.gatewayUrl}`
            : `[visual-remote] Pair: ${bridge.openUrl}`,
        );
      }
      const close = server.close;
      server.close = async () => {
        try {
          await close();
        } finally {
          await serverLease?.release();
        }
      };
      server.httpServer?.once("close", () => {
        void serverLease?.release();
      });
    },
  };
}

export default visualRemote;
