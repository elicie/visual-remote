import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  closeVisualRemoteNext,
  isNextDetachedTelemetryProcess,
  mergeNextRewrites,
  resolveNextPublicUrl,
  resolveNextUpstream,
  withVisualRemote,
} from "@visual-remote/cli/next";
import { startAttachBridge } from "@visual-remote/cli/bridge";
import {
  acquireWorktreeLock,
  BridgeAlreadyRunningError,
  findAvailablePort,
  readInstance,
} from "@visual-remote/bridge-core";

const execFileAsync = promisify(execFile);

async function authenticateOrigin(gatewayUrl: string, origin: string, token: string | null): Promise<void> {
  const bootstrap = await fetch(`${gatewayUrl}/_visual/bootstrap`).then(async (response) => await response.json()) as { authMode: "local" | "token" };
  const socket = new WebSocket(`${gatewayUrl.replace(/^http/, "ws")}/_visual/ws`, { origin });
  try {
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", resolveOpen);
      socket.once("error", reject);
    });
    const authenticated = new Promise<unknown>((resolveMessage, reject) => {
      socket.once("message", (data) => {
        try {
          resolveMessage(JSON.parse(data.toString()) as unknown);
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
      socket.once("close", (code) => reject(new Error(`Authentication closed with code ${code}`)));
    });
    socket.send(JSON.stringify({
      id: "next-origin-auth",
      type: bootstrap.authMode === "local" ? "session.open" : "auth",
      browserSessionId: "00000000-0000-4000-8000-000000000001",
      payload: bootstrap.authMode === "local" ? {} : { token },
    }));
    await expect(authenticated).resolves.toMatchObject({
      type: bootstrap.authMode === "local" ? "session.ready" : "auth.ok",
      payload: bootstrap.authMode === "local" ? { access: "control" } : { authenticated: true, access: "control" },
    });
  } finally {
    socket.terminate();
  }
}

describe("Visual Remote Next.js integration", () => {
  it("resolves the original Next.js port from options, argv, and environment", () => {
    expect(resolveNextUpstream({ appPort: 10_101 }, ["node"], {})).toBe(
      "http://127.0.0.1:10101",
    );
    expect(resolveNextUpstream({}, ["node", "next", "dev", "--port", "10102"], {})).toBe(
      "http://127.0.0.1:10102",
    );
    expect(resolveNextUpstream({}, ["node", "next", "dev", "-p10103"], {})).toBe(
      "http://127.0.0.1:10103",
    );
    expect(resolveNextUpstream({}, ["node"], { PORT: "10104" })).toBe(
      "http://127.0.0.1:10104",
    );
    expect(resolveNextPublicUrl({ appPort: 10_101 }, ["node"], {})).toBe(
      "http://localhost:10101",
    );
  });

  it("does not start a Bridge inside Next.js detached telemetry", () => {
    expect(
      isNextDetachedTelemetryProcess([
        "node",
        "/project/node_modules/next/dist/telemetry/detached-flush.js",
      ]),
    ).toBe(true);
    expect(
      isNextDetachedTelemetryProcess([
        "node",
        "C:\\project\\node_modules\\next\\dist\\telemetry\\detached-flush.js",
      ]),
    ).toBe(true);
    expect(isNextDetachedTelemetryProcess(["node", "next/dist/bin/next"])).toBe(false);
  });

  it("puts Visual Remote before existing rewrites without losing them", () => {
    expect(
      mergeNextRewrites(
        [{ source: "/legacy", destination: "/new" }],
        "http://localhost:10105",
      ),
    ).toEqual({
      beforeFiles: [
        {
          source: "/_visual/:path*",
          destination: "http://localhost:10105/_visual/:path*",
          basePath: false,
          locale: false,
        },
      ],
      afterFiles: [{ source: "/legacy", destination: "/new" }],
      fallback: [],
    });
  });

  it("starts one development Bridge and exposes it through a Next.js rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-next-"));
    await execFileAsync("git", ["init", "--quiet", root]);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "visual-next-fixture", private: true }),
      "utf8",
    );
    await mkdir(join(root, ".visualdev"));
    await writeFile(
      join(root, ".visualdev/config.yaml"),
      "version: 1\nproject:\n  id: next-fixture\n  workspace: .\ngateway:\n  host: 127.0.0.1\n  port: auto\nupstream:\n  port: auto\n",
      "utf8",
    );

    const appPort = await findAvailablePort(32_000 + (process.pid % 1_000), "127.0.0.1");
    const bridgePort = await findAvailablePort(appPort + 1, "127.0.0.1");
    const config = withVisualRemote(
      {
        allowedDevOrigins: ["example.test"],
        async rewrites() {
          return [{ source: "/legacy", destination: "/new" }];
        },
      },
      { cwd: root, appPort, bridgeHost: "127.0.0.1", bridgePort },
    );

    try {
      const production = await config("phase-production-build", { defaultConfig: {} });
      expect(production.allowedDevOrigins).toEqual([
        "example.test",
        "dev",
        "localhost",
        "127.0.0.1",
      ]);

      const development = await config("phase-development-server", { defaultConfig: {} });
      const rewrites = await development.rewrites?.();
      expect(Array.isArray(rewrites)).toBe(false);
      const groups = rewrites as { beforeFiles: Array<{ destination: string }> };
      expect(groups.beforeFiles[0]?.destination).toBe(
        `http://127.0.0.1:${bridgePort}/_visual/:path*`,
      );

      const client = await fetch(`http://127.0.0.1:${bridgePort}/_visual/client.js`);
      expect(client.status).toBe(200);
      expect(await client.text()).toContain("__visual");
      const localApi = await fetch(`http://127.0.0.1:${bridgePort}/_visual/api/unknown`, {
        headers: { Origin: `http://127.0.0.1:${appPort}` },
      });
      expect(localApi.status).not.toBe(403);
    } finally {
      await closeVisualRemoteNext(root);
    }
  });

  it.each([
    { policy: "default", config: "", publicUrl: undefined, both: true },
    { policy: "configured public URL", config: "  publicUrl: https://next.example.test\n", publicUrl: undefined, both: false },
    { policy: "explicit public URL", config: "", publicUrl: "https://next.example.test", both: false },
    { policy: "explicit allowed origins", config: "", publicUrl: undefined, both: false },
  ])("authenticates only intended origins with $policy", async ({ policy, config, publicUrl, both }) => {
    const root = await mkdtemp(join(tmpdir(), "visual-next-origin-"));
    await execFileAsync("git", ["init", "--quiet", root]);
    await mkdir(join(root, ".visualdev"));
    await writeFile(
      join(root, ".visualdev/config.yaml"),
      `version: 1\nproject:\n  id: next-origin-fixture\n  workspace: .\ngateway:\n  host: 127.0.0.1\n  port: auto\n${config}upstream:\n  port: auto\n${policy === "explicit allowed origins" ? "security:\n  allowedOrigins:\n    - https://trusted.example.test\n" : ""}`,
    );
    const appPort = await findAvailablePort(34_000 + (process.pid % 1_000), "127.0.0.1");
    const bridge = await startAttachBridge({
      upstream: `http://127.0.0.1:${appPort}`,
      listen: appPort + 1,
      fallbackPublicUrl: `http://localhost:${appPort}`,
      fallbackLoopbackOrigins: true,
      ...(publicUrl === undefined ? {} : { publicUrl }),
    }, { cwd: root, upstreamMonitor: false });
    try {
      const token = new URLSearchParams(new URL(bridge.openUrl).hash.slice(1)).get("visual-pair");
      expect(bridge.authMode).toBe(policy === "default" ? "local" : "token");
      if (policy === "default") expect(new URL(bridge.openUrl).hash).toBe("");
      else expect(token).toBeTruthy();
      if (bridge.authMode === "token") {
        await expect(authenticateOrigin(bridge.gatewayUrl, new URL(bridge.openUrl).origin, "incorrect-token")).rejects.toThrow();
      }
      const accepted = [new URL(bridge.openUrl).origin];
      if (both) accepted.push(`http://127.0.0.1:${appPort}`);
      if (policy === "explicit allowed origins") accepted.push("https://trusted.example.test");
      for (const origin of accepted) {
        await authenticateOrigin(bridge.gatewayUrl, origin, token);
      }
      const rejected = ["https://unrelated.example.test", `http://127.0.0.1:${appPort + 2}`, `http://192.168.1.10:${appPort}`];
      if (!both) rejected.push(`http://127.0.0.1:${appPort}`);
      if (config || publicUrl) rejected.push(`http://localhost:${appPort}`);
      for (const origin of rejected) {
        await expect(authenticateOrigin(bridge.gatewayUrl, origin, token)).rejects.toThrow("Unexpected server response: 403");
      }
    } finally {
      await bridge.close();
    }
  });

  it("reuses a registered Bridge without taking ownership of its lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-next-reuse-"));
    await execFileAsync("git", ["init", "--quiet", root]);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "visual-next-reuse-fixture", private: true }),
      "utf8",
    );
    await mkdir(join(root, ".visualdev"));
    await writeFile(
      join(root, ".visualdev/config.yaml"),
      "version: 1\nproject:\n  id: next-reuse-fixture\n  workspace: .\ngateway:\n  host: 127.0.0.1\n  port: auto\nupstream:\n  port: auto\n",
      "utf8",
    );

    const appPort = await findAvailablePort(33_000 + (process.pid % 1_000), "127.0.0.1");
    const ownerPort = await findAvailablePort(appPort + 1, "127.0.0.1");
    const owner = await startAttachBridge(
      {
        upstream: `http://127.0.0.1:${appPort}`,
        host: "127.0.0.1",
        listen: ownerPort,
        publicUrl: "https://owner.example.test",
      },
      { cwd: root, upstreamMonitor: false },
    );

    try {
      expect(await readInstance(root)).toMatchObject({
        gatewayUrl: owner.gatewayUrl,
        pid: process.pid,
      });

      const requestedPort = await findAvailablePort(ownerPort + 1, "127.0.0.1");
      const config = withVisualRemote(
        {},
        {
          cwd: root,
          appPort,
          bridgeHost: "127.0.0.1",
          bridgePort: requestedPort,
        },
      );
      const development = await config("phase-development-server", {
        defaultConfig: {},
      });
      const rewrites = await development.rewrites?.();
      const groups = rewrites as { beforeFiles: Array<{ destination: string }> };

      expect(groups.beforeFiles[0]?.destination).toBe(
        `${owner.gatewayUrl}/_visual/:path*`,
      );
      expect((await readInstance(root))?.gatewayUrl).toBe(owner.gatewayUrl);
      const ownerToken = new URLSearchParams(new URL(owner.openUrl).hash.slice(1)).get("visual-pair")!;
      await authenticateOrigin(owner.gatewayUrl, "https://owner.example.test", ownerToken);
      for (const origin of [`http://localhost:${appPort}`, `http://127.0.0.1:${appPort}`]) {
        await expect(authenticateOrigin(owner.gatewayUrl, origin, ownerToken)).rejects.toThrow("Unexpected server response: 403");
      }

      await closeVisualRemoteNext(root);

      expect((await readInstance(root))?.gatewayUrl).toBe(owner.gatewayUrl);
      await expect(acquireWorktreeLock(root)).rejects.toBeInstanceOf(
        BridgeAlreadyRunningError,
      );
      const client = await fetch(`${owner.gatewayUrl}/_visual/client.js`);
      expect(client.status).toBe(200);

      await owner.close();

      expect(await readInstance(root)).toBeUndefined();
      const lock = await acquireWorktreeLock(root);
      await lock.release();
    } finally {
      await closeVisualRemoteNext(root);
      await owner.close();
    }
  });
});
