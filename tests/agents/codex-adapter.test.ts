import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse, resolve } from "node:path";
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

function input(
  root: string,
  environment: Record<string, string> = {},
  workspaceRoot = root,
): AgentRunInput {
  return {
    taskId: "adapter-test",
    repoRoot: root,
    workspaceRoot,
    prompt: "edit the requested UI",
    contextBundlePath: resolve(root, "context.json"),
    environment,
    maxRunMs: 5_000,
  };
}

describe("CodexAdapter", () => {
  it.each([false, true])("uses safe fresh/resume argv with artifact access %s", async (withArtifacts) => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-codex-test-"));
    const initialExitListeners = process.listenerCount("exit");
    const artifactDirectory = resolve(`${directory} artifacts`, "task-test");
    const runInput = {
      ...input(directory),
      ...(withArtifacts ? { artifactDirectory } : {}),
    };
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
      const adapter = new CodexAdapter({
        executable: command,
        rtkExecutable: false,
        directExecMcpScript: false,
      });
      const events: NormalizedAgentEvent[] = [];
      for await (const event of adapter.run(runInput, new AbortController().signal)) {
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
        ...(withArtifacts ? ["--add-dir", artifactDirectory] : []),
        "-",
      ]);
      expect(record.body).toBe("edit the requested UI");
      expect(record.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");

      const resumed: NormalizedAgentEvent[] = [];
      for await (const event of adapter.resume(
        { ...runInput, sessionId: "thread-test" },
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
        ...(withArtifacts ? ["--add-dir", artifactDirectory] : []),
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

  it.each(["", "relative/artifacts", parse(tmpdir()).root, `${parse(tmpdir()).root}tmp/..`])(
    "rejects unsafe artifact directory %j before starting fresh or resumed runs",
    async (artifactDirectory) => {
      const adapter = new CodexAdapter({ executable: "must-not-start", rtkExecutable: false });
      const runInput = { ...input(tmpdir()), artifactDirectory };
      const signal = new AbortController().signal;
      for (const events of [
        adapter.run(runInput, signal),
        adapter.resume({ ...runInput, sessionId: "thread-test" }, signal),
      ]) {
        await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow(
          "Artifact directory must be an absolute non-root path",
        );
      }
    },
  );

  it("registers the bounded direct-exec MCP server for each Codex run", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-codex-direct-test-"));
    try {
      const workspace = resolve(directory, "apps", "web");
      await mkdir(workspace, { recursive: true });
      const command = await executable(
        directory,
        `
let body = "";
for await (const chunk of process.stdin) body += chunk;
console.log(JSON.stringify({
  type:"item.completed",
  item:{type:"agent_message",text:JSON.stringify({args:process.argv.slice(2),body,cwd:process.cwd()})}
}));
`,
      );
      const mcpScript = resolve(directory, "direct-exec-mcp.js");
      const adapter = new CodexAdapter({
        executable: command,
        rtkExecutable: false,
        directExecMcpScript: mcpScript,
      });
      const events: NormalizedAgentEvent[] = [];
      for await (const event of adapter.run(
        input(directory, {}, workspace),
        new AbortController().signal,
      )) {
        events.push(event);
      }
      const message = events.find((event) => event.type === "message");
      if (message?.type !== "message") throw new Error("Missing direct-exec prompt message");
      const record = JSON.parse(message.text) as { args: string[]; body: string; cwd: string };
      expect(record.cwd).toBe(workspace);
      expect(record.args).toContain(workspace);
      expect(record.args).toContain(
        `mcp_servers.visual_remote_exec.command=${JSON.stringify(process.execPath)}`,
      );
      expect(record.args).toContain(
        `mcp_servers.visual_remote_exec.args=${JSON.stringify([
          mcpScript,
          "--repo-root",
          directory,
          "--workspace-root",
          workspace,
          "--no-rtk",
        ])}`,
      );
      expect(record.body).toContain("mcp__visual_remote_exec__run_readonly");
      expect(record.body).toContain("executes without a shell");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("pins the configured model and reasoning effort for new and resumed runs", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-codex-model-test-"));
    try {
      const command = await executable(
        directory,
        `
let body = "";
for await (const chunk of process.stdin) body += chunk;
console.log(JSON.stringify({
  type:"item.completed",
  item:{type:"agent_message",text:JSON.stringify({
    args:process.argv.slice(2),
    providerKey:process.env.CUSTOM_PROVIDER_KEY
  })}
}));
`,
      );
      const adapter = new CodexAdapter({
        executable: command,
        model: "gpt-5.6-sol",
        profile: "proxy",
        reasoningEffort: "high",
        rtkExecutable: false,
        directExecMcpScript: false,
      });

      const runEvents: NormalizedAgentEvent[] = [];
      for await (const event of adapter.run(
        input(directory, { CUSTOM_PROVIDER_KEY: "provider-secret" }),
        new AbortController().signal,
      )) {
        runEvents.push(event);
      }
      const runMessage = runEvents.find((event) => event.type === "message");
      if (runMessage?.type !== "message") throw new Error("Missing run message");
      const runRecord = JSON.parse(runMessage.text) as {
        args: string[];
        providerKey: string;
      };
      expect(runRecord.providerKey).toBe("provider-secret");
      expect(runRecord.args).toEqual([
        "exec",
        "--json",
        "--color",
        "never",
        "-s",
        "workspace-write",
        "-C",
        directory,
        "--profile",
        "proxy",
        "--model",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="high"',
        "-",
      ]);

      const resumeEvents: NormalizedAgentEvent[] = [];
      for await (const event of adapter.resume(
        {
          ...input(directory, { CUSTOM_PROVIDER_KEY: "provider-secret" }),
          sessionId: "thread-model-test",
        },
        new AbortController().signal,
      )) {
        resumeEvents.push(event);
      }
      const resumeMessage = resumeEvents.find((event) => event.type === "message");
      if (resumeMessage?.type !== "message") throw new Error("Missing resume message");
      const resumeRecord = JSON.parse(resumeMessage.text) as { args: string[] };
      expect(resumeRecord.args).toEqual([
        "exec",
        "--json",
        "--color",
        "never",
        "-s",
        "workspace-write",
        "-C",
        directory,
        "--profile",
        "proxy",
        "--model",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="high"',
        "resume",
        "thread-model-test",
        "-",
      ]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("adds RTK guidance when installed and preserves the repo cwd in command events", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-codex-rtk-test-"));
    try {
      const command = await executable(
        directory,
        `
let body = "";
for await (const chunk of process.stdin) body += chunk;
console.log(JSON.stringify({type:"thread.started",thread_id:"rtk-test"}));
console.log(JSON.stringify({
  type:"item.completed",
  item:{type:"command_execution",command:"rtk rg component src",exit_code:0}
}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:body}}));
`,
      );
      const rtk = resolve(directory, "fake-rtk.mjs");
      await writeFile(rtk, "#!/usr/bin/env node\nconsole.log('rtk 0.44.2');\n");
      await chmod(rtk, 0o755);

      const adapter = new CodexAdapter({
        executable: command,
        rtkExecutable: rtk,
        directExecMcpScript: false,
      });
      const events: NormalizedAgentEvent[] = [];
      for await (const event of adapter.run(input(directory), new AbortController().signal)) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: "command",
        command: "rtk rg component src",
        cwd: directory,
      });
      const message = events.find((event) => event.type === "message");
      if (message?.type !== "message") throw new Error("Missing RTK prompt message");
      expect(message.text).toContain("rtk 0.44.2 is installed");
      expect(message.text).toContain("Prefix shell commands with RTK by default");
      expect(message.text).toContain("rtk rg <pattern>");

      const fallbackAdapter = new CodexAdapter({
        executable: command,
        rtkExecutable: resolve(directory, "missing-rtk"),
        directExecMcpScript: false,
      });
      const fallbackEvents: NormalizedAgentEvent[] = [];
      for await (const event of fallbackAdapter.run(
        input(directory),
        new AbortController().signal,
      )) {
        fallbackEvents.push(event);
      }
      const fallbackMessage = fallbackEvents.find((event) => event.type === "message");
      if (fallbackMessage?.type !== "message") {
        throw new Error("Missing fallback prompt message");
      }
      expect(fallbackMessage.text).toContain("RTK was not detected");
      expect(fallbackMessage.text).toContain("Use native repository commands directly");
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
        const adapter = new CodexAdapter({
          executable: command,
          killGraceMs: 100,
          directExecMcpScript: false,
        });
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
