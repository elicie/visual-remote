import { parseCodexJsonLine } from "@visual-remote/bridge-core";
import { describe, expect, it } from "vitest";

describe("parseCodexJsonLine", () => {
  it("extracts a thread id without depending on unrelated fields", () => {
    expect(
      parseCodexJsonLine(JSON.stringify({ type: "thread.started", thread_id: "thread-123" })),
    ).toEqual([{ type: "session", sessionId: "thread-123" }]);
  });

  it("normalizes messages, command completions, and malformed lines", () => {
    expect(
      parseCodexJsonLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Done" },
        }),
      ),
    ).toEqual([{ type: "message", text: "Done" }]);
    expect(
      parseCodexJsonLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "npm test", cwd: "/repo", exit_code: 0 },
        }),
      ),
    ).toEqual([
      { type: "command", command: "npm test", cwd: "/repo" },
      { type: "tool_end", name: "command_execution", ok: true },
    ]);
    expect(parseCodexJsonLine("not json")).toEqual([{ type: "warning", text: "not json" }]);
  });
});
