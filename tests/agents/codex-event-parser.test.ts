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
    expect(
      parseCodexJsonLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "rtk git status", exit_code: 0 },
        }),
        "/repo/worktree",
      ),
    ).toEqual([
      { type: "command", command: "rtk git status", cwd: "/repo/worktree" },
      { type: "tool_end", name: "command_execution", ok: true },
    ]);
    expect(parseCodexJsonLine("not json")).toEqual([{ type: "warning", text: "not json" }]);
  });

  it("normalizes direct MCP batches as shell-free command events", () => {
    const item = {
      type: "mcp_tool_call",
      server: "visual_remote_exec",
      tool: "run_readonly",
      arguments: {
        commands: [
          { argv: ["pwd"] },
          { argv: ["git", "status", "--short"] },
        ],
      },
    };
    expect(
      parseCodexJsonLine(JSON.stringify({ type: "item.started", item })),
    ).toEqual([
      {
        type: "tool_start",
        name: "direct_exec",
        summary: "pwd · git status --short",
      },
    ]);
    expect(
      parseCodexJsonLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            ...item,
            status: "completed",
            result: {
              structured_content: {
                results: [
                  {
                    argv: ["pwd"],
                    cwd: "/repo",
                    exitCode: 0,
                    durationMs: 2,
                    usedRtk: false,
                  },
                  {
                    argv: ["rtk", "git", "status", "--short"],
                    cwd: "/repo",
                    exitCode: 0,
                    durationMs: 4,
                    usedRtk: true,
                    truncated: true,
                  },
                ],
              },
            },
          },
        }),
      ),
    ).toEqual([
      {
        type: "command",
        command: "pwd",
        cwd: "/repo",
        exitCode: 0,
        durationMs: 2,
        usedRtk: false,
      },
      {
        type: "command",
        command: "rtk git status --short",
        cwd: "/repo",
        exitCode: 0,
        durationMs: 4,
        usedRtk: true,
        truncated: true,
      },
      { type: "tool_end", name: "direct_exec", ok: true },
    ]);
  });

  it("normalizes Codex token usage when the completed turn reports it", () => {
    expect(
      parseCodexJsonLine(
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 12_000,
            cached_input_tokens: 9_000,
            output_tokens: 450,
          },
        }),
      ),
    ).toEqual([
      {
        type: "usage",
        inputTokens: 12_000,
        cachedInputTokens: 9_000,
        outputTokens: 450,
      },
      { type: "complete" },
    ]);
  });
});
