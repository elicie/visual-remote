import { createConnection } from "node:net";
import type { Writable } from "node:stream";
import {
  createGatewayServer,
  type GatewayServer,
} from "@visual-remote/gateway";
import {
  acquireWorktreeLock,
  createDefaultControlService,
  createPairingUrl,
  discoverVisualDevConfigRoot,
  discoverGitWorktreeRoot,
  findAvailablePort,
  generatePairingToken,
  loadVisualDevConfig,
  MIN_SERVICE_PORT,
  removeInstance,
  removeInstanceSync,
  startManagedProcess,
  type BridgeControlContext,
  type BridgeInstanceRecord,
  type BridgeMode,
  type ControlService,
  type LoadedVisualDevConfig,
  type ManagedProcess,
  type WorktreeLock,
  updateInstance,
  writeInstance,
} from "@visual-remote/bridge-core";

export type { BridgeControlContext, BridgeMode } from "@visual-remote/bridge-core";

export interface UpstreamMonitorOptions {
  intervalMs?: number;
  connectTimeoutMs?: number;
  initialTimeoutMs?: number;
  failureGraceMs?: number;
}

export interface BridgeDependencies {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  stdout?: Writable;
  stderr?: Writable;
  controlServiceFactory?: (
    context: BridgeControlContext,
  ) => ControlService | Promise<ControlService>;
  upstreamMonitor?: false | UpstreamMonitorOptions;
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
  openUrl: string;
  gateway: GatewayServer;
  managedProcess?: ManagedProcess;
  closed: Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_UPSTREAM_MONITOR_INTERVAL_MS = 1_000;
const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_UPSTREAM_FAILURE_GRACE_MS = 5_000;

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0
    ? fallback
    : Math.max(1, Math.floor(value));
}

async function probeUpstream(upstreamUrl: string, timeoutMs: number): Promise<boolean> {
  const upstream = new URL(upstreamUrl);
  const hostname = upstream.hostname.startsWith("[")
    ? upstream.hostname.slice(1, -1)
    : upstream.hostname;
  const port = Number(
    upstream.port || (upstream.protocol === "https:" ? 443 : 80),
  );

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const socket = createConnection({ host: hostname, port });
    socket.unref();

    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      socket.destroy();
      resolve(reachable);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
  });
}

function monitorUpstream(
  bridge: RunningBridge,
  options: UpstreamMonitorOptions,
): void {
  const intervalMs = positiveMilliseconds(
    options.intervalMs,
    DEFAULT_UPSTREAM_MONITOR_INTERVAL_MS,
  );
  const connectTimeoutMs = positiveMilliseconds(
    options.connectTimeoutMs,
    DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS,
  );
  const initialTimeoutMs = positiveMilliseconds(
    options.initialTimeoutMs,
    60_000,
  );
  const failureGraceMs = positiveMilliseconds(
    options.failureGraceMs,
    DEFAULT_UPSTREAM_FAILURE_GRACE_MS,
  );
  let connected = false;
  let unavailableSince: number | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void check().catch(() => undefined);
    }, intervalMs);
    timer.unref();
  };
  const check = async (): Promise<void> => {
    if (stopped) return;
    const reachable = await probeUpstream(bridge.upstreamUrl, connectTimeoutMs);
    if (stopped) return;

    const now = Date.now();
    if (reachable) {
      connected = true;
      unavailableSince = undefined;
      schedule();
      return;
    }

    unavailableSince ??= now;
    const timeoutMs = connected ? failureGraceMs : initialTimeoutMs;
    if (now - unavailableSince >= timeoutMs) {
      stop();
      await bridge.close();
      return;
    }
    schedule();
  };

  void bridge.closed.then(stop);
  void check().catch(() => undefined);
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
  let registryUpdate = Promise.resolve();
  let latestRuntimeState: {
    status: "idle" | "working";
    activeTaskId?: string;
  } = { status: "idle" };

  const updateRuntimeState = (
    status: "idle" | "working",
    activeTaskId?: string,
  ): void => {
    latestRuntimeState = {
      status,
      ...(activeTaskId === undefined ? {} : { activeTaskId }),
    };
    if (!registryWritten) return;
    registryUpdate = registryUpdate
      .then(async () => {
        await updateInstance(
          loadedConfig.repoRoot,
          process.pid,
          {
            status,
            activeTaskId: activeTaskId ?? null,
          },
          { environment },
        );
      })
      .catch(() => undefined);
  };

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
      configRoot: loadedConfig.configRoot,
      workspaceRoot: loadedConfig.workspaceRoot,
      upstreamUrl: options.upstreamUrl,
      onRuntimeState: (state) => {
        updateRuntimeState(state.status, state.activeTaskId);
      },
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
    const openUrl = createPairingUrl(publicUrl ?? address.url, token);
    const instance: BridgeInstanceRecord = {
      projectId: loadedConfig.config.project.id,
      repoRoot: loadedConfig.repoRoot,
      pid: process.pid,
      gatewayUrl: address.url,
      upstreamUrl: options.upstreamUrl,
      status: latestRuntimeState.status,
      startedAt: new Date().toISOString(),
      ...(latestRuntimeState.activeTaskId === undefined
        ? {}
        : { activeTaskId: latestRuntimeState.activeTaskId }),
      ...(publicUrl === undefined ? {} : { publicUrl }),
    };
    await writeInstance(loadedConfig.repoRoot, instance, { environment });
    registryWritten = true;

    const emergencyExitCleanup = (): void => {
      try {
        removeInstanceSync(loadedConfig.repoRoot, process.pid, { environment });
        lock?.releaseSync();
      } catch {
        // Exit hooks cannot recover; stale owner state is reclaimed next start.
      }
    };
    process.once("exit", emergencyExitCleanup);

    let resolveClosed = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let closePromise: Promise<void> | undefined;
    return {
      mode: options.mode,
      projectId: loadedConfig.config.project.id,
      repoRoot: loadedConfig.repoRoot,
      workspaceRoot: loadedConfig.workspaceRoot,
      upstreamUrl: options.upstreamUrl,
      gatewayUrl: address.url,
      ...(publicUrl === undefined ? {} : { publicUrl }),
      openUrl,
      gateway,
      ...(options.managedProcess === undefined
        ? {}
        : { managedProcess: options.managedProcess }),
      closed,
      close() {
        closePromise ??= (async () => {
          process.off("exit", emergencyExitCleanup);
          try {
            await registryUpdate;
            await updateInstance(
              loadedConfig.repoRoot,
              process.pid,
              { status: "stopping", activeTaskId: null },
              { environment },
            );
            await Promise.allSettled([
              gateway?.close(),
              options.managedProcess?.stop(),
              controlService?.close?.(),
            ]);
            await removeInstance(loadedConfig.repoRoot, process.pid, { environment });
          } finally {
            try {
              await lock?.release();
            } finally {
              resolveClosed();
            }
          }
        })();
        return closePromise;
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
  const cwd = dependencies.cwd ?? process.cwd();
  const repoRoot = await discoverGitWorktreeRoot(cwd);
  const configRoot = await discoverVisualDevConfigRoot(cwd, repoRoot);
  const loadedConfig = await loadVisualDevConfig(repoRoot, { configRoot });
  const bridge = await startBridgeCore(
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
  if (dependencies.upstreamMonitor !== false) {
    monitorUpstream(bridge, {
      initialTimeoutMs: loadedConfig.config.upstream.ready.timeoutMs,
      ...dependencies.upstreamMonitor,
    });
  }
  return bridge;
}

export async function startManagedBridge(
  options: StartManagedBridgeOptions = {},
  dependencies: BridgeDependencies = {},
): Promise<RunningBridge> {
  const cwd = dependencies.cwd ?? process.cwd();
  const repoRoot = await discoverGitWorktreeRoot(cwd);
  const configRoot = await discoverVisualDevConfigRoot(cwd, repoRoot);
  const loadedConfig = await loadVisualDevConfig(repoRoot, {
    requireConfig: true,
    configRoot,
  });
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
    void bridge.closed?.then(shutdown);
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
  rows.push(`Open:     ${bridge.openUrl}`);
  return rows.join("\n");
}
