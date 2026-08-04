import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
const payload = JSON.stringify({args:process.argv.slice(2),body});
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

function invocation(events: NormalizedAgentEvent[]): { args: string[]; body: string } {
  const message = events.find((event) => event.type === "message");
  if (message?.type !== "message") throw new Error("Missing Claude invocation");
  return JSON.parse(message.text) as { args: string[]; body: string };
}

describe("ClaudeAdapter", () => {
  it("uses stream JSON with bounded permissions for new and resumed runs", async () => {
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
      expect(run.args).toContain("--strict-mcp-config");
      expect(run.args).toContain("--no-chrome");
      expect(run.args).toContain("acceptEdits");
      expect(run.args).toContain("sonnet");
      expect(run.args).toContain("high");
      expect(run.args).not.toContain("--dangerously-skip-permissions");
      const settingsIndex = run.args.indexOf("--settings");
      expect(settingsIndex).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(run.args[settingsIndex + 1] ?? "{}")).toMatchObject({
        permissions: { disableBypassPermissionsMode: "disable" },
        sandbox: {
          enabled: true,
          allowUnsandboxedCommands: false,
        },
      });

      const resumeEvents: NormalizedAgentEvent[] = [];
      for await (const event of adapter.resume(
        { ...input(directory), sessionId: "claude-session" },
        new AbortController().signal,
      )) {
        resumeEvents.push(event);
      }
      const resumed = invocation(resumeEvents);
      expect(resumed.args).toContain("--resume");
      expect(resumed.args[resumed.args.indexOf("--resume") + 1]).toBe("claude-session");
      expect(resumed.body).toBe("edit the requested UI");
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
