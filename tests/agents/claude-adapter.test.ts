import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeAdapter,
  AgentPermissionDeniedError,
  type AgentRunInput,
  type NormalizedAgentEvent,
} from "@visual-remote/bridge-core";

async function executable(directory: string): Promise<string> {
  const path = resolve(directory, "fake-claude.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
let body = "";
for await (const chunk of process.stdin) body += chunk;
const payload = JSON.stringify({
  args: process.argv.slice(2), body, cwd: process.cwd(),
  environment: Object.fromEntries([
    "HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
    "HTTPS_PROXY", "VISUAL_MCP_TOKEN", "VISUAL_UNRELATED_SECRET"
  ].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]))
});
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-session"}));
console.log(JSON.stringify({
  type:"assistant",
  session_id:"claude-session",
  message:{content:[{type:"text",text:payload}]}
}));
console.log(JSON.stringify({
  type:"result",
  subtype:"success",
  session_id:"claude-session",
  result:"complete",
  usage:{input_tokens:1,output_tokens:1}
}));
`,
  );
  await chmod(path, 0o755);
  return path;
}

function input(root: string): AgentRunInput {
  return {
    taskId: "claude-adapter-test",
    repoRoot: root,
    workspaceRoot: root,
    prompt: "edit the requested UI",
    contextBundlePath: resolve(root, "context.json"),
    environment: {},
    maxRunMs: 5_000,
  };
}

interface Invocation {
  args: string[];
  body: string;
  cwd: string;
  environment: Record<string, string>;
}

function invocation(events: NormalizedAgentEvent[]): Invocation {
  const message = events.find((event) => event.type === "message");
  if (message?.type !== "message") throw new Error("Missing Claude invocation");
  return JSON.parse(message.text) as Invocation;
}

describe("ClaudeAdapter", () => {
  beforeEach(() => {
    for (const name of [
      "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
      "HTTPS_PROXY", "VISUAL_MCP_TOKEN", "VISUAL_UNRELATED_SECRET",
    ]) vi.stubEnv(name, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([[false, false], [true, false], [false, true], [true, true]])("preserves fresh/resume configuration with artifact access %s and approval %s", async (withArtifacts, approved) => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-claude-test-"));
    const artifactDirectory = resolve(`${directory} artifacts`, "task-test");
    const runInput = {
      ...input(directory),
      ...(withArtifacts ? { artifactDirectory } : {}),
      ...(approved ? { allowedTools: ["mcp__figma__download", "mcp__figma__get_node"] } : {}),
    };
    try {
      const adapter = new ClaudeAdapter({
        executable: await executable(directory),
        model: "sonnet",
        reasoningEffort: "high",
        rtkExecutable: false,
      });

      const runEvents: NormalizedAgentEvent[] = [];
      for await (const event of adapter.run(
        runInput,
        new AbortController().signal,
      )) {
        runEvents.push(event);
      }
      const run = invocation(runEvents);
      expect(run.body).toBe("edit the requested UI");
      expect(run.cwd).toBe(directory);
      expect(run.args).toEqual([
        "-p", "--output-format", "stream-json", "--verbose",
        ...(withArtifacts ? ["--add-dir", artifactDirectory] : []),
        ...(approved ? ["--allowedTools", "mcp__figma__download,mcp__figma__get_node"] : []),
        "--model", "sonnet", "--effort", "high", "--permission-mode", "bypassPermissions",
      ]);

      const resumeEvents: NormalizedAgentEvent[] = [];
      for await (const event of adapter.resume(
        { ...runInput, sessionId: "claude-session" },
        new AbortController().signal,
      )) {
        resumeEvents.push(event);
      }
      const resumed = invocation(resumeEvents);
      expect(resumed.args).toEqual([...run.args, "--resume", "claude-session"]);
      expect(resumed.body).toBe("edit the requested UI");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it.each(["default", "acceptEdits", "bypassPermissions"] as const)("passes permissionMode %s to fresh and resumed runs and defaults to bypassPermissions", async (permissionMode) => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-claude-test-"));
    try {
      const exe = await executable(directory);
      const events = async (adapter: ClaudeAdapter, resume = false) => {
        const collected: NormalizedAgentEvent[] = [];
        const source = resume
          ? adapter.resume({ ...input(directory), sessionId: "claude-session" }, new AbortController().signal)
          : adapter.run(input(directory), new AbortController().signal);
        for await (const event of source) collected.push(event);
        return invocation(collected).args;
      };

      const scoped = new ClaudeAdapter({ executable: exe, rtkExecutable: false, permissionMode });
      expect(await events(scoped)).toEqual([
        "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permissionMode,
      ]);
      expect(await events(scoped, true)).toEqual([
        "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permissionMode,
        "--resume", "claude-session",
      ]);

      const unscoped = new ClaudeAdapter({ executable: exe, rtkExecutable: false });
      expect(await events(unscoped)).toEqual([
        "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
      ]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it.each(["Bash", "mcp__figma__*", "mcp__figma__download:all", "mcp__figma__download,Edit", "mcp__figma__download Edit", "mcp__figma__download\n", "--dangerously-skip-permissions", ""])(
    "rejects unscoped allowed tool %j before starting fresh or resumed runs", async (name) => {
      const adapter = new ClaudeAdapter({ executable: "must-not-start", rtkExecutable: false });
      const runInput = { ...input(tmpdir()), allowedTools: [name] };
      const signal = new AbortController().signal;
      for (const events of [adapter.run(runInput, signal), adapter.resume({ ...runInput, sessionId: "claude-session" }, signal)]) {
        await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow("Allowed tools must be exact MCP tool names");
      }
    },
  );

  it.each(["system", "result", "unknown"])("terminates a continuing %s denial and throws its permission error", async (kind) => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-claude-denial-"));
    const tool = "mcp__figma__download";
    const denial = kind === "result"
      ? { type: "result", subtype: "success", permission_denials: [{ tool_name: tool, tool_input: { token: "secret" } }, { tool_name: "mcp__figma__get_node" }] }
      : { type: "system", subtype: "permission_denied", ...(kind === "system" ? { tool_name: tool } : {}), message: "secret" };
    try {
      const path = resolve(directory, "denied.mjs");
      await writeFile(path, `#!/usr/bin/env node\nfor await (const chunk of process.stdin) {}\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(denial)}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "must not continue" }] } })}\n`)});\nsetInterval(() => {}, 1000);\n`);
      await chmod(path, 0o755);
      const adapter = new ClaudeAdapter({ executable: path, rtkExecutable: false, killGraceMs: 20 });
      const events: NormalizedAgentEvent[] = [];
      let failure: unknown;
      try {
        for await (const event of adapter.run(input(directory), new AbortController().signal)) events.push(event);
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AgentPermissionDeniedError);
      expect(failure).toMatchObject({ code: "AGENT_PERMISSION_DENIED", tools: kind === "unknown" ? [] : kind === "result" ? [tool, "mcp__figma__get_node"] : [tool] });
      expect(events).toEqual(kind === "unknown" ? [{ type: "permission_denied" }] : kind === "result" ? [{ type: "permission_denied", toolName: tool }, { type: "permission_denied", toolName: "mcp__figma__get_node" }] : [{ type: "permission_denied", toolName: tool }]);
      expect(JSON.stringify(events)).not.toContain("secret");
    } finally { await rm(directory, { recursive: true }); }
  });

  it.each(["", "relative/artifacts", parse(tmpdir()).root, `${parse(tmpdir()).root}tmp/..`])(
    "rejects unsafe artifact directory %j before starting fresh or resumed runs",
    async (artifactDirectory) => {
      const adapter = new ClaudeAdapter({ executable: "must-not-start", rtkExecutable: false });
      const runInput = { ...input(tmpdir()), artifactDirectory };
      const signal = new AbortController().signal;
      for (const events of [
        adapter.run(runInput, signal),
        adapter.resume({ ...runInput, sessionId: "claude-session" }, signal),
      ]) {
        await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow(
          "Artifact directory must be an absolute non-root path",
        );
      }
    },
  );

  it("inherits config, authentication and proxy settings without copying unrelated secrets", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-claude-env-test-"));
    vi.stubEnv("HOME", directory);
    vi.stubEnv("CLAUDE_CONFIG_DIR", resolve(directory, "custom-config"));
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-oauth-token");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:8080");
    vi.stubEnv("VISUAL_MCP_TOKEN", "parent-mcp-token");
    vi.stubEnv("VISUAL_UNRELATED_SECRET", "must-not-be-inherited");
    try {
      const adapter = new ClaudeAdapter({
        executable: await executable(directory),
        rtkExecutable: false,
      });
      const environments: Record<string, string>[] = [
        {},
        { VISUAL_MCP_TOKEN: "explicit-mcp-token" },
      ];
      for (const environment of environments) {
        const events: NormalizedAgentEvent[] = [];
        for await (const event of adapter.run(
          { ...input(directory), environment },
          new AbortController().signal,
        )) {
          events.push(event);
        }
        const run = invocation(events);
        expect(run.args).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"]);
        expect(run.environment).toEqual({
          HOME: directory,
          CLAUDE_CONFIG_DIR: resolve(directory, "custom-config"),
          ANTHROPIC_API_KEY: "test-anthropic-key",
          CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
          HTTPS_PROXY: "http://proxy.example.test:8080",
          ...environment,
        });
        expect(run.body).toBe(input(directory).prompt);
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
