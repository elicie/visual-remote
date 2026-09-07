import { resolve } from "node:path";
import {
  BridgeAlreadyRunningError,
  isProcessAlive,
  type BridgeInstanceRecord,
} from "@visual-remote/bridge-core";
import { startAttachBridge, type RunningBridge } from "./bridge.js";

const DEVELOPMENT_SERVER_PHASE = "phase-development-server";
const VISUAL_REWRITE_SOURCE = "/_visual/:path*";

interface NextRewrite {
  source: string;
  destination: string;
  basePath?: boolean;
  locale?: boolean;
  [key: string]: unknown;
}

interface NextRewriteGroups {
  beforeFiles?: NextRewrite[];
  afterFiles?: NextRewrite[];
  fallback?: NextRewrite[];
}

type NextRewrites = NextRewrite[] | NextRewriteGroups;

interface NextConfigLike extends Record<string, unknown> {
  allowedDevOrigins?: string[];
  rewrites?: () => NextRewrites | Promise<NextRewrites>;
}

type NextConfigFactory = (
  phase: string,
  context: Record<string, unknown>,
) => NextConfigLike | Promise<NextConfigLike>;

type NextConfigExport = NextConfigLike | NextConfigFactory;

export interface VisualRemoteNextOptions {
  cwd?: string;
  bridgeHost?: string;
  bridgePort?: number;
  appPort?: number;
}

interface NextBridgeReference {
  gatewayUrl: string;
  ownedBridge?: RunningBridge;
}

const runningBridges = new Map<string, Promise<NextBridgeReference>>();

function validPort(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : undefined;
}

function commandLinePort(argv: readonly string[]): number | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port" || argument === "-p") {
      return validPort(argv[index + 1]);
    }
    if (argument?.startsWith("--port=")) {
      return validPort(argument.slice("--port=".length));
    }
    if (argument?.startsWith("-p") && argument.length > 2) {
      return validPort(argument.slice(2));
    }
  }
  return undefined;
}

function resolveNextPort(
  options: Pick<VisualRemoteNextOptions, "appPort">,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): number {
  return (
    validPort(options.appPort) ??
    commandLinePort(argv) ??
    validPort(environment.PORT) ??
    3_000
  );
}

export function resolveNextUpstream(
  options: Pick<VisualRemoteNextOptions, "appPort"> = {},
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const port = resolveNextPort(options, argv, environment);
  return `http://127.0.0.1:${port}`;
}

export function resolveNextPublicUrl(
  options: Pick<VisualRemoteNextOptions, "appPort"> = {},
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const port = resolveNextPort(options, argv, environment);
  return `http://localhost:${port}`;
}

export function isNextDetachedTelemetryProcess(
  argv: readonly string[] = process.argv,
): boolean {
  return argv.some((argument) =>
    /[\\/]next[\\/]dist[\\/]telemetry[\\/]detached-flush\.js$/.test(argument),
  );
}

function withoutVisualRewrite(rewrites: NextRewrite[] | undefined): NextRewrite[] {
  return (rewrites ?? []).filter((rewrite) => rewrite.source !== VISUAL_REWRITE_SOURCE);
}

export function mergeNextRewrites(
  existing: NextRewrites | undefined,
  gatewayUrl: string,
): NextRewriteGroups {
  const visualRewrite: NextRewrite = {
    source: VISUAL_REWRITE_SOURCE,
    destination: `${gatewayUrl}/_visual/:path*`,
    basePath: false,
    locale: false,
  };

  if (Array.isArray(existing)) {
    return {
      beforeFiles: [visualRewrite],
      afterFiles: withoutVisualRewrite(existing),
      fallback: [],
    };
  }

  return {
    beforeFiles: [visualRewrite, ...withoutVisualRewrite(existing?.beforeFiles)],
    afterFiles: withoutVisualRewrite(existing?.afterFiles),
    fallback: withoutVisualRewrite(existing?.fallback),
  };
}

function addRequiredDevOrigin(config: NextConfigLike): NextConfigLike {
  const existing = Array.isArray(config.allowedDevOrigins)
    ? config.allowedDevOrigins
    : [];
  const required = ["dev", "localhost", "127.0.0.1"];
  return {
    ...config,
    allowedDevOrigins: [
      ...existing,
      ...required.filter((origin) => !existing.includes(origin)),
    ],
  };
}

function isLiveBridgeInstance(
  instance: BridgeInstanceRecord | undefined,
  repoRoot: string,
): instance is BridgeInstanceRecord {
  return (
    instance !== undefined &&
    instance.repoRoot === repoRoot &&
    isProcessAlive(instance.pid)
  );
}

async function startOrReuseBridge(
  options: VisualRemoteNextOptions,
  cwd: string,
): Promise<NextBridgeReference> {
  try {
    const ownedBridge = await startAttachBridge(
      {
        upstream: resolveNextUpstream(options),
        fallbackPublicUrl: resolveNextPublicUrl(options),
        fallbackLoopbackOrigins: true,
        ...(options.bridgeHost === undefined ? {} : { host: options.bridgeHost }),
        ...(options.bridgePort === undefined ? {} : { listen: options.bridgePort }),
      },
      { cwd },
    );
    process.stderr.write(`[visual-remote] Pair: ${ownedBridge.openUrl}\n`);
    return { gatewayUrl: ownedBridge.gatewayUrl, ownedBridge };
  } catch (error) {
    if (!(error instanceof BridgeAlreadyRunningError)) throw error;
    if (isLiveBridgeInstance(error.instance, error.repoRoot)) {
      return { gatewayUrl: error.instance.gatewayUrl };
    }
    throw error;
  }
}

function ensureBridge(options: VisualRemoteNextOptions): Promise<NextBridgeReference> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const existing = runningBridges.get(cwd);
  if (existing !== undefined) return existing;

  const bridge = startOrReuseBridge(options, cwd);
  runningBridges.set(cwd, bridge);
  void bridge.then(
    (running) => {
      if (running.ownedBridge === undefined) return;
      running.ownedBridge.gateway.server.unref();
      void running.ownedBridge.closed.then(() => {
        if (runningBridges.get(cwd) === bridge) runningBridges.delete(cwd);
      });
    },
    () => {
      if (runningBridges.get(cwd) === bridge) runningBridges.delete(cwd);
    },
  );
  process.once("beforeExit", () => {
    void closeVisualRemoteNext(cwd);
  });
  return bridge;
}

export async function closeVisualRemoteNext(cwd = process.cwd()): Promise<void> {
  const key = resolve(cwd);
  const bridge = runningBridges.get(key);
  runningBridges.delete(key);
  if (bridge === undefined) return;
  const running = await bridge.catch(() => undefined);
  await running?.ownedBridge?.close();
}

/**
 * Adds development-only Visual Remote routes to a Next.js config while keeping
 * the application's original origin, API routes, and HMR endpoints unchanged.
 */
export function withVisualRemote(
  nextConfig: NextConfigExport = {},
  options: VisualRemoteNextOptions = {},
): NextConfigFactory {
  return async (phase, context) => {
    const configured =
      typeof nextConfig === "function"
        ? await nextConfig(phase, context)
        : nextConfig;
    const config = addRequiredDevOrigin(configured ?? {});
    if (phase !== DEVELOPMENT_SERVER_PHASE || isNextDetachedTelemetryProcess()) {
      return config;
    }

    const bridge = await ensureBridge(options);
    const existingRewrites = config.rewrites;
    return {
      ...config,
      async rewrites() {
        const existing =
          existingRewrites === undefined
            ? undefined
            : await existingRewrites.call(config);
        return mergeNextRewrites(existing, bridge.gatewayUrl);
      },
    };
  };
}

export default withVisualRemote;
