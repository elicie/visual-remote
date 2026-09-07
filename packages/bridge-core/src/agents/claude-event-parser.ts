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

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contentBlocks(record: JsonRecord): JsonRecord[] {
  const message = asRecord(record.message);
  return Array.isArray(message?.content)
    ? message.content.flatMap((block) => {
        const parsed = asRecord(block);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
}

function toolSummary(name: string, input: JsonRecord): string | undefined {
  return (
    asText(input.description) ??
    asText(input.command) ??
    asText(input.file_path) ??
    asText(input.path) ??
    (name === "Bash" ? "Run command" : undefined)
  );
}

function filePath(input: JsonRecord): string | undefined {
  return (
    asText(input.file_path) ??
    asText(input.path) ??
    asText(input.notebook_path)
  );
}

export class ClaudeEventParser {
  readonly #defaultCwd: string;
  readonly #tools = new Map<string, string>();
  #sessionId: string | undefined;

  constructor(defaultCwd = "") {
    this.#defaultCwd = defaultCwd;
  }

  parse(line: string): NormalizedAgentEvent[] {
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
    const events: NormalizedAgentEvent[] = [];
    const foundSession = asText(record.session_id) ?? asText(record.sessionId);
    if (foundSession !== undefined && foundSession !== this.#sessionId) {
      this.#sessionId = foundSession;
      events.push({ type: "session", sessionId: foundSession });
    }

    const type = asText(record.type) ?? "unknown";
    if (type === "system") {
      const subtype = asText(record.subtype);
      if (subtype === "permission_denied") {
        const toolName = asText(record.tool_name);
        events.push(toolName ? { type: "permission_denied", toolName } : { type: "permission_denied" });
        return events;
      }
      if (subtype) events.push({ type: "phase", name: subtype });
      return events;
    }

    if (type === "assistant") {
      for (const block of contentBlocks(record)) {
        if (block.type === "text") {
          const text = asText(block.text);
          if (text) events.push({ type: "message", text });
          continue;
        }
        if (block.type !== "tool_use") continue;
        const name = asText(block.name) ?? "tool";
        const id = asText(block.id);
        const input = asRecord(block.input) ?? {};
        if (id) this.#tools.set(id, name);
        const summary = toolSummary(name, input);
        events.push(
          summary
            ? { type: "tool_start", name, summary }
            : { type: "tool_start", name },
        );
        const command = name === "Bash" ? asText(input.command) : undefined;
        if (command) {
          events.push({ type: "command", command, cwd: this.#defaultCwd });
        }
        const path = filePath(input);
        if (path && ["Edit", "Write", "NotebookEdit"].includes(name)) {
          events.push({ type: "file_hint", path });
        }
      }
      return events;
    }

    if (type === "user") {
      for (const block of contentBlocks(record)) {
        if (block.type !== "tool_result") continue;
        const id = asText(block.tool_use_id);
        const name = (id ? this.#tools.get(id) : undefined) ?? "tool";
        if (id) this.#tools.delete(id);
        events.push({ type: "tool_end", name, ok: block.is_error !== true });
      }
      return events;
    }

    if (type === "result") {
      if (Array.isArray(record.permission_denials) && record.permission_denials.length > 0) {
        for (const denial of record.permission_denials) {
          const toolName = asText(asRecord(denial)?.tool_name);
          events.push(toolName ? { type: "permission_denied", toolName } : { type: "permission_denied" });
        }
        return events;
      }
      const usage = asRecord(record.usage);
      if (usage) {
        const cachedInputTokens = asNumber(usage.cache_read_input_tokens);
        events.push({
          type: "usage",
          inputTokens:
            asNumber(usage.input_tokens) +
            asNumber(usage.cache_creation_input_tokens) +
            cachedInputTokens,
          outputTokens: asNumber(usage.output_tokens),
          ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        });
      }
      const result = asText(record.result);
      const subtype = asText(record.subtype);
      if (record.is_error === true || subtype?.startsWith("error") === true) {
        events.push({ type: "error", text: result ?? "Claude reported an error" });
      } else {
        events.push(result ? { type: "complete", summary: result } : { type: "complete" });
      }
      return events;
    }

    return events;
  }
}
