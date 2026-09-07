import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBasicControlService,
  createGatewayServer,
  type AuthenticatedControlSocket,
  type ControlService,
  type GatewayOptions,
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
    vi.restoreAllMocks();
  });

  async function startGateway(
    controlService: ControlService,
    overrides: Pick<GatewayOptions, "viewerToken" | "viewerSessionTtlMs" | "authMode" | "allowedOrigins"> = {},
  ): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "visual-overlay-"));
    const overlayBundlePath = join(directory, "client.js");
    const viewerBundlePath = join(directory, "viewer.js");
    await writeFile(overlayBundlePath, "globalThis.__visual = true;");
    await writeFile(viewerBundlePath, "globalThis.__visualViewer = true;");
    gateway = createGatewayServer({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      pairingToken: "fixture-token",
      viewerToken: "fixture-viewer-token",
      projectId: "fixture",
      controlService,
      host: "127.0.0.1",
      port: gatewayPort,
      overlayBundlePath,
      viewerBundlePath,
      allowedOrigins: ["https://allowed.example"],
      ...overrides,
    });
    return (await gateway.start()).url;
  }

  it("keeps viewer and control capabilities on different tokens", () => {
    expect(() =>
      createGatewayServer({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        pairingToken: "same-token",
        viewerToken: "same-token",
        projectId: "fixture",
        controlService: createBasicControlService({ project: { id: "fixture" } }),
        host: "127.0.0.1",
        port: gatewayPort,
      }),
    ).toThrow("Viewer token must differ");
  });

  it("serves local resources without tokens and restricts viewer writes", async () => {
    const createTask = vi.fn(() => ({ id: "new-task" }));
    const url = await startGateway({
      health: () => ({ status: "ok" }), project: () => ({ id: "fixture" }), createTask,
    }, { authMode: "local", allowedOrigins: [`http://localhost:${upstreamPort}`] });
    expect(await (await fetch(`${url}/_visual/bootstrap`)).json()).toEqual({ authMode: "local", projectId: "fixture" });
    for (const path of ["client.js", "viewer.js", "viewer", "api/health"]) {
      expect((await fetch(`${url}/_visual/${path}`)).status).toBe(200);
    }
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      const authority = `${hostname}:${gatewayPort}`;
      for (const path of ["bootstrap", "client.js", "viewer.js", "viewer", "api/health"]) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const request = httpRequest(`${url}/_visual/${path}`, {
            headers: { host: authority, origin: `http://${authority}` },
          }, (response) => { response.resume(); resolve(response.statusCode); });
          request.once("error", reject);
          request.end();
        });
        expect(status).toBe(200);
      }
      const socket = await new Promise<WebSocket>((resolve, reject) => {
        const connection = new WebSocket(`${url.replace("http:", "ws:")}/_visual/ws`, {
          headers: { host: authority }, origin: `http://${authority}`,
        });
        connection.once("open", () => resolve(connection));
        connection.once("error", reject);
      });
      const ready = nextMessage(socket);
      socket.send(JSON.stringify({ type: "session.open", payload: { mode: "control" } }));
      await expect(ready).resolves.toMatchObject({ type: "session.ready" });
      socket.close();
    }
    expect(await (await fetch(`${url}/_visual/api/viewer-session`)).json()).toEqual({ viewerUrl: "/_visual/viewer" });
    expect((await fetch(`${url}/_visual/api/health`, {
      headers: { "X-Visual-Mode": "viewer", origin: `http://localhost:${upstreamPort}` },
    })).status).toBe(200);
    expect((await fetch(`${url}/_visual/api/tasks`, {
      method: "POST", headers: { "X-Visual-Mode": "viewer", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "change" }),
    })).status).toBe(403);
    expect((await fetch(`${url}/_visual/api/viewer-session`, { headers: { "X-Visual-Mode": "viewer" } })).status).toBe(403);
    expect(createTask).not.toHaveBeenCalled();
    expect((await fetch(`${url}/_visual/api/tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "change" }),
    })).status).toBe(201);
    expect(createTask).toHaveBeenCalledOnce();
  });

  it("rejects foreign local hosts and origins across visual resources, not upstream", async () => {
    const url = await startGateway({
      health: () => ({ status: "ok" }), project: () => ({ id: "fixture" }),
    }, { authMode: "local", allowedOrigins: [] });
    const rejectedHeaders: Record<string, string>[] = [
      { host: "foreign.example" }, { host: `localhost:${gatewayPort + 1}` },
      { origin: "https://foreign.example" }, { origin: "null" },
      { origin: `http://localhost:${upstreamPort}` }, { "sec-fetch-site": "cross-site" },
      { host: "foreign.example", "x-forwarded-host": `127.0.0.1:${gatewayPort}`, "x-forwarded-for": "127.0.0.1" },
    ];
    for (const path of ["bootstrap", "client.js", "viewer.js", "viewer", "api/health", "unknown"]) {
      for (const headers of rejectedHeaders) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const request = httpRequest(`${url}/_visual/${path}`, { headers }, (response) => {
            response.resume(); resolve(response.statusCode);
          });
          request.once("error", reject); request.end();
        });
        expect(status).toBe(403);
      }
    }
    expect((await fetch(`${url}/asset.js`, { headers: { origin: "https://foreign.example" } })).status).toBe(200);
    await expect(openWebSocket(`${url.replace("http:", "ws:")}/_visual/ws`, "https://foreign.example")).rejects.toThrow("403");
    await expect(new Promise((resolve, reject) => {
      const socket = new WebSocket(`${url.replace("http:", "ws:")}/_visual/ws`, { headers: { host: "foreign.example" } });
      socket.once("open", resolve); socket.once("error", reject);
    })).rejects.toThrow("403");
  });

  it("opens local control and viewer sockets with session.open", async () => {
    const connectWebSocket = vi.fn(({ socket }: AuthenticatedControlSocket) => {
      socket.on("message", (data) => socket.send(data.toString()));
    });
    const connectViewerWebSocket = vi.fn();
    const url = await startGateway({
      health: () => ({ status: "ok" }), project: () => ({ id: "fixture" }),
      connectWebSocket, connectViewerWebSocket,
    }, { authMode: "local", allowedOrigins: [] });
    for (const mode of ["control", "viewer"] as const) {
      const socket = await openWebSocket(`${url.replace("http:", "ws:")}/_visual/ws`, url);
      const ready = nextMessage(socket);
      socket.send(JSON.stringify({ type: "session.open", payload: { mode } }));
      expect(await ready).toEqual({ type: "session.ready", projectId: "fixture", payload: { access: mode } });
      if (mode === "control") {
        const echo = nextMessage(socket);
        socket.send(JSON.stringify({ type: "browser.hello" }));
        expect(await echo).toEqual({ type: "browser.hello" });
      }
      socket.close();
    }
    expect(connectWebSocket).toHaveBeenCalledOnce();
    expect(connectViewerWebSocket).toHaveBeenCalledOnce();
    for (const frame of [
      { type: "session.open", payload: { mode: "admin" } },
      { type: "auth", payload: { token: "fixture-token" } },
    ]) {
      const invalid = await openWebSocket(`${url.replace("http:", "ws:")}/_visual/ws`);
      const closed = nextClose(invalid);
      invalid.send(JSON.stringify(frame));
      expect((await closed).code).toBe(4401);
    }
  });

  it("rejects local configuration with external binds or application origins", () => {
    const options: GatewayOptions = {
      upstream: `http://127.0.0.1:${upstreamPort}`, pairingToken: "", projectId: "fixture",
      controlService: createBasicControlService({ project: { id: "fixture" } }), authMode: "local", port: gatewayPort,
    };
    expect(() => createGatewayServer(options)).toThrow("loopback gateway host");
    for (const host of ["0.0.0.0", "::", "192.168.1.2", "remote.example"]) {
      expect(() => createGatewayServer({ ...options, host })).toThrow("loopback gateway host");
    }
    for (const origin of ["https://foreign.example", "http://127.0.0.2", "file://localhost"]) {
      expect(() => createGatewayServer({ ...options, host: "127.0.0.1", allowedOrigins: [origin] }))
        .toThrow("loopback application origins");
    }
  });

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
    let taskListRequest: unknown;
    const url = await startGateway({
      health: () => ({ status: "ok" }),
      project: () => ({ id: "fixture" }),
      listTasks: (request) => {
        taskListRequest = request;
        return [{ id: "task-1" }];
      },
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
    expect(viewer.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(viewer.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await viewer.text()).toContain(
      '<div id="visual-viewer-root">',
    );

    const viewerBundle = await fetch(`${url}/_visual/viewer.js`);
    expect(viewerBundle.status).toBe(200);
    expect(await viewerBundle.text()).toContain("__visualViewer");

    const viewerHead = await fetch(`${url}/_visual/viewer`, { method: "HEAD" });
    expect(viewerHead.status).toBe(200);
    expect(await viewerHead.text()).toBe("");

    const anonymous = await fetch(`${url}/_visual/api/health`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");

    const headers = {
      authorization: "Bearer fixture-token",
      origin: "https://allowed.example",
    };
    const project = await fetch(`${url}/_visual/api/project`, { headers });
    expect(await project.json()).toEqual({ id: "fixture" });

    const viewerSession = await fetch(`${url}/_visual/api/viewer-session`, {
      headers,
    });
    const firstViewerSession = await viewerSession.json();
    expect(firstViewerSession).toEqual({
      viewerUrl: "/_visual/viewer#visual-view=fixture-viewer-token",
    });

    const secondViewerSessionResponse = await fetch(`${url}/_visual/api/viewer-session`, {
      headers,
    });
    const secondViewerSession = await secondViewerSessionResponse.json() as {
      viewerUrl: string;
    };
    expect(secondViewerSession.viewerUrl).toMatch(
      /^\/_visual\/viewer#visual-view=[A-Za-z0-9_-]+$/,
    );
    expect(secondViewerSession.viewerUrl).not.toBe(firstViewerSession.viewerUrl);

    const viewerHeaders = {
      authorization: "Bearer fixture-viewer-token",
      origin: "https://allowed.example",
    };
    const viewerTasks = await fetch(`${url}/_visual/api/tasks`, {
      headers: viewerHeaders,
    });
    expect(await viewerTasks.json()).toEqual([{ id: "task-1" }]);

    const pagedTasks = await fetch(
      `${url}/_visual/api/tasks?limit=25&before=2026-01-02T00%3A00%3A00.000Z&beforeId=task-25`,
      { headers: viewerHeaders },
    );
    expect(pagedTasks.status).toBe(200);
    expect(taskListRequest).toEqual({
      limit: 25,
      cursor: {
        createdAt: "2026-01-02T00:00:00.000Z",
        id: "task-25",
      },
    });

    const invalidCursor = await fetch(
      `${url}/_visual/api/tasks?before=2026-01-02T00%3A00%3A00.000Z`,
      { headers: viewerHeaders },
    );
    expect(invalidCursor.status).toBe(400);

    const viewerCreate = await fetch(`${url}/_visual/api/tasks`, {
      method: "POST",
      headers: { ...viewerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ request: "must stay read only" }),
    });
    expect(viewerCreate.status).toBe(403);
    expect(await viewerCreate.json()).toMatchObject({
      error: { code: "read_only_token" },
    });
    expect(created).toEqual([]);

    const nestedViewerSession = await fetch(`${url}/_visual/api/viewer-session`, {
      headers: viewerHeaders,
    });
    expect(nestedViewerSession.status).toBe(403);

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
    let viewerConnection: AuthenticatedControlSocket | undefined;
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
      connectViewerWebSocket(connection) {
        viewerConnection = connection;
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
      payload: { authenticated: true, access: "control" },
    });
    expect(controlConnection?.projectId).toBe("fixture");

    const echo = nextMessage(control);
    control.send(JSON.stringify({ type: "browser.hello" }));
    expect(await echo).toEqual({
      type: "echo",
      payload: JSON.stringify({ type: "browser.hello" }),
    });
    control.close();

    const viewerControl = await openWebSocket(
      `${wsUrl}/_visual/ws`,
      "https://allowed.example",
    );
    const viewerAuthenticated = nextMessage(viewerControl);
    viewerControl.send(
      JSON.stringify({
        id: "auth-viewer",
        type: "auth",
        browserSessionId: "00000000-0000-4000-8000-000000000002",
        payload: { token: "fixture-viewer-token" },
      }),
    );
    expect(await viewerAuthenticated).toEqual({
      type: "auth.ok",
      projectId: "fixture",
      payload: { authenticated: true, access: "viewer" },
    });
    expect(viewerConnection?.projectId).toBe("fixture");
    viewerControl.close();

    const anonymousControl = await openWebSocket(
      `${wsUrl}/_visual/ws`,
      "https://allowed.example",
    );
    const anonymousClosed = nextClose(anonymousControl);
    anonymousControl.send(
      JSON.stringify({
        id: "auth-anonymous",
        type: "auth",
        payload: { token: "" },
      }),
    );
    await expect(anonymousClosed).resolves.toEqual({
      code: 4401,
      reason: "Invalid viewer token",
    });
  });

  it("rejects expired viewer sessions for REST and new WebSocket authentication", async () => {
    let now = Date.parse("2026-08-02T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const url = await startGateway(
      {
        health: () => ({ status: "ok" }),
        project: () => ({ id: "fixture" }),
      },
      { viewerSessionTtlMs: 1_000 },
    );
    const viewerHeaders = {
      authorization: "Bearer fixture-viewer-token",
      origin: "https://allowed.example",
    };

    const active = await fetch(`${url}/_visual/api/health`, {
      headers: viewerHeaders,
    });
    expect(active.status).toBe(200);

    now += 1_001;
    const expired = await fetch(`${url}/_visual/api/health`, {
      headers: viewerHeaders,
    });
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toBe("Bearer");

    const viewerSocket = await openWebSocket(
      `${url.replace("http:", "ws:")}/_visual/ws`,
      "https://allowed.example",
    );
    const closed = nextClose(viewerSocket);
    viewerSocket.send(
      JSON.stringify({
        id: "auth-expired-viewer",
        type: "auth",
        payload: { token: "fixture-viewer-token" },
      }),
    );
    await expect(closed).resolves.toEqual({
      code: 4401,
      reason: "Invalid viewer token",
    });
  });

  it("requires a positive integer viewer session TTL", () => {
    expect(() =>
      createGatewayServer({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        pairingToken: "fixture-token",
        projectId: "fixture",
        controlService: createBasicControlService({ project: { id: "fixture" } }),
        host: "127.0.0.1",
        port: gatewayPort,
        viewerSessionTtlMs: 0,
      }),
    ).toThrow("Viewer session TTL must be a positive integer");
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
