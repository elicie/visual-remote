import { resolve } from "node:path";
import type { Plugin, UserConfig } from "vite";
import {
  startAttachBridge,
  type RunningBridge,
} from "./bridge.js";

export interface VisualRemoteViteOptions {
  cwd?: string;
  bridgeHost?: string;
  bridgePort?: number;
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

export function visualRemote(options: VisualRemoteViteOptions = {}): Plugin {
  let bridgePromise: Promise<RunningBridge> | undefined;

  const closeBridge = async (): Promise<void> => {
    if (bridgePromise === undefined) return;
    const bridge = await bridgePromise.catch(() => undefined);
    await bridge?.close();
  };

  return {
    name: "visual-remote",
    apply: "serve",
    enforce: "pre",
    async config(config) {
      bridgePromise ??= startAttachBridge(
        {
          upstream: upstreamUrl(config),
          ...(options.bridgeHost === undefined
            ? {}
            : { host: options.bridgeHost }),
          ...(options.bridgePort === undefined
            ? {}
            : { listen: options.bridgePort }),
        },
        { cwd: projectRoot(config, options.cwd) },
      );
      const bridge = await bridgePromise;
      bridge.gateway.server.unref();
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
