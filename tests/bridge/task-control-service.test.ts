import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BrowserSessionManager,
  FakeAgentAdapter,
  GitTransactionManager,
  SqliteTaskStore,
  TaskService,
  type BrowserVerificationResult,
  combineVerificationStatus,
  createTaskControlService,
} from "@visual-remote/bridge-core";
import type { ContextBundle, TaskRecord } from "@visual-remote/protocol";

class FakeControlSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly sent: string[] = [];

  send(value: unknown): void {
    this.sent.push(String(value));
  }
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visual-control-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Visual Test"]);
  git(root, ["config", "user.email", "visual@example.test"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "button.ts"), "export const color = 'blue';\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

function context(projectId: string): ContextBundle {
  return {
    version: 1,
    projectId,
    browserSessionId: "d33f254d-1009-4de7-99ad-7f93154e77cc",
    page: {
      url: "http://dev:10001/",
      pathname: "/",
      title: "Fixture",
      viewport: { width: 1280, height: 720 },
      devicePixelRatio: 1,
      scroll: { x: 0, y: 0 },
      renderRevision: 1,
    },
    selection: {
      mode: "element",
      targets: [
        {
          targetId: "button",
          order: 0,
          dom: {
            tagName: "button",
            classNames: ["button"],
            text: "Save",
            attributes: {},
            rect: { x: 10, y: 10, width: 80, height: 32 },
            locatorCandidates: [],
            parentPath: [],
          },
          styles: { color: "rgb(0, 0, 255)" },
          source: {
            primary: { filePath: "src/button.ts", lineNumber: 1 },
            stack: [],
            confidence: "exact",
          },
        },
      ],
    },
    request: { text: "Change the button color to green.", scope: "instance" },
  };
}

describe("task control service", () => {
  it("connects a control request to the writer queue and task diff", async () => {
    const repoRoot = await repositoryFixture();
    const gitManager = await GitTransactionManager.open(repoRoot, {
      allowed: ["src/**"],
    });
    const browserSessions = new BrowserSessionManager();
    browserSessions.connect(
      "d33f254d-1009-4de7-99ad-7f93154e77cc",
      {
        url: "http://dev:10001/",
        viewport: { width: 1280, height: 720 },
        renderRevision: 1,
      },
    );
    const socket = new FakeControlSocket();
    const adapter = new FakeAgentAdapter(async (input) => {
      await writeFile(join(repoRoot, "src", "button.ts"), "export const color = 'green';\n");
      browserSessions.updatePage(
        "d33f254d-1009-4de7-99ad-7f93154e77cc",
        {
          url: "http://dev:10001/",
          viewport: { width: 1280, height: 720 },
          renderRevision: 2,
        },
      );
      for (const [browserSessionId, state] of [
        ["00000000-0000-4000-8000-000000000099", "not-found"],
        ["d33f254d-1009-4de7-99ad-7f93154e77cc", "found-and-changed"],
      ] as const) {
        socket.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              id: crypto.randomUUID(),
              type: "verification.target_state",
              browserSessionId,
              payload: {
                taskId: input.taskId,
                state,
                renderRevision: 2,
                targetCount: 1,
                foundCount: state === "not-found" ? 0 : 1,
                changedCount: state === "found-and-changed" ? 1 : 0,
              },
            }),
          ),
        );
      }
      return [{ type: "complete", summary: "Updated button color" }];
    });
    const taskService = new TaskService({
      projectId: "fixture",
      workspaceRoot: repoRoot,
      adapter,
      store: new SqliteTaskStore(":memory:"),
      git: gitManager,
    });
    const control = createTaskControlService({
      taskService,
      project: {
        id: "fixture",
        repoRoot,
        workspaceRoot: repoRoot,
        mode: "attach",
        upstreamUrl: "http://127.0.0.1:10002",
      },
      browserSessions,
      hmrWaitMs: 0,
    });
    const disconnect = control.connectWebSocket?.({
      socket: socket as never,
      request: {} as never,
      projectId: "fixture",
    }) as (() => void);

    const created = (await control.createTask?.({
      contextBundle: context("fixture"),
    })) as TaskRecord;
    await taskService.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(created.status).toBe("queued");
    expect(control.getTask?.(created.id)).toMatchObject({
      status: "review",
      verificationStatus: "passed",
    });
    expect(control.getTaskFiles?.(created.id)).toEqual({ files: ["src/button.ts"] });
    expect(control.getTaskDiff?.(created.id)).toEqual({
      diff: expect.stringContaining("green"),
    });
    const logs = JSON.stringify(control.getTaskLogs?.(created.id));
    expect(logs).toContain("found-and-changed");
    expect(logs).not.toContain("not-found");
    disconnect();
    await control.close?.();
  });

  it("keeps the writer lock through browser verification before starting the next task", async () => {
    const repoRoot = await repositoryFixture();
    const gitManager = await GitTransactionManager.open(repoRoot, {
      allowed: ["src/**"],
    });
    const browserSessions = new BrowserSessionManager();
    browserSessions.connect(
      "d33f254d-1009-4de7-99ad-7f93154e77cc",
      {
        url: "http://dev:10001/",
        viewport: { width: 1280, height: 720 },
        renderRevision: 1,
      },
    );
    const taskService = new TaskService({
      projectId: "fixture",
      workspaceRoot: repoRoot,
      adapter: new FakeAgentAdapter(),
      store: new SqliteTaskStore(":memory:"),
      git: gitManager,
    });
    const control = createTaskControlService({
      taskService,
      project: {
        id: "fixture",
        repoRoot,
        workspaceRoot: repoRoot,
        mode: "attach",
        upstreamUrl: "http://127.0.0.1:10002",
      },
      browserSessions,
      hmrWaitMs: 25,
    });

    const first = control.createTask?.({ contextBundle: context("fixture") }) as TaskRecord;
    const second = control.createTask?.({ contextBundle: context("fixture") }) as TaskRecord;
    await taskService.waitForIdle();

    const events = taskService.replay();
    const firstVerified = events.findIndex(
      (event) => event.type === "task.verification_result" && event.taskId === first.id,
    );
    const secondStarted = events.findIndex(
      (event) => event.type === "task.started" && event.taskId === second.id,
    );
    expect(firstVerified).toBeGreaterThanOrEqual(0);
    expect(secondStarted).toBeGreaterThan(firstVerified);
    expect(control.getTask?.(first.id)).toMatchObject({ verificationStatus: "partial" });
    expect(control.getTask?.(second.id)).toMatchObject({ verificationStatus: "partial" });
    await control.close?.();
  });

  it("runs configured verification argv in the workspace and persists redacted summaries", async () => {
    const repoRoot = await repositoryFixture();
    const gitManager = await GitTransactionManager.open(repoRoot, {
      allowed: ["src/**"],
    });
    const browserSessions = new BrowserSessionManager();
    browserSessions.connect(
      "d33f254d-1009-4de7-99ad-7f93154e77cc",
      {
        url: "http://dev:10001/",
        viewport: { width: 1280, height: 720 },
        renderRevision: 1,
      },
    );
    const taskService = new TaskService({
      projectId: "fixture",
      workspaceRoot: repoRoot,
      adapter: new FakeAgentAdapter(),
      store: new SqliteTaskStore(":memory:"),
      git: gitManager,
    });
    const control = createTaskControlService({
      taskService,
      project: {
        id: "fixture",
        repoRoot,
        workspaceRoot: repoRoot,
        mode: "attach",
        upstreamUrl: "http://127.0.0.1:10002",
      },
      browserSessions,
      hmrWaitMs: 0,
      verificationCommands: [
        {
          name: "verify-cwd",
          command: [
            process.execPath,
            "-e",
            "process.stdout.write(process.cwd() + '\\nOPENAI_API_KEY=sk-abcdefghijklmnop')",
          ],
          timeoutMs: 2_000,
        },
      ],
    });

    const task = control.createTask?.({ contextBundle: context("fixture") }) as TaskRecord;
    await taskService.waitForIdle();

    expect(control.getTask?.(task.id)).toMatchObject({ verificationStatus: "partial" });
    const logs = JSON.stringify(control.getTaskLogs?.(task.id));
    expect(logs).toContain(repoRoot);
    expect(logs).toContain("[REDACTED]");
    expect(logs).not.toContain("abcdefghijklmnop");
    const events = JSON.stringify(taskService.replay());
    expect(events).not.toContain("abcdefghijklmnop");
    expect(events).toContain('"status":"passed"');
    await control.close?.();
  });

  it("combines browser and command outcomes conservatively", () => {
    const browser: BrowserVerificationResult = {
      status: "passed",
      renderChanged: true,
      newErrors: [],
      summary: "rendered",
    };
    expect(combineVerificationStatus(browser, [])).toBe("passed");
    expect(
      combineVerificationStatus(
        { ...browser, status: "partial", renderChanged: false },
        [
          {
            name: "typecheck",
            command: ["npm", "run", "typecheck"],
            status: "passed",
            exitCode: 0,
            durationMs: 1,
            output: "",
          },
        ],
      ),
    ).toBe("partial");
    expect(
      combineVerificationStatus(browser, [
        {
          name: "typecheck",
          command: ["npm", "run", "typecheck"],
          status: "timeout",
          exitCode: null,
          durationMs: 1,
          output: "",
        },
      ]),
    ).toBe("failed");
  });
});
