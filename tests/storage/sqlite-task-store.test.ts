import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SqliteTaskStore, type StoredTask } from "@visual-remote/bridge-core";
import { createFixtureRepository } from "../git/helpers.js";

function storedTask(): StoredTask {
  return {
    id: "persisted-task",
    projectId: "project",
    status: "queued",
    requestText: "Change it",
    scope: "component",
    originBrowserSessionId: "00000000-0000-4000-8000-000000000001",
    agentAdapter: "fake",
    contextBundle: {
      version: 1,
      projectId: "project",
      browserSessionId: "00000000-0000-4000-8000-000000000001",
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
      request: { text: "Change it", scope: "component" },
    },
    changedFiles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("SqliteTaskStore", () => {
  it("persists tasks, logs, and replayable monotonically sequenced events", async () => {
    const fixture = await createFixtureRepository();
    const database = resolve(fixture.parent, "state.sqlite");
    let store = new SqliteTaskStore(database);
    store.createTask(storedTask());
    store.appendLog("persisted-task", { type: "message", text: "hello" });
    const first = store.appendEvent("project", "task.queued", { value: 1 }, "persisted-task");
    const second = store.appendEvent("project", "task.started", { value: 2 }, "persisted-task");
    expect(second.seq).toBeGreaterThan(first.seq);
    store.close();

    store = new SqliteTaskStore(database);
    expect(store.getTask("persisted-task")?.requestText).toBe("Change it");
    expect(store.listLogs("persisted-task")[0]?.event).toEqual({
      type: "message",
      text: "hello",
    });
    expect(store.replayEvents({ afterSeq: first.seq })).toMatchObject([
      { seq: second.seq, type: "task.started" },
    ]);
    store.close();
    await rm(fixture.parent, { recursive: true });
  });

  it("adds the restricted guard column to an existing database", async () => {
    const fixture = await createFixtureRepository();
    const database = resolve(fixture.parent, "state.sqlite");
    let store = new SqliteTaskStore(database);
    store.close();

    const legacy = new DatabaseSync(database);
    legacy.exec("ALTER TABLE tasks DROP COLUMN pre_restricted_fingerprint");
    legacy.close();

    store = new SqliteTaskStore(database);
    store.createTask({
      ...storedTask(),
      preRestrictedFingerprint: "restricted-fingerprint",
    });
    expect(store.getTask("persisted-task")?.preRestrictedFingerprint).toBe(
      "restricted-fingerprint",
    );
    store.close();
    await rm(fixture.parent, { recursive: true });
  });
});
