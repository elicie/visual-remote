import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

  it("tells the agent which paths it may modify", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root, {
      allowed: ["src/**", "tests/**"],
      denied: ["private/**"],
    });
    const adapter = new FakeAgentAdapter();
    const store = new SqliteTaskStore(resolve(fixture.parent, "state.sqlite"));
    const service = new TaskService({
      projectId: "fixture-project",
      adapter,
      store,
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

    expect(service.get(task.id)).toMatchObject({
      status: "unsafe",
      error: { code: "REPOSITORY_STATE_CHANGED" },
    });
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
      error: { code: "REPOSITORY_STATE_CHANGED" },
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
