import type * as PngModule from "pngjs";
import { createRequire } from "node:module";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentCanceledError,
  AgentPermissionDeniedError,
  type AgentAdapter,
  FakeAgentAdapter,
  GitTransactionManager,
  SqliteTaskStore,
  TaskService,
  TaskServiceError,
  type NormalizedAgentEvent,
  type StoredTask,
} from "@visual-remote/bridge-core";
import type { ContextBundle, TaskStatus } from "@visual-remote/protocol";
import { normalizeComparisonRequest } from "@visual-remote/protocol";
import { createFixtureRepository } from "../git/helpers.js";

function context(request: string, browserOffset = 1): ContextBundle {
  return {
    version: 1,
    projectId: "fixture-project",
    browserSessionId: `00000000-0000-4000-8000-${String(browserOffset).padStart(12, "0")}`,
    page: {
      url: "http://dev:10001/",
      pathname: "/",
      title: "Fixture",
      viewport: { width: 1280, height: 720 },
      devicePixelRatio: 1,
      scroll: { x: 0, y: 0 },
      renderRevision: 0,
    },
    selection: { mode: "page", targets: [] },
    request: { text: request, scope: "page" },
  };
}

async function waitForStatus(
  service: TaskService,
  taskId: string,
  expected: TaskStatus,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (service.get(taskId)?.status === expected) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`Task ${taskId} did not reach ${expected}; got ${service.get(taskId)?.status}`);
}

describe("TaskService", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (path) => await rm(path, { recursive: true })));
  });

  it("retries only observed MCP denials with private cumulative approvals and a fresh session", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const firstTool = "mcp__figma__download_image";
    const secondTool = "mcp__figma__get_frame";
    const fake = new FakeAgentAdapter(async function* (input) {
      yield { type: "session", sessionId: `session-${input.taskId}` };
      if (!input.allowedTools?.includes(firstTool)) {
        yield { type: "permission_denied", toolName: firstTool };
        throw new AgentPermissionDeniedError([firstTool]);
      }
      if (!input.allowedTools.includes(secondTool)) throw new AgentPermissionDeniedError([secondTool]);
      yield { type: "complete" };
    });
    const resume = vi.fn(fake.run.bind(fake));
    const adapter: AgentAdapter = { id: "claude", probe: fake.probe.bind(fake), run: fake.run.bind(fake), resume };
    const store = new SqliteTaskStore(":memory:");
    const service = new TaskService({ projectId: "fixture-project", adapter, store, git: await GitTransactionManager.open(fixture.root) });
    const originalContext = context("download reference");
    const original = service.create(originalContext);
    await service.waitForIdle();
    expect(service.get(original.id)).toMatchObject({ status: "failed", permissionDeniedTools: [firstTool], error: { code: "AGENT_PERMISSION_DENIED" } });
    for (const tools of [[], ["Bash"], ["mcp__figma__*"], [secondTool], [firstTool, firstTool], ["mcp__figma__download_image "]]) {
      expect(() => service.approveToolsAndRetry(original.id, tools)).toThrow(TaskServiceError);
    }
    const retry = service.approveToolsAndRetry(original.id, [firstTool]);
    expect(retry.parentTaskId).toBe(original.id);
    expect(retry).not.toHaveProperty("approvedTools");
    expect(store.getTask(retry.id)?.contextBundle).toEqual(originalContext);
    await service.waitForIdle();
    expect(service.get(retry.id)).toMatchObject({ status: "failed", permissionDeniedTools: [secondTool], error: { code: "AGENT_PERMISSION_DENIED" } });
    const next = service.approveToolsAndRetry(retry.id, [secondTool]);
    await service.waitForIdle();
    expect(service.get(next.id)?.status).toBe("review");
    expect(fake.runs.map((run) => run.input.allowedTools)).toEqual([undefined, [firstTool], [firstTool, secondTool]]);
    expect(resume).not.toHaveBeenCalled();
    expect(() => service.approveToolsAndRetry(next.id, [firstTool])).toThrow(TaskServiceError);
    const ordinary = service.create(context("ordinary followup"), { parentTaskId: next.id, approvedTools: [firstTool] } as never);
    await service.waitForIdle();
    expect(fake.runs.at(-1)?.input.allowedTools).toBeUndefined();
    expect(store.getTask(ordinary.id)?.approvedTools).toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
    expect(JSON.stringify(service.replay())).not.toContain('"approvedTools"');
    await service.close();
  });

  it("restores queued retry approvals after restart without resuming the denied session", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const database = resolve(fixture.parent, "approvals.sqlite");
    const bundle = context("queued retry");
    const tool = "mcp__figma__download_image";
    const initial = new SqliteTaskStore(database);
    const parent: StoredTask = { id: "denied", projectId: bundle.projectId, status: "failed", requestText: bundle.request.text, scope: bundle.request.scope, originBrowserSessionId: bundle.browserSessionId, contextBundle: bundle, agentAdapter: "claude", agentSessionId: "denied-session", permissionDeniedTools: [tool], error: { code: "AGENT_PERMISSION_DENIED", message: "denied" }, changedFiles: [], createdAt: "2026-01-01T00:00:00.000Z" };
    initial.createTask(parent);
    const queued: StoredTask = { ...parent, id: "queued-retry", status: "queued", parentTaskId: parent.id, approvedTools: [tool] };
    delete queued.agentSessionId;
    delete queued.permissionDeniedTools;
    delete queued.error;
    initial.createTask(queued);
    initial.close();
    const fake = new FakeAgentAdapter();
    const resume = vi.fn(fake.run.bind(fake));
    const service = new TaskService({ projectId: bundle.projectId, adapter: { id: "claude", probe: fake.probe.bind(fake), run: fake.run.bind(fake), resume }, store: new SqliteTaskStore(database), git: await GitTransactionManager.open(fixture.root) });
    await service.waitForIdle();
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]?.input.allowedTools).toEqual([tool]);
    expect(resume).not.toHaveBeenCalled();
    expect(service.get(queued.id)?.status).toBe("review");
    await service.close();
  });

  it.each([undefined, "Bash"])("keeps unknown or built-in denial actionable without MCP approval (%s)", async (toolName) => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const fake = new FakeAgentAdapter(async function* () {
      yield toolName ? { type: "permission_denied", toolName } : { type: "permission_denied" };
    });
    const service = new TaskService({ projectId: "fixture-project", adapter: { id: "claude", probe: fake.probe.bind(fake), run: fake.run.bind(fake) }, store: new SqliteTaskStore(":memory:"), git: await GitTransactionManager.open(fixture.root) });
    const task = service.create(context("denied"));
    await service.waitForIdle();
    expect(service.get(task.id)).toMatchObject({ status: "failed", error: { code: "AGENT_PERMISSION_DENIED" }, permissionDeniedTools: toolName ? [toolName] : [] });
    expect(() => service.approveToolsAndRetry(task.id, ["mcp__figma__download_image"])).toThrow(TaskServiceError);
    await service.close();
  });

  it("normalizes frame links and honors an explicit disabled override", () => {
    const url = "https://www.figma.com/design/ABC/frame?node-id=1-2";
    expect(normalizeComparisonRequest(`Match ${url}`)).toMatchObject({ enabled: true, url, maxIterations: 4 });
    expect(normalizeComparisonRequest(`Match ${url}`, { enabled: false })?.enabled).toBe(false);
    expect(() => normalizeComparisonRequest("https://www.figma.com/design/ABC/frame")).toThrow("node-id");
    expect(() => normalizeComparisonRequest("match", { enabled: true, url: "https://evil.test/design/ABC?node-id=1-2" })).toThrow("full");
  });

  it("runs preparation and correction inside one snapshot pair with real image evidence", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const root = resolve(fixture.parent, "comparisons");
    const manager = await GitTransactionManager.open(fixture.root);
    const snapshots = vi.spyOn(manager, "createSnapshot");
    const requireCore = createRequire(resolve("packages/bridge-core/package.json"));
    const { PNG } = requireCore("pngjs") as typeof PngModule;
    const image = new PNG({ width: 3, height: 3 });
    image.data.fill(255);
    const bytes = PNG.sync.write(image);
    const differentImage = new PNG({ width: 3, height: 3 });
    for (let offset = 0; offset < differentImage.data.length; offset += 4) differentImage.data[offset + 3] = 255;
    const differentBytes = PNG.sync.write(differentImage);
    let captures = 0;
    const url = "https://www.figma.com/design/ABC/frame?node-id=1-2";
    let runs = 0;
    const lifecycle: string[] = [];
    const adapter = new FakeAgentAdapter(async (input) => {
      lifecycle.push("agent");
      runs++;
      if (runs === 1) {
        expect(input.prompt).not.toContain("change tracked content");
        expect(input.artifactDirectory).toBe(resolve(root, input.taskId));
        await writeFile(resolve(root, input.taskId, "reference.png"), bytes);
        await writeFile(resolve(root, input.taskId, "reference.json"), JSON.stringify({ width: 3, height: 3, targets: [], sourceUrl: url, nodeId: "1:2" }));
      } else {
        expect(input.prompt).toContain("change tracked content");
        await writeFile(resolve(fixture.root, "tracked.txt"), `comparison run ${runs}\n`);
      }
      return [{ type: "session", sessionId: "comparison-session" }];
    });
    const service = new TaskService({ projectId: "fixture-project", adapter, store: new SqliteTaskStore(":memory:"), git: manager, comparisonRoot: root,
      comparisonBrowser: {
        begin: async () => { lifecycle.push("begin"); },
        capture: async (taskId, _context, dimensions) => {
          lifecycle.push("capture");
          return { requestId: crypto.randomUUID(), taskId, ...dimensions, targets: [], pngBase64: (++captures === 1 ? differentBytes : bytes).toString("base64") };
        },
        finish: async () => { lifecycle.push("finish"); },
      },
    });
    const task = service.create(context(`change tracked content to match ${url}`));
    await service.waitForIdle();
    expect(service.get(task.id)).toMatchObject({ status: "review", comparison: { status: "passed", iteration: 2 } });
    expect(runs).toBe(3);
    expect(lifecycle).toEqual(["begin", "agent", "agent", "capture", "agent", "capture", "finish"]);
    expect(snapshots.mock.calls.map((call) => call[1])).toEqual(["before", "after"]);
    expect(service.diff(task.id)).toContain("comparison run 3");
    const state = service.get(task.id)!.comparison!;
    expect(await service.getArtifact(state.iterations[0]!.referenceArtifactId)).toBeDefined();
    expect(JSON.stringify(service.replay())).not.toContain(bytes.toString("base64"));
    await service.close();
  });

  it("blocks unavailable verification browsers before running any agent", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const service = new TaskService({ projectId: "fixture-project", adapter: new FakeAgentAdapter(), store: new SqliteTaskStore(":memory:"), git: await GitTransactionManager.open(fixture.root), comparisonRoot: resolve(fixture.parent, "comparisons") });
    const task = service.create(context("Match https://www.figma.com/design/ABC/frame?node-id=1-2"));
    await service.waitForIdle();
    expect(service.get(task.id)).toMatchObject({ status: "failed", comparison: { status: "blocked", iterations: [] } });
    expect(service.get(task.id)?.comparison?.message).toContain("Verification browser unavailable");
    await service.close();
  });

  it("preserves permission failure during comparison reference preparation instead of missing-file errors", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const tool = "mcp__figma__download_image";
    const capture = vi.fn();
    const finish = vi.fn(async () => {});
    const adapter = new FakeAgentAdapter(async function* () {
      yield { type: "permission_denied", toolName: tool };
      throw new AgentPermissionDeniedError([tool]);
    });
    const service = new TaskService({ projectId: "fixture-project", adapter, store: new SqliteTaskStore(":memory:"), git: await GitTransactionManager.open(fixture.root), comparisonRoot: resolve(fixture.parent, "comparisons"), comparisonBrowser: { begin: async () => {}, capture, finish } });
    const task = service.create(context("Match https://www.figma.com/design/ABC/frame?node-id=1-2"));
    await service.waitForIdle();
    expect(service.get(task.id)).toMatchObject({ status: "failed", permissionDeniedTools: [tool], error: { code: "AGENT_PERMISSION_DENIED" }, comparison: { status: "blocked" } });
    expect(service.get(task.id)?.error?.message).not.toContain("ENOENT");
    expect(capture).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
    expect(adapter.runs).toHaveLength(1);
    await service.close();
  });

  it.each(["preflight", "reference", "cleanup", "canceled"] as const)("finalizes %s failures before releasing the next writer", async (stage) => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const snapshots = vi.spyOn(manager, "createSnapshot");
    const lifecycle: string[] = [];
    let releaseFinish!: () => void;
    let enteredFinish!: () => void;
    const finishing = new Promise<void>((resolveFinish) => { enteredFinish = resolveFinish; });
    const finishGate = new Promise<void>((resolveFinish) => { releaseFinish = resolveFinish; });
    let enteredBegin!: () => void;
    const beginning = new Promise<void>((resolveBegin) => { enteredBegin = resolveBegin; });
    const adapter = new FakeAgentAdapter(async () => { lifecycle.push("agent"); return []; });
    const service = new TaskService({ projectId: "fixture-project", adapter, store: new SqliteTaskStore(":memory:"), git: manager,
      comparisonRoot: resolve(fixture.parent, "comparisons"),
      comparisonBrowser: {
        begin: async (_taskId, _context, signal) => {
          lifecycle.push("begin");
          enteredBegin();
          if (stage === "canceled") await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          if (stage === "preflight" || stage === "cleanup") throw new Error("Selected state cannot be reproduced");
        },
        capture: async () => { throw new Error("Capture must not run"); },
        finish: async () => {
          lifecycle.push("finish-start");
          enteredFinish();
          await finishGate;
          lifecycle.push("finish-end");
          if (stage === "cleanup") throw new Error("Page close failed");
        },
      },
    });
    const first = service.create(context("Match https://www.figma.com/design/ABC/frame?node-id=1-2"));
    const second = service.create(context("Normal task"));
    await beginning;
    if (stage === "canceled") service.cancel(first.id);
    await finishing;
    expect(service.get(second.id)?.status).toBe("queued");
    expect(adapter.runs).toHaveLength(stage === "reference" ? 1 : 0);
    releaseFinish();
    await service.waitForIdle();
    expect(service.get(first.id)).toMatchObject({ status: stage === "canceled" ? "canceled" : "failed", comparison: { status: stage === "canceled" ? "canceled" : "blocked" } });
    if (stage === "preflight" || stage === "cleanup") expect(service.get(first.id)?.comparison?.message).toBe("Selected state cannot be reproduced");
    expect(service.get(second.id)?.status).toBe("review");
    expect(lifecycle.slice(-2)).toEqual(["finish-end", "agent"]);
    expect(snapshots.mock.calls.map((call) => call[1])).toEqual(["before", "after", "before", "after"]);
    await service.close();
  });

  it("runs one writer at a time and keeps each task diff isolated", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    let active = 0;
    let maxActive = 0;
    let runNumber = 0;
    const adapter = new FakeAgentAdapter(async function* () {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runNumber += 1;
      const current = runNumber;
      try {
        await new Promise((resolveWait) => setTimeout(resolveWait, 30));
        await writeFile(resolve(fixture.root, "tracked.txt"), `task ${current}\n`);
        yield { type: "message", text: `run ${current}` };
      } finally {
        active -= 1;
      }
    });
    const store = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store,
      git: manager,
    });

    const first = service.create(context("first", 1));
    const second = service.create(context("second", 2));
    await service.waitForIdle();

    expect(maxActive).toBe(1);
    expect(adapter.runs).toHaveLength(2);
    expect(service.get(first.id)).toMatchObject({ status: "review", changedFiles: ["tracked.txt"] });
    expect(service.get(second.id)).toMatchObject({ status: "review", changedFiles: ["tracked.txt"] });
    expect(service.diff(first.id)).toContain("+task 1");
    expect(service.diff(second.id)).toContain("+task 2");
    expect(service.diff(second.id)).toContain("-task 1");
    expect(service.logs(first.id).map((entry) => entry.event)).toContainEqual({
      type: "message",
      text: "run 1",
    });
    await service.close();
  });

  it("states the capabilities available to the Bridge-launched agent", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const adapter = new FakeAgentAdapter();
    const service = new TaskService({
      projectId: "fixture-project",
      workspaceRoot: fixture.root,
      upstreamUrl: "http://127.0.0.1:10010/",
      adapter,
      store: new SqliteTaskStore(":memory:"),
      git: await GitTransactionManager.open(fixture.root),
    });

    service.create(context("edit the selected UI"));
    await service.waitForIdle();

    const prompt = adapter.runs[0]?.input.prompt ?? "";
    expect(prompt).toContain("Runtime capabilities:");
    expect(prompt).toContain(`Repository worktree: ${fixture.root}`);
    expect(prompt).toContain(`Workspace: ${fixture.root}`);
    expect(prompt).toContain("Browser URL: http://dev:10001/");
    expect(prompt).toContain("Local upstream URL: http://127.0.0.1:10010/");
    expect(prompt).toContain("already-resolved service directory");
    expect(prompt).toContain("Run project commands from the workspace");
    expect(prompt).toContain("selected CLI's configured tools and permissions");
    expect(prompt).toContain("actually access and inspect it with an available tool");
    expect(prompt).toContain("A URL in the request is not access evidence");
    expect(prompt).toContain("explicitly disclose that limitation and do not claim design verification");
    expect(prompt).toContain("Repository documentation may guide implementation but is not evidence");
    expect(prompt).toContain("Bridge performs its configured HMR and browser checks");
    await service.close();
  });

  it("tells the agent which paths it may modify", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root, {
      allowed: ["src/**", "tests/**"],
      denied: ["private/**"],
    });
    const adapter = new FakeAgentAdapter();
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store: new SqliteTaskStore(resolve(fixture.parent, "state.sqlite")),
      git: manager,
    });

    service.create(context("respect the path policy"));
    await service.waitForIdle();

    expect(adapter.runs[0]?.input.prompt).toContain(
      "Only modify paths matching these allowed patterns: src/**, tests/**.",
    );
    expect(adapter.runs[0]?.input.prompt).toContain("private/**");
    await service.close();
  });

  it("cancels an active adapter and still records an after snapshot", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const adapter = new FakeAgentAdapter(async function* (
      _input,
      signal,
    ): AsyncIterable<NormalizedAgentEvent> {
      yield { type: "phase", name: "waiting" };
      await new Promise<void>((_resolveWait, rejectWait) => {
        const rejectCanceled = (): void => rejectWait(new AgentCanceledError());
        if (signal.aborted) rejectCanceled();
        else signal.addEventListener("abort", rejectCanceled, { once: true });
      });
    });
    const store = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store,
      git: manager,
      maxRunMs: 10_000,
    });

    const task = service.create(context("wait forever"));
    await waitForStatus(service, task.id, "running_agent");
    service.cancel(task.id);
    await service.waitForIdle();

    expect(service.get(task.id)).toMatchObject({
      status: "canceled",
      beforeRef: expect.stringContaining("/before"),
      afterRef: expect.stringContaining("/after"),
    });
    await service.close();
  });

  it("marks a task unsafe when the adapter changes an ignored denied file", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    await fixture.write(".env", "SECRET=before\n");
    const manager = await GitTransactionManager.open(fixture.root);
    const adapter = new FakeAgentAdapter(async function* () {
      await writeFile(resolve(fixture.root, ".env"), "SECRET=after\n");
      yield { type: "complete" };
    });
    const store = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store,
      git: manager,
    });

    const task = service.create(context("change a secret"));
    await service.waitForIdle();

    const unsafeTask = service.get(task.id);
    expect(unsafeTask).toMatchObject({
      status: "unsafe",
      error: {
        code: "REPOSITORY_STATE_CHANGED",
        message: expect.stringContaining('".env"'),
      },
    });
    expect(unsafeTask?.error?.message).not.toContain("SECRET");
    expect(service.diff(task.id)).not.toContain("SECRET");
    await service.close();
  });

  it("times out an adapter through the same cancellation path", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const adapter = new FakeAgentAdapter(async function* (
      _input,
      signal,
    ): AsyncIterable<NormalizedAgentEvent> {
      await new Promise<void>((_resolveWait, rejectWait) => {
        const rejectTimeout = (): void =>
          rejectWait(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        if (signal.aborted) rejectTimeout();
        else signal.addEventListener("abort", rejectTimeout, { once: true });
      });
    });
    const store = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store,
      git: manager,
      maxRunMs: 20,
    });

    const task = service.create(context("time out"));
    await service.waitForIdle();

    expect(service.get(task.id)).toMatchObject({
      status: "failed",
      error: { code: "AGENT_TIMEOUT" },
      afterRef: expect.stringContaining("/after"),
    });
    await service.close();
  });

  it("finalizes an interrupted partial write with an inspectable diff and safe revert", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const database = resolve(fixture.parent, "state.sqlite");
    const guard = await manager.captureGuard();
    const before = await manager.createSnapshot("interrupted-task", "before");
    const interrupted: StoredTask = {
      id: "interrupted-task",
      projectId: "fixture-project",
      status: "running_agent",
      requestText: "partially edit the tracked file",
      scope: "page",
      originBrowserSessionId: context("recover").browserSessionId,
      agentAdapter: "fake",
      contextBundle: context("recover"),
      comparison: { status: "passed", url: "https://www.figma.com/design/ABC/frame?node-id=1-2", iteration: 1, maxIterations: 4, iterations: [] },
      changedFiles: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      beforeRef: before.ref,
      preHead: guard.head,
      preIndexTree: guard.indexTree,
      preRestrictedFingerprint: guard.restrictedFingerprint,
    };
    const initialStore = new SqliteTaskStore(database);
    initialStore.createTask(interrupted);
    initialStore.close();
    await writeFile(resolve(fixture.root, "tracked.txt"), "partial agent write\n");

    const adapter = new FakeAgentAdapter();
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store: new SqliteTaskStore(database),
      git: manager,
    });
    await service.waitForIdle();

    expect(adapter.runs).toHaveLength(0);
    expect(service.get(interrupted.id)).toMatchObject({
      status: "failed",
      error: { code: "BRIDGE_INTERRUPTED" },
      comparison: { status: "blocked" },
      beforeRef: before.ref,
      afterRef: expect.stringContaining("/after"),
      changedFiles: ["tracked.txt"],
    });
    expect(service.diff(interrupted.id)).toContain("+partial agent write");

    await service.revert(interrupted.id);
    await expect(
      readFile(resolve(fixture.root, "tracked.txt"), "utf8"),
    ).resolves.toBe("base\n");
    expect(service.get(interrupted.id)?.status).toBe("reverted");
    await service.close();
  });

  it.each([false, true])("preserves a persisted after snapshot during recovery (missing ref: %s)", async (missingRef) => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const guard = await manager.captureGuard();
    const before = await manager.createSnapshot("snapshotted-task", "before");
    await fixture.write("tracked.txt", "completed agent write\n");
    const after = await manager.createSnapshot("snapshotted-task", "after");
    const database = resolve(fixture.parent, "state.sqlite");
    const initialStore = new SqliteTaskStore(database);
    initialStore.createTask({
      id: "snapshotted-task",
      projectId: "fixture-project",
      status: "diffing",
      requestText: "recover a completed snapshot",
      scope: "page",
      originBrowserSessionId: context("recover").browserSessionId,
      agentAdapter: "fake",
      contextBundle: context("recover"),
      changedFiles: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      beforeRef: before.ref,
      afterRef: after.ref,
      preHead: guard.head,
      preIndexTree: guard.indexTree,
      preRestrictedFingerprint: guard.restrictedFingerprint,
    });
    initialStore.close();
    if (missingRef) await fixture.git(["update-ref", "-d", after.ref]);
    await fixture.write("tracked.txt", "user edit after snapshot\n");
    const adapter = new FakeAgentAdapter();
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store: new SqliteTaskStore(database),
      git: manager,
    });
    await service.waitForIdle();

    expect(adapter.runs).toHaveLength(0);
    expect(service.get("snapshotted-task")).toMatchObject({
      status: missingRef ? "unsafe" : "failed",
      beforeRef: before.ref,
      afterRef: after.ref,
      error: { code: missingRef ? "RECOVERY_FINALIZATION_FAILED" : "BRIDGE_INTERRUPTED" },
    });
    expect(await fixture.git(["rev-parse", before.ref])).toBe(before.commit);
    if (missingRef) {
      await expect(fixture.git(["rev-parse", "--verify", after.ref])).rejects.toThrow();
    } else {
      expect(await fixture.git(["rev-parse", after.ref])).toBe(after.commit);
      expect(service.diff("snapshotted-task")).toContain("+completed agent write");
      expect(service.diff("snapshotted-task")).not.toContain("user edit after snapshot");
    }
    await expect(service.revert("snapshotted-task")).rejects.toMatchObject({
      code: missingRef ? "TASK_NOT_REVERTIBLE" : "REVERT_CONFLICT",
    });
    expect(await readFile(resolve(fixture.root, "tracked.txt"), "utf8")).toBe(
      "user edit after snapshot\n",
    );
    await service.close();
  });

  it.each(["success", "conflict", "close"] as const)("holds the writer through revert and releases it on %s", async (outcome) => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const adapter = new FakeAgentAdapter(async function* () {
      await fixture.write("tracked.txt", "agent write\n");
      yield { type: "complete" };
    });
    const store = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store,
      git: manager,
    });
    const first = service.create(context("first"));
    await service.waitForIdle();
    let releaseRevert!: () => void;
    const gate = new Promise<void>((resolveWait) => { releaseRevert = resolveWait; });
    const originalRevert = manager.revert.bind(manager);
    const revertSpy = vi.spyOn(manager, "revert").mockImplementationOnce(async (...args) => {
      await gate;
      return await originalRevert(...args);
    });
    const reverting = service.revert(first.id);
    const result = outcome === "conflict"
      ? expect(reverting).rejects.toMatchObject({ code: "REVERT_CONFLICT" })
      : expect(reverting).resolves.toMatchObject({ status: "reverted" });
    await expect(service.revert(first.id)).rejects.toMatchObject({ code: "WRITER_BUSY" });
    expect(revertSpy).toHaveBeenCalledTimes(1);
    const second = service.create(context("second", 2));
    expect(service.get(second.id)?.status).toBe("queued");
    expect(adapter.runs).toHaveLength(1);
    let idle = false;
    const idlePromise = service.waitForIdle().then(() => { idle = true; });
    let closed = false;
    const closeSpy = vi.spyOn(store, "close");
    const closing = outcome === "close"
      ? service.close().then(() => { closed = true; })
      : undefined;
    if (outcome === "conflict") await fixture.write("tracked.txt", "user edit\n");
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(closed).toBe(false);
    expect(closeSpy).not.toHaveBeenCalled();
    if (outcome === "close") {
      expect(service.get(second.id)?.status).toBe("canceled");
      await expect(service.revert(first.id)).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
    }

    releaseRevert();
    await result;
    await idlePromise;
    if (closing) {
      await closing;
      expect(adapter.runs).toHaveLength(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(await readFile(resolve(fixture.root, "tracked.txt"), "utf8")).toBe("base\n");
    } else {
      expect(adapter.runs).toHaveLength(2);
      expect(service.get(second.id)?.status).toBe("review");
      expect(service.get(first.id)?.status).toBe(outcome === "conflict" ? "review" : "reverted");
      expect(service.diff(second.id)).toContain(outcome === "conflict" ? "-user edit" : "-base");
      await service.close();
    }
  });

  it("marks recovered changes unsafe when the persisted restricted guard changed", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    await fixture.write(".env", "SECRET=before\n");
    const manager = await GitTransactionManager.open(fixture.root);
    const database = resolve(fixture.parent, "state.sqlite");
    const guard = await manager.captureGuard();
    const before = await manager.createSnapshot("unsafe-recovery", "before");
    const initialStore = new SqliteTaskStore(database);
    initialStore.createTask({
      id: "unsafe-recovery",
      projectId: "fixture-project",
      status: "running_agent",
      requestText: "partial write with unsafe repository change",
      scope: "page",
      originBrowserSessionId: context("unsafe recovery").browserSessionId,
      agentAdapter: "fake",
      contextBundle: context("unsafe recovery"),
      changedFiles: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      beforeRef: before.ref,
      preHead: guard.head,
      preIndexTree: guard.indexTree,
      preRestrictedFingerprint: guard.restrictedFingerprint,
    });
    initialStore.close();
    await writeFile(resolve(fixture.root, "tracked.txt"), "inspectable write\n");
    await writeFile(resolve(fixture.root, ".env"), "SECRET=after\n");

    const service = new TaskService({
      projectId: "fixture-project",
      adapter: new FakeAgentAdapter(),
      store: new SqliteTaskStore(database),
      git: manager,
    });
    await service.waitForIdle();

    expect(service.get("unsafe-recovery")).toMatchObject({
      status: "unsafe",
      error: {
        code: "REPOSITORY_STATE_CHANGED",
        message: expect.stringContaining('".env"'),
      },
      afterRef: expect.stringContaining("/after"),
      changedFiles: ["tracked.txt"],
    });
    expect(service.diff("unsafe-recovery")).toContain("+inspectable write");
    await service.close();
  });

  it("redacts normalized logs and nested event payloads before storage and broadcast", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const adapter = new FakeAgentAdapter(() => [
      {
        type: "message",
        text: "Authorization: Bearer header-secret-value",
      },
      {
        type: "command",
        command: "OPENAI_API_KEY=sk-abcdefghijklmnop npm test",
        cwd: fixture.root,
      },
      {
        type: "complete",
        summary: '{"token":"pairing-secret-value"}',
      },
    ]);
    const store = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store,
      git: manager,
    });
    const broadcasts: unknown[] = [];
    service.subscribe((event) => broadcasts.push(event));

    const task = service.create(context("sanitize output"));
    await service.waitForIdle();
    service.recordVerification(task.id, "failed", {
      nested: { cookie: "session=cookie-secret-value" },
    });

    const persisted = JSON.stringify({
      logs: service.logs(task.id),
      events: service.replay(),
    });
    const delivered = JSON.stringify(broadcasts);
    for (const value of [
      "header-secret-value",
      "abcdefghijklmnop",
      "pairing-secret-value",
      "cookie-secret-value",
    ]) {
      expect(persisted).not.toContain(value);
      expect(delivered).not.toContain(value);
    }
    expect(persisted).toContain("[REDACTED]");
    expect(delivered).toContain("[REDACTED]");
    await service.close();
  });

  it("commits a reviewed task with a default message, records the sha and refuses unsafe repeats", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const adapter = new FakeAgentAdapter(async function* () {
      await writeFile(resolve(fixture.root, "tracked.txt"), "committed by task\n");
      yield { type: "complete" };
    });
    const store = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    const service = new TaskService({ projectId: "fixture-project", adapter, store, git: manager });
    const events: string[] = [];
    service.subscribe((event) => events.push(event.type));
    const task = service.create(context("버튼 색을   브랜드 색으로\n바꿔줘"));
    await service.waitForIdle();
    expect(service.get(task.id)?.status).toBe("review");

    const committed = await service.commit(task.id);
    expect(committed.status).toBe("accepted");
    expect(committed.commit).toMatchObject({ message: `버튼 색을 브랜드 색으로 바꿔줘\n\nVisual Remote task ${task.id}\n` });
    expect(committed.commit?.sha).toBe(await fixture.git(["rev-parse", "HEAD"]));
    expect(await fixture.git(["log", "-1", "--format=%s"])).toBe("버튼 색을 브랜드 색으로 바꿔줘");
    expect(events).toContain("task.committed");
    expect(store.getTask(task.id)?.commit).toEqual(committed.commit);

    await expect(service.commit(task.id, "again")).resolves.toMatchObject({ commit: committed.commit });
    expect(await fixture.git(["rev-list", "--count", "HEAD"])).toBe("2");
    await expect(service.commit("missing")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });

    const reopened = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    expect(reopened.getTask(task.id)?.commit).toEqual(committed.commit);
    reopened.close();
    await service.close();
  });

  it("waits for the task's own verification hold before committing instead of reporting a busy writer", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const adapter = new FakeAgentAdapter(async function* () {
      await writeFile(resolve(fixture.root, "tracked.txt"), "held\n");
      yield { type: "complete" };
    });
    const service = new TaskService({ projectId: "fixture-project", adapter, store: new SqliteTaskStore(":memory:"), git: await GitTransactionManager.open(fixture.root) });
    const task = service.create(context("held"));
    const release = service.holdWriter(task.id);
    await waitForStatus(service, task.id, "review");

    let settled = false;
    const commit = service.commit(task.id, "held change").finally(() => {
      settled = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(settled).toBe(false);
    release();
    await expect(commit).resolves.toMatchObject({ status: "accepted", commit: { message: "held change" } });
    expect(await fixture.git(["log", "-1", "--format=%s"])).toBe("held change");
    await service.close();
  });

  it("rejects commits for reverted tasks and surfaces conflicts as errors", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const adapter = new FakeAgentAdapter(async function* () {
      await writeFile(resolve(fixture.root, "tracked.txt"), "task output\n");
      yield { type: "complete" };
    });
    const service = new TaskService({ projectId: "fixture-project", adapter, store: new SqliteTaskStore(":memory:"), git: manager });
    const task = service.create(context("conflict"));
    await service.waitForIdle();
    await writeFile(resolve(fixture.root, "tracked.txt"), "user edit after task\n");
    await expect(service.commit(task.id, "x".repeat(4_001))).rejects.toMatchObject({ code: "COMMIT_MESSAGE_TOO_LONG" });
    await expect(service.commit(task.id, "should conflict")).rejects.toMatchObject({ code: "COMMIT_CONFLICT" });
    expect(service.get(task.id)?.commit).toBeUndefined();
    await writeFile(resolve(fixture.root, "tracked.txt"), "task output\n");
    await service.revert(task.id);
    await expect(service.commit(task.id)).rejects.toMatchObject({ code: "TASK_NOT_COMMITTABLE" });
    await service.close();
  });

  it("reverts only the latest completed task and refuses conflicts", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    let runNumber = 0;
    const adapter = new FakeAgentAdapter(async function* () {
      runNumber += 1;
      await writeFile(resolve(fixture.root, "tracked.txt"), `task ${runNumber}\n`);
      yield { type: "complete" };
    });
    const store = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store,
      git: manager,
    });
    const first = service.create(context("first"));
    const second = service.create(context("second", 2));
    await service.waitForIdle();

    await expect(service.revert(first.id)).rejects.toMatchObject({
      code: "NOT_LATEST_TASK",
    } satisfies Partial<TaskServiceError>);
    await writeFile(resolve(fixture.root, "tracked.txt"), "changed after task\n");
    await expect(service.revert(second.id)).rejects.toMatchObject({ code: "REVERT_CONFLICT" });
    await expect(readFile(resolve(fixture.root, "tracked.txt"), "utf8")).resolves.toBe(
      "changed after task\n",
    );
    await service.close();
  });
});
