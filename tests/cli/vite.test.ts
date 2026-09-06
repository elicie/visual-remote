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
  it.each(["same plugin", "reloaded config"])("keeps the app and owned Bridge alive across restart with %s", async (mode) => {
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
    const apiFixture: Plugin = {
      name: "api-fixture",
      configureServer(server) {
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
      customLogger: createLogger("silent"),
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
      const originalInstance = await readInstance(root);
      expect(originalInstance?.gatewayUrl).toBe(`http://127.0.0.1:${bridgePort}`);
      for (let restart = 0; restart < 2; restart += 1) {
        await server.restart();
        expect(await responseStatus(`${origin}/_visual/client.js`)).toBe(200);
        expect(await responseStatus(`${origin}/api/ping`)).toBe(200);
        expect((await readInstance(root))?.startedAt).toBe(originalInstance?.startedAt);
      }
      expect(pluginInstances).toBe(mode === "reloaded config" ? 3 : 1);
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
