import type {
  ContextBundle,
  ServerEvent,
  TaskRecord,
  TaskStatus,
} from "@visual-remote/protocol";
import type { NormalizedAgentEvent } from "../agents/types.js";

export interface StoredTask extends TaskRecord {
  agentAdapter: string;
  contextBundle: ContextBundle;
  preHead?: string;
  preIndexTree?: string;
  preRestrictedFingerprint?: string;
  diffText?: string;
}

export interface AgentLogEntry {
  id: number;
  taskId: string;
  event: NormalizedAgentEvent;
  createdAt: string;
}

export interface TaskListOptions {
  limit?: number;
  statuses?: TaskStatus[];
  cursor?: {
    createdAt: string;
    id: string;
  };
}

export interface EventReplayOptions {
  afterSeq?: number;
  limit?: number;
}

export interface TaskStore {
  createTask(task: StoredTask): void;
  updateTask(id: string, patch: Partial<StoredTask>): StoredTask;
  getTask(id: string): StoredTask | undefined;
  listTasks(options?: TaskListOptions): StoredTask[];

  appendLog(taskId: string, event: NormalizedAgentEvent, createdAt?: string): AgentLogEntry;
  listLogs(taskId: string): AgentLogEntry[];

  appendEvent<T>(
    projectId: string,
    type: string,
    payload: T,
    taskId?: string,
    createdAt?: string,
  ): ServerEvent<T>;
  replayEvents(options?: EventReplayOptions): ServerEvent[];

  close(): void;
}
