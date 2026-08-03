import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createLogger, createServer, type Plugin } from "vite";
import { visualRemote } from "@visual-remote/cli/vite";
import { findAvailablePort } from "@visual-remote/bridge-core";

const execFileAsync = promisify(execFile);

async function responseStatus(url: string): Promise<number> {
  const response = await fetch(url);
  await response.arrayBuffer();
  return response.status;
}

describe("Visual Remote Vite integration", () => {
  it("keeps the original app origin and proxies only Visual Remote routes", async () => {
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
      configFile: false,
      customLogger: createLogger("silent"),
      server: {
        host: "127.0.0.1",
        port: appPort,
        strictPort: true,
      },
      plugins: [
        apiFixture,
        visualRemote({ cwd: root, bridgeHost: "127.0.0.1", bridgePort }),
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
    } finally {
      await server.close();
    }
  });
});
