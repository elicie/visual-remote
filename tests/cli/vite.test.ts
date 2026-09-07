import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createLogger, createServer, type Plugin } from "vite";
import { startAttachBridge } from "@visual-remote/cli/bridge";
import { visualRemote } from "@visual-remote/cli/vite";
import { findAvailablePort, readInstance } from "@visual-remote/bridge-core";

const execFileAsync = promisify(execFile);

async function responseStatus(url: string): Promise<number> {
  const response = await fetch(url);
  await response.arrayBuffer();
  return response.status;
}

describe("Visual Remote Vite integration", () => {
  it.each([
    { mode: "same plugin", failure: "none" },
    { mode: "reloaded config", failure: "none" },
    { mode: "same plugin", failure: "close" },
    { mode: "reloaded config", failure: "close" },
    { mode: "same plugin", failure: "recover" },
    { mode: "reloaded config", failure: "recover" },
  ])("keeps the owned Bridge lifecycle correct with $mode and $failure restart failure", async ({ mode, failure }) => {
    const root = await mkdtemp(join(tmpdir(), "visual-vite-"));
    await execFileAsync("git", ["init", "--quiet", root]);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "visual-vite-fixture", private: true, scripts: { dev: "vite" } }),
      "utf8",
    );
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><html><head></head><body><main>original app</main></body></html>',
      "utf8",
    );
    await mkdir(join(root, ".visualdev"));
    await writeFile(
      join(root, ".visualdev/config.yaml"),
      "version: 1\nproject:\n  id: vite-fixture\n  workspace: .\ngateway:\n  host: 127.0.0.1\n  port: auto\nupstream:\n  port: auto\n",
      "utf8",
    );

    const appPort = await findAvailablePort(31_000 + (process.pid % 1_000), "127.0.0.1");
    const bridgePort = await findAvailablePort(appPort + 1, "127.0.0.1");
    let pluginInstances = 0;
    const pluginFactory = () => {
      pluginInstances += 1;
      return visualRemote({ cwd: root, bridgeHost: "127.0.0.1", bridgePort });
    };
    const factoryKey = Symbol.for(`visual-vite-test:${root}`);
    const factories = globalThis as typeof globalThis & {
      [factoryKey]?: () => Plugin;
    };
    const configFile = mode === "reloaded config" ? join(root, "vite.config.mjs") : false;
    if (configFile !== false) {
      factories[factoryKey] = pluginFactory;
      await writeFile(
        configFile,
        `export default () => ({ plugins: [globalThis[Symbol.for(${JSON.stringify(`visual-vite-test:${root}`)})]()] });`,
        "utf8",
      );
    }
    let configureCalls = 0;
    const restartErrors: string[] = [];
    const logger = createLogger("silent");
    const announcements: string[] = [];
    logger.info = (message) => { announcements.push(message); };
    logger.error = (message) => { restartErrors.push(message); };
    const apiFixture: Plugin = {
      name: "api-fixture",
      configureServer(server) {
        configureCalls += 1;
        if (failure !== "none" && configureCalls === 2) {
          throw new Error("replacement configureServer failed");
        }
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/api/ping") {
            next();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"source":"original-app"}');
        });
      },
    };
    const server = await createServer({
      root,
      configFile,
      customLogger: logger,
      server: {
        host: "127.0.0.1",
        port: appPort,
        strictPort: true,
      },
      plugins: [
        apiFixture,
        ...(configFile === false ? [pluginFactory()] : []),
      ],
    });

    try {
      await server.listen();
      const origin = `http://127.0.0.1:${appPort}`;
      const html = await (await fetch(`${origin}/`)).text();
      expect(html).toContain("original app");
      expect(html).toContain('src="/_visual/client.js"');

      const api = await (await fetch(`${origin}/api/ping`)).json();
      expect(api).toEqual({ source: "original-app" });
      expect(await responseStatus(`${origin}/@vite/client`)).toBe(200);
      expect(await responseStatus(`${origin}/_visual/client.js`)).toBe(200);
      expect(await responseStatus(`${origin}/_visual/viewer`)).toBe(200);
      expect(announcements).toContain(`[visual-remote] Open: ${origin}/`);
      for (const appOrigin of [origin, `http://localhost:${appPort}`]) {
        const bootstrap = await fetch(`${origin}/_visual/bootstrap`, {
          headers: { Origin: appOrigin },
        });
        expect(bootstrap.status).toBe(200);
        expect(await bootstrap.json()).toMatchObject({ authMode: "local" });
      }
      const untrusted = await fetch(`${origin}/_visual/bootstrap`, {
        headers: { Origin: `http://localhost:${appPort + 2}` },
      });
      expect(untrusted.status).toBe(403);
      const originalInstance = await readInstance(root);
      expect(originalInstance?.gatewayUrl).toBe(`http://127.0.0.1:${bridgePort}`);
      if (failure !== "none") {
        await server.restart();
        expect(restartErrors).toContain("replacement configureServer failed");
        expect(restartErrors).toContain("server restart failed");
        expect(await responseStatus(`${origin}/_visual/client.js`)).toBe(200);
        expect(await responseStatus(`${origin}/api/ping`)).toBe(200);
        expect((await readInstance(root))?.startedAt).toBe(originalInstance?.startedAt);
      }
      const successfulRestarts = failure === "close" ? 0 : 2;
      for (let restart = 0; restart < successfulRestarts; restart += 1) {
        await server.restart();
        expect(await responseStatus(`${origin}/_visual/client.js`)).toBe(200);
        expect(await responseStatus(`${origin}/api/ping`)).toBe(200);
        expect((await readInstance(root))?.startedAt).toBe(originalInstance?.startedAt);
      }
      expect(configureCalls).toBe(1 + successfulRestarts + (failure === "none" ? 0 : 1));
      expect(pluginInstances).toBe(mode === "reloaded config" ? configureCalls : 1);
    } finally {
      await server.close();
      delete factories[factoryKey];
    }
    expect(await readInstance(root)).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${bridgePort}/_visual/client.js`)).rejects.toThrow();
  });

  it("reuses a registered Bridge without taking ownership of its lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-vite-reuse-"));
    await execFileAsync("git", ["init", "--quiet", root]);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "visual-vite-reuse-fixture", private: true }),
      "utf8",
    );
    await writeFile(
      join(root, "index.html"),
      "<!doctype html><html><body>reuse fixture</body></html>",
      "utf8",
    );
    await mkdir(join(root, ".visualdev"));
    await writeFile(
      join(root, ".visualdev/config.yaml"),
      "version: 1\nproject:\n  id: vite-reuse-fixture\n  workspace: .\ngateway:\n  host: 127.0.0.1\n  port: auto\nupstream:\n  port: auto\n",
      "utf8",
    );

    const appPort = await findAvailablePort(
      32_000 + (process.pid % 1_000),
      "127.0.0.1",
    );
    const ownerPort = await findAvailablePort(appPort + 1, "127.0.0.1");
    const owner = await startAttachBridge(
      {
        upstream: `http://127.0.0.1:${appPort}`,
        host: "127.0.0.1",
        listen: ownerPort,
      },
      { cwd: root, upstreamMonitor: false },
    );
    const server = await createServer({
      root,
      configFile: false,
      customLogger: createLogger("silent"),
      server: {
        host: "127.0.0.1",
        port: appPort,
        strictPort: true,
      },
      plugins: [
        visualRemote({
          cwd: root,
          bridgeHost: "127.0.0.1",
          bridgePort: await findAvailablePort(ownerPort + 1, "127.0.0.1"),
        }),
      ],
    });
    let serverClosed = false;

    try {
      await server.listen();
      expect(await responseStatus(`http://127.0.0.1:${appPort}/_visual/client.js`)).toBe(
        200,
      );
      for (const origin of [`http://127.0.0.1:${appPort}`, `http://localhost:${appPort}`]) {
        const bootstrap = await fetch(`http://127.0.0.1:${appPort}/_visual/bootstrap`, {
          headers: { Origin: origin },
        });
        expect(bootstrap.status).toBe(200);
        expect(await bootstrap.json()).toMatchObject({ authMode: "local" });
      }
      const rejected = await fetch(`http://127.0.0.1:${appPort}/_visual/bootstrap`, {
        headers: { Origin: `http://localhost:${appPort + 2}` },
      });
      expect(rejected.status).toBe(403);
      expect((await readInstance(root))?.gatewayUrl).toBe(owner.gatewayUrl);
      await server.restart();
      expect(await responseStatus(`http://127.0.0.1:${appPort}/_visual/client.js`)).toBe(200);
      expect((await readInstance(root))?.gatewayUrl).toBe(owner.gatewayUrl);

      await server.close();
      serverClosed = true;

      expect((await readInstance(root))?.gatewayUrl).toBe(owner.gatewayUrl);
      expect(await responseStatus(`${owner.gatewayUrl}/_visual/client.js`)).toBe(200);
    } finally {
      if (!serverClosed) await server.close();
      await owner.close();
    }

    expect(await readInstance(root)).toBeUndefined();
  });
});
