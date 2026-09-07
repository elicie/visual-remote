import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import {
  acquireWorktreeLock,
  findAvailablePort,
  readInstance,
  terminateChildProcessTree,
} from "@visual-remote/bridge-core";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nextExecutable = require.resolve("next/dist/bin/next");
const nextAdapterUrl = pathToFileURL(
  resolve(repositoryRoot, "apps/cli/dist/next.js"),
).href;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function nextMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise<unknown>((resolveMessage, reject) => {
    socket.once("message", (data) => {
      try {
        resolveMessage(JSON.parse(data.toString()) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function openWebSocket(url: string, origin: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolveSocket, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once("open", () => resolveSocket(socket));
    socket.once("error", reject);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await terminateChildProcessTree(child, 5_000);
}

test("Next.js serves token-free HTTP and Visual Remote WebSocket on the app port", async ({ page }) => {
  const outputRoot = resolve(repositoryRoot, "output");
  await mkdir(outputRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(join(outputRoot, "next-single-port-"));
  const appPort = await findAvailablePort(20_000 + (process.pid % 10_000), "0.0.0.0");
  const bridgePort = await findAvailablePort(appPort + 1, "0.0.0.0", new Set([appPort]));
  const appOrigin = `http://localhost:${appPort}`;

  await execFileAsync("git", ["init", "--quiet", fixtureRoot]);
  await mkdir(join(fixtureRoot, "app"));
  await mkdir(join(fixtureRoot, ".visualdev"));
  await writeFile(
    join(fixtureRoot, "package.json"),
    JSON.stringify({ name: "visual-next-single-port", private: true, type: "module" }),
  );
  await writeFile(
    join(fixtureRoot, "app", "layout.js"),
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
  );
  await writeFile(
    join(fixtureRoot, "app", "page.js"),
    "export default function Page() { return <main>Next single port fixture</main>; }\n",
  );
  await writeFile(
    join(fixtureRoot, ".visualdev", "config.yaml"),
    [
      "version: 1",
      "project:",
      "  id: next-single-port",
      "  workspace: .",
      "gateway:",
      "  host: 127.0.0.1",
      `  port: ${bridgePort}`,
      "upstream:",
      `  port: ${appPort}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, "next.config.mjs"),
    [
      `import withVisualRemote from ${JSON.stringify(nextAdapterUrl)};`,
      "",
      "export default withVisualRemote({}, {",
      `  cwd: ${JSON.stringify(fixtureRoot)},`,
      `  appPort: ${appPort},`,
      `  bridgePort: ${bridgePort},`,
      '  bridgeHost: "127.0.0.1",',
      "});",
      "",
    ].join("\n"),
  );

  let output = "";
  const child = spawn(
    process.execPath,
    [nextExecutable, "dev", "--hostname", "0.0.0.0", "--port", String(appPort)],
    {
      cwd: fixtureRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${appPort}`)).status === 200;
      } catch {
        return false;
      }
    }, "Next.js readiness");

    await waitFor(
      () => /\[visual-remote\] Open: \S+/.test(output),
      "Visual Remote Open URL",
    );
    const openUrl = /\[visual-remote\] Open: (\S+)/.exec(output)?.[1];
    expect(openUrl).toBeDefined();
    const parsedOpenUrl = new URL(openUrl ?? "http://invalid");
    expect(parsedOpenUrl.origin).toBe(appOrigin);
    expect(parsedOpenUrl.hash).toBe("");

    const client = await fetch(`http://127.0.0.1:${appPort}/_visual/client.js`);
    expect(client.status).toBe(200);
    expect(await client.text()).toContain("visual-bridge");

    const bootstrap = await fetch(`http://127.0.0.1:${appPort}/_visual/bootstrap`);
    expect(await bootstrap.json()).toMatchObject({ authMode: "local" });
    const socket = await openWebSocket(
      `ws://127.0.0.1:${appPort}/_visual/ws`,
      appOrigin,
    );
    const authenticated = nextMessage(socket);
    socket.send(
      JSON.stringify({
        id: "next-single-port-auth",
        type: "session.open",
        browserSessionId: "00000000-0000-4000-8000-000000000001",
        payload: {},
      }),
    );
    await expect(authenticated).resolves.toMatchObject({
      type: "session.ready",
      projectId: "next-single-port",
      payload: { access: "control" },
    });
    socket.close();

    await page.goto(`http://127.0.0.1:${appPort}`);
    expect(new URL(page.url()).origin).toBe(`http://127.0.0.1:${appPort}`);
    const browserAuthenticated = await page.evaluate(async () => {
      const url = new URL("/_visual/ws", window.location.href);
      url.protocol = "ws:";
      const browserSocket = new WebSocket(url);
      return await new Promise<unknown>((resolveMessage, reject) => {
        browserSocket.addEventListener("open", () => {
          browserSocket.send(JSON.stringify({
            id: "next-browser-origin-auth",
            type: "session.open",
            browserSessionId: "00000000-0000-4000-8000-000000000002",
            payload: {},
          }));
        }, { once: true });
        browserSocket.addEventListener("message", (event) => {
          try {
            resolveMessage(JSON.parse(String(event.data)) as unknown);
          } catch (error) {
            reject(error);
          } finally {
            browserSocket.close();
          }
        }, { once: true });
        browserSocket.addEventListener("error", () => {
          browserSocket.close();
          reject(new Error("Same-origin browser WebSocket failed"));
        }, { once: true });
      });
    });
    expect(browserAuthenticated).toMatchObject({
      type: "session.ready",
      projectId: "next-single-port",
      payload: { access: "control" },
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\nNext output:\n${output}`,
    );
  } finally {
    await stop(child);
    try {
      await waitFor(
        async () => (await readInstance(fixtureRoot)) === undefined,
        "Bridge registry cleanup",
        10_000,
      );
      const lock = await acquireWorktreeLock(fixtureRoot);
      await lock.release();
    } finally {
      await rm(fixtureRoot, { recursive: true });
    }
  }
});
