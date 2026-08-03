import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  type ControlArtifact,
  type ControlService,
  ControlServiceError,
  type TaskListRequest,
} from "@visual-remote/bridge-core/control";
import {
  generatePairingToken,
  pairingTokensMatch,
} from "@visual-remote/bridge-core/pairing";
import { assertServicePort, MIN_SERVICE_PORT } from "@visual-remote/bridge-core/ports";
import { HtmlInjectionTransform } from "./html-injector.js";

const DEFAULT_OVERLAY_BUNDLE_PATH = fileURLToPath(
  new URL("../../../packages/overlay/dist/client.js", import.meta.url),
);
const DEFAULT_VIEWER_BUNDLE_PATH = fileURLToPath(
  new URL("../../../packages/overlay/dist/viewer.js", import.meta.url),
);
const VIEWER_HTML = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Visual Bridge 작업 뷰어</title>
  </head>
  <body>
    <div id="visual-viewer-root">
      <p>작업 뷰어를 불러오는 중입니다.</p>
      <noscript>작업 뷰어를 사용하려면 JavaScript를 활성화해 주세요.</noscript>
    </div>
    <script type="module" src="/_visual/viewer.js"></script>
  </body>
</html>`;
const MAX_CONTROL_BODY_BYTES = 1_048_576;
const CONTROL_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_VIEWER_SESSION_TTL_MS = 30 * 60 * 1_000;
const VIEWER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

type AccessLevel = "control" | "viewer";

export interface GatewayOptions {
  upstream: string | URL;
  pairingToken: string;
  viewerToken?: string;
  viewerSessionTtlMs?: number;
  projectId: string;
  controlService: ControlService;
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  overlayBundlePath?: string;
  viewerBundlePath?: string;
  injectOverlay?: boolean;
}

export interface GatewayAddress {
  host: string;
  port: number;
  url: string;
}

export interface GatewayServer {
  readonly server: Server;
  readonly pairingToken: string;
  readonly projectId: string;
  start(): Promise<GatewayAddress>;
  address(): GatewayAddress | undefined;
  close(): Promise<void>;
}

interface ApiRoute {
  operation: keyof ControlService;
  successStatus?: number;
  taskId?: string;
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://visual.invalid").pathname;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function extractBearerToken(request: IncomingMessage): string | undefined {
  const authorization = headerValue(request.headers, "authorization");
  if (authorization === undefined) {
    return undefined;
  }
  const match = /^Bearer[ \t]+(.+)$/i.exec(authorization);
  return match?.[1];
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  const serialized = `${JSON.stringify(body === undefined ? null : body)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
  });
  response.end(serialized);
}

function writeApiError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  writeJson(response, statusCode, { error: { code, message } });
}

function originAllowed(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): boolean {
  const origin = headerValue(request.headers, "origin");
  if (origin === undefined || allowedOrigins.size === 0) {
    return true;
  }
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function tokenAccess(
  token: string | undefined,
  controlToken: string,
  viewerSessions: Map<string, number>,
  now: number,
): AccessLevel | undefined {
  if (token === undefined || token.length === 0) return undefined;
  if (pairingTokensMatch(controlToken, token)) return "control";
  const expiresAt = viewerSessions.get(token);
  if (expiresAt !== undefined) {
    if (expiresAt > now) return "viewer";
    viewerSessions.delete(token);
  }
  return undefined;
}

function requestAccess(
  request: IncomingMessage,
  controlToken: string,
  viewerSessions: Map<string, number>,
): AccessLevel | undefined {
  return tokenAccess(
    extractBearerToken(request),
    controlToken,
    viewerSessions,
    Date.now(),
  );
}

function isReadOnlyRoute(route: ApiRoute): boolean {
  return [
    "health",
    "project",
    "listTasks",
    "getTask",
    "getTaskDiff",
    "getTaskFiles",
    "getTaskLogs",
  ].includes(route.operation);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_CONTROL_BODY_BYTES) {
      throw new ControlServiceError(413, "body_too_large", "Control request body is too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ControlServiceError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function parseTaskListRequest(request: IncomingMessage): TaskListRequest {
  const url = new URL(request.url ?? "/", "http://visual.invalid");
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit === null ? undefined : Number.parseInt(rawLimit, 10);
  if (
    rawLimit !== null
    && (!/^\d+$/.test(rawLimit)
      || !Number.isFinite(parsedLimit)
      || parsedLimit === undefined
      || parsedLimit < 1)
  ) {
    throw new ControlServiceError(400, "invalid_limit", "Task limit must be a positive integer");
  }
  const before = url.searchParams.get("before");
  const beforeId = url.searchParams.get("beforeId");
  if ((before === null) !== (beforeId === null)) {
    throw new ControlServiceError(
      400,
      "invalid_cursor",
      "Task cursor requires both before and beforeId",
    );
  }
  if (
    before !== null
    && beforeId !== null
    && (before.length > 64 || beforeId.length === 0 || beforeId.length > 256)
  ) {
    throw new ControlServiceError(400, "invalid_cursor", "Task cursor is invalid");
  }

  return {
    ...(parsedLimit === undefined ? {} : { limit: Math.min(parsedLimit, 1_000) }),
    ...(before === null || beforeId === null
      ? {}
      : { cursor: { createdAt: before, id: beforeId } }),
  };
}

function parseApiRoute(method: string, path: string): ApiRoute | undefined {
  if (method === "GET" && path === "/_visual/api/health") {
    return { operation: "health" };
  }
  if (method === "GET" && path === "/_visual/api/project") {
    return { operation: "project" };
  }
  if (path === "/_visual/api/tasks") {
    if (method === "GET") {
      return { operation: "listTasks" };
    }
    if (method === "POST") {
      return { operation: "createTask", successStatus: 201 };
    }
    return undefined;
  }

  const taskMatch = /^\/_visual\/api\/tasks\/([^/]+)(?:\/(diff|files|logs|cancel|accept|revert))?$/.exec(
    path,
  );
  if (taskMatch === null) {
    return undefined;
  }

  const rawTaskId = taskMatch[1];
  if (rawTaskId === undefined) {
    return undefined;
  }

  let taskId: string;
  try {
    taskId = decodeURIComponent(rawTaskId);
  } catch {
    throw new ControlServiceError(400, "invalid_task_id", "Task id is not valid URL text");
  }

  const action = taskMatch[2];
  if (action === undefined && method === "GET") {
    return { operation: "getTask", taskId };
  }
  if (action === "diff" && method === "GET") {
    return { operation: "getTaskDiff", taskId };
  }
  if (action === "files" && method === "GET") {
    return { operation: "getTaskFiles", taskId };
  }
  if (action === "logs" && method === "GET") {
    return { operation: "getTaskLogs", taskId };
  }
  if (action === "cancel" && method === "POST") {
    return { operation: "cancelTask", taskId };
  }
  if (action === "accept" && method === "POST") {
    return { operation: "acceptTask", taskId };
  }
  if (action === "revert" && method === "POST") {
    return { operation: "revertTask", taskId };
  }
  return undefined;
}

async function invokeApiRoute(
  service: ControlService,
  route: ApiRoute,
  request: IncomingMessage,
): Promise<unknown> {
  const operation = service[route.operation];
  if (typeof operation !== "function") {
    throw new ControlServiceError(
      501,
      "not_implemented",
      `Control operation ${route.operation} is not available`,
    );
  }

  if (route.operation === "createTask") {
    return await service.createTask?.(await readJsonBody(request));
  }
  if (route.operation === "listTasks") {
    return await service.listTasks?.(parseTaskListRequest(request));
  }
  if (route.taskId !== undefined) {
    return await (
      operation as (taskId: string) => unknown | Promise<unknown>
    ).call(service, route.taskId);
  }
  return await (operation as () => unknown | Promise<unknown>).call(service);
}

function copyProxyHeaders(
  upstreamResponse: IncomingMessage,
  response: ServerResponse,
  injectingHtml: boolean,
): void {
  const skippedHeaders = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  if (injectingHtml) {
    skippedHeaders.add("content-length");
    skippedHeaders.add("content-encoding");
    skippedHeaders.add("etag");
  }

  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    if (value !== undefined && !skippedHeaders.has(name.toLowerCase())) {
      response.setHeader(name, value);
    }
  }
}

function shouldInjectHtml(
  request: IncomingMessage,
  upstreamResponse: IncomingMessage,
  enabled: boolean,
): boolean {
  if (!enabled || request.method !== "GET") {
    return false;
  }
  const contentType = headerValue(upstreamResponse.headers, "content-type");
  if (contentType === undefined || !/^text\/html(?:;|$)/i.test(contentType.trim())) {
    return false;
  }
  const encoding = headerValue(upstreamResponse.headers, "content-encoding");
  return encoding === undefined || encoding.toLowerCase() === "identity";
}

async function serveBrowserBundle(
  request: IncomingMessage,
  response: ServerResponse,
  bundlePath: string,
  unavailableCode: string,
  unavailableMessage: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    writeApiError(response, 405, "method_not_allowed", "Only GET and HEAD are supported");
    return;
  }

  try {
    const metadata = await stat(bundlePath);
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "content-length": metadata.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(bundlePath)
      .once("error", () => {
        response.destroy();
      })
      .pipe(response);
  } catch {
    writeApiError(
      response,
      503,
      unavailableCode,
      unavailableMessage,
    );
  }
}

function serveViewerHtml(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    writeApiError(response, 405, "method_not_allowed", "Only GET and HEAD are supported");
    return;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(VIEWER_HTML),
    "cache-control": "no-store",
    "content-security-policy": VIEWER_CONTENT_SECURITY_POLICY,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : VIEWER_HTML);
}

async function serveArtifact(
  service: ControlService,
  artifactId: string,
  response: ServerResponse,
): Promise<void> {
  if (service.getArtifact === undefined) {
    throw new ControlServiceError(501, "not_implemented", "Artifacts are not available");
  }
  const artifact: ControlArtifact | undefined = await service.getArtifact(artifactId);
  if (artifact === undefined) {
    throw new ControlServiceError(404, "not_found", "Artifact was not found");
  }
  const body = Buffer.isBuffer(artifact.body) ? artifact.body : Buffer.from(artifact.body);
  const headers: Record<string, string | number> = {
    "content-type": artifact.contentType,
    "content-length": body.length,
    "cache-control": "no-store",
  };
  if (artifact.fileName !== undefined) {
    headers["content-disposition"] = `attachment; filename="${artifact.fileName.replaceAll('"', "")}"`;
  }
  response.writeHead(200, headers);
  response.end(body);
}

function parseWebSocketAuth(data: RawData): string | undefined {
  try {
    const message = JSON.parse(data.toString()) as unknown;
    if (typeof message !== "object" || message === null) {
      return undefined;
    }
    const candidate = message as Record<string, unknown>;
    if (candidate.type !== "auth") {
      return undefined;
    }
    if (typeof candidate.payload === "string") {
      return candidate.payload;
    }
    if (typeof candidate.payload === "object" && candidate.payload !== null) {
      const token = (candidate.payload as Record<string, unknown>).token;
      return typeof token === "string" ? token : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function rejectUpgrade(socket: NodeJS.WritableStream, statusCode: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  if ("destroy" in socket && typeof socket.destroy === "function") {
    socket.destroy();
  }
}

function gatewayDisplayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function createGatewayServer(options: GatewayOptions): GatewayServer {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? MIN_SERVICE_PORT;
  assertServicePort(port);
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new TypeError("Gateway upstream must use http: or https:");
  }

  const allowedOrigins = new Set(
    (options.allowedOrigins ?? []).map((origin) => new URL(origin).origin),
  );
  const overlayBundlePath = options.overlayBundlePath ?? DEFAULT_OVERLAY_BUNDLE_PATH;
  const viewerBundlePath = options.viewerBundlePath ?? DEFAULT_VIEWER_BUNDLE_PATH;
  const viewerSessionTtlMs =
    options.viewerSessionTtlMs ?? DEFAULT_VIEWER_SESSION_TTL_MS;
  if (!Number.isSafeInteger(viewerSessionTtlMs) || viewerSessionTtlMs <= 0) {
    throw new TypeError("Viewer session TTL must be a positive integer");
  }
  let injectedViewerToken = options.viewerToken;
  if (
    injectedViewerToken !== undefined
    && pairingTokensMatch(options.pairingToken, injectedViewerToken)
  ) {
    throw new TypeError("Viewer token must differ from the control pairing token");
  }
  const viewerSessions = new Map<string, number>();
  if (injectedViewerToken !== undefined) {
    viewerSessions.set(injectedViewerToken, Date.now() + viewerSessionTtlMs);
  }
  const issueViewerSessionToken = (): string => {
    const now = Date.now();
    for (const [token, expiresAt] of viewerSessions) {
      if (expiresAt <= now) viewerSessions.delete(token);
    }

    if (injectedViewerToken !== undefined) {
      const token = injectedViewerToken;
      injectedViewerToken = undefined;
      viewerSessions.set(token, now + viewerSessionTtlMs);
      return token;
    }

    let token: string | undefined;
    while (
      token === undefined
      || pairingTokensMatch(options.pairingToken, token)
      || viewerSessions.has(token)
    ) {
      token = generatePairingToken();
    }
    viewerSessions.set(token, now + viewerSessionTtlMs);
    return token;
  };
  const injectOverlay = options.injectOverlay ?? true;
  const controlWebSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CONTROL_BODY_BYTES,
  });
  const controlSockets = new Set<WebSocket>();
  const proxy = httpProxy.createProxyServer({
    target: upstream,
    ws: true,
    xfwd: true,
    changeOrigin: false,
    selfHandleResponse: true,
  });
  proxy.on("error", () => {
    // Individual HTTP and WebSocket proxy calls handle errors at their boundary.
  });
  proxy.on("proxyReq", (proxyRequest) => {
    proxyRequest.setHeader("accept-encoding", "identity");
  });
  proxy.on(
    "proxyRes",
    (
      upstreamResponse: IncomingMessage,
      proxiedRequest: IncomingMessage,
      proxiedResponse: ServerResponse,
    ) => {
      const injectingHtml = shouldInjectHtml(
        proxiedRequest,
        upstreamResponse,
        injectOverlay,
      );
      copyProxyHeaders(upstreamResponse, proxiedResponse, injectingHtml);
      proxiedResponse.statusCode = upstreamResponse.statusCode ?? 502;
      if (upstreamResponse.statusMessage !== undefined) {
        proxiedResponse.statusMessage = upstreamResponse.statusMessage;
      }
      if (injectingHtml) {
        const transform = new HtmlInjectionTransform();
        transform.once("error", (error) => {
          proxiedResponse.destroy(error);
        });
        upstreamResponse.pipe(transform).pipe(proxiedResponse);
      } else {
        upstreamResponse.pipe(proxiedResponse);
      }
    },
  );

  const server = createServer((request, response) => {
    void (async () => {
      const path = requestPath(request);
      if (path === "/_visual/client.js") {
        await serveBrowserBundle(
          request,
          response,
          overlayBundlePath,
          "overlay_unavailable",
          "Overlay bundle is not built. Run the overlay build first.",
        );
        return;
      }

      if (path === "/_visual/viewer" || path === "/_visual/viewer/") {
        serveViewerHtml(request, response);
        return;
      }

      if (path === "/_visual/viewer.js") {
        await serveBrowserBundle(
          request,
          response,
          viewerBundlePath,
          "viewer_unavailable",
          "Viewer bundle is not built. Run the overlay build first.",
        );
        return;
      }

      if (path.startsWith("/_visual/api/")) {
        if (!originAllowed(request, allowedOrigins)) {
          writeApiError(response, 403, "origin_forbidden", "Request origin is not allowed");
          return;
        }
        const access = requestAccess(request, options.pairingToken, viewerSessions);
        if (access === undefined) {
          response.setHeader("www-authenticate", "Bearer");
          writeApiError(
            response,
            401,
            "unauthorized",
            "A valid control or viewer token is required",
          );
          return;
        }

        try {
          if (path === "/_visual/api/viewer-session") {
            if (request.method !== "GET") {
              writeApiError(response, 405, "method_not_allowed", "Only GET is supported");
              return;
            }
            if (access !== "control") {
              writeApiError(
                response,
                403,
                "control_token_required",
                "Viewer sessions cannot open another viewer session",
              );
              return;
            }
            const viewerToken = issueViewerSessionToken();
            writeJson(response, 200, {
              viewerUrl: `/_visual/viewer#visual-view=${encodeURIComponent(viewerToken)}`,
            });
            return;
          }

          const artifactMatch = /^\/_visual\/api\/artifacts\/([^/]+)$/.exec(path);
          if (artifactMatch !== null && request.method === "GET") {
            const artifactId = artifactMatch[1];
            if (artifactId === undefined) {
              throw new ControlServiceError(400, "invalid_artifact_id", "Artifact id is required");
            }
            await serveArtifact(options.controlService, decodeURIComponent(artifactId), response);
            return;
          }

          const route = parseApiRoute(request.method ?? "GET", path);
          if (route === undefined) {
            writeApiError(response, 404, "not_found", "Control route was not found");
            return;
          }
          if (access === "viewer" && !isReadOnlyRoute(route)) {
            writeApiError(
              response,
              403,
              "read_only_token",
              "Viewer sessions cannot change tasks",
            );
            return;
          }
          const result = await invokeApiRoute(options.controlService, route, request);
          if (result === undefined && route.taskId !== undefined) {
            writeApiError(response, 404, "not_found", "Task was not found");
            return;
          }
          writeJson(response, route.successStatus ?? 200, result);
        } catch (error) {
          if (error instanceof ControlServiceError) {
            writeApiError(response, error.statusCode, error.code, error.message);
            return;
          }
          writeApiError(
            response,
            500,
            "internal_error",
            error instanceof Error ? error.message : "Unknown control service error",
          );
        }
        return;
      }

      proxy.web(
        request,
        response,
        {
          target: upstream,
          selfHandleResponse: true,
        },
        (error) => {
          if (!response.headersSent) {
            writeApiError(response, 502, "upstream_unavailable", error.message);
          } else {
            response.destroy(error);
          }
        },
      );
    })().catch((error: unknown) => {
      writeApiError(
        response,
        500,
        "gateway_error",
        error instanceof Error ? error.message : "Unknown gateway error",
      );
    });
  });
  const gatewaySockets = new Set<Socket>();
  server.on("connection", (socket) => {
    gatewaySockets.add(socket);
    socket.once("close", () => {
      gatewaySockets.delete(socket);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const path = requestPath(request);
    if (path !== "/_visual/ws") {
      proxy.ws(request, socket, head, { target: upstream, selfHandleResponse: false }, () => {
        socket.destroy();
      });
      return;
    }

    if (!originAllowed(request, allowedOrigins)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    controlWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      controlSockets.add(webSocket);
      webSocket.on("error", () => {
        // Invalid or oversized control frames are isolated to their connection.
      });
      webSocket.once("close", () => {
        controlSockets.delete(webSocket);
      });
      const timeout = setTimeout(() => {
        webSocket.close(4401, "Pairing authentication timed out");
      }, CONTROL_AUTH_TIMEOUT_MS);
      timeout.unref();
      webSocket.once("close", () => {
        clearTimeout(timeout);
      });

      webSocket.once("message", (data) => {
        const token = parseWebSocketAuth(data);
        const access = tokenAccess(
          token,
          options.pairingToken,
          viewerSessions,
          Date.now(),
        );
        if (access === undefined) {
          clearTimeout(timeout);
          webSocket.close(4401, "Invalid viewer token");
          return;
        }

        clearTimeout(timeout);
        webSocket.send(
          JSON.stringify({
            type: "auth.ok",
            projectId: options.projectId,
            payload: { authenticated: true, access },
          }),
        );
        const connect =
          access === "viewer"
            ? options.controlService.connectViewerWebSocket
            : options.controlService.connectWebSocket;
        void Promise.resolve(
          connect?.({
            socket: webSocket,
            request,
            projectId: options.projectId,
          }),
        )
          .then((cleanup) => {
            if (cleanup !== undefined) {
              webSocket.once("close", cleanup);
            }
          })
          .catch(() => {
            webSocket.close(1011, "Control service failed");
          });
      });
    });
  });

  let currentAddress: GatewayAddress | undefined;
  let startPromise: Promise<GatewayAddress> | undefined;
  let closePromise: Promise<void> | undefined;
  let permanentlyClosed = false;

  return {
    server,
    pairingToken: options.pairingToken,
    projectId: options.projectId,
    start() {
      if (permanentlyClosed) {
        return Promise.reject(new Error("Gateway has already been closed"));
      }
      if (currentAddress !== undefined) {
        return Promise.resolve(currentAddress);
      }
      if (startPromise !== undefined) {
        return startPromise;
      }
      startPromise = new Promise<GatewayAddress>((resolve, reject) => {
        const handleError = (error: Error) => {
          server.off("listening", handleListening);
          startPromise = undefined;
          reject(error);
        };
        const handleListening = () => {
          server.off("error", handleError);
          const boundAddress = server.address() as AddressInfo | null;
          if (boundAddress === null) {
            startPromise = undefined;
            reject(new Error("Gateway did not expose a network address"));
            return;
          }
          currentAddress = {
            host,
            port: boundAddress.port,
            url: `http://${gatewayDisplayHost(host)}:${boundAddress.port}`,
          };
          resolve(currentAddress);
        };
        server.once("error", handleError);
        server.once("listening", handleListening);
        server.listen({ host, port });
      });
      return startPromise;
    },
    address() {
      return currentAddress;
    },
    close() {
      if (closePromise !== undefined) {
        return closePromise;
      }
      permanentlyClosed = true;
      closePromise = (async () => {
        for (const socket of controlSockets) {
          socket.terminate();
        }
        controlWebSocketServer.close();
        proxy.close();
        if (!server.listening) {
          currentAddress = undefined;
          return;
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            currentAddress = undefined;
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
          server.closeAllConnections();
          for (const socket of gatewaySockets) {
            socket.destroy();
          }
        });
      })();
      return closePromise;
    },
  };
}
