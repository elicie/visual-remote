import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

export type Awaitable<T> = T | Promise<T>;

export interface AuthenticatedControlSocket {
  socket: WebSocket;
  request: IncomingMessage;
  projectId: string;
}

export interface TaskListRequest {
  limit?: number;
  cursor?: {
    createdAt: string;
    id: string;
  };
}

export interface ControlService {
  health(): Awaitable<unknown>;
  project(): Awaitable<unknown>;
  listTasks?(request?: TaskListRequest): Awaitable<unknown>;
  createTask?(payload: unknown): Awaitable<unknown>;
  openComparisonBrowser?(payload: unknown): Awaitable<unknown>;
  getTask?(taskId: string): Awaitable<unknown | undefined>;
  getTaskDiff?(taskId: string): Awaitable<unknown | undefined>;
  getTaskFiles?(taskId: string): Awaitable<unknown | undefined>;
  getTaskLogs?(taskId: string): Awaitable<unknown | undefined>;
  cancelTask?(taskId: string): Awaitable<unknown | undefined>;
  acceptTask?(taskId: string): Awaitable<unknown | undefined>;
  revertTask?(taskId: string): Awaitable<unknown | undefined>;
  getArtifact?(artifactId: string): Awaitable<ControlArtifact | undefined>;
  connectWebSocket?(
    connection: AuthenticatedControlSocket,
  ): Awaitable<void | (() => void)>;
  connectViewerWebSocket?(
    connection: AuthenticatedControlSocket,
  ): Awaitable<void | (() => void)>;
  close?(): Awaitable<void>;
}

export interface ControlArtifact {
  body: Buffer | string;
  contentType: string;
  fileName?: string;
}

export class ControlServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ControlServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface BasicControlServiceOptions {
  project: unknown;
  health?: () => Awaitable<unknown>;
}

export function createBasicControlService(
  options: BasicControlServiceOptions,
): ControlService {
  return {
    health: options.health ?? (() => ({ status: "ok" })),
    project: () => options.project,
    listTasks: () => [],
  };
}
