import { describe, expect, it } from "vitest";

import { ClaudeEventParser } from "@visual-remote/bridge-core";

describe("ClaudeEventParser", () => {
  it("normalizes sessions, tools, messages, usage, and completion", () => {
    const parser = new ClaudeEventParser("/repo");
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-1",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "pwd", description: "Print working directory" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        session_id: "session-1",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "/repo",
              is_error: false,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        message: { content: [{ type: "text", text: "Done" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session-1",
        result: "Done",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 3,
          output_tokens: 4,
        },
      }),
    ];

    expect(lines.flatMap((line) => parser.parse(line))).toEqual([
      { type: "session", sessionId: "session-1" },
      { type: "phase", name: "init" },
      { type: "tool_start", name: "Bash", summary: "Print working directory" },
      { type: "command", command: "pwd", cwd: "/repo" },
      { type: "tool_end", name: "Bash", ok: true },
      { type: "message", text: "Done" },
      { type: "usage", inputTokens: 15, outputTokens: 4, cachedInputTokens: 3 },
      { type: "complete", summary: "Done" },
    ]);
  });

  it("reports failed results and edited files", () => {
    const parser = new ClaudeEventParser("/repo");
    expect(
      parser.parse(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "edit-1",
                name: "Edit",
                input: { file_path: "/repo/src/app.ts" },
              },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "tool_start", name: "Edit", summary: "/repo/src/app.ts" },
      { type: "file_hint", path: "/repo/src/app.ts" },
    ]);
    expect(
      parser.parse(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Tool execution failed",
        }),
      ),
    ).toEqual([{ type: "error", text: "Tool execution failed" }]);
  });
});
