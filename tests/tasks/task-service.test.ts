import type * as PngModule from "pngjs";
import { createRequire } from "node:module";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentCanceledError,
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
    const adapter = new FakeAgentAdapter(async (input) => {
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
      captureComparison: async (taskId, _context, dimensions) => ({ requestId: crypto.randomUUID(), taskId, ...dimensions, targets: [], pngBase64: (++captures === 1 ? differentBytes : bytes).toString("base64") }),
    });
    const task = service.create(context(`change tracked content to match ${url}`));
    await service.waitForIdle();
    expect(service.get(task.id)).toMatchObject({ status: "review", comparison: { status: "passed", iteration: 2 } });
    expect(runs).toBe(3);
    expect(snapshots.mock.calls.map((call) => call[1])).toEqual(["before", "after"]);
    expect(service.diff(task.id)).toContain("comparison run 3");
    const state = service.get(task.id)!.comparison!;
    expect(await service.getArtifact(state.iterations[0]!.referenceArtifactId)).toBeDefined();
    expect(JSON.stringify(service.replay())).not.toContain(bytes.toString("base64"));
    await service.close();
  });

  it("blocks unavailable reference access rather than reporting a fabricated pass", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const service = new TaskService({ projectId: "fixture-project", adapter: new FakeAgentAdapter(), store: new SqliteTaskStore(":memory:"), git: await GitTransactionManager.open(fixture.root), comparisonRoot: resolve(fixture.parent, "comparisons") });
    const task = service.create(context("Match https://www.figma.com/design/ABC/frame?node-id=1-2"));
    await service.waitForIdle();
    expect(service.get(task.id)).toMatchObject({ status: "failed", comparison: { status: "blocked", iterations: [] } });
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
