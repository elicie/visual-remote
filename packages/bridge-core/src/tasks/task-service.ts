import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  AgentCanceledError,
  AgentProcessError,
  AgentTimeoutError,
  type AgentAdapter,
  type AgentResumeInput,
  type AgentRunInput,
  type NormalizedAgentEvent,
} from "../agents/index.js";
import { resolveContextSources } from "../context/resolve-sources.js";
import { runDesignComparison, getComparisonArtifact } from "../comparison/engine.js";
import { resolveStoragePaths } from "../storage/paths.js";
import {
  GitTransactionManager,
  RepositorySafetyError,
  type GuardVerification,
  type RepositoryGuard,
} from "../git/index.js";
import {
  contextBundleSchema,
  normalizeComparisonRequest,
  type CaptureResult,
  type ComparisonCaptureRequest,
  type ComparisonState,
  type ContextBundle,
  type ServerEvent,
  type SourceLocation,
  type TaskRecord,
  type TaskStatus,
} from "@visual-remote/protocol";
import { redactSecrets, redactSecretValues } from "../context/sanitize.js";
import type {
  AgentLogEntry,
  EventReplayOptions,
  StoredTask,
  TaskListOptions,
  TaskStore,
} from "../storage/index.js";
import { buildAgentPrompt } from "./prompt.js";
import {
  assertTaskStatusTransition,
  isActiveTaskStatus,
  isTerminalTaskStatus,
} from "./state-machine.js";

export interface TaskServiceOptions {
  projectId: string;
  workspaceRoot?: string;
  upstreamUrl?: string;
  adapter: AgentAdapter;
  store: TaskStore;
  git: GitTransactionManager;
  maxRunMs?: number;
  maxPending?: number;
  resumeMode?: "auto" | "new";
  environment?: Record<string, string>;
  comparisonRoot?: string;
  captureComparison?: (taskId: string, context: ContextBundle, dimensions: { width: number; height: number }, signal: AbortSignal) => Promise<CaptureResult>;
  idFactory?: () => string;
  now?: () => Date;
}

export interface CreateTaskOptions {
  parentTaskId?: string;
}

export type TaskEventListener = (event: ServerEvent) => void;

export class TaskServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskServiceError";
    this.code = code;
  }
}

function publicTask(task: StoredTask): TaskRecord {
  const result: TaskRecord = {
    id: task.id,
    projectId: task.projectId,
    status: task.status,
    requestText: task.requestText,
    scope: task.scope,
    originBrowserSessionId: task.originBrowserSessionId,
    changedFiles: [...task.changedFiles],
    createdAt: task.createdAt,
  };
  if (task.parentTaskId) result.parentTaskId = task.parentTaskId;
  if (task.agentSessionId) result.agentSessionId = task.agentSessionId;
  if (task.beforeRef) result.beforeRef = task.beforeRef;
  if (task.afterRef) result.afterRef = task.afterRef;
  if (task.verificationStatus) result.verificationStatus = task.verificationStatus;
  if (task.comparison) result.comparison = structuredClone(task.comparison);
  if (task.error) result.error = { ...task.error };
  if (task.startedAt) result.startedAt = task.startedAt;
  if (task.completedAt) result.completedAt = task.completedAt;
  return result;
}

function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof TaskServiceError || error instanceof RepositorySafetyError) {
    return { code: error.code, message: redactSecrets(error.message) };
  }
  if (error instanceof AgentTimeoutError) {
    return { code: "AGENT_TIMEOUT", message: redactSecrets(error.message) };
  }
  if (error instanceof AgentCanceledError) {
    return { code: "AGENT_CANCELED", message: redactSecrets(error.message) };
  }
  if (error instanceof AgentProcessError) {
    return { code: "AGENT_FAILED", message: redactSecrets(error.message) };
  }
  if (error instanceof Error) {
    return { code: "TASK_FAILED", message: redactSecrets(error.message) };
  }
  return { code: "TASK_FAILED", message: redactSecrets(String(error)) };
}

function isWithin(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate === "" ||
    (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !candidate.startsWith("/"))
  );
}

function repositoryGuardMessage(result: GuardVerification): string {
  const reasons = [
    result.headChanged ? "HEAD 변경" : "",
    result.indexChanged ? "Git index 변경" : "",
  ].filter(Boolean);
  if (result.restrictedPathsChanged) {
    if (result.restrictedPaths.length === 0) {
      reasons.push("제한 경로 변경");
    } else {
      const maximum = 20;
      const paths = result.restrictedPaths
        .slice(0, maximum)
        .map((path) => JSON.stringify(path))
        .join(", ");
      const remaining = result.restrictedPaths.length - maximum;
      reasons.push(
        `제한 경로 변경: ${paths}${remaining > 0 ? ` 외 ${remaining}개` : ""}`,
      );
    }
  }
  return reasons.join(", ");
}

export class TaskService {
  readonly #projectId: string;
  readonly #workspaceRoot: string;
  readonly #upstreamUrl: string | undefined;
  readonly #adapter: AgentAdapter;
  readonly #store: TaskStore;
  readonly #git: GitTransactionManager;
  readonly #maxRunMs: number;
  readonly #maxPending: number;
  readonly #resumeMode: "auto" | "new";
  readonly #environment: Record<string, string>;
  readonly #idFactory: () => string;
  readonly #now: () => Date;
  readonly #queue: string[] = [];
  readonly #recoveryQueue: string[] = [];
  readonly #listeners = new Set<TaskEventListener>();
  readonly #cancelRequested = new Set<string>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #writerHolds = new Map<
    string,
    { promise: Promise<void>; release: () => void }
  >();
  #activeTaskId: string | undefined;
  #activeAbort: AbortController | undefined;
  #recovering = false;
  #draining = false;
  #closed = false;
  readonly #comparisonRoot: string | undefined;
  #captureComparison: TaskServiceOptions["captureComparison"];

  constructor(options: TaskServiceOptions) {
    this.#projectId = options.projectId;
    this.#workspaceRoot = resolve(options.workspaceRoot ?? options.git.repoRoot);
    this.#upstreamUrl = options.upstreamUrl;
    if (!isWithin(options.git.repoRoot, this.#workspaceRoot)) {
      throw new TaskServiceError(
        "WORKSPACE_OUTSIDE_REPOSITORY",
        `Workspace is outside repository: ${this.#workspaceRoot}`,
      );
    }
    this.#adapter = options.adapter;
    this.#store = options.store;
    this.#git = options.git;
    this.#maxRunMs = options.maxRunMs ?? 15 * 60_000;
    this.#maxPending = options.maxPending ?? 20;
    this.#resumeMode = options.resumeMode ?? "auto";
    if (!Number.isInteger(this.#maxPending) || this.#maxPending < 1) {
      throw new TaskServiceError("INVALID_QUEUE_LIMIT", "maxPending must be a positive integer");
    }
    this.#environment = { ...(options.environment ?? {}) };
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#comparisonRoot = options.comparisonRoot === undefined ? undefined : resolve(options.comparisonRoot);
    this.#captureComparison = options.captureComparison;
    this.#recoverPersistedTasks();
  }

  create(contextInput: ContextBundle, options: CreateTaskOptions = {}): TaskRecord {
    if (this.#closed) throw new TaskServiceError("SERVICE_CLOSED", "Task service is closed");
    if (this.#queue.length >= this.#maxPending) {
      throw new TaskServiceError(
        "QUEUE_FULL",
        `Task queue is full (${this.#maxPending} pending tasks)`,
      );
    }
    const context = contextBundleSchema.parse(contextInput);
    try {
      const inherited = options.parentTaskId ? this.#store.getTask(options.parentTaskId)?.contextBundle.request.comparison : undefined;
      const comparison = normalizeComparisonRequest(context.request.text, context.request.comparison ?? inherited);
      if (comparison) context.request.comparison = comparison;
    } catch (error) {
      throw new TaskServiceError("INVALID_COMPARISON", error instanceof Error ? error.message : "Invalid Figma comparison request");
    }
    if (context.projectId !== this.#projectId) {
      throw new TaskServiceError(
        "PROJECT_MISMATCH",
        `Expected project ${this.#projectId}, received ${context.projectId}`,
      );
    }
    if (options.parentTaskId && !this.#store.getTask(options.parentTaskId)) {
      throw new TaskServiceError("UNKNOWN_PARENT_TASK", `Unknown parent task: ${options.parentTaskId}`);
    }
    const createdAt = this.#now().toISOString();
    const task: StoredTask = {
      id: this.#idFactory(),
      projectId: this.#projectId,
      status: "queued",
      requestText: context.request.text,
      scope: context.request.scope,
      originBrowserSessionId: context.browserSessionId,
      agentAdapter: this.#adapter.id,
      contextBundle: context,
      changedFiles: [],
      createdAt,
    };
    if (context.request.comparison?.enabled) task.comparison = {
      status: "preparing", url: context.request.comparison.url!, iteration: 0,
      maxIterations: context.request.comparison.maxIterations, iterations: [],
      threshold: context.request.comparison.threshold, targetMatch: context.request.comparison.targetMatch,
    };
    if (options.parentTaskId) task.parentTaskId = options.parentTaskId;
    this.#store.createTask(task);
    this.#queue.push(task.id);
    this.#emit("task.queued", { task: publicTask(task) }, task.id);
    void this.#drain();
    return publicTask(task);
  }

  setComparisonCaptureHandler(handler: TaskServiceOptions["captureComparison"]): void {
    this.#captureComparison = handler;
  }

  requestComparisonCapture(request: ComparisonCaptureRequest): void {
    this.#requireTask(request.taskId);
    this.#emit("comparison.capture_requested", request, request.taskId);
  }

  async getArtifact(artifactId: string) {
    return getComparisonArtifact(await this.#resolveComparisonRoot(), artifactId);
  }

  async #resolveComparisonRoot(): Promise<string> {
    const root = this.#comparisonRoot ?? resolve((await resolveStoragePaths(this.#git.repoRoot)).logsDirectory, "..", "comparisons");
    try {
      return await realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return root;
    }
  }

  #recordComparison(taskId: string, comparison: ComparisonState): void {
    const task = this.#store.updateTask(taskId, { comparison });
    this.#emit("task.comparison_updated", { task: publicTask(task) }, taskId);
  }

  get(id: string): TaskRecord | undefined {
    const task = this.#store.getTask(id);
    return task ? publicTask(task) : undefined;
  }

  list(options: TaskListOptions = {}): TaskRecord[] {
    return this.#store.listTasks(options).map(publicTask);
  }

  diff(id: string): string {
    return this.#requireTask(id).diffText ?? "";
  }

  files(id: string): string[] {
    return [...this.#requireTask(id).changedFiles];
  }

  logs(id: string): AgentLogEntry[] {
    this.#requireTask(id);
    return this.#store.listLogs(id);
  }

  recordLog(id: string, event: NormalizedAgentEvent): void {
    this.#requireTask(id);
    this.#recordAgentEvent(id, event);
  }

  holdWriter(id: string): () => void {
    this.#requireTask(id);
    const existing = this.#writerHolds.get(id);
    if (existing !== undefined) {
      return existing.release;
    }
    let released = false;
    let resolveHold: (() => void) | undefined;
    const promise = new Promise<void>((resolveWait) => {
      resolveHold = resolveWait;
    });
    const release = (): void => {
      if (released) return;
      released = true;
      this.#writerHolds.delete(id);
      resolveHold?.();
    };
    this.#writerHolds.set(id, { promise, release });
    return release;
  }

  recordVerification(
    id: string,
    status: NonNullable<TaskRecord["verificationStatus"]>,
    details?: unknown,
  ): TaskRecord {
    const task = this.#requireTask(id);
    if (!task.afterRef) {
      throw new TaskServiceError(
        "TASK_NOT_VERIFIABLE",
        `Task has no completed snapshot: ${id}`,
      );
    }
    const updated = this.#store.updateTask(id, { verificationStatus: status });
    this.#emit(
      "task.verification_result",
      {
        task: publicTask(updated),
        status,
        ...(details === undefined ? {} : { details }),
      },
      id,
    );
    this.#writerHolds.get(id)?.release();
    return publicTask(updated);
  }

  replay(afterSeq = 0, limit = 1_000): ServerEvent[] {
    const options: EventReplayOptions = { afterSeq, limit };
    return this.#store.replayEvents(options);
  }

  subscribe(listener: TaskEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  cancel(id: string): TaskRecord {
    const task = this.#requireTask(id);
    if (isTerminalTaskStatus(task.status) || task.status === "review") return publicTask(task);
    this.#cancelRequested.add(id);
    if (task.comparison) this.#recordComparison(id, { ...task.comparison, status: "canceled", message: "Task was canceled" });
    if (task.status === "queued") {
      const index = this.#queue.indexOf(id);
      if (index >= 0) this.#queue.splice(index, 1);
      const canceled = this.#transition(id, "canceled", {
        completedAt: this.#now().toISOString(),
        error: { code: "TASK_CANCELED", message: "Task canceled before it started" },
      });
      this.#emit("task.canceled", { task: publicTask(canceled) }, id);
      this.#resolveIdleIfNeeded();
      return publicTask(canceled);
    }
    if (this.#activeTaskId === id) this.#activeAbort?.abort(new AgentCanceledError());
    return publicTask(this.#requireTask(id));
  }

  accept(id: string): TaskRecord {
    const task = this.#requireTask(id);
    if (task.status === "accepted") return publicTask(task);
    if (task.status === "unsafe" || !task.afterRef) {
      throw new TaskServiceError("TASK_NOT_ACCEPTABLE", `Task cannot be accepted: ${task.status}`);
    }
    const accepted = this.#transition(id, "accepted");
    this.#emit("task.completed", { task: publicTask(accepted) }, id);
    return publicTask(accepted);
  }

  async revert(id: string): Promise<TaskRecord> {
    if (this.#closed) throw new TaskServiceError("SERVICE_CLOSED", "Task service is closed");
    if (
      this.#activeTaskId ||
      this.#recovering ||
      this.#recoveryQueue.length > 0
    ) {
      throw new TaskServiceError(
        "WRITER_BUSY",
        "Cannot revert while task recovery or another writer is active",
      );
    }
    const task = this.#requireTask(id);
    if (task.status === "reverted") return publicTask(task);
    if (task.status === "unsafe" || !task.beforeRef || !task.afterRef) {
      throw new TaskServiceError("TASK_NOT_REVERTIBLE", `Task cannot be reverted: ${task.status}`);
    }
    const latest = this.#latestRevertibleTask();
    if (!latest || latest.id !== id) {
      throw new TaskServiceError("NOT_LATEST_TASK", "Only the latest completed task can be reverted");
    }
    this.#activeTaskId = id;
    try {
      await this.#git.revert(id, task.beforeRef, task.afterRef);
      const reverted = this.#transition(id, "reverted", {
        completedAt: this.#now().toISOString(),
      });
      this.#emit("task.reverted", { task: publicTask(reverted) }, id);
      return publicTask(reverted);
    } finally {
      this.#activeTaskId = undefined;
      if (!this.#closed) void this.#drain();
      this.#resolveIdleIfNeeded();
    }
  }

  async waitForIdle(): Promise<void> {
    if (
      !this.#activeTaskId &&
      this.#queue.length === 0 &&
      this.#recoveryQueue.length === 0 &&
      !this.#recovering &&
      !this.#draining
    ) {
      return;
    }
    await new Promise<void>((resolveWait) => this.#idleWaiters.add(resolveWait));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeTaskId && this.#activeAbort) {
      this.#cancelRequested.add(this.#activeTaskId);
      this.#activeAbort?.abort(new AgentCanceledError("Task service is closing"));
    }
    for (const taskId of [...this.#queue]) this.cancel(taskId);
    for (const hold of this.#writerHolds.values()) hold.release();
    await this.waitForIdle();
    this.#store.close();
  }

  #recoverPersistedTasks(): void {
    const persisted = this.#store.listTasks({ limit: 1_000 });
    for (const task of persisted) {
      if (task.status === "queued") this.#queue.unshift(task.id);
      else if (isActiveTaskStatus(task.status)) {
        if (task.comparison) this.#recordComparison(task.id, { ...task.comparison, status: "blocked", message: "Bridge interrupted comparison; start a new task to compare again." });
        if (task.beforeRef) {
          this.#recoveryQueue.unshift(task.id);
        } else {
          const failed = this.#store.updateTask(task.id, {
            status: "failed",
            completedAt: this.#now().toISOString(),
            error: {
              code: "BRIDGE_INTERRUPTED",
              message: "Bridge stopped before a recoverable snapshot was created",
            },
          });
          this.#emit(
            "task.failed",
            { task: publicTask(failed), error: failed.error },
            task.id,
          );
        }
      }
    }
    if (this.#recoveryQueue.length > 0) {
      queueMicrotask(() => void this.#recoverInterruptedTasks());
    } else if (this.#queue.length > 0) {
      queueMicrotask(() => void this.#drain());
    }
  }

  async #recoverInterruptedTasks(): Promise<void> {
    if (this.#recovering) return;
    this.#recovering = true;
    try {
      while (this.#recoveryQueue.length > 0) {
        const taskId = this.#recoveryQueue.shift();
        if (!taskId) break;
        this.#activeTaskId = taskId;
        try {
          await this.#finalizeInterruptedTask(taskId);
        } finally {
          this.#activeTaskId = undefined;
        }
      }
    } finally {
      this.#recovering = false;
      if (!this.#closed) void this.#drain();
      this.#resolveIdleIfNeeded();
    }
  }

  async #finalizeInterruptedTask(taskId: string): Promise<void> {
    try {
      const task = this.#requireTask(taskId);
      if (!task.beforeRef) {
        throw new Error("Interrupted task is missing its before snapshot");
      }

      let afterRef = task.afterRef;
      if (!afterRef) {
        afterRef = (await this.#git.createSnapshot(taskId, "after")).ref;
        this.#store.updateTask(taskId, { afterRef });
      }
      // diff validates persisted refs without replacing the completed snapshot.
      const diff = await this.#git.diff(task.beforeRef, afterRef);
      this.#store.updateTask(taskId, {
        diffText: diff.text,
        changedFiles: diff.files,
      });
      this.#emit("task.diff_ready", { changedFiles: diff.files }, taskId);

      if (
        task.preHead === undefined ||
        task.preIndexTree === undefined ||
        task.preRestrictedFingerprint === undefined
      ) {
        const unsafe = this.#transition(taskId, "unsafe", {
          completedAt: this.#now().toISOString(),
          error: {
            code: "RECOVERY_GUARD_INCOMPLETE",
            message: "Stored repository guard is incomplete",
          },
        });
        this.#emit(
          "task.failed",
          { task: publicTask(unsafe), error: unsafe.error },
          taskId,
        );
        return;
      }

      const guardResult = await this.#git.verifyGuard({
        head: task.preHead,
        indexTree: task.preIndexTree,
        restrictedFingerprint: task.preRestrictedFingerprint,
        statusPorcelainV2: "",
      });
      if (!guardResult.safe) {
        const unsafe = this.#transition(taskId, "unsafe", {
          completedAt: this.#now().toISOString(),
          error: {
            code: "REPOSITORY_STATE_CHANGED",
            message: repositoryGuardMessage(guardResult),
          },
        });
        this.#emit(
          "task.failed",
          { task: publicTask(unsafe), error: unsafe.error },
          taskId,
        );
        return;
      }

      const failed = this.#transition(taskId, "failed", {
        completedAt: this.#now().toISOString(),
        error: {
          code: "BRIDGE_INTERRUPTED",
          message:
            "Bridge stopped while this task was active; recovered changes are available for review",
        },
      });
      this.#emit(
        "task.failed",
        { task: publicTask(failed), error: failed.error },
        taskId,
      );
    } catch (error) {
      const info = errorInfo(error);
      const unsafe = this.#store.updateTask(taskId, {
        status: "unsafe",
        completedAt: this.#now().toISOString(),
        error: {
          code: "RECOVERY_FINALIZATION_FAILED",
          message: info.message,
        },
      });
      this.#emit(
        "task.failed",
        { task: publicTask(unsafe), error: unsafe.error },
        taskId,
      );
    }
  }

  async #drain(): Promise<void> {
    if (
      this.#draining ||
      this.#activeTaskId ||
      this.#closed ||
      this.#recovering ||
      this.#recoveryQueue.length > 0
    ) {
      return;
    }
    this.#draining = true;
    try {
      while (!this.#closed) {
        const taskId = this.#queue.shift();
        if (!taskId) break;
        const task = this.#store.getTask(taskId);
        if (!task || task.status !== "queued") continue;
        this.#activeTaskId = taskId;
        this.#activeAbort = new AbortController();
        try {
          await this.#execute(taskId, this.#activeAbort);
          await this.#writerHolds.get(taskId)?.promise;
        } finally {
          this.#activeTaskId = undefined;
          this.#activeAbort = undefined;
          this.#cancelRequested.delete(taskId);
        }
      }
    } finally {
      this.#draining = false;
      this.#resolveIdleIfNeeded();
    }
  }

  async #execute(taskId: string, controller: AbortController): Promise<void> {
    let guard: RepositoryGuard | undefined;
    let contextPath: string | undefined;
    let failure: unknown;
    let timedOut = false;
    const deadline = Date.now() + this.#maxRunMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new AgentTimeoutError());
    }, this.#maxRunMs);
    timeout.unref();

    try {
      const preparing = this.#transition(taskId, "preparing", {
        startedAt: this.#now().toISOString(),
      });
      this.#emit("task.started", { task: publicTask(preparing) }, taskId);
      guard = await this.#git.captureGuard();
      this.#throwIfCanceled(taskId);

      this.#transition(taskId, "snapshotting_before");
      const before = await this.#git.createSnapshot(taskId, "before");
      this.#store.updateTask(taskId, {
        beforeRef: before.ref,
        preHead: guard.head,
        preIndexTree: guard.indexTree,
        preRestrictedFingerprint: guard.restrictedFingerprint,
      });
      this.#throwIfCanceled(taskId);

      this.#transition(taskId, "resolving_context");
      const context = await this.#sanitizeContext(this.#requireTask(taskId).contextBundle);
      contextPath = await this.#writeContextBundle(taskId, context);
      const parent = this.#parentPromptContext(this.#requireTask(taskId));
      const prompt = buildAgentPrompt({
        repoRoot: this.#git.repoRoot,
        workspaceRoot: this.#workspaceRoot,
        ...(this.#upstreamUrl === undefined ? {} : { upstreamUrl: this.#upstreamUrl }),
        contextBundlePath: contextPath,
        context,
        allowedPatterns: this.#git.pathPolicy.allowedPatterns,
        deniedPatterns: this.#git.pathPolicy.deniedPatterns,
        ...(parent ? { parent } : {}),
      });
      this.#throwIfCanceled(taskId);

      this.#transition(taskId, "running_agent");
      const input: AgentRunInput = {
        taskId,
        repoRoot: this.#git.repoRoot,
        workspaceRoot: this.#workspaceRoot,
        prompt,
        contextBundlePath: contextPath,
        environment: { ...this.#environment },
        maxRunMs: this.#maxRunMs,
      };
      const task = this.#requireTask(taskId);
      const parentTask = task.parentTaskId ? this.#store.getTask(task.parentTaskId) : undefined;
      let sessionId = this.#resumeMode === "auto" ? parentTask?.agentSessionId : undefined;
      const runAgent = async (agentPrompt: string): Promise<void> => {
        controller.signal.throwIfAborted();
        const runInput = { ...input, prompt: agentPrompt, maxRunMs: Math.max(1, deadline - Date.now()) };
        const stream = sessionId && this.#adapter.resume
          ? this.#adapter.resume({ ...runInput, sessionId } satisfies AgentResumeInput, controller.signal)
          : this.#adapter.run(runInput, controller.signal);
        for await (const event of stream) this.#recordAgentEvent(taskId, event);
        sessionId = this.#requireTask(taskId).agentSessionId;
        controller.signal.throwIfAborted();
      };
      if (context.request.comparison?.enabled) {
        let root = await this.#resolveComparisonRoot();
        await mkdir(root, { recursive: true, mode: 0o700 });
        root = await realpath(root);
        input.artifactDirectory = resolve(root, taskId);
        let preparation = true;
        const result = await runDesignComparison({
          taskId, context, root, signal: controller.signal,
          runAgent: async (instruction) => {
            const exception = `The only additional writable directory outside the repository is ${resolve(root, taskId)}, exclusively for comparison reference/evidence files. Never write elsewhere outside the repository.`;
            const combined = preparation ? `${instruction}\n\n${exception}\nThis is reference preparation only. Do not edit application/repository files.` : `${prompt}\n\n${exception}\n\n${instruction}`;
            preparation = false;
            await runAgent(combined);
          },
          capture: async (dimensions) => {
            if (!this.#captureComparison) throw new Error("Comparison capture unavailable. Connect the originating browser and explicitly share the current tab.");
            return this.#captureComparison(taskId, context, dimensions, controller.signal);
          },
          onState: (state) => this.#recordComparison(taskId, state),
        });
        controller.signal.throwIfAborted();
        this.#recordComparison(taskId, result);
        if (result.status === "blocked" || result.status === "canceled") throw new TaskServiceError("COMPARISON_BLOCKED", result.message ?? "Comparison could not finish");
      } else {
        await runAgent(prompt);
      }
      this.#throwIfCanceled(taskId);
    } catch (error) {
      failure = timedOut ? new AgentTimeoutError() : error;
      const normalized = errorInfo(failure);
      const comparison = this.#requireTask(taskId).comparison;
      if (comparison) this.#recordComparison(taskId, { ...comparison, status: this.#cancelRequested.has(taskId) ? "canceled" : "blocked", message: normalized.message });
      this.#recordAgentEvent(taskId, { type: "error", text: normalized.message });
    } finally {
      clearTimeout(timeout);
      if (contextPath) await rm(contextPath, { force: true }).catch(() => undefined);
    }

    try {
      const current = this.#requireTask(taskId);
      if (!current.beforeRef) throw failure ?? new Error("Before snapshot was not created");
      this.#forceFlowStatus(taskId, "snapshotting_after");
      const after = await this.#git.createSnapshot(taskId, "after");
      this.#store.updateTask(taskId, { afterRef: after.ref });
      this.#forceFlowStatus(taskId, "diffing");
      const diff = await this.#git.diff(current.beforeRef, after.ref);
      const updated = this.#store.updateTask(taskId, {
        diffText: diff.text,
        changedFiles: diff.files,
      });
      this.#emit("task.diff_ready", { changedFiles: diff.files }, taskId);

      const guardResult = guard ? await this.#git.verifyGuard(guard) : undefined;
      if (guardResult && !guardResult.safe) {
        const unsafe = this.#transition(taskId, "unsafe", {
          completedAt: this.#now().toISOString(),
          error: {
            code: "REPOSITORY_STATE_CHANGED",
            message: repositoryGuardMessage(guardResult),
          },
        });
        this.#emit("task.failed", { task: publicTask(unsafe), error: unsafe.error }, taskId);
      } else if (this.#cancelRequested.has(taskId) || failure instanceof AgentCanceledError) {
        const canceled = this.#transition(taskId, "canceled", {
          completedAt: this.#now().toISOString(),
          error: { code: "TASK_CANCELED", message: "Task was canceled" },
        });
        this.#emit("task.canceled", { task: publicTask(canceled) }, taskId);
      } else if (failure) {
        const info = errorInfo(failure);
        const failed = this.#transition(taskId, "failed", {
          completedAt: this.#now().toISOString(),
          error: info,
        });
        this.#emit("task.failed", { task: publicTask(failed), error: info }, taskId);
      } else {
        const review = this.#forceFlowStatus(taskId, "review", {
          completedAt: this.#now().toISOString(),
          verificationStatus: "unverified",
        });
        this.#emit("task.completed", { task: publicTask(review) }, taskId);
      }
      void updated;
    } catch (postError) {
      const info = errorInfo(postError);
      const current = this.#requireTask(taskId);
      if (current.comparison) this.#recordComparison(taskId, { ...current.comparison, status: this.#cancelRequested.has(taskId) ? "canceled" : "blocked", message: info.message });
      if (current.status !== "unsafe") {
        const canceled =
          this.#cancelRequested.has(taskId) ||
          failure instanceof AgentCanceledError ||
          postError instanceof AgentCanceledError;
        const finalTask = this.#store.updateTask(taskId, {
          status: canceled ? "canceled" : "failed",
          completedAt: this.#now().toISOString(),
          error: canceled
            ? { code: "TASK_CANCELED", message: "Task was canceled" }
            : info,
        });
        this.#emit(
          canceled ? "task.canceled" : "task.failed",
          canceled
            ? { task: publicTask(finalTask) }
            : { task: publicTask(finalTask), error: info },
          taskId,
        );
      }
    }
  }

  #transition(
    taskId: string,
    status: TaskStatus,
    patch: Partial<StoredTask> = {},
  ): StoredTask {
    const current = this.#requireTask(taskId);
    assertTaskStatusTransition(current.status, status);
    if ((status === "unsafe" || status === "failed" || status === "canceled") && current.comparison) {
      this.#recordComparison(taskId, { ...current.comparison, status: status === "canceled" ? "canceled" : "blocked", message: patch.error?.message ?? "Task did not finish safely" });
    }
    const next = this.#store.updateTask(taskId, { ...patch, status });
    this.#emit("task.phase_changed", { task: publicTask(next), status }, taskId);
    return next;
  }

  #forceFlowStatus(
    taskId: string,
    target: TaskStatus,
    patch: Partial<StoredTask> = {},
  ): StoredTask {
    const current = this.#requireTask(taskId);
    const flow: TaskStatus[] = [
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
    ];
    const currentIndex = flow.indexOf(current.status);
    const targetIndex = flow.indexOf(target);
    if (currentIndex < 0 || targetIndex < currentIndex) {
      return this.#store.updateTask(taskId, { ...patch, status: target });
    }
    let result = current;
    for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
      const status = flow[index];
      if (!status) continue;
      result = this.#transition(taskId, status, index === targetIndex ? patch : {});
    }
    if (currentIndex === targetIndex && Object.keys(patch).length > 0) {
      result = this.#store.updateTask(taskId, patch);
    }
    return result;
  }

  #recordAgentEvent(taskId: string, event: NormalizedAgentEvent): void {
    const sanitized = redactSecretValues(event);
    this.#store.appendLog(taskId, sanitized, this.#now().toISOString());
    if (sanitized.type === "session") {
      this.#store.updateTask(taskId, { agentSessionId: sanitized.sessionId });
    }
    this.#emit("task.agent_output", { event: sanitized }, taskId);
  }

  #emit<T>(type: string, payload: T, taskId?: string): ServerEvent<T> {
    const sanitizedPayload = redactSecretValues(payload);
    const event = this.#store.appendEvent(
      this.#projectId,
      type,
      sanitizedPayload,
      taskId,
      this.#now().toISOString(),
    );
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected client must not interrupt the writer queue.
      }
    }
    return event;
  }

  #requireTask(id: string): StoredTask {
    const task = this.#store.getTask(id);
    if (!task) throw new TaskServiceError("TASK_NOT_FOUND", `Unknown task: ${id}`);
    return task;
  }

  #throwIfCanceled(taskId: string): void {
    if (this.#cancelRequested.has(taskId)) throw new AgentCanceledError();
  }

  #latestRevertibleTask(): StoredTask | undefined {
    const latest = this.#store
      .listTasks({ limit: 1_000 })
      .filter(
        (task) =>
          Boolean(task.beforeRef && task.afterRef) &&
          task.status !== "queued" &&
          !isActiveTaskStatus(task.status),
      )
      .sort((left, right) =>
        (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt),
      )[0];
    return latest && latest.status !== "reverted" && latest.status !== "unsafe"
      ? latest
      : undefined;
  }

  #parentPromptContext(task: StoredTask):
    | { taskId: string; requestText: string; diffSummary: string }
    | undefined {
    if (!task.parentTaskId) return undefined;
    const parent = this.#store.getTask(task.parentTaskId);
    if (!parent) return undefined;
    return {
      taskId: parent.id,
      requestText: parent.requestText,
      diffSummary: parent.changedFiles.join(", "),
    };
  }

  async #sanitizeContext(context: ContextBundle): Promise<ContextBundle> {
    const result = await resolveContextSources(
      structuredClone(context),
      this.#git.repoRoot,
    );
    for (const target of result.selection.targets) {
      const sanitize = async (location: SourceLocation): Promise<SourceLocation | undefined> => {
        try {
          const filePath = await this.#git.pathPolicy.assertFilesystemPathAllowed(
            location.filePath,
            false,
          );
          return { ...location, filePath };
        } catch {
          return undefined;
        }
      };
      const primary = target.source.primary
        ? await sanitize(target.source.primary)
        : undefined;
      const stack = (
        await Promise.all(target.source.stack.map(async (source) => await sanitize(source)))
      ).filter((source): source is SourceLocation => source !== undefined);
      if (primary) target.source.primary = primary;
      else delete target.source.primary;
      target.source.stack = stack;
      if (!primary && stack.length === 0) target.source.confidence = "unknown";
    }
    return result;
  }

  async #writeContextBundle(taskId: string, context: ContextBundle): Promise<string> {
    const directory = resolve(this.#git.repository.gitDir, "visual-bridge", "contexts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const resolvedDirectory = await realpath(directory);
    if (!isWithin(this.#git.repository.gitDir, resolvedDirectory)) {
      throw new TaskServiceError("CONTEXT_PATH_UNSAFE", "Context directory escaped the Git dir");
    }
    const path = resolve(resolvedDirectory, `${taskId}.json`);
    await writeFile(path, JSON.stringify(context, null, 2), { mode: 0o600 });
    return path;
  }

  #resolveIdleIfNeeded(): void {
    if (
      this.#activeTaskId ||
      this.#queue.length > 0 ||
      this.#recoveryQueue.length > 0 ||
      this.#recovering ||
      this.#draining
    ) {
      return;
    }
    for (const resolveWait of this.#idleWaiters) resolveWait();
    this.#idleWaiters.clear();
  }
}
