import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type {
  ContextBundle,
  ServerEvent,
  TaskRecord,
} from "@visual-remote/protocol";
import type { NormalizedAgentEvent } from "../agents/types.js";
import type {
  AgentLogEntry,
  EventReplayOptions,
  StoredTask,
  TaskListOptions,
  TaskStore,
} from "./types.js";

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;
type NodeSqliteModule = typeof import("node:sqlite");

const requireNodeBuiltin = createRequire(import.meta.url);

const optional = <T>(value: T | null): T | undefined => value ?? undefined;

function parseJson<T>(value: SqlValue | undefined, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(row: Row): StoredTask {
  const errorCode = optional(row.error_code as string | null);
  const errorMessage = optional(row.error_message as string | null);
  const record: StoredTask = {
    id: String(row.id),
    projectId: String(row.project_id),
    status: String(row.status) as TaskRecord["status"],
    requestText: String(row.request_text),
    scope: String(row.scope) as TaskRecord["scope"],
    originBrowserSessionId: String(row.origin_browser_session_id),
    agentAdapter: String(row.agent_adapter),
    contextBundle: parseJson<ContextBundle>(row.context_json, {} as ContextBundle),
    changedFiles: parseJson<string[]>(row.changed_files_json, []),
    createdAt: String(row.created_at),
  };

  const parentTaskId = optional(row.parent_task_id as string | null);
  const agentSessionId = optional(row.agent_session_id as string | null);
  const preHead = optional(row.pre_head as string | null);
  const preIndexTree = optional(row.pre_index_tree as string | null);
  const preRestrictedFingerprint = optional(
    row.pre_restricted_fingerprint as string | null,
  );
  const beforeRef = optional(row.before_ref as string | null);
  const afterRef = optional(row.after_ref as string | null);
  const verificationStatus = optional(row.verification_status as string | null);
  const diffText = optional(row.diff_text as string | null);
  const startedAt = optional(row.started_at as string | null);
  const completedAt = optional(row.completed_at as string | null);

  if (parentTaskId) record.parentTaskId = parentTaskId;
  if (agentSessionId) record.agentSessionId = agentSessionId;
  if (preHead !== undefined) record.preHead = preHead;
  if (preIndexTree !== undefined) record.preIndexTree = preIndexTree;
  if (preRestrictedFingerprint !== undefined) {
    record.preRestrictedFingerprint = preRestrictedFingerprint;
  }
  if (beforeRef) record.beforeRef = beforeRef;
  if (afterRef) record.afterRef = afterRef;
  if (verificationStatus) {
    record.verificationStatus = verificationStatus as NonNullable<TaskRecord["verificationStatus"]>;
  }
  const comparison = parseJson<TaskRecord["comparison"]>(row.comparison_json, undefined);
  if (comparison) record.comparison = comparison;
  if (diffText !== undefined) record.diffText = diffText;
  if (errorCode || errorMessage) {
    record.error = {
      code: errorCode ?? "UNKNOWN",
      message: errorMessage ?? "Unknown task error",
    };
  }
  if (startedAt) record.startedAt = startedAt;
  if (completedAt) record.completedAt = completedAt;
  return record;
}

function taskParams(task: StoredTask): Record<string, SqlValue> {
  return {
    id: task.id,
    project_id: task.projectId,
    status: task.status,
    request_text: task.requestText,
    scope: task.scope,
    origin_browser_session_id: task.originBrowserSessionId,
    parent_task_id: task.parentTaskId ?? null,
    agent_adapter: task.agentAdapter,
    agent_session_id: task.agentSessionId ?? null,
    pre_head: task.preHead ?? null,
    pre_index_tree: task.preIndexTree ?? null,
    pre_restricted_fingerprint: task.preRestrictedFingerprint ?? null,
    before_ref: task.beforeRef ?? null,
    after_ref: task.afterRef ?? null,
    changed_files_json: JSON.stringify(task.changedFiles),
    verification_status: task.verificationStatus ?? null,
    comparison_json: task.comparison ? JSON.stringify(task.comparison) : null,
    error_code: task.error?.code ?? null,
    error_message: task.error?.message ?? null,
    context_json: JSON.stringify(task.contextBundle),
    diff_text: task.diffText ?? null,
    created_at: task.createdAt,
    started_at: task.startedAt ?? null,
    completed_at: task.completedAt ?? null,
  };
}

export class SqliteTaskStore implements TaskStore {
  readonly #db: DatabaseSyncType;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = requireNodeBuiltin("node:sqlite") as NodeSqliteModule;
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        request_text TEXT NOT NULL,
        scope TEXT NOT NULL,
        origin_browser_session_id TEXT NOT NULL,
        parent_task_id TEXT,
        agent_adapter TEXT NOT NULL,
        agent_session_id TEXT,
        pre_head TEXT,
        pre_index_tree TEXT,
        pre_restricted_fingerprint TEXT,
        before_ref TEXT,
        after_ref TEXT,
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        verification_status TEXT,
        error_code TEXT,
        error_message TEXT,
        context_json TEXT NOT NULL,
        diff_text TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);

      CREATE TABLE IF NOT EXISTS task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_logs_task_idx ON task_logs(task_id, id);

      CREATE TABLE IF NOT EXISTS task_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        task_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const taskColumns = this.#db.prepare("PRAGMA table_info(tasks)").all() as Row[];
    if (!taskColumns.some((column) => String(column.name) === "comparison_json")) {
      this.#db.exec("ALTER TABLE tasks ADD COLUMN comparison_json TEXT");
    }
    if (
      !taskColumns.some(
        (column) => String(column.name) === "pre_restricted_fingerprint",
      )
    ) {
      this.#db.exec(
        "ALTER TABLE tasks ADD COLUMN pre_restricted_fingerprint TEXT",
      );
    }
  }

  createTask(task: StoredTask): void {
    const params = taskParams(task);
    this.#db
      .prepare(`
        INSERT INTO tasks (
          id, project_id, status, request_text, scope, origin_browser_session_id,
          parent_task_id, agent_adapter, agent_session_id, pre_head, pre_index_tree,
          pre_restricted_fingerprint, before_ref, after_ref, changed_files_json,
          verification_status, error_code, error_message, context_json, diff_text,
          comparison_json,
          created_at, started_at, completed_at
        ) VALUES (
          $id, $project_id, $status, $request_text, $scope, $origin_browser_session_id,
          $parent_task_id, $agent_adapter, $agent_session_id, $pre_head, $pre_index_tree,
          $pre_restricted_fingerprint, $before_ref, $after_ref, $changed_files_json,
          $verification_status, $error_code, $error_message, $context_json, $diff_text,
          $comparison_json,
          $created_at, $started_at, $completed_at
        )
      `)
      .run(params);
  }

  updateTask(id: string, patch: Partial<StoredTask>): StoredTask {
    const current = this.getTask(id);
    if (!current) throw new Error(`Unknown task: ${id}`);
    const next: StoredTask = { ...current, ...patch, id: current.id };
    const params = taskParams(next);
    this.#db
      .prepare(`
        UPDATE tasks SET
          project_id = $project_id,
          status = $status,
          request_text = $request_text,
          scope = $scope,
          origin_browser_session_id = $origin_browser_session_id,
          parent_task_id = $parent_task_id,
          agent_adapter = $agent_adapter,
          agent_session_id = $agent_session_id,
          pre_head = $pre_head,
          pre_index_tree = $pre_index_tree,
          pre_restricted_fingerprint = $pre_restricted_fingerprint,
          before_ref = $before_ref,
          after_ref = $after_ref,
          changed_files_json = $changed_files_json,
          verification_status = $verification_status,
          comparison_json = $comparison_json,
          error_code = $error_code,
          error_message = $error_message,
          context_json = $context_json,
          diff_text = $diff_text,
          created_at = $created_at,
          started_at = $started_at,
          completed_at = $completed_at
        WHERE id = $id
      `)
      .run(params);
    return next;
  }

  getTask(id: string): StoredTask | undefined {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listTasks(options: TaskListOptions = {}): StoredTask[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      conditions.push(`status IN (${placeholders})`);
      parameters.push(...options.statuses);
    }
    if (options.cursor) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(
        options.cursor.createdAt,
        options.cursor.createdAt,
        options.cursor.id,
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...parameters, limit) as Row[];
    return rows.map(rowToTask);
  }

  appendLog(
    taskId: string,
    event: NormalizedAgentEvent,
    createdAt = new Date().toISOString(),
  ): AgentLogEntry {
    const result = this.#db
      .prepare("INSERT INTO task_logs (task_id, event_json, created_at) VALUES (?, ?, ?)")
      .run(taskId, JSON.stringify(event), createdAt);
    return { id: Number(result.lastInsertRowid), taskId, event, createdAt };
  }

  listLogs(taskId: string): AgentLogEntry[] {
    const rows = this.#db
      .prepare("SELECT id, task_id, event_json, created_at FROM task_logs WHERE task_id = ? ORDER BY id")
      .all(taskId) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      event: parseJson<NormalizedAgentEvent>(row.event_json, {
        type: "warning",
        text: "Unreadable persisted agent event",
      }),
      createdAt: String(row.created_at),
    }));
  }

  appendEvent<T>(
    projectId: string,
    type: string,
    payload: T,
    taskId?: string,
    createdAt = new Date().toISOString(),
  ): ServerEvent<T> {
    const result = this.#db
      .prepare(`
        INSERT INTO task_events (project_id, task_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(projectId, taskId ?? null, type, JSON.stringify(payload), createdAt);
    const event: ServerEvent<T> = {
      seq: Number(result.lastInsertRowid),
      type,
      projectId,
      payload,
      createdAt,
    };
    if (taskId) event.taskId = taskId;
    return event;
  }

  replayEvents(options: EventReplayOptions = {}): ServerEvent[] {
    const afterSeq = Math.max(0, options.afterSeq ?? 0);
    const limit = Math.max(1, Math.min(options.limit ?? 1_000, 1_000));
    const rows = this.#db
      .prepare(`
        SELECT seq, project_id, task_id, event_type, payload_json, created_at
        FROM task_events
        WHERE seq > ?
        ORDER BY seq
        LIMIT ?
      `)
      .all(afterSeq, limit) as Row[];
    return rows.map((row) => {
      const event: ServerEvent = {
        seq: Number(row.seq),
        type: String(row.event_type),
        projectId: String(row.project_id),
        payload: parseJson<unknown>(row.payload_json, null),
        createdAt: String(row.created_at),
      };
      const taskId = optional(row.task_id as string | null);
      if (taskId) event.taskId = taskId;
      return event;
    });
  }

  close(): void {
    this.#db.close();
  }
}
