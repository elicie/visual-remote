import type { RawData, WebSocket } from "ws";

import {
  clientMessageSchema,
  contextBundleSchema,
  type ClientMessage,
  type ContextBundle,
  type ServerEvent,
  type TaskRecord,
} from "@visual-remote/protocol";
import {
  ControlServiceError,
  type AuthenticatedControlSocket,
  type ControlService,
} from "./control-service.js";
import type { BridgeMode } from "./control-context.js";
import {
  isWorkingTaskStatus,
  TaskService,
  TaskServiceError,
} from "../tasks/index.js";
import {
  BrowserSessionManager,
  type BrowserConsoleEvent,
  type BrowserPageState,
  type BrowserTargetResult,
  type BrowserTargetState,
  type BrowserVerificationBaseline,
  type BrowserVerificationResult,
} from "../verification/browser-sessions.js";
import {
  runVerificationCommands,
  type VerificationCommand,
  type VerificationCommandResult,
} from "../verification/commands.js";
import { sanitizeContextBundle } from "../context/sanitize.js";

export interface TaskControlServiceOptions {
  taskService: TaskService;
  project: {
    id: string;
    repoRoot: string;
    workspaceRoot: string;
    mode: BridgeMode;
    upstreamUrl: string;
  };
  browserSessions?: BrowserSessionManager;
  hmrWaitMs?: number;
  verificationCommands?: readonly VerificationCommand[];
}

interface TaskRequest {
  context: ContextBundle;
  parentTaskId?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parsePageState(payload: unknown): BrowserPageState | undefined {
  const record = recordOf(payload);
  const viewport = recordOf(record?.viewport);
  if (
    typeof record?.url !== "string"
    || typeof viewport?.width !== "number"
    || typeof viewport.height !== "number"
  ) {
    return undefined;
  }

  return {
    url: record.url,
    viewport: { width: viewport.width, height: viewport.height },
    renderRevision: Math.max(0, Math.floor(numberOf(record.renderRevision))),
  };
}

function parseTaskRequest(payload: unknown): TaskRequest {
  const record = recordOf(payload);
  const contextCandidate = record?.contextBundle ?? record?.context ?? payload;
  const context = sanitizeContextBundle(contextBundleSchema.parse(contextCandidate));
  const parentTaskId =
    typeof record?.parentTaskId === "string" && record.parentTaskId.length > 0
      ? record.parentTaskId
      : undefined;

  return {
    context,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
  };
}

function translateError(error: unknown): never {
  if (error instanceof ControlServiceError) {
    throw error;
  }
  if (error instanceof TaskServiceError) {
    const statusCode =
      error.code === "TASK_NOT_FOUND" || error.code === "UNKNOWN_PARENT_TASK"
        ? 404
        : error.code === "WRITER_BUSY"
          || error.code === "NOT_LATEST_TASK"
          || error.code === "TASK_NOT_ACCEPTABLE"
          || error.code === "TASK_NOT_REVERTIBLE"
          ? 409
          : 400;
    throw new ControlServiceError(statusCode, error.code.toLowerCase(), error.message);
  }
  throw error;
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value));
  }
}

const MAX_BUFFERED_VIEWER_EVENTS = 1_000;

function rawText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  return data.toString("utf8");
}

function parseClientMessage(data: RawData): ClientMessage | undefined {
  try {
    const result = clientMessageSchema.safeParse(JSON.parse(rawText(data)) as unknown);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function recordConsoleEvents(
  sessions: BrowserSessionManager,
  browserSessionId: string,
  payload: unknown,
): void {
  const record = recordOf(payload);
  const candidates = Array.isArray(record?.events)
    ? record.events
    : Array.isArray(payload)
      ? payload
      : [];
  for (const candidate of candidates.slice(0, 100)) {
    const event = recordOf(candidate);
    const level =
      event?.level === "warning" || event?.level === "error" || event?.level === "unhandled"
        ? event.level
        : undefined;
    if (level === undefined || typeof event?.message !== "string") {
      continue;
    }
    sessions.recordConsole(browserSessionId, {
      level: level as BrowserConsoleEvent["level"],
      message: event.message,
      ...(typeof event.createdAt === "string" ? { createdAt: event.createdAt } : {}),
    });
  }
}

const TARGET_STATES = new Set<BrowserTargetState>([
  "found-and-changed",
  "found-no-visible-change",
  "not-found",
  "page-reloaded",
  "unverified",
]);

function targetCount(value: unknown, maximum = 20): number {
  return Math.min(maximum, Math.max(0, Math.floor(numberOf(value))));
}

function parseTargetResult(
  payload: unknown,
): Omit<BrowserTargetResult, "createdAt"> | undefined {
  const record = recordOf(payload);
  if (
    typeof record?.taskId !== "string"
    || typeof record.state !== "string"
    || !TARGET_STATES.has(record.state as BrowserTargetState)
  ) {
    return undefined;
  }
  const total = targetCount(record.targetCount);
  const found = Math.min(total, targetCount(record.foundCount));
  return {
    taskId: record.taskId,
    state: record.state as BrowserTargetState,
    renderRevision: targetCount(record.renderRevision, Number.MAX_SAFE_INTEGER),
    targetCount: total,
    foundCount: found,
    changedCount: Math.min(found, targetCount(record.changedCount)),
  };
}

function targetResultSummary(result: BrowserTargetResult): string {
  return `Browser target check: ${result.state} (${result.foundCount}/${result.targetCount} found, ${result.changedCount} changed).`;
}

function taskFromPayload(payload: unknown): TaskRecord | undefined {
  const record = recordOf(payload);
  const task = recordOf(record?.task) ?? record;
  return typeof task?.id === "string" && typeof task.status === "string"
    ? (task as unknown as TaskRecord)
    : undefined;
}

export function combineVerificationStatus(
  browser: BrowserVerificationResult,
  commands: readonly VerificationCommandResult[],
): NonNullable<TaskRecord["verificationStatus"]> {
  if (
    browser.status === "failed"
    || commands.some((command) => command.status !== "passed")
  ) {
    return "failed";
  }
  if (browser.status === "passed") {
    return "passed";
  }
  if (browser.status === "unverified" && commands.length === 0) {
    return "unverified";
  }
  return "partial";
}

export function createTaskControlService(
  options: TaskControlServiceOptions,
): ControlService {
  const sessions = options.browserSessions ?? new BrowserSessionManager();
  const taskService = options.taskService;
  const verificationBaselines = new Map<string, BrowserVerificationBaseline>();
  const targetEvidenceRequirements = new Map<string, boolean>();
  const pendingVerifications = new Map<
    string,
    {
      baseline: BrowserVerificationBaseline;
      targetEvidenceRequired: boolean;
      timeout: NodeJS.Timeout;
      resolve: (result: BrowserVerificationResult) => void;
    }
  >();
  const hmrWaitMs = Math.max(0, options.hmrWaitMs ?? 12_000);
  const verificationCommands = options.verificationCommands ?? [];
  const verificationAbort = new AbortController();
  const verificationRuns = new Set<Promise<void>>();
  let closed = false;

  const finalizeVerification = (taskId: string, force: boolean): void => {
    const pending = pendingVerifications.get(taskId);
    if (pending === undefined) {
      return;
    }
    const result = sessions.verify(pending.baseline, {
      taskId,
      targetEvidenceRequired: pending.targetEvidenceRequired,
    });
    if (!force && result.status !== "passed" && result.status !== "failed") {
      return;
    }
    clearTimeout(pending.timeout);
    pendingVerifications.delete(taskId);
    pending.resolve(result);
  };

  const waitForBrowserVerification = (
    taskId: string,
    baseline: BrowserVerificationBaseline | undefined,
    targetEvidenceRequired: boolean,
  ): Promise<BrowserVerificationResult> => {
    if (baseline === undefined) {
      return Promise.resolve({
        status: "unverified",
        renderChanged: false,
        newErrors: [],
        summary: "Origin browser session was unavailable when the task started.",
      });
    }

    return new Promise<BrowserVerificationResult>((resolveResult) => {
      const timeout = setTimeout(
        () => finalizeVerification(taskId, true),
        hmrWaitMs,
      );
      timeout.unref();
      pendingVerifications.set(taskId, {
        baseline,
        targetEvidenceRequired,
        timeout,
        resolve: resolveResult,
      });
      finalizeVerification(taskId, hmrWaitMs === 0);
    });
  };

  const checkSessionVerification = (browserSessionId: string): void => {
    for (const [taskId, pending] of pendingVerifications) {
      if (pending.baseline.browserSessionId === browserSessionId) {
        finalizeVerification(taskId, false);
      }
    }
  };

  const verifyCompletedTask = async (
    task: TaskRecord,
    baseline: BrowserVerificationBaseline | undefined,
    targetEvidenceRequired: boolean,
  ): Promise<void> => {
    const [browser, commands] = await Promise.all([
      waitForBrowserVerification(task.id, baseline, targetEvidenceRequired),
      runVerificationCommands(
        verificationCommands,
        options.project.workspaceRoot,
        verificationAbort.signal,
      ),
    ]);
    if (closed) return;

    for (const command of commands) {
      const output = command.output.trim();
      taskService.recordLog(task.id, {
        type: command.status === "passed" ? "message" : "warning",
        text: `${command.name}: ${command.status}${output.length > 0 ? `\n${output}` : ""}`,
      });
    }
    const status = combineVerificationStatus(browser, commands);
    taskService.recordVerification(task.id, status, { browser, commands });
    targetEvidenceRequirements.delete(task.id);
  };

  const unsubscribeVerification = taskService.subscribe((event) => {
    const task = taskFromPayload(event.payload);
    if (task === undefined) {
      return;
    }
    if (event.type === "task.started") {
      const baseline = sessions.baseline(task.originBrowserSessionId);
      if (baseline !== undefined) {
        verificationBaselines.set(task.id, baseline);
      }
      return;
    }
    if (
      event.type !== "task.completed"
      || task.status !== "review"
      || task.verificationStatus !== "unverified"
    ) {
      return;
    }
    const releaseWriter = taskService.holdWriter(task.id);
    const baseline = verificationBaselines.get(task.id);
    verificationBaselines.delete(task.id);
    const targetEvidenceRequired =
      targetEvidenceRequirements.get(task.id) ?? false;
    let run: Promise<void>;
    run = verifyCompletedTask(task, baseline, targetEvidenceRequired)
      .catch((error: unknown) => {
        if (!closed) {
          taskService.recordVerification(task.id, "failed", {
            browser: null,
            commands: [],
            summary:
              error instanceof Error
                ? error.message
                : "Verification failed unexpectedly",
          });
        }
      })
      .finally(() => {
        targetEvidenceRequirements.delete(task.id);
        releaseWriter();
        verificationRuns.delete(run);
      });
    verificationRuns.add(run);
  });

  const createTask = (payload: unknown) => {
    try {
      const request = parseTaskRequest(payload);
      const created = taskService.create(
        request.context,
        request.parentTaskId === undefined
          ? {}
          : { parentTaskId: request.parentTaskId },
      );
      targetEvidenceRequirements.set(
        created.id,
        request.context.selection.mode !== "page"
          && request.context.selection.targets.length > 0,
      );
      return created;
    } catch (error) {
      translateError(error);
    }
  };

  const taskAction = <T>(action: () => T): T => {
    try {
      return action();
    } catch (error) {
      translateError(error);
    }
  };

  const connectWebSocket = ({
    socket,
  }: AuthenticatedControlSocket): (() => void) => {
    const unsubscribe = taskService.subscribe((event) => send(socket, event));

    const handleMessage = (data: RawData) => {
      const message = parseClientMessage(data);
      if (message === undefined) {
        send(socket, {
          type: "command.error",
          payload: { code: "invalid_message", message: "Invalid control message" },
        });
        return;
      }

      try {
        if (message.type === "browser.hello") {
          const page = parsePageState(message.payload);
          if (page !== undefined) {
            sessions.connect(message.browserSessionId, page);
          }
          const payload = recordOf(message.payload);
          const lastSeq = Math.max(0, Math.floor(numberOf(payload?.lastSeq)));
          for (const event of taskService.replay(lastSeq)) {
            send(socket, event);
          }
          return;
        }
        if (message.type === "browser.heartbeat") {
          sessions.heartbeat(message.browserSessionId);
          const page = parsePageState(message.payload);
          if (page !== undefined) {
            sessions.updatePage(message.browserSessionId, page);
          }
          return;
        }
        if (message.type === "browser.page_state") {
          const page = parsePageState(message.payload);
          if (page !== undefined) {
            sessions.updatePage(message.browserSessionId, page);
            checkSessionVerification(message.browserSessionId);
          }
          return;
        }
        if (message.type === "verification.console_events") {
          recordConsoleEvents(sessions, message.browserSessionId, message.payload);
          checkSessionVerification(message.browserSessionId);
          return;
        }
        if (message.type === "verification.target_state") {
          const result = parseTargetResult(message.payload);
          const task =
            result === undefined ? undefined : taskService.get(result.taskId);
          if (
            result === undefined
            || task === undefined
            || task.originBrowserSessionId !== message.browserSessionId
          ) {
            return;
          }
          const stored = sessions.recordTargetResult(
            message.browserSessionId,
            result,
          );
          if (stored === undefined) {
            return;
          }
          taskService.recordLog(result.taskId, {
            type:
              result.state === "found-and-changed" ? "message" : "warning",
            text: targetResultSummary(stored),
          });
          checkSessionVerification(message.browserSessionId);
          return;
        }
        if (message.type === "task.create") {
          createTask(message.payload);
          return;
        }

        const payload = recordOf(message.payload);
        const taskId =
          typeof payload?.taskId === "string"
            ? payload.taskId
            : typeof message.payload === "string"
              ? message.payload
              : undefined;
        if (taskId === undefined) {
          throw new ControlServiceError(400, "task_id_required", "Task id is required");
        }
        if (message.type === "task.cancel") {
          taskService.cancel(taskId);
        } else if (message.type === "task.accept") {
          taskService.accept(taskId);
        } else if (message.type === "task.revert") {
          void taskService.revert(taskId).catch((error: unknown) => {
            try {
              translateError(error);
            } catch (translated) {
              send(socket, {
                type: "command.error",
                payload: {
                  code:
                    translated instanceof ControlServiceError
                      ? translated.code
                      : "revert_failed",
                  message:
                    translated instanceof Error ? translated.message : "Revert failed",
                },
              });
            }
          });
        } else if (message.type === "task.follow_up") {
          const request = parseTaskRequest(message.payload);
          const created = taskService.create(request.context, {
            parentTaskId: taskId,
          });
          targetEvidenceRequirements.set(
            created.id,
            request.context.selection.mode !== "page"
              && request.context.selection.targets.length > 0,
          );
        }
      } catch (error) {
        try {
          translateError(error);
        } catch (translated) {
          send(socket, {
            type: "command.error",
            payload: {
              code:
                translated instanceof ControlServiceError
                  ? translated.code
                  : "command_failed",
              message:
                translated instanceof Error ? translated.message : "Command failed",
            },
          });
        }
      }
    };

    socket.on("message", handleMessage);
    return () => {
      socket.off("message", handleMessage);
      unsubscribe();
    };
  };

  const connectViewerWebSocket = ({
    socket,
  }: AuthenticatedControlSocket): (() => void) => {
    let synchronized = false;
    const bufferedEvents = new Map<number, ServerEvent>();
    const unsubscribe = taskService.subscribe((event) => {
      if (synchronized) {
        send(socket, event);
        return;
      }
      bufferedEvents.set(event.seq, event);
      if (bufferedEvents.size > MAX_BUFFERED_VIEWER_EVENTS) {
        const oldestSequence = bufferedEvents.keys().next().value;
        if (typeof oldestSequence === "number") {
          bufferedEvents.delete(oldestSequence);
        }
      }
    });

    const handleMessage = (data: RawData) => {
      const message = parseClientMessage(data);
      if (message === undefined) {
        send(socket, {
          type: "command.error",
          payload: { code: "invalid_message", message: "Invalid viewer message" },
        });
        return;
      }
      if (message.type !== "browser.hello") {
        send(socket, {
          type: "command.error",
          payload: {
            code: "read_only_socket",
            message: "Viewer sessions can only receive task updates",
          },
        });
        return;
      }

      if (synchronized) {
        return;
      }

      const payload = recordOf(message.payload);
      const lastSeq =
        typeof payload?.lastSeq === "number" && Number.isFinite(payload.lastSeq)
          ? Math.max(0, Math.floor(payload.lastSeq))
          : undefined;
      const events = new Map<number, ServerEvent>();
      if (lastSeq !== undefined) {
        for (const event of taskService.replay(lastSeq)) {
          events.set(event.seq, event);
        }
      }
      for (const event of bufferedEvents.values()) {
        if (lastSeq === undefined || event.seq > lastSeq) {
          events.set(event.seq, event);
        }
      }
      bufferedEvents.clear();
      synchronized = true;
      for (const event of [...events.values()].sort((left, right) => left.seq - right.seq)) {
        send(socket, event);
      }
    };

    socket.on("message", handleMessage);
    return () => {
      socket.off("message", handleMessage);
      unsubscribe();
    };
  };

  return {
    health: () => ({
      status: "ok",
      bridge: "online",
      projectId: options.project.id,
      activeTask:
        taskService
          .list()
          .find((task) => isWorkingTaskStatus(task.status))
          ?.id ?? null,
    }),
    project: () => ({
      id: options.project.id,
      repoRoot: options.project.repoRoot,
      workspaceRoot: options.project.workspaceRoot,
      mode: options.project.mode,
      upstreamUrl: options.project.upstreamUrl,
    }),
    listTasks: (request) => taskService.list(request),
    createTask,
    getTask: (taskId) => taskService.get(taskId),
    getTaskDiff: (taskId) => taskAction(() => ({ diff: taskService.diff(taskId) })),
    getTaskFiles: (taskId) => taskAction(() => ({ files: taskService.files(taskId) })),
    getTaskLogs: (taskId) => taskAction(() => ({ logs: taskService.logs(taskId) })),
    cancelTask: (taskId) => taskAction(() => taskService.cancel(taskId)),
    acceptTask: (taskId) => taskAction(() => taskService.accept(taskId)),
    revertTask: async (taskId) => {
      try {
        return await taskService.revert(taskId);
      } catch (error) {
        translateError(error);
      }
    },
    connectWebSocket,
    connectViewerWebSocket,
    close: async () => {
      closed = true;
      unsubscribeVerification();
      verificationAbort.abort();
      targetEvidenceRequirements.clear();
      for (const taskId of pendingVerifications.keys()) {
        finalizeVerification(taskId, true);
      }
      await Promise.allSettled(verificationRuns);
      await taskService.close();
    },
  };
}
