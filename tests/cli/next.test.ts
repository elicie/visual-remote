import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  closeVisualRemoteNext,
  isNextDetachedTelemetryProcess,
  mergeNextRewrites,
  resolveNextUpstream,
  withVisualRemote,
} from "@visual-remote/cli/next";
import { findAvailablePort } from "@visual-remote/bridge-core";

const execFileAsync = promisify(execFile);

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
    } finally {
      await closeVisualRemoteNext(root);
    }
  });
});
