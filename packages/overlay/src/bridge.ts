import type {
  ClientMessage,
  ContextBundle,
  ServerEvent,
  TaskRecord,
  TaskStatus,
} from "@visual-remote/protocol";

import {
  compactText,
  parsePairingFragment,
  parseViewerFragment,
} from "./helpers.js";

const PAIRING_TOKEN_KEY = "visual-bridge:pairing-token";
const VIEWER_TOKEN_KEY = "visual-bridge:viewer-token";
const BROWSER_SESSION_KEY = "visual-bridge:browser-session";
const LAST_SEQUENCE_KEY = "visual-bridge:last-sequence";
const VIEWER_LAST_SEQUENCE_KEY = "visual-bridge:viewer-last-sequence";

const VALID_TASK_STATUSES = new Set<TaskStatus>([
  "queued",
  "preparing",
  "snapshotting_before",
  "resolving_context",
  "running_agent",
  "snapshotting_after",
  "diffing",
  "waiting_hmr",
  "verifying",
  "review",
  "accepted",
  "reverted",
  "failed",
  "canceled",
  "unsafe",
]);

export type ConnectionState =
  | "unpaired"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "unauthorized";

export interface ConnectionSnapshot {
  state: ConnectionState;
  projectId?: string;
  lastSequence: number;
}

export interface SequenceGap {
  expectedSequence: number;
  receivedSequence: number;
}

export interface TaskArtifacts {
  changedFiles: string[];
  diff: string;
  logs: string[];
  unavailable: Array<"files" | "diff" | "logs">;
}

export interface TaskEventRoute {
  accept: boolean;
  bind: boolean;
  taskId?: string;
}

export interface BridgeBootstrap {
  authMode: "local" | "token";
  projectId: string;
}

export interface BridgeRequestOptions {
  authMode?: BridgeBootstrap["authMode"];
  mode?: "control" | "viewer";
}

export async function fetchBootstrap(): Promise<BridgeBootstrap> {
  const response = await fetch("/_visual/bootstrap", {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Bridge bootstrap failed (${response.status})`);
  const value = recordOf(await response.json());
  if (
    (value?.authMode !== "local" && value?.authMode !== "token")
    || typeof value.projectId !== "string"
    || !value.projectId
  ) throw new Error("Bridge returned invalid bootstrap settings");
  return { authMode: value.authMode, projectId: value.projectId };
}

export interface BridgeConnectionOptions {
  token: string;
  browserSessionId: string;
  mode?: "control" | "viewer";
  authMode?: BridgeBootstrap["authMode"];
  getPageState?: () => Record<string, unknown>;
  onSnapshot: (snapshot: ConnectionSnapshot) => void;
  onEvent: (event: ServerEvent) => void;
  onSequenceGap?: (gap: SequenceGap) => void;
}

function safeSessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage can be blocked in hardened browser contexts; the live session still works.
  }
}

function safeSessionRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage can be blocked in hardened browser contexts; the live session still works.
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function consumePairingToken(): string {
  const parsed = parsePairingFragment(location.hash);
  if (parsed.token) {
    if (safeSessionGet(PAIRING_TOKEN_KEY) !== parsed.token) {
      safeSessionRemove(LAST_SEQUENCE_KEY);
    }
    safeSessionSet(PAIRING_TOKEN_KEY, parsed.token);
    const nextUrl = `${location.pathname}${location.search}${parsed.remainingHash}`;
    history.replaceState(history.state, "", nextUrl);
    return parsed.token;
  }

  return safeSessionGet(PAIRING_TOKEN_KEY) ?? "";
}

export function consumeViewerToken(): string | null {
  const parsed = parseViewerFragment(location.hash);
  if (parsed.token) {
    if (safeSessionGet(VIEWER_TOKEN_KEY) !== parsed.token) {
      safeSessionRemove(VIEWER_LAST_SEQUENCE_KEY);
    }
    safeSessionSet(VIEWER_TOKEN_KEY, parsed.token);
    const nextUrl = `${location.pathname}${location.search}${parsed.remainingHash}`;
    history.replaceState(history.state, "", nextUrl);
    return parsed.token;
  }

  return safeSessionGet(VIEWER_TOKEN_KEY);
}

export function getBrowserSessionId(): string {
  const existing = safeSessionGet(BROWSER_SESSION_KEY);
  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  safeSessionSet(BROWSER_SESSION_KEY, id);
  return id;
}

function readLastSequence(key: string): number | null {
  const raw = safeSessionGet(key);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function websocketUrl(): string {
  const url = new URL("/_visual/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export class BridgeConnection {
  readonly browserSessionId: string;

  private readonly token: string;
  private readonly mode: "control" | "viewer";
  private readonly authMode: BridgeBootstrap["authMode"];
  private readonly getPageState: () => Record<string, unknown>;
  private readonly sequenceStorageKey: string;
  private readonly onSnapshot: (snapshot: ConnectionSnapshot) => void;
  private readonly onEvent: (event: ServerEvent) => void;
  private readonly onSequenceGap: (gap: SequenceGap) => void;
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private state: ConnectionState = "connecting";
  private projectId: string | undefined;
  private lastSequence: number;
  private hasReplaySequence: boolean;

  constructor(options: BridgeConnectionOptions) {
    this.token = options.token;
    this.browserSessionId = options.browserSessionId;
    this.mode = options.mode ?? "control";
    this.authMode = options.authMode ?? "token";
    this.getPageState = options.getPageState ?? (() => ({}));
    this.sequenceStorageKey =
      this.mode === "viewer" ? VIEWER_LAST_SEQUENCE_KEY : LAST_SEQUENCE_KEY;
    const storedSequence = readLastSequence(this.sequenceStorageKey);
    this.lastSequence = storedSequence ?? 0;
    this.hasReplaySequence = storedSequence !== null || this.mode === "control";
    this.onSnapshot = options.onSnapshot;
    this.onEvent = options.onEvent;
    this.onSequenceGap = options.onSequenceGap ?? (() => {});
  }

  connect(): void {
    this.manuallyClosed = false;
    this.openSocket();
  }

  close(): void {
    this.manuallyClosed = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
  }

  send(type: ClientMessage["type"], payload: unknown): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    const message: ClientMessage = {
      id: crypto.randomUUID(),
      type,
      browserSessionId: this.browserSessionId,
      payload,
    };
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private emitSnapshot(): void {
    this.onSnapshot({
      state: this.state,
      ...(this.projectId ? { projectId: this.projectId } : {}),
      lastSequence: this.lastSequence,
    });
  }

  private openSocket(): void {
    this.clearTimers();
    this.state = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.emitSnapshot();

    let socket: WebSocket;
    try {
      socket = new WebSocket(websocketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;

      if (this.authMode === "local") {
        socket.send(JSON.stringify({
          type: "session.open",
          payload: { mode: this.mode },
        }));
      } else {
        this.send("auth", { token: this.token });
      }
    });

    socket.addEventListener("message", (message) => {
      this.handleMessage(String(message.data));
    });

    socket.addEventListener("close", (event) => {
      this.socket = null;
      if (event.code === 4001 || event.code === 4401) {
        this.state = "unauthorized";
        this.emitSnapshot();
        return;
      }
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      if (this.state === "connecting") {
        this.state = "offline";
        this.emitSnapshot();
      }
    });
  }

  private handleMessage(rawMessage: string): void {
    const parsed = recordOf(safeJsonParse(rawMessage));
    if (!parsed || typeof parsed.type !== "string") {
      return;
    }

    if (parsed.type === (this.authMode === "local" ? "session.ready" : "auth.ok")) {
      this.projectId =
        typeof parsed.projectId === "string" ? parsed.projectId : this.projectId;
      this.state = "connected";
      this.emitSnapshot();
      this.send("browser.hello", {
        ...(this.hasReplaySequence ? { lastSeq: this.lastSequence } : {}),
        ...(this.mode === "control" ? this.getPageState() : {}),
      });
      if (this.mode === "control") {
        this.heartbeatTimer = window.setInterval(() => {
          this.send("browser.heartbeat", {
            lastSeq: this.lastSequence,
            ...this.getPageState(),
          });
        }, 15_000);
      }
      return;
    }

    if (parsed.type === "auth.error" || parsed.type === "error.unauthorized") {
      this.state = "unauthorized";
      this.emitSnapshot();
      this.socket?.close(4401, "Pairing rejected");
      return;
    }

    if (typeof parsed.seq === "number") {
      if (parsed.seq <= this.lastSequence && this.hasReplaySequence) return;
      if (this.hasReplaySequence && parsed.seq > this.lastSequence + 1) {
        this.onSequenceGap({
          expectedSequence: this.lastSequence + 1,
          receivedSequence: parsed.seq,
        });
      }
      this.lastSequence = parsed.seq;
      this.hasReplaySequence = true;
      safeSessionSet(this.sequenceStorageKey, String(this.lastSequence));
      this.emitSnapshot();
    }
    if (typeof parsed.projectId === "string") {
      this.projectId = parsed.projectId;
    }

    this.onEvent(parsed as unknown as ServerEvent);
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    if (this.manuallyClosed) {
      return;
    }

    this.reconnectAttempt += 1;
    this.state = "reconnecting";
    this.emitSnapshot();
    const delay = Math.min(10_000, 500 * 2 ** (this.reconnectAttempt - 1));
    this.reconnectTimer = window.setTimeout(() => this.openSocket(), delay);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

async function authorizedFetch(
  token: string,
  path: string,
  init?: RequestInit,
  options: BridgeRequestOptions = {},
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (options.authMode === "local") {
    headers.delete("Authorization");
    if (options.mode === "viewer") headers.set("X-Visual-Mode", "viewer");
  } else if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const detail = compactText(await response.text(), 180);
    throw new Error(
      detail || `Bridge request failed (${response.status} ${response.statusText})`,
    );
  }
  return response;
}

async function responseValue(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? safeJsonParse(text) : null;
}

export async function fetchViewerUrl(token: string): Promise<string> {
  const value = await responseValue(
    await authorizedFetch(token, "/_visual/api/viewer-session"),
  );
  const viewerUrl = recordOf(value)?.viewerUrl;
  if (
    typeof viewerUrl !== "string"
    || !viewerUrl.startsWith("/_visual/viewer#visual-view=")
  ) {
    throw new Error("Bridge returned an invalid viewer session URL");
  }
  return viewerUrl;
}

export async function fetchProjectId(token: string, options: BridgeRequestOptions = {}): Promise<string | undefined> {
  const value = await responseValue(
    await authorizedFetch(token, "/_visual/api/project", undefined, options),
  );
  const record = recordOf(value);
  const nested = recordOf(record?.project);
  return typeof record?.id === "string"
    ? record.id
    : typeof record?.projectId === "string"
      ? record.projectId
      : typeof nested?.id === "string"
        ? nested.id
        : undefined;
}

export interface FetchTasksOptions extends BridgeRequestOptions {
  limit?: number;
  cursor?: Pick<TaskRecord, "createdAt" | "id">;
  signal?: AbortSignal;
}

export async function fetchTasks(
  token: string,
  options: FetchTasksOptions = {},
): Promise<TaskRecord[]> {
  const search = new URLSearchParams();
  if (options.limit !== undefined) search.set("limit", String(options.limit));
  if (options.cursor !== undefined) {
    search.set("before", options.cursor.createdAt);
    search.set("beforeId", options.cursor.id);
  }
  const serializedSearch = search.toString();
  const query = serializedSearch ? `?${serializedSearch}` : "";
  const value = await responseValue(
    await authorizedFetch(
      token,
      `/_visual/api/tasks${query}`,
      options.signal ? { signal: options.signal } : undefined,
      options,
    ),
  );
  const record = recordOf(value);
  const tasks = Array.isArray(value)
    ? value
    : Array.isArray(record?.tasks)
      ? record.tasks
      : [];

  return tasks.filter((candidate): candidate is TaskRecord => {
    const task = recordOf(candidate);
    return (
      typeof task?.id === "string" &&
      typeof task.projectId === "string" &&
      typeof task.status === "string" &&
      VALID_TASK_STATUSES.has(task.status as TaskStatus) &&
      typeof task.requestText === "string" &&
      (task.scope === "instance" ||
        task.scope === "component" ||
        task.scope === "page" ||
        task.scope === "project") &&
      typeof task.originBrowserSessionId === "string" &&
      Array.isArray(task.changedFiles) &&
      task.changedFiles.every((file) => typeof file === "string") &&
      typeof task.createdAt === "string"
    );
  });
}

export async function fetchLatestTaskForSession(
  token: string,
  browserSessionId: string,
  signal?: AbortSignal,
): Promise<TaskRecord | undefined> {
  const tasks = await fetchTasks(token, signal ? { signal } : undefined);

  for (const candidate of tasks) {
    if (candidate.originBrowserSessionId === browserSessionId) {
      return candidate;
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function filesFromValue(value: unknown): string[] {
  const direct = stringArray(value);
  if (direct.length > 0 || Array.isArray(value)) {
    return direct;
  }

  const record = recordOf(value);
  return stringArray(record?.files ?? record?.changedFiles ?? record?.data);
}

function diffFromValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = recordOf(value);
  const diff = record?.diff ?? record?.content ?? record?.data;
  return typeof diff === "string" ? diff : "";
}

function unwrapShellCommand(command: string): string {
  const match = /^(?:\/usr)?\/bin\/(?:bash|sh|zsh)\s+-lc\s+([\s\S]+)$/u.exec(
    command.trim(),
  );
  if (!match?.[1]) return command;
  const payload = match[1].trim();
  if (
    payload.length >= 2
    && ((payload.startsWith("'") && payload.endsWith("'"))
      || (payload.startsWith('"') && payload.endsWith('"')))
  ) {
    return payload.slice(1, -1);
  }
  return payload;
}

function commandLogLine(event: Record<string, unknown>): string | null {
  if (typeof event.command !== "string") return null;
  const command = unwrapShellCommand(event.command);
  const runtime = event.usedRtk === true || /^rtk(?:\s|$)/u.test(command) ? "RTK" : "명령";
  const cwd =
    typeof event.cwd === "string"
      ? event.cwd.split(/[\\/]/u).filter(Boolean).at(-1)
      : undefined;
  const metadata = [
    cwd,
    typeof event.durationMs === "number" ? `${event.durationMs}ms` : undefined,
    event.timedOut === true ? "시간 초과" : undefined,
    event.truncated === true ? "출력 축약" : undefined,
  ].filter((value): value is string => Boolean(value));
  return `${runtime} · ${command}${metadata.length > 0 ? ` · ${metadata.join(" · ")}` : ""}`;
}

type LogFormat = "compact" | "full";

function logTextFromValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  const record = recordOf(value);
  if (!record) {
    return null;
  }
  const event = recordOf(record.event) ?? record;
  const type = typeof event.type === "string" ? event.type : undefined;
  if (type === "command") {
    return commandLogLine(event);
  }
  if (type === "tool_start" && typeof event.name === "string") {
    if (event.name === "command_execution" || event.name === "direct_exec") return null;
    return `도구 시작 · ${event.name}${
      typeof event.summary === "string" ? ` · ${event.summary}` : ""
    }`;
  }
  if (type === "tool_end" && typeof event.name === "string") {
    if (event.name === "command_execution" || event.name === "direct_exec") return null;
    return `도구 ${event.ok === false ? "실패" : "완료"} · ${event.name}`;
  }
  if (type === "phase" && typeof event.name === "string") {
    return `단계 · ${event.name}`;
  }
  if (type === "file_hint" && typeof event.path === "string") {
    return `파일 · ${event.path}`;
  }
  if (
    type === "usage"
    && typeof event.inputTokens === "number"
    && typeof event.outputTokens === "number"
  ) {
    return `토큰 · 입력 ${event.inputTokens.toLocaleString("en-US")}${
      typeof event.cachedInputTokens === "number"
        ? ` · 캐시 ${event.cachedInputTokens.toLocaleString("en-US")}`
        : ""
    } · 출력 ${event.outputTokens.toLocaleString("en-US")}`;
  }
  const message =
    event.message ??
    event.text ??
    event.summary ??
    event.command ??
    event.error ??
    record.message;
  return typeof message === "string" ? message : null;
}

function logLineFromValue(value: unknown, format: LogFormat): string | null {
  const text = logTextFromValue(value);
  return text === null || format === "full" ? text : compactText(text, 500);
}

export async function fetchTaskArtifacts(
  token: string,
  taskId: string,
  signal?: AbortSignal,
  options: BridgeRequestOptions & { logFormat?: LogFormat } = {},
): Promise<TaskArtifacts> {
  const base = `/_visual/api/tasks/${encodeURIComponent(taskId)}`;
  const requestInit = signal === undefined ? undefined : { signal };
  const [filesResult, diffResult, logsResult] = await Promise.allSettled([
    authorizedFetch(token, `${base}/files`, requestInit, options).then(responseValue),
    authorizedFetch(token, `${base}/diff`, requestInit, options).then(responseValue),
    authorizedFetch(token, `${base}/logs`, requestInit, options).then(responseValue),
  ]);
  const aborted = [filesResult, diffResult, logsResult].find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected"
      && result.reason instanceof DOMException
      && result.reason.name === "AbortError",
  );
  if (aborted !== undefined) throw aborted.reason;

  const files =
    filesResult.status === "fulfilled" ? filesFromValue(filesResult.value) : [];
  const diff =
    diffResult.status === "fulfilled" ? diffFromValue(diffResult.value) : "";
  const logsValue = logsResult.status === "fulfilled" ? logsResult.value : [];
  const logsRecord = recordOf(logsValue);
  const logEntries = Array.isArray(logsValue)
    ? logsValue
    : Array.isArray(logsRecord?.logs)
      ? logsRecord.logs
      : [];
  const formattedLogs = logEntries
    .map((entry) => logLineFromValue(entry, options.logFormat ?? "compact"))
    .filter((line): line is string => line !== null && line.length > 0);
  const logs = options.logFormat === "full" ? formattedLogs : formattedLogs.slice(-40);

  const unavailable: TaskArtifacts["unavailable"] = [];
  if (filesResult.status === "rejected") unavailable.push("files");
  if (diffResult.status === "rejected") unavailable.push("diff");
  if (logsResult.status === "rejected") unavailable.push("logs");

  return { changedFiles: files, diff, logs, unavailable };
}

export async function postTaskAction(
  token: string,
  taskId: string,
  action: "accept" | "revert" | "cancel",
): Promise<unknown> {
  return responseValue(
    await authorizedFetch(
      token,
      `/_visual/api/tasks/${encodeURIComponent(taskId)}/${action}`,
      { method: "POST" },
    ),
  );
}

export function taskFromEvent(event: ServerEvent): TaskRecord | undefined {
  const payload = recordOf(event.payload);
  const nested = recordOf(payload?.task);
  const candidate = nested ?? payload;
  return candidate && typeof candidate.id === "string"
    ? (candidate as unknown as TaskRecord)
    : undefined;
}

export function routeTaskEvent(
  event: ServerEvent,
  browserSessionId: string,
  activeTaskId?: string,
): TaskEventRoute {
  const task = taskFromEvent(event);
  const taskId = event.taskId ?? task?.id;
  if (!taskId) {
    return { accept: false, bind: false };
  }

  if (event.type === "task.queued") {
    const bind = task?.originBrowserSessionId === browserSessionId;
    return bind
      ? { accept: true, bind: true, taskId }
      : { accept: false, bind: false, taskId };
  }

  return {
    accept: activeTaskId === taskId,
    bind: false,
    taskId,
  };
}

export function phaseFromEvent(event: ServerEvent): TaskStatus | undefined {
  const task = taskFromEvent(event);
  if (task?.status) {
    return task.status;
  }
  const payload = recordOf(event.payload);
  const phase = payload?.phase ?? payload?.status;
  return typeof phase === "string" ? (phase as TaskStatus) : undefined;
}

export function logFromEvent(event: ServerEvent, format: LogFormat = "compact"): string | null {
  const payload = recordOf(event.payload);
  return logLineFromValue(payload?.event ?? payload, format);
}

export function changedFilesFromEvent(event: ServerEvent): string[] {
  const payload = recordOf(event.payload);
  return filesFromValue(payload?.changedFiles ?? payload?.files ?? []);
}

export function createTaskPayload(bundle: ContextBundle): ContextBundle {
  return bundle;
}
