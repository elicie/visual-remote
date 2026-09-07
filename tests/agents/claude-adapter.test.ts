import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeAdapter,
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

  it("preserves Claude configuration and permissions for new and resumed stream runs", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-claude-test-"));
    try {
      const adapter = new ClaudeAdapter({
        executable: await executable(directory),
        model: "sonnet",
        reasoningEffort: "high",
        rtkExecutable: false,
      });

      const runEvents: NormalizedAgentEvent[] = [];
      for await (const event of adapter.run(
        input(directory),
        new AbortController().signal,
      )) {
        runEvents.push(event);
      }
      const run = invocation(runEvents);
      expect(run.body).toBe("edit the requested UI");
      expect(run.cwd).toBe(directory);
      expect(run.args).toEqual([
        "-p", "--output-format", "stream-json", "--verbose",
        "--model", "sonnet", "--effort", "high",
      ]);

      const resumeEvents: NormalizedAgentEvent[] = [];
      for await (const event of adapter.resume(
        { ...input(directory), sessionId: "claude-session" },
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
        expect(run.args).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
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
