import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calculatePopoverPosition,
  clampDragPosition,
  compactText,
  intersectionRatio,
  normalizeRect,
  orderTasks,
  parsePairingFragment,
  parseViewerFragment,
  shouldSubmitOnEnter,
  upsertTask,
} from "@visual-remote/overlay/helpers";
import {
  BridgeConnection,
  consumePairingToken,
  consumeViewerToken,
  fetchTaskArtifacts,
  fetchTasks,
  fetchViewerUrl,
  logFromEvent,
  routeTaskEvent,
} from "@visual-remote/overlay/bridge";
import type { ServerEvent, TaskRecord } from "@visual-remote/protocol";

const BROWSER_A = "00000000-0000-4000-8000-000000000001";
const BROWSER_B = "00000000-0000-4000-8000-000000000002";

class FakeBrowserSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeBrowserSocket[] = [];

  readonly OPEN = FakeBrowserSocket.OPEN;
  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeBrowserSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code = 1_000): void {
    this.readyState = 3;
    this.emit("close", { code });
  }

  open(): void {
    this.readyState = FakeBrowserSocket.OPEN;
    this.emit("open", {});
  }

  receive(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

afterEach(() => {
  FakeBrowserSocket.instances.length = 0;
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

  it("extracts a read-only viewer token independently from pairing", () => {
    expect(parseViewerFragment("#visual-view=read-token&task=one")).toEqual({
      token: "read-token",
      remainingHash: "#task=one",
    });
    expect(parsePairingFragment("#visual-view=read-token").token).toBeNull();
  });

  it("stores a control pairing token for the current browser tab", () => {
    const values = new Map<string, string>([
      ["visual-bridge:pairing-token", "old-token"],
      ["visual-bridge:last-sequence", "12"],
    ]);
    vi.stubGlobal("location", {
      hash: "#visual-pair=new-token&panel=logs",
      pathname: "/",
      search: "",
    });
    const replaceState = vi.fn();
    vi.stubGlobal("history", { state: null, replaceState });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    expect(consumePairingToken()).toBe("new-token");
    expect(values.get("visual-bridge:pairing-token")).toBe("new-token");
    expect(values.has("visual-bridge:last-sequence")).toBe(false);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/#panel=logs");

    vi.stubGlobal("location", { hash: "", pathname: "/", search: "" });
    expect(consumePairingToken()).toBe("new-token");
  });

  it("clears a stale viewer event sequence when the viewer token changes", () => {
    const values = new Map<string, string>([
      ["visual-bridge:viewer-token", "old-token"],
      ["visual-bridge:viewer-last-sequence", "84"],
    ]);
    vi.stubGlobal("location", {
      hash: "#visual-view=new-token",
      pathname: "/_visual/viewer",
      search: "",
    });
    vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    expect(consumeViewerToken()).toBe("new-token");
    expect(values.get("visual-bridge:viewer-token")).toBe("new-token");
    expect(values.has("visual-bridge:viewer-last-sequence")).toBe(false);
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

describe("task log summaries", () => {
  const event = (payload: unknown): ServerEvent => ({
    seq: 1,
    type: "task.agent_event",
    projectId: "project",
    taskId: "task-1",
    payload,
    createdAt: "2026-08-03T00:00:00.000Z",
  });

  it("preserves full multiline live output for both log surfaces", () => {
    const message = `  Claude output\n${"long text ".repeat(100)}\n  final line\n`;
    const output = event({ event: { type: "message", message } });
    expect(logFromEvent(output)).toBe(message);
    const summary = event({ event: { type: "tool_start", name: "Read", summary: message } });
    expect(logFromEvent(summary)).toBe(`도구 시작 · Read · ${message}`);
  });

  it("shows the effective RTK command and cwd without shell-wrapper noise", () => {
    expect(
      logFromEvent(
        event({
          event: {
            type: "command",
            command: "/usr/bin/zsh -lc 'rtk git status --short'",
            cwd: "/home/elicie/Dev/ai-canvas",
            durationMs: 4,
            usedRtk: true,
            truncated: true,
          },
        }),
      ),
    ).toBe("RTK · rtk git status --short · ai-canvas · 4ms · 출력 축약");
    expect(
      logFromEvent(
        event({
          event: {
            type: "tool_start",
            name: "command_execution",
            summary: "/usr/bin/zsh -lc 'rtk git status --short'",
          },
        }),
      ),
    ).toBeNull();
    expect(
      logFromEvent(
        event({
          event: {
            type: "tool_start",
            name: "direct_exec",
            summary: "pwd · git status --short",
          },
        }),
      ),
    ).toBeNull();
    expect(
      logFromEvent(
        event({
          event: {
            type: "usage",
            inputTokens: 12_000,
            cachedInputTokens: 9_000,
            outputTokens: 450,
          },
        }),
      ),
    ).toBe("토큰 · 입력 12,000 · 캐시 9,000 · 출력 450");
  });
});

describe("bridge event sequencing", () => {
  it("reports a sequence gap without delivering late duplicate events", () => {
    const values = new Map<string, string>([
      ["visual-bridge:viewer-last-sequence", "5"],
    ]);
    vi.stubGlobal("location", {
      href: "http://dev:10001/_visual/viewer",
      protocol: "http:",
    });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal("WebSocket", FakeBrowserSocket);

    const received: ServerEvent[] = [];
    const gaps: Array<{ expectedSequence: number; receivedSequence: number }> = [];
    const connection = new BridgeConnection({
      token: "viewer-token",
      browserSessionId: BROWSER_A,
      mode: "viewer",
      onSnapshot: () => {},
      onEvent: (event) => received.push(event),
      onSequenceGap: (gap) => gaps.push(gap),
    });
    connection.connect();

    const socket = FakeBrowserSocket.instances[0];
    expect(socket).toBeDefined();
    socket?.open();
    socket?.receive({ type: "auth.ok", projectId: "project" });
    expect(socket?.sent.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ type: "auth", payload: { token: "viewer-token" } }),
      expect.objectContaining({ type: "browser.hello", payload: { lastSeq: 5 } }),
    ]);

    const event = (seq: number): ServerEvent => ({
      seq,
      type: "task.phase_changed",
      projectId: "project",
      taskId: "task-1",
      payload: {},
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    socket?.receive(event(6));
    socket?.receive(event(8));
    socket?.receive(event(7));

    expect(gaps).toEqual([{ expectedSequence: 7, receivedSequence: 8 }]);
    expect(received.map((item) => item.seq)).toEqual([6, 8]);
    expect(values.get("visual-bridge:viewer-last-sequence")).toBe("8");
    connection.close();
  });
});

describe("draggable surfaces", () => {
  const size = { width: 360, height: 48 };
  const viewport = { width: 1280, height: 800 };

  it("keeps a dragged strip inside the viewport margin", () => {
    expect(clampDragPosition({ left: -40, top: -10 }, size, viewport, 8)).toEqual({ left: 8, top: 8 });
    expect(clampDragPosition({ left: 2000, top: 2000 }, size, viewport, 8)).toEqual({
      left: 1280 - 360 - 8,
      top: 800 - 48 - 8,
    });
    expect(clampDragPosition({ left: 100.4, top: 200.6 }, size, viewport, 8)).toEqual({ left: 100, top: 201 });
  });

  it("pins to the margin when the surface is wider than the viewport", () => {
    expect(clampDragPosition({ left: 50, top: 50 }, size, { width: 300, height: 40 }, 8)).toEqual({
      left: 8,
      top: 8,
    });
  });
});

describe("task list ordering", () => {
  const older = { id: "task-a", createdAt: "2026-07-31T00:00:00.000Z", status: "accepted" };
  const newer = { id: "task-b", createdAt: "2026-07-31T00:05:00.000Z", status: "queued" };
  const tie = { id: "task-c", createdAt: "2026-07-31T00:05:00.000Z", status: "queued" };

  it("orders newest first and breaks timestamp ties by id", () => {
    expect(orderTasks([older, newer, tie]).map((task) => task.id)).toEqual([
      "task-c", "task-b", "task-a",
    ]);
  });

  it("upserts live task records without duplicating or reordering unrelated rows", () => {
    const inserted = upsertTask([older], newer);
    expect(inserted.map((task) => task.id)).toEqual(["task-b", "task-a"]);
    const updated = upsertTask(inserted, { ...newer, status: "review" });
    expect(updated).toHaveLength(2);
    expect(updated[0]).toEqual({ ...newer, status: "review" });
    expect(upsertTask([], older)).toEqual([older]);
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
        JSON.stringify({
          tasks: [task, { ...task, id: "unknown", status: "future-phase" }, { id: "incomplete" }],
        }),
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

  it("loads a viewer-scoped URL with the control pairing token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer fixture-token",
        );
        return new Response(
          JSON.stringify({
            viewerUrl: "/_visual/viewer#visual-view=viewer-token",
          }),
        );
      }),
    );

    await expect(fetchViewerUrl("fixture-token")).resolves.toBe(
      "/_visual/viewer#visual-view=viewer-token",
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

  it("loads all persisted viewer logs without clipping multiline or repeated entries", async () => {
    const message = `  persisted\n${"full output ".repeat(100)}\n  final line\n`;
    const messages = [message, ...Array.from({ length: 45 }, (_, index) => `entry ${index}`), message, message];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/logs")) {
        return new Response(JSON.stringify({ logs: messages.map((text, index) => ({
          id: `log-${index}`, event: { type: "message", message: text },
        })) }));
      }
      return new Response(JSON.stringify(path.endsWith("/diff") ? { diff: "" } : []));
    }));
    const full = await fetchTaskArtifacts("fixture-token", "task-1", undefined, { logHistory: "all" });
    expect(full.logs).toEqual(messages);
    const compact = await fetchTaskArtifacts("fixture-token", "task-1");
    expect(compact.logs).toEqual(messages.slice(-40));
  });

  it("cancels superseded artifact requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
      ),
    );
    const controller = new AbortController();
    const artifacts = fetchTaskArtifacts(
      "fixture-token",
      "task-1",
      controller.signal,
    );
    controller.abort();

    await expect(artifacts).rejects.toMatchObject({ name: "AbortError" });
  });
});
