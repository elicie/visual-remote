import { describe, expect, it } from "vitest";

import { BrowserSessionManager } from "@visual-remote/bridge-core";

describe("BrowserSessionManager", () => {
  it("passes when the render revision advances without new errors", () => {
    const sessions = new BrowserSessionManager();
    const started = new Date("2026-07-31T00:00:00.000Z");
    sessions.connect(
      "browser",
      { url: "http://dev:10001", viewport: { width: 1200, height: 800 }, renderRevision: 1 },
      started,
    );
    const baseline = sessions.baseline("browser", started)!;
    sessions.updatePage(
      "browser",
      { url: "http://dev:10001", viewport: { width: 1200, height: 800 }, renderRevision: 2 },
      new Date("2026-07-31T00:00:01.000Z"),
    );

    expect(sessions.verify(baseline).status).toBe("passed");
  });

  it("fails when a new unhandled error is reported", () => {
    const sessions = new BrowserSessionManager();
    const started = new Date("2026-07-31T00:00:00.000Z");
    sessions.connect(
      "browser",
      { url: "http://dev:10001", viewport: { width: 1200, height: 800 }, renderRevision: 1 },
      started,
    );
    const baseline = sessions.baseline("browser", started)!;
    sessions.recordConsole("browser", {
      level: "unhandled",
      message: "Bearer should-not-leak",
      createdAt: "2026-07-31T00:00:01.000Z",
    });

    const result = sessions.verify(baseline);
    expect(result.status).toBe("failed");
    expect(result.newErrors[0]?.message).toBe("[REDACTED]");
  });

  it("ignores recurring errors that were already present at the task baseline", () => {
    const sessions = new BrowserSessionManager();
    const started = new Date("2026-07-31T00:00:00.000Z");
    sessions.connect(
      "browser",
      { url: "http://dev:10001/editor", viewport: { width: 1200, height: 800 }, renderRevision: 1 },
      started,
    );
    sessions.recordConsole("browser", {
      level: "error",
      message: "Existing AI proxy returned 502",
      createdAt: "2026-07-30T23:59:59.000Z",
    });
    const baseline = sessions.baseline("browser", started)!;
    sessions.recordConsole("browser", {
      level: "error",
      message: "Existing AI proxy returned 502",
      createdAt: "2026-07-31T00:00:01.000Z",
    });
    sessions.updatePage(
      "browser",
      { url: "http://dev:10001/editor", viewport: { width: 1200, height: 800 }, renderRevision: 2 },
      new Date("2026-07-31T00:00:01.000Z"),
    );

    expect(sessions.verify(baseline)).toMatchObject({
      status: "passed",
      newErrors: [],
    });
  });

  it("does not treat navigation to another page as a successful render verification", () => {
    const sessions = new BrowserSessionManager();
    const started = new Date("2026-07-31T00:00:00.000Z");
    sessions.connect(
      "browser",
      { url: "http://dev:10001/editor", viewport: { width: 1200, height: 800 }, renderRevision: 1 },
      started,
    );
    const baseline = sessions.baseline("browser", started)!;
    sessions.updatePage(
      "browser",
      { url: "http://dev:10001/settings", viewport: { width: 1200, height: 800 }, renderRevision: 2 },
      new Date("2026-07-31T00:00:01.000Z"),
    );

    expect(sessions.verify(baseline)).toMatchObject({
      status: "partial",
      renderChanged: true,
      summary: expect.stringContaining("different page"),
    });
  });

  it("requires matching changed-target evidence for targeted work", () => {
    const sessions = new BrowserSessionManager();
    const started = new Date("2026-07-31T00:00:00.000Z");
    sessions.connect(
      "browser",
      { url: "http://dev:10001", viewport: { width: 1200, height: 800 }, renderRevision: 1 },
      started,
    );
    const baseline = sessions.baseline("browser", started)!;
    sessions.updatePage(
      "browser",
      { url: "http://dev:10001", viewport: { width: 1200, height: 800 }, renderRevision: 2 },
      new Date("2026-07-31T00:00:01.000Z"),
    );

    expect(
      sessions.verify(baseline, {
        taskId: "task",
        targetEvidenceRequired: true,
      }).status,
    ).toBe("partial");

    sessions.recordTargetResult(
      "browser",
      {
        taskId: "other-task",
        state: "found-and-changed",
        renderRevision: 2,
        targetCount: 1,
        foundCount: 1,
        changedCount: 1,
      },
      new Date("2026-07-31T00:00:02.000Z"),
    );
    expect(
      sessions.verify(baseline, {
        taskId: "task",
        targetEvidenceRequired: true,
      }).status,
    ).toBe("partial");

    sessions.recordTargetResult(
      "browser",
      {
        taskId: "task",
        state: "found-and-changed",
        renderRevision: 2,
        targetCount: 1,
        foundCount: 1,
        changedCount: 1,
      },
      new Date("2026-07-31T00:00:03.000Z"),
    );
    expect(
      sessions.verify(baseline, {
        taskId: "task",
        targetEvidenceRequired: true,
      }),
    ).toMatchObject({
      status: "passed",
      renderChanged: true,
      targetResult: { taskId: "task", state: "found-and-changed" },
    });
  });
});
