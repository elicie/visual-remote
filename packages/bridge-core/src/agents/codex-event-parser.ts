import type { NormalizedAgentEvent } from "./types.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionId(record: JsonRecord): string | undefined {
  const thread = asRecord(record.thread);
  return (
    asText(record.thread_id) ??
    asText(record.threadId) ??
    asText(record.session_id) ??
    asText(record.sessionId) ??
    (thread ? asText(thread.id) : undefined)
  );
}

function itemFiles(item: JsonRecord): string[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const files = changes.flatMap((change) => {
    const record = asRecord(change);
    if (!record) return [];
    return [asText(record.path) ?? asText(record.file_path) ?? asText(record.filePath)].filter(
      (path): path is string => path !== undefined,
    );
  });
  const direct = asText(item.path) ?? asText(item.file_path) ?? asText(item.filePath);
  if (direct) files.push(direct);
  return [...new Set(files)];
}

export function parseCodexJsonLine(line: string): NormalizedAgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return [{ type: "warning", text: trimmed }];
  }

  const record = asRecord(value);
  if (!record) return [{ type: "message", text: trimmed }];
  const type = asText(record.type) ?? "unknown";
  const events: NormalizedAgentEvent[] = [];
  const foundSession = sessionId(record);
  if (foundSession) events.push({ type: "session", sessionId: foundSession });

  if (type === "thread.started" || type === "thread.created") return events;
  if (type === "turn.started") return [...events, { type: "phase", name: "turn.started" }];
  if (type === "turn.completed") {
    const result = asRecord(record.result);
    const summary = asText(record.summary) ?? (result ? asText(result.summary) : undefined);
    return [...events, summary ? { type: "complete", summary } : { type: "complete" }];
  }
  if (type === "turn.failed" || type === "error") {
    const error = asRecord(record.error);
    const text =
      asText(record.message) ??
      (error ? asText(error.message) : undefined) ??
      "Codex reported an error";
    return [...events, { type: "error", text }];
  }

  const item = asRecord(record.item);
  if (type === "item.started" && item) {
    const itemType = asText(item.type) ?? "item";
    const summary = asText(item.command) ?? asText(item.text);
    const start: NormalizedAgentEvent = summary
      ? { type: "tool_start", name: itemType, summary }
      : { type: "tool_start", name: itemType };
    return [...events, start];
  }

  if (type === "item.completed" && item) {
    const itemType = asText(item.type) ?? "item";
    if (itemType === "agent_message") {
      const text = asText(item.text) ?? asText(item.message);
      return text ? [...events, { type: "message", text }] : events;
    }
    if (itemType === "command_execution") {
      const command = asText(item.command);
      if (command) {
        events.push({
          type: "command",
          command,
          cwd: asText(item.cwd) ?? "",
        });
      }
    }
    for (const path of itemFiles(item)) events.push({ type: "file_hint", path });
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
    events.push({ type: "tool_end", name: itemType, ok: exitCode === undefined || exitCode === 0 });
    return events;
  }

  const message = asText(record.message);
  if (message) events.push({ type: "message", text: message });
  return events;
}
