import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AgentCanceledError,
  CodexAdapter,
  type AgentRunInput,
  type NormalizedAgentEvent,
} from "@visual-remote/bridge-core";

async function executable(directory: string, source: string): Promise<string> {
  const path = resolve(directory, "fake-codex.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${source}`);
  await chmod(path, 0o755);
  return path;
}

function input(root: string, environment: Record<string, string> = {}): AgentRunInput {
  return {
    taskId: "adapter-test",
    repoRoot: root,
    workspaceRoot: root,
    prompt: "edit the requested UI",
    contextBundlePath: resolve(root, "context.json"),
    environment,
    maxRunMs: 5_000,
  };
}

describe("CodexAdapter", () => {
  it("uses the pinned safe exec shape and feeds the prompt on stdin", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-codex-test-"));
    const initialExitListeners = process.listenerCount("exit");
    try {
      const command = await executable(
        directory,
        `
let body = "";
for await (const chunk of process.stdin) body += chunk;
console.log(JSON.stringify({type:"thread.started",thread_id:"thread-test"}));
console.log(JSON.stringify({
  type:"item.completed",
  item:{type:"agent_message",text:JSON.stringify({args:process.argv.slice(2),body})}
}));
`,
      );
      const adapter = new CodexAdapter({ executable: command });
      const events: NormalizedAgentEvent[] = [];
      for await (const event of adapter.run(input(directory), new AbortController().signal)) {
        events.push(event);
      }
      expect(events[0]).toEqual({ type: "session", sessionId: "thread-test" });
      const message = events.find((event) => event.type === "message");
      expect(message?.type).toBe("message");
      if (message?.type !== "message") throw new Error("Missing agent message");
      const record = JSON.parse(message.text) as { args: string[]; body: string };
      expect(record.args).toEqual([
        "exec",
        "--json",
        "--color",
        "never",
        "-s",
        "workspace-write",
        "-C",
        directory,
        "-",
      ]);
      expect(record.body).toBe("edit the requested UI");
      expect(record.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");

      const resumed: NormalizedAgentEvent[] = [];
      for await (const event of adapter.resume(
        { ...input(directory), sessionId: "thread-test" },
        new AbortController().signal,
      )) {
        resumed.push(event);
      }
      const resumedMessage = resumed.find((event) => event.type === "message");
      if (resumedMessage?.type !== "message") throw new Error("Missing resumed agent message");
      const resumedRecord = JSON.parse(resumedMessage.text) as { args: string[]; body: string };
      expect(resumedRecord.args).toEqual([
        "exec",
        "--json",
        "--color",
        "never",
        "-s",
        "workspace-write",
        "-C",
        directory,
        "resume",
        "thread-test",
        "-",
      ]);
      expect(resumedRecord.body).toBe("edit the requested UI");
      expect(process.listenerCount("exit")).toBe(initialExitListeners);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "terminates stubborn descendants in the agent process group on cancellation",
    async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "visual-codex-cancel-test-"));
      const marker = resolve(directory, "descendant-signaled");
      const readyMarker = resolve(directory, "descendant-ready");
      const groupMarker = resolve(directory, "process-group");
      try {
        const command = await executable(
          directory,
          `
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
writeFileSync(process.env.GROUP_MARKER, String(process.pid));
const code = \`
  const fs = require("node:fs");
  fs.writeFileSync(process.env.READY_MARKER, "ready");
  process.on("SIGTERM", () => {
    fs.writeFileSync(process.env.CANCEL_MARKER, "term-received");
  });
  setInterval(() => {}, 1000);
\`;
spawn(process.execPath, ["-e", code], {env: process.env, stdio:"ignore"});
const ready = setInterval(() => {
  if (!existsSync(process.env.READY_MARKER)) return;
  clearInterval(ready);
  console.log(JSON.stringify({type:"thread.started",thread_id:"cancel-test"}));
}, 10);
setInterval(() => {}, 1000);
`,
        );
        const adapter = new CodexAdapter({ executable: command, killGraceMs: 100 });
        const controller = new AbortController();
        const consume = async (): Promise<void> => {
          for await (const event of adapter.run(
            input(directory, {
              CANCEL_MARKER: marker,
              READY_MARKER: readyMarker,
              GROUP_MARKER: groupMarker,
            }),
            controller.signal,
          )) {
            if (event.type === "session") controller.abort();
          }
        };
        await expect(consume()).rejects.toBeInstanceOf(AgentCanceledError);
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          try {
            await stat(marker);
            break;
          } catch {
            await new Promise((resolveWait) => setTimeout(resolveWait, 20));
          }
        }
        await expect(readFile(marker, "utf8")).resolves.toBe("term-received");
        const processGroupId = Number(await readFile(groupMarker, "utf8"));
        expect(() => process.kill(-processGroupId, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        try {
          const processGroupId = Number(await readFile(groupMarker, "utf8"));
          if (Number.isSafeInteger(processGroupId) && processGroupId > 1) {
            process.kill(-processGroupId, "SIGKILL");
          }
        } catch {
          // The adapter already terminated the group, which is the expected path.
        }
        await rm(directory, { recursive: true });
      }
    },
  );
});
