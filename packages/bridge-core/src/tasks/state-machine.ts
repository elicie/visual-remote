import type { TaskStatus } from "@visual-remote/protocol";

const ACTIVE_FLOW: TaskStatus[] = [
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

const TERMINAL = new Set<TaskStatus>(["accepted", "reverted", "failed", "canceled", "unsafe"]);

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return status !== "queued" && status !== "review" && !TERMINAL.has(status);
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  if (to === "failed" || to === "canceled" || to === "unsafe") {
    return from !== "accepted" && from !== "reverted";
  }
  if (to === "accepted") return from === "review" || from === "failed" || from === "canceled";
  if (to === "reverted") {
    return from === "review" || from === "accepted" || from === "failed" || from === "canceled";
  }
  const fromIndex = ACTIVE_FLOW.indexOf(from);
  const toIndex = ACTIVE_FLOW.indexOf(to);
  return fromIndex >= 0 && toIndex === fromIndex + 1;
}

export function assertTaskStatusTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTaskStatus(from, to)) {
    throw new Error(`Invalid task status transition: ${from} -> ${to}`);
  }
}
