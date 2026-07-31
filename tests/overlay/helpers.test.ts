import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calculatePopoverPosition,
  compactText,
  intersectionRatio,
  normalizeRect,
  parsePairingFragment,
  shouldSubmitOnEnter,
} from "@visual-remote/overlay/helpers";
import {
  fetchTaskArtifacts,
  fetchTasks,
  routeTaskEvent,
} from "@visual-remote/overlay/bridge";
import type { ServerEvent, TaskRecord } from "@visual-remote/protocol";

const BROWSER_A = "00000000-0000-4000-8000-000000000001";
const BROWSER_B = "00000000-0000-4000-8000-000000000002";

afterEach(() => {
  vi.unstubAllGlobals();
});

function taskEvent(
  type: string,
  taskId: string,
  originBrowserSessionId: string,
): ServerEvent<{ task: TaskRecord }> {
  return {
    seq: 1,
    type,
    projectId: "project",
    taskId,
    createdAt: "2026-07-31T00:00:00.000Z",
    payload: {
      task: {
        id: taskId,
        projectId: "project",
        status: type === "task.queued" ? "queued" : "running_agent",
        requestText: "change it",
        scope: "instance",
        originBrowserSessionId,
        changedFiles: [],
        createdAt: "2026-07-31T00:00:00.000Z",
      },
    },
  };
}

describe("overlay geometry", () => {
  it("normalizes a reverse drag", () => {
    expect(normalizeRect({ x: 90, y: 70 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 50,
    });
  });

  it("measures the subject area inside a region", () => {
    expect(
      intersectionRatio(
        { x: 10, y: 10, width: 20, height: 20 },
        { x: 20, y: 0, width: 30, height: 30 },
      ),
    ).toBe(0.5);
  });

  it("flips above and clamps a popover at viewport edges", () => {
    expect(
      calculatePopoverPosition(
        { x: 290, y: 170, width: 20, height: 20 },
        { width: 140, height: 100 },
        { width: 320, height: 200 },
      ),
    ).toEqual({ left: 168, top: 60, placement: "above" });
  });

  it("moves beside the target when neither vertical side fits", () => {
    expect(
      calculatePopoverPosition(
        { x: 300, y: 390, width: 120, height: 44 },
        { width: 408, height: 470 },
        { width: 1280, height: 720 },
        12,
        10,
        62,
      ),
    ).toEqual({ left: 430, top: 238, placement: "right" });
  });
});

describe("pairing fragments", () => {
  it("extracts the pairing token without retaining it in the hash", () => {
    expect(parsePairingFragment("#visual-pair=one%20two&panel=logs")).toEqual({
      token: "one two",
      remainingHash: "#panel=logs",
    });
  });

  it("leaves unrelated hashes untouched", () => {
    expect(parsePairingFragment("#section-heading")).toEqual({
      token: null,
      remainingHash: "#section-heading",
    });
  });
});

describe("request input", () => {
  it("does not submit during IME composition or for Shift+Enter", () => {
    expect(
      shouldSubmitOnEnter(
        { key: "Enter", shiftKey: false, isComposing: true },
        false,
      ),
    ).toBe(false);
    expect(
      shouldSubmitOnEnter(
        { key: "Enter", shiftKey: false, isComposing: false },
        true,
      ),
    ).toBe(false);
    expect(
      shouldSubmitOnEnter(
        { key: "Enter", shiftKey: true, isComposing: false },
        false,
      ),
    ).toBe(false);
    expect(
      shouldSubmitOnEnter(
        { key: "Enter", shiftKey: false, isComposing: false },
        false,
      ),
    ).toBe(true);
  });

  it("compacts and bounds captured text", () => {
    expect(compactText("  one \n two   three ", 9)).toBe("one two…");
  });
});

describe("task event routing", () => {
  it("binds only queued work created by the current browser session", () => {
    expect(routeTaskEvent(taskEvent("task.queued", "a", BROWSER_A), BROWSER_A)).toEqual({
      accept: true,
      bind: true,
      taskId: "a",
    });
    expect(routeTaskEvent(taskEvent("task.queued", "b", BROWSER_B), BROWSER_A)).toEqual({
      accept: false,
      bind: false,
      taskId: "b",
    });
  });

  it("ignores later events for another tab's active task", () => {
    expect(
      routeTaskEvent(
        taskEvent("task.started", "other", BROWSER_B),
        BROWSER_A,
        "mine",
      ),
    ).toEqual({ accept: false, bind: false, taskId: "other" });
    expect(
      routeTaskEvent(
        taskEvent("task.started", "mine", BROWSER_A),
        BROWSER_A,
        "mine",
      ),
    ).toEqual({ accept: true, bind: false, taskId: "mine" });
  });
});

describe("task history", () => {
  it("loads valid task records with the pairing token", async () => {
    const task: TaskRecord = {
      id: "task-1",
      projectId: "project",
      status: "accepted",
      requestText: "change it",
      scope: "instance",
      originBrowserSessionId: BROWSER_A,
      changedFiles: ["src/app.tsx"],
      createdAt: "2026-07-31T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer fixture-token",
      );
      return new Response(
        JSON.stringify({ tasks: [task, { id: "incomplete" }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTasks("fixture-token")).resolves.toEqual([task]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/_visual/api/tasks",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("keeps partial artifacts and reports unavailable detail types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/diff")) {
          return new Response(JSON.stringify({ diff: "diff --git a/file b/file" }));
        }
        return new Response("Bridge unavailable", { status: 503 });
      }),
    );

    await expect(fetchTaskArtifacts("fixture-token", "task-1")).resolves.toEqual({
      changedFiles: [],
      diff: "diff --git a/file b/file",
      logs: [],
      unavailable: ["files", "logs"],
    });
  });
});
