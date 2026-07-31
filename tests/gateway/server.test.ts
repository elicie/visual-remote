import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGatewayServer,
  type AuthenticatedControlSocket,
  type ControlService,
} from "@visual-remote/gateway";
import { findAvailablePort } from "@visual-remote/bridge-core";

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function openWebSocket(url: string, origin?: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(
      url,
      origin === undefined ? undefined : { origin },
    );
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function nextMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve, reject) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
    socket.once("error", reject);
  });
}

describe("Gateway server", () => {
  let upstream: Server;
  let gateway: ReturnType<typeof createGatewayServer>;
  let upstreamWebSockets: WebSocketServer;
  let upstreamPort: number;
  let gatewayPort: number;
  let lastAcceptEncoding: string | undefined;

  beforeEach(async () => {
    const portBase = 20_000 + (process.pid % 5_000);
    upstreamPort = await findAvailablePort(portBase, "127.0.0.1");
    gatewayPort = await findAvailablePort(upstreamPort + 1, "127.0.0.1", new Set([upstreamPort]));
    upstream = createServer((request, response) => {
      lastAcceptEncoding = request.headers["accept-encoding"];
      if (request.url === "/asset.js") {
        const source = "window.fixture=1;";
        response.writeHead(200, {
          "content-type": "text/javascript",
          "content-length": Buffer.byteLength(source),
        });
        response.end(source);
        return;
      }
      const html = "<!doctype html><html><head><title>Fixture</title></head><body>OK</body></html>";
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
      });
      response.end(request.method === "HEAD" ? undefined : html);
    });
    upstreamWebSockets = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (request, socket, head) => {
      upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("message", (data) => webSocket.send(data));
      });
    });
    await listen(upstream, upstreamPort);
  });

  afterEach(async () => {
    await gateway?.close();
    upstreamWebSockets.close();
    await close(upstream);
  });

  async function startGateway(controlService: ControlService): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "visual-overlay-"));
    const overlayBundlePath = join(directory, "client.js");
    const viewerBundlePath = join(directory, "viewer.js");
    await writeFile(overlayBundlePath, "globalThis.__visual = true;");
    await writeFile(viewerBundlePath, "globalThis.__visualViewer = true;");
    gateway = createGatewayServer({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      pairingToken: "fixture-token",
      projectId: "fixture",
      controlService,
      host: "127.0.0.1",
      port: gatewayPort,
      overlayBundlePath,
      viewerBundlePath,
      allowedOrigins: ["https://allowed.example"],
    });
    return (await gateway.start()).url;
  }

  it("injects only GET HTML and requests identity encoding upstream", async () => {
    const url = await startGateway({
      health: () => ({ status: "ok" }),
      project: () => ({ id: "fixture" }),
    });

    const htmlResponse = await fetch(`${url}/`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(await htmlResponse.text()).toContain(
      '<head><script type="module" src="/_visual/client.js"></script>',
    );
    expect(htmlResponse.headers.get("content-length")).toBeNull();
    expect(lastAcceptEncoding).toBe("identity");

    const assetResponse = await fetch(`${url}/asset.js`);
    expect(await assetResponse.text()).toBe("window.fixture=1;");
    expect(assetResponse.headers.get("content-length")).toBe(
      String(Buffer.byteLength("window.fixture=1;")),
    );

    const headResponse = await fetch(`${url}/`, { method: "HEAD" });
    expect(await headResponse.text()).toBe("");
    expect(headResponse.headers.get("content-length")).not.toBeNull();
  });

  it("serves the overlay and routes authenticated control requests", async () => {
    const created: unknown[] = [];
    const url = await startGateway({
      health: () => ({ status: "ok" }),
      project: () => ({ id: "fixture" }),
      listTasks: () => [{ id: "task-1" }],
      createTask: (payload) => {
        created.push(payload);
        return { id: "task-2" };
      },
      getTask: (taskId) =>
        taskId === "task-1" ? { id: taskId, status: "review" } : undefined,
    });

    const overlay = await fetch(`${url}/_visual/client.js`);
    expect(overlay.status).toBe(200);
    expect(await overlay.text()).toContain("__visual");

    const viewer = await fetch(`${url}/_visual/viewer`);
    expect(viewer.status).toBe(200);
    expect(await viewer.text()).toContain(
      '<div id="visual-viewer-root"></div>',
    );

    const viewerBundle = await fetch(`${url}/_visual/viewer.js`);
    expect(viewerBundle.status).toBe(200);
    expect(await viewerBundle.text()).toContain("__visualViewer");

    const viewerHead = await fetch(`${url}/_visual/viewer`, { method: "HEAD" });
    expect(viewerHead.status).toBe(200);
    expect(await viewerHead.text()).toBe("");

    const unauthorized = await fetch(`${url}/_visual/api/health`);
    expect(unauthorized.status).toBe(401);

    const headers = {
      authorization: "Bearer fixture-token",
      origin: "https://allowed.example",
    };
    const project = await fetch(`${url}/_visual/api/project`, { headers });
    expect(await project.json()).toEqual({ id: "fixture" });

    const tasks = await fetch(`${url}/_visual/api/tasks`, { headers });
    expect(await tasks.json()).toEqual([{ id: "task-1" }]);

    const create = await fetch(`${url}/_visual/api/tasks`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ request: "change it" }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toEqual({ id: "task-2" });
    expect(created).toEqual([{ request: "change it" }]);

    const missing = await fetch(`${url}/_visual/api/tasks/missing`, { headers });
    expect(missing.status).toBe(404);
  });

  it("preserves upstream HMR WebSockets and authenticates control WebSockets", async () => {
    let controlConnection: AuthenticatedControlSocket | undefined;
    const url = await startGateway({
      health: () => ({ status: "ok" }),
      project: () => ({ id: "fixture" }),
      connectWebSocket(connection) {
        controlConnection = connection;
        connection.socket.on("message", (data) => {
          connection.socket.send(
            JSON.stringify({ type: "echo", payload: data.toString() }),
          );
        });
      },
    });
    const wsUrl = url.replace("http:", "ws:");

    const hmr = await openWebSocket(`${wsUrl}/hmr`);
    const hmrReply = nextMessage(hmr);
    hmr.send(JSON.stringify({ type: "hmr-ping" }));
    expect(await hmrReply).toEqual({ type: "hmr-ping" });
    hmr.close();

    const control = await openWebSocket(
      `${wsUrl}/_visual/ws`,
      "https://allowed.example",
    );
    const authenticated = nextMessage(control);
    control.send(
      JSON.stringify({
        id: "auth-1",
        type: "auth",
        browserSessionId: "00000000-0000-4000-8000-000000000001",
        payload: { token: "fixture-token" },
      }),
    );
    expect(await authenticated).toEqual({
      type: "auth.ok",
      projectId: "fixture",
      payload: { authenticated: true },
    });
    expect(controlConnection?.projectId).toBe("fixture");

    const echo = nextMessage(control);
    control.send(JSON.stringify({ type: "browser.hello" }));
    expect(await echo).toEqual({
      type: "echo",
      payload: JSON.stringify({ type: "browser.hello" }),
    });
    control.close();
  });

  it("closes control WebSockets that exceed the one MiB payload limit", async () => {
    const url = await startGateway({
      health: () => ({ status: "ok" }),
      project: () => ({ id: "fixture" }),
    });
    const control = await openWebSocket(
      `${url.replace("http:", "ws:")}/_visual/ws`,
      "https://allowed.example",
    );
    const closed = nextClose(control);

    control.send(Buffer.alloc(1_048_577, 97));

    await expect(closed).resolves.toMatchObject({ code: 1009 });
  });
});
