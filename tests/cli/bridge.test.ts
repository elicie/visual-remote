import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  formatBridgeSummary,
  runBridgeUntilSignal,
  startAttachBridge,
  type BridgeControlContext,
  type RunningBridge,
} from "@visual-remote/cli/bridge";
import { formatDoctorChecks } from "@visual-remote/cli/doctor";
import { formatBridgeStatus, getBridgeStatus } from "@visual-remote/cli/status";
import {
  acquireWorktreeLock,
  BridgeAlreadyRunningError,
  findAvailablePort,
  readInstance,
  removeInstanceSync,
  writeInstance,
} from "@visual-remote/bridge-core";
import { createBasicControlService } from "@visual-remote/gateway";

const execFileAsync = promisify(execFile);

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Operation did not finish within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("attach CLI lifecycle", () => {
  it("starts with service-safe defaults, registers status, and cleans up", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "visual-cli-repo-"));
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "visual-cli-runtime-"));
    await execFileAsync("git", ["init", "--quiet", repoRoot]);
    const upstreamPort = await findAvailablePort(
      30_000 + (process.pid % 5_000),
      "127.0.0.1",
    );
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head></head><body>fixture</body></html>");
    });
    await listen(upstream, upstreamPort);

    const environment = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDirectory,
    };
    let runtimeContext: BridgeControlContext | undefined;
    const bridge = await startAttachBridge(
      {
        upstream: `http://127.0.0.1:${upstreamPort}`,
        publicUrl: "https://portr.example.test/",
      },
      {
        cwd: repoRoot,
        environment,
        controlServiceFactory: (context) => {
          runtimeContext = context;
          context.onRuntimeState?.({
            status: "working",
            activeTaskId: "task-startup-fixture",
          });
          return createBasicControlService({ project: { id: context.projectId } });
        },
      },
    );

    try {
      expect(Number(new URL(bridge.gatewayUrl).port)).toBeGreaterThanOrEqual(10_001);
      expect(new URL(bridge.gatewayUrl).hostname).toBe("localhost");
      expect(bridge.gateway.address()?.host).toBe("0.0.0.0");
      const openUrl = new URL(bridge.openUrl);
      expect(openUrl.origin).toBe("https://portr.example.test");
      expect(openUrl.hash).toMatch(/^#visual-pair=[A-Za-z0-9_-]+$/);
      expect(formatBridgeSummary(bridge)).toContain("Upstream:");
      expect(formatBridgeSummary(bridge)).toContain(
        "Public:   https://portr.example.test/",
      );
      expect(formatBridgeSummary(bridge)).toContain(`Open:     ${bridge.openUrl}`);

      const status = await getBridgeStatus({ cwd: repoRoot, environment });
      expect(status.running).toBe(true);
      expect(status.instance?.pid).toBe(process.pid);
      expect(status.instance).toMatchObject({
        status: "working",
        activeTaskId: "task-startup-fixture",
      });

      runtimeContext?.onRuntimeState?.({
        status: "working",
        activeTaskId: "task-runtime-fixture",
      });
      await vi.waitFor(async () => {
        expect(await readInstance(repoRoot, { environment })).toMatchObject({
          status: "working",
          activeTaskId: "task-runtime-fixture",
        });
      });
      expect(formatBridgeStatus(await getBridgeStatus({ cwd: repoRoot, environment }))).toContain(
        "Active:   task-runtime-fixture",
      );
    } finally {
      await bridge.close();
      await close(upstream);
    }

    expect(await getBridgeStatus({ cwd: repoRoot, environment })).toEqual({
      running: false,
    });
  });

  it("closes and unregisters after the attached upstream disappears", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "visual-cli-orphan-repo-"));
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "visual-cli-orphan-runtime-"));
    await execFileAsync("git", ["init", "--quiet", repoRoot]);
    const upstreamPort = await findAvailablePort(
      35_000 + (process.pid % 5_000),
      "127.0.0.1",
    );
    const upstream = createServer((_request, response) => response.end("ok"));
    await listen(upstream, upstreamPort);
    const environment = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDirectory,
    };
    const bridge = await startAttachBridge(
      { upstream: `http://127.0.0.1:${upstreamPort}` },
      {
        cwd: repoRoot,
        environment,
        upstreamMonitor: {
          intervalMs: 10,
          connectTimeoutMs: 20,
          initialTimeoutMs: 40,
          failureGraceMs: 40,
        },
        controlServiceFactory: (context) =>
          createBasicControlService({ project: { id: context.projectId } }),
      },
    );
    let upstreamClosed = false;

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await close(upstream);
      upstreamClosed = true;
      await within(bridge.closed);

      expect(bridge.gateway.address()).toBeUndefined();
      expect(await getBridgeStatus({ cwd: repoRoot, environment })).toEqual({
        running: false,
      });
    } finally {
      await bridge.close();
      if (!upstreamClosed) await close(upstream);
    }
  });

  it("formats doctor results without hiding warning/failure labels", () => {
    expect(
      formatDoctorChecks([
        { name: "git", status: "pass", message: "ok" },
        { name: "config", status: "warning", message: "missing" },
        { name: "agent", status: "fail", message: "not found" },
      ]),
    ).toBe(
      [
        "[PASS] git: ok",
        "[WARN] config: missing",
        "[FAIL] agent: not found",
      ].join("\n"),
    );
  });

  it("prevents two Bridge locks for the same Git worktree", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "visual-cli-lock-repo-"));
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "visual-cli-lock-runtime-"));
    await execFileAsync("git", ["init", "--quiet", repoRoot]);
    const environment = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDirectory,
    };

    const first = await acquireWorktreeLock(repoRoot, { environment });
    try {
      await expect(
        acquireWorktreeLock(repoRoot, { environment }),
      ).rejects.toBeInstanceOf(BridgeAlreadyRunningError);
      expect(first.lockPath).toMatch(
        /visual-bridge\/[a-f0-9]{64}\/bridge\.lock$/,
      );
    } finally {
      await first.release();
    }

    const afterRelease = await acquireWorktreeLock(repoRoot, { environment });
    await afterRelease.release();
  });

  it("cleans registry ownership synchronously during process exit", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "visual-cli-exit-repo-"));
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "visual-cli-exit-runtime-"));
    await execFileAsync("git", ["init", "--quiet", repoRoot]);
    const environment = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDirectory,
    };
    const lock = await acquireWorktreeLock(repoRoot, { environment });
    await writeInstance(
      repoRoot,
      {
        projectId: "exit-fixture",
        repoRoot,
        pid: process.pid,
        gatewayUrl: "http://127.0.0.1:10001",
        upstreamUrl: "http://127.0.0.1:10002",
        status: "idle",
        startedAt: new Date().toISOString(),
      },
      { environment },
    );

    removeInstanceSync(repoRoot, process.pid, { environment });
    lock.releaseSync();

    expect(await readInstance(repoRoot, { environment })).toBeUndefined();
    const afterCleanup = await acquireWorktreeLock(repoRoot, { environment });
    await afterCleanup.release();
  });
});

describe("Bridge process lifecycle", () => {
  it("exits when an attached Bridge closes itself", async () => {
    const processLike = Object.assign(new EventEmitter(), {
      exit: vi.fn(),
    });
    let resolveClosed = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const closeBridge = vi.fn(async () => undefined);
    const bridge = { close: closeBridge, closed } as unknown as RunningBridge;

    const running = runBridgeUntilSignal(
      bridge,
      processLike as unknown as NonNullable<
        Parameters<typeof runBridgeUntilSignal>[1]
      >,
    );
    resolveClosed();
    await running;

    expect(closeBridge).toHaveBeenCalledOnce();
    expect(processLike.exit).toHaveBeenCalledWith(0);
    for (const registeredSignal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      expect(processLike.listenerCount(registeredSignal)).toBe(0);
    }
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "closes on %s and removes all signal listeners",
    async (signal) => {
      const processLike = new EventEmitter();
      const closeBridge = vi.fn(async () => undefined);
      const bridge = { close: closeBridge } as unknown as RunningBridge;

      const running = runBridgeUntilSignal(
        bridge,
        processLike as unknown as Pick<NodeJS.Process, "once" | "off">,
      );
      processLike.emit(signal);
      await running;

      expect(closeBridge).toHaveBeenCalledOnce();
      for (const registeredSignal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        expect(processLike.listenerCount(registeredSignal)).toBe(0);
      }
    },
  );

  it("forces only the Bridge process to exit when graceful shutdown stalls", async () => {
    vi.useFakeTimers();
    try {
      const forceExit = vi.fn();
      const processLike = Object.assign(new EventEmitter(), {
        exit: forceExit,
      });
      const bridge = {
        close: vi.fn(() => new Promise<void>(() => undefined)),
      } as unknown as RunningBridge;

      const running = runBridgeUntilSignal(
        bridge,
        processLike as unknown as NonNullable<
          Parameters<typeof runBridgeUntilSignal>[1]
        >,
        250,
      );
      const settled = running.catch((error: unknown) => error);
      processLike.emit("SIGINT");
      await vi.advanceTimersByTimeAsync(250);

      await expect(settled).resolves.toMatchObject({
        message: expect.stringContaining("forcing this Bridge process"),
      });
      expect(forceExit).toHaveBeenCalledOnce();
      expect(forceExit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exits the Bridge process after graceful shutdown even when handles remain", async () => {
    const forceExit = vi.fn();
    const processLike = Object.assign(new EventEmitter(), {
      exit: forceExit,
    });
    const bridge = {
      close: vi.fn(async () => undefined),
    } as unknown as RunningBridge;

    const running = runBridgeUntilSignal(
      bridge,
      processLike as unknown as NonNullable<
        Parameters<typeof runBridgeUntilSignal>[1]
      >,
    );
    processLike.emit("SIGINT");
    await running;

    expect(forceExit).toHaveBeenCalledOnce();
    expect(forceExit).toHaveBeenCalledWith(0);
  });

  it("races a managed child exit against terminal shutdown without double-closing", async () => {
    const processLike = new EventEmitter();
    let resolveManagedExit: (
      result: { code: number | null; signal: NodeJS.Signals | null },
    ) => void = () => undefined;
    const managedExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) => {
      resolveManagedExit = resolveExit;
    });
    const closeBridge = vi.fn(async () => undefined);
    const bridge = {
      close: closeBridge,
      managedProcess: { exit: managedExit },
    } as unknown as RunningBridge;

    const running = runBridgeUntilSignal(
      bridge,
      processLike as unknown as Pick<NodeJS.Process, "once" | "off">,
    );
    resolveManagedExit({ code: 1, signal: null });
    processLike.emit("SIGHUP");
    await running;

    expect(closeBridge).toHaveBeenCalledOnce();
  });
});
