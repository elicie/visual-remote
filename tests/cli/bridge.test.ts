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
  type RunningBridge,
} from "@visual-remote/cli/bridge";
import { formatDoctorChecks } from "@visual-remote/cli/doctor";
import { getBridgeStatus } from "@visual-remote/cli/status";
import {
  acquireWorktreeLock,
  BridgeAlreadyRunningError,
  findAvailablePort,
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
    const bridge = await startAttachBridge(
      { upstream: `http://127.0.0.1:${upstreamPort}` },
      {
        cwd: repoRoot,
        environment,
        controlServiceFactory: (context) =>
          createBasicControlService({ project: { id: context.projectId } }),
      },
    );

    try {
      expect(Number(new URL(bridge.gatewayUrl).port)).toBeGreaterThanOrEqual(10_001);
      expect(bridge.gateway.address()?.host).toBe("0.0.0.0");
      expect(bridge.pairingUrl).toContain("#visual-pair=");
      expect(formatBridgeSummary(bridge)).toContain("Upstream:");

      const status = await getBridgeStatus({ cwd: repoRoot, environment });
      expect(status.running).toBe(true);
      expect(status.instance?.pid).toBe(process.pid);
    } finally {
      await bridge.close();
      await close(upstream);
    }

    expect(await getBridgeStatus({ cwd: repoRoot, environment })).toEqual({
      running: false,
    });
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
});

describe("Bridge process lifecycle", () => {
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
