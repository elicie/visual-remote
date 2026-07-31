/** Shared browser/server wire schemas and inferred types. */
import { z } from "zod";

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export type Rect = z.infer<typeof rectSchema>;

export const sourceLocationSchema = z.object({
  filePath: z.string().min(1),
  lineNumber: z.number().int().positive().optional(),
  columnNumber: z.number().int().positive().optional(),
  componentName: z.string().min(1).optional(),
});

export type SourceLocation = z.infer<typeof sourceLocationSchema>;

const locatorCandidateSchema = z.object({
  type: z.enum(["testid", "id", "role", "css", "text", "dom-path"]),
  value: z.string(),
  confidence: z.number().min(0).max(1),
});

export const targetContextSchema = z.object({
  targetId: z.string().min(1),
  order: z.number().int().nonnegative(),
  dom: z.object({
    tagName: z.string(),
    id: z.string().optional(),
    classNames: z.array(z.string()).max(100),
    text: z.string().max(500).optional(),
    role: z.string().optional(),
    accessibleName: z.string().optional(),
    attributes: z.record(z.string(), z.string()),
    rect: rectSchema,
    locatorCandidates: z.array(locatorCandidateSchema),
    parentPath: z.array(
      z.object({
        tagName: z.string(),
        id: z.string().optional(),
        classNames: z.array(z.string()).max(20),
        siblingIndex: z.number().int().nonnegative().optional(),
      }),
    ),
  }),
  styles: z.record(z.string(), z.string()),
  source: z.object({
    primary: sourceLocationSchema.optional(),
    stack: z.array(sourceLocationSchema).max(8),
    confidence: z.enum(["exact", "probable", "ambiguous", "unknown"]),
  }),
});

export type TargetContext = z.infer<typeof targetContextSchema>;

const selectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("element"), targets: z.array(targetContextSchema).min(1).max(1) }),
  z.object({ mode: z.literal("multi"), targets: z.array(targetContextSchema).min(1).max(8) }),
  z.object({
    mode: z.literal("region"),
    region: rectSchema,
    targets: z.array(targetContextSchema).max(20),
  }),
  z.object({ mode: z.literal("page"), targets: z.array(targetContextSchema).max(20) }),
]);

export const contextBundleSchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  browserSessionId: z.string().uuid(),
  page: z.object({
    url: z.string().url(),
    pathname: z.string(),
    title: z.string(),
    viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
    devicePixelRatio: z.number().positive(),
    scroll: z.object({ x: z.number(), y: z.number() }),
    renderRevision: z.number().int().nonnegative(),
  }),
  selection: selectionSchema,
  request: z.object({
    text: z.string().trim().min(1).max(10_000),
    scope: z.enum(["instance", "page", "component", "project"]),
  }),
});

export type ContextBundle = z.infer<typeof contextBundleSchema>;

export const taskStatusSchema = z.enum([
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

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const clientMessageSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "auth",
    "browser.hello",
    "browser.heartbeat",
    "browser.page_state",
    "verification.console_events",
    "verification.target_state",
    "task.create",
    "task.cancel",
    "task.accept",
    "task.revert",
    "task.follow_up",
  ]),
  browserSessionId: z.string().uuid(),
  payload: z.unknown(),
});

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface ServerEvent<T = unknown> {
  seq: number;
  type: string;
  projectId: string;
  taskId?: string;
  payload: T;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  status: TaskStatus;
  requestText: string;
  scope: ContextBundle["request"]["scope"];
  originBrowserSessionId: string;
  parentTaskId?: string;
  agentSessionId?: string;
  beforeRef?: string;
  afterRef?: string;
  changedFiles: string[];
  verificationStatus?: "passed" | "partial" | "unverified" | "failed";
  error?: { code: string; message: string };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
