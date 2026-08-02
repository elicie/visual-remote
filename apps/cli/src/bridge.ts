import type { Writable } from "node:stream";
import {
  createGatewayServer,
  type GatewayServer,
} from "@visual-remote/gateway";
import {
  acquireWorktreeLock,
  createDefaultControlService,
  createPairingUrl,
  discoverGitWorktreeRoot,
  findAvailablePort,
  generatePairingToken,
  loadVisualDevConfig,
  MIN_SERVICE_PORT,
  removeInstance,
  startManagedProcess,
  type BridgeControlContext,
  type BridgeInstanceRecord,
  type BridgeMode,
  type ControlService,
  type LoadedVisualDevConfig,
  type ManagedProcess,
  type WorktreeLock,
  writeInstance,
} from "@visual-remote/bridge-core";

export type { BridgeControlContext, BridgeMode } from "@visual-remote/bridge-core";

export interface BridgeDependencies {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  stdout?: Writable;
  stderr?: Writable;
  controlServiceFactory?: (
    context: BridgeControlContext,
  ) => ControlService | Promise<ControlService>;
}

export interface StartAttachBridgeOptions {
  upstream: string;
  listen?: number;
  host?: string;
  publicUrl?: string;
}

export interface StartManagedBridgeOptions {
  listen?: number;
  host?: string;
  publicUrl?: string;
}

export interface RunningBridge {
  mode: BridgeMode;
  projectId: string;
  repoRoot: string;
  workspaceRoot: string;
  upstreamUrl: string;
  gatewayUrl: string;
  publicUrl?: string;
  pairingUrl: string;
  gateway: GatewayServer;
  managedProcess?: ManagedProcess;
  close(): Promise<void>;
}

function normalizeUpstream(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Upstream must use http: or https:");
  }
  return url.toString();
}

function normalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Public URL must use http: or https:");
  }
  return url.toString();
}

function startPort(config: LoadedVisualDevConfig, requested?: number): number {
  if (requested !== undefined) {
    return requested;
  }
  return config.config.gateway.port === "auto"
    ? MIN_SERVICE_PORT
    : config.config.gateway.port;
}

async function resolveControlService(
  dependencies: BridgeDependencies,
  context: BridgeControlContext,
): Promise<ControlService> {
  if (dependencies.controlServiceFactory !== undefined) {
    return await dependencies.controlServiceFactory(context);
  }
  return await createDefaultControlService(
    context,
    dependencies.environment ?? process.env,
  );
}

interface StartBridgeCoreOptions {
  mode: BridgeMode;
  loadedConfig: LoadedVisualDevConfig;
  upstreamUrl: string;
  listen?: number;
  host?: string;
  publicUrl?: string;
  managedProcess?: ManagedProcess;
  lock?: WorktreeLock;
}

async function startBridgeCore(
  options: StartBridgeCoreOptions,
  dependencies: BridgeDependencies,
): Promise<RunningBridge> {
  const { loadedConfig } = options;
  const environment = dependencies.environment ?? process.env;
  let lock: WorktreeLock | undefined;
  let gateway: GatewayServer | undefined;
  let controlService: ControlService | undefined;
  let registryWritten = false;

  try {
    lock =
      options.lock ??
      (await acquireWorktreeLock(loadedConfig.repoRoot, { environment }));
    const host = options.host ?? loadedConfig.config.gateway.host;
    const configuredPublicUrl =
      options.publicUrl ?? loadedConfig.config.gateway.publicUrl;
    const publicUrl =
      configuredPublicUrl === undefined
        ? undefined
        : normalizePublicUrl(configuredPublicUrl);
    const gatewayPort = await findAvailablePort(startPort(loadedConfig, options.listen), host);
    const token = generatePairingToken();
    const controlContext: BridgeControlContext = {
      mode: options.mode,
      projectId: loadedConfig.config.project.id,
      repoRoot: loadedConfig.repoRoot,
      workspaceRoot: loadedConfig.workspaceRoot,
      upstreamUrl: options.upstreamUrl,
    };
    controlService = await resolveControlService(dependencies, controlContext);
    const allowedOrigins = new Set(loadedConfig.config.security.allowedOrigins);
    if (publicUrl !== undefined) allowedOrigins.add(new URL(publicUrl).origin);
    gateway = createGatewayServer({
      upstream: options.upstreamUrl,
      pairingToken: token,
      projectId: loadedConfig.config.project.id,
      controlService,
      host,
      port: gatewayPort,
      allowedOrigins: [...allowedOrigins],
    });
    const address = await gateway.start();
    const pairingUrl = createPairingUrl(publicUrl ?? address.url, token);
    const instance: BridgeInstanceRecord = {
      projectId: loadedConfig.config.project.id,
      repoRoot: loadedConfig.repoRoot,
      pid: process.pid,
      gatewayUrl: address.url,
      upstreamUrl: options.upstreamUrl,
      status: "idle",
      startedAt: new Date().toISOString(),
      ...(publicUrl === undefined ? {} : { publicUrl }),
    };
    await writeInstance(loadedConfig.repoRoot, instance, { environment });
    registryWritten = true;

    let closed = false;
    return {
      mode: options.mode,
      projectId: loadedConfig.config.project.id,
      repoRoot: loadedConfig.repoRoot,
      workspaceRoot: loadedConfig.workspaceRoot,
      upstreamUrl: options.upstreamUrl,
      gatewayUrl: address.url,
      ...(publicUrl === undefined ? {} : { publicUrl }),
      pairingUrl,
      gateway,
      ...(options.managedProcess === undefined
        ? {}
        : { managedProcess: options.managedProcess }),
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        await Promise.allSettled([
          gateway?.close(),
          options.managedProcess?.stop(),
          controlService?.close?.(),
        ]);
        await removeInstance(loadedConfig.repoRoot, process.pid, { environment });
        await lock?.release();
      },
    };
  } catch (error) {
    if (registryWritten) {
      await removeInstance(loadedConfig.repoRoot, process.pid, { environment });
    }
    await Promise.allSettled([
      gateway?.close(),
      options.managedProcess?.stop(),
      controlService?.close?.(),
      lock?.release(),
    ]);
    throw error;
  }
}

export async function startAttachBridge(
  options: StartAttachBridgeOptions,
  dependencies: BridgeDependencies = {},
): Promise<RunningBridge> {
  const repoRoot = await discoverGitWorktreeRoot(dependencies.cwd ?? process.cwd());
  const loadedConfig = await loadVisualDevConfig(repoRoot);
  return await startBridgeCore(
    {
      mode: "attach",
      loadedConfig,
      upstreamUrl: normalizeUpstream(options.upstream),
      ...(options.listen === undefined ? {} : { listen: options.listen }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    },
    dependencies,
  );
}

export async function startManagedBridge(
  options: StartManagedBridgeOptions = {},
  dependencies: BridgeDependencies = {},
): Promise<RunningBridge> {
  const repoRoot = await discoverGitWorktreeRoot(dependencies.cwd ?? process.cwd());
  const loadedConfig = await loadVisualDevConfig(repoRoot, { requireConfig: true });
  const command = loadedConfig.config.upstream.command;
  if (command === undefined) {
    throw new Error("visual dev requires upstream.command in .visualdev/config.yaml");
  }

  const environment = dependencies.environment ?? process.env;
  const lock = await acquireWorktreeLock(loadedConfig.repoRoot, { environment });
  let managedProcess: ManagedProcess | undefined;
  try {
    const host = options.host ?? loadedConfig.config.gateway.host;
    const requestedGatewayPort = startPort(loadedConfig, options.listen);
    const provisionalGatewayPort = await findAvailablePort(requestedGatewayPort, host);
    const configuredUpstreamPort = loadedConfig.config.upstream.port;
    const upstreamStart =
      configuredUpstreamPort === "auto"
        ? Math.max(MIN_SERVICE_PORT, provisionalGatewayPort + 1)
        : configuredUpstreamPort;
    const upstreamPort = await findAvailablePort(
      upstreamStart,
      "0.0.0.0",
      new Set([provisionalGatewayPort]),
    );
    managedProcess = await startManagedProcess({
      command,
      cwd: loadedConfig.workspaceRoot,
      upstreamPort,
      environment,
      ...(dependencies.stdout === undefined ? {} : { stdout: dependencies.stdout }),
      ...(dependencies.stderr === undefined ? {} : { stderr: dependencies.stderr }),
    });
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

    return await startBridgeCore(
      {
        mode: "managed",
        loadedConfig,
        upstreamUrl,
        listen: provisionalGatewayPort,
        host,
        ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
        managedProcess,
        lock,
      },
      dependencies,
    );
  } catch (error) {
    await Promise.allSettled([managedProcess?.stop(), lock.release()]);
    throw error;
  }
}

export async function runBridgeUntilSignal(
  bridge: RunningBridge,
  processLike: Pick<NodeJS.Process, "once" | "off">
    & Partial<Pick<NodeJS.Process, "exit">> = process,
  gracefulTimeoutMs = 5_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    let shutdownTimeout: NodeJS.Timeout | undefined;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const removeSignalListeners = (): void => {
      for (const signal of signals) processLike.off(signal, shutdown);
    };
    const shutdown = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      removeSignalListeners();
      const timeoutMs = Math.max(1, gracefulTimeoutMs);
      shutdownTimeout = setTimeout(() => {
        const error = new Error(
          `Bridge shutdown exceeded ${timeoutMs}ms; forcing this Bridge process to exit`,
        );
        try {
          processLike.exit?.(1);
        } finally {
          reject(error);
        }
      }, timeoutMs);
      shutdownTimeout.unref();
      void Promise.resolve()
        .then(async () => await bridge.close())
        .then(
          () => {
            if (shutdownTimeout !== undefined) clearTimeout(shutdownTimeout);
            try {
              processLike.exit?.(0);
            } finally {
              resolve();
            }
          },
          (error: unknown) => {
            if (shutdownTimeout !== undefined) clearTimeout(shutdownTimeout);
            try {
              processLike.exit?.(1);
            } finally {
              reject(error);
            }
          },
        );
    };
    for (const signal of signals) processLike.once(signal, shutdown);
    void bridge.managedProcess?.exit.then(shutdown);
  });
}

export function formatBridgeSummary(bridge: RunningBridge): string {
  const rows = [
    `Gateway:  ${bridge.gatewayUrl}`,
    `Upstream: ${bridge.upstreamUrl}`,
  ];
  if (bridge.publicUrl !== undefined) {
    rows.push(`Public:   ${bridge.publicUrl}`);
  }
  rows.push(`Pair URL: ${bridge.pairingUrl}`);
  return rows.join("\n");
}
