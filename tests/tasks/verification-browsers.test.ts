import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ContextBundle } from "@visual-remote/protocol";
import { EgoComparisonBrowser, type EgoScriptRunner } from "../../packages/bridge-core/src/comparison/ego-browser.js";
import { VerificationBrowserRouter, type VerificationBrowserDriver } from "../../packages/bridge-core/src/comparison/router.js";

const RESULT = "__VISUAL_RESULT__";
const UPSTREAM = "http://127.0.0.1:9011";

function context(overrides: Partial<ContextBundle["request"]> = {}, text = "Original"): ContextBundle {
  return {
    version: 1, projectId: "browser-test", browserSessionId: randomUUID(),
    page: { url: "http://localhost:9011/frame?view=one#target", pathname: "/frame", title: "Original", viewport: { width: 320, height: 240 }, devicePixelRatio: 2, scroll: { x: 0, y: 12 }, renderRevision: 0 },
    selection: { mode: "element", targets: [{ targetId: "selected", order: 0, dom: { tagName: "div", id: "target", classNames: [], text, attributes: {}, rect: { x: 20, y: 30, width: 120, height: 60 }, locatorCandidates: [{ type: "id", value: "target", confidence: 1 }], parentPath: [] }, styles: {}, source: { stack: [], confidence: "unknown" } }] },
    request: { text: "Compare", scope: "instance", ...overrides },
  };
}

function fakeDriver(name: string, calls: string[]): VerificationBrowserDriver {
  return {
    open: async () => { calls.push(`${name}:open`); return { status: "ready", message: name }; },
    begin: async (taskId) => { calls.push(`${name}:begin:${taskId}`); },
    capture: async (taskId, _context, size) => { calls.push(`${name}:capture:${taskId}`); return { requestId: "r", taskId, ...size, targets: [], pngBase64: "" }; },
    finish: async (taskId) => { calls.push(`${name}:finish:${taskId}`); },
    close: async () => { calls.push(`${name}:close`); },
  };
}

describe("verification browser router", () => {
  it("routes by request choice, remembers the driver per task and reports what is available", async () => {
    const calls: string[] = [];
    const router = new VerificationBrowserRouter({ playwright: fakeDriver("pw", calls), ego: fakeDriver("ego", calls) }, "ego");
    expect(router.info()).toEqual({ browsers: ["playwright", "ego"], defaultBrowser: "ego" });
    expect(router.kindFor(context())).toBe("ego");
    expect(router.kindFor(context({ comparison: { enabled: true, browser: "playwright", maxIterations: 4, targetMatch: 99, threshold: 30 } }))).toBe("playwright");

    const signal = new AbortController().signal;
    const explicit = context({ comparison: { enabled: true, browser: "playwright", maxIterations: 4, targetMatch: 99, threshold: 30 } });
    await router.begin("t1", explicit, signal);
    await router.capture("t1", context(), { width: 1, height: 1 }, signal);
    await router.finish("t1");
    await router.begin("t2", context(), signal);
    await router.finish("t2");
    await expect(router.capture("t3", context(), { width: 1, height: 1 }, signal)).rejects.toThrow("No active verification page");
    await router.close();
    expect(calls).toEqual(["pw:begin:t1", "pw:capture:t1", "pw:finish:t1", "ego:begin:t2", "ego:finish:t2", "pw:close", "ego:close"]);
  });

  it("explains a missing ego lite driver and refuses an unavailable default", () => {
    const calls: string[] = [];
    const router = new VerificationBrowserRouter({ playwright: fakeDriver("pw", calls) }, "playwright");
    expect(router.info()).toEqual({ browsers: ["playwright"], defaultBrowser: "playwright" });
    const wantsEgo = context({ comparison: { enabled: true, browser: "ego", maxIterations: 4, targetMatch: 99, threshold: 30 } });
    expect(() => router.open(wantsEgo)).toThrow(/ego-browser command is not available/);
    expect(() => new VerificationBrowserRouter({ playwright: fakeDriver("pw", calls) }, "ego")).toThrow(/not available/);
  });
});

describe("ego lite verification browser", () => {
  function runnerWith(outputs: Array<string | ((script: string) => string)>): { runner: EgoScriptRunner; scripts: string[] } {
    const scripts: string[] = [];
    const runner = vi.fn(async (script: string) => {
      scripts.push(script);
      const next = outputs.shift();
      if (next === undefined) throw new Error("unexpected ego script");
      return typeof next === "function" ? next(script) : next;
    });
    return { runner, scripts };
  }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

  it("maps the page onto the upstream, keeps the task-space ids and captures through the same tab", async () => {
    const { runner, scripts } = runnerWith([
      `noise\n${RESULT}${JSON.stringify({ ok: true, texts: ["Original"], rect: { x: 20, y: 30, width: 120, height: 60 } })}\n`,
      `${RESULT}${JSON.stringify({ ok: true, pngBase64: png, targets: [{ text: "Original", rect: { x: 0, y: 0, width: 10, height: 10 }, styles: {} }], crop: { x: 20, y: 30, width: 120, height: 60 } })}`,
      `${RESULT}${JSON.stringify({ ok: true })}`,
    ]);
    const browser = new EgoComparisonBrowser({ upstreamUrl: UPSTREAM, runner, taskSpaceName: "space" });
    const signal = new AbortController().signal;
    await browser.begin("task-1", context(), signal);
    expect(scripts[0]).toContain('"url":"http://localhost:9011/frame?view=one#target"');
    expect(scripts[0]).toMatch(/"spaceName":"space task-1 preflight [0-9a-f]{8}"/);
    expect(scripts[0]).toContain("useOrCreateTaskSpace(ARGS.spaceName)");
    expect(scripts[0]).toContain("completeTaskSpace(space.id, { keep: false })");
    const capture = await browser.capture("task-1", context(), { width: 120, height: 60 }, signal);
    expect(capture).toMatchObject({ taskId: "task-1", width: 120, height: 60, pngBase64: png });
    expect(capture.targets).toHaveLength(1);
    expect(scripts[1]).toMatch(/"spaceName":"space task-1 capture [0-9a-f]{8}"/);
    expect(scripts[1]).toContain("Page.captureScreenshot");
    await browser.finish("task-1");
    expect(scripts[2]).toContain('"spacePrefix":"space task-1"');
    expect(scripts[2]).toContain("listTaskSpaces()");
    expect(runner).toHaveBeenCalledTimes(3);
    await browser.close();
  });

  it("reports route changes with redacted diagnostics and retries text mismatches until they settle", async () => {
    const route = runnerWith([
      `${RESULT}${JSON.stringify({ ok: false, kind: "route", actual: "http://localhost:9011/login?token=secret" })}`,
      `${RESULT}${JSON.stringify({ ok: true })}`,
    ]);
    const routed = new EgoComparisonBrowser({ upstreamUrl: UPSTREAM, runner: route.runner });
    await expect(routed.begin("task-2", context(), new AbortController().signal)).rejects.toThrow(
      /Expected: http:\/\/localhost:9011\/frame; actual: http:\/\/localhost:9011\/login\./,
    );

    const settle = runnerWith([
      `${RESULT}${JSON.stringify({ ok: true, texts: ["Loading…"], rect: { x: 0, y: 0, width: 1, height: 1 } })}`,
      `${RESULT}${JSON.stringify({ ok: true, texts: ["Original"], rect: { x: 0, y: 0, width: 1, height: 1 } })}`,
    ]);
    const settling = new EgoComparisonBrowser({ upstreamUrl: UPSTREAM, runner: settle.runner, preflightTimeoutMs: 5_000 });
    await settling.begin("task-3", context(), new AbortController().signal);
    expect(settle.runner).toHaveBeenCalledTimes(2);
    await settling.close();
  });

  it("captures page mode at the reference size and measures before implementing", async () => {
    const { runner, scripts } = runnerWith([
      `${RESULT}${JSON.stringify({ ok: true, texts: ["Original"], rect: { x: 0, y: 0, width: 320, height: 240 } })}`,
      `${RESULT}${JSON.stringify({ ok: true, rect: { x: 0, y: 0, width: 320, height: 240 } })}`,
      `${RESULT}${JSON.stringify({ ok: true, pngBase64: png, targets: [], crop: { x: 0, y: 0, width: 1672, height: 709 } })}`,
      `${RESULT}${JSON.stringify({ ok: true })}`,
    ]);
    const browser = new EgoComparisonBrowser({ upstreamUrl: UPSTREAM, runner });
    const page = context();
    page.selection = { mode: "page", targets: page.selection.targets };
    const signal = new AbortController().signal;
    await browser.begin("page-task", page, signal);
    expect(await browser.measure("page-task", page, signal)).toEqual({ x: 0, y: 0, width: 320, height: 240 });
    expect(scripts[1]).toMatch(/"spaceName":"Visual Remote verification page-tas measure [0-9a-f]{8}"/);
    await browser.capture("page-task", page, { width: 1672, height: 709 }, signal);
    expect(scripts[2]).toContain('"viewport":{"width":1672,"height":709}');
    await browser.finish("page-task");

    const mismatch = runnerWith([
      `${RESULT}${JSON.stringify({ ok: true, texts: ["Original"], rect: { x: 20, y: 30, width: 120, height: 60 } })}`,
      `${RESULT}${JSON.stringify({ ok: false, kind: "crop", crop: { x: 20, y: 30, width: 1405, height: 877 } })}`,
      `${RESULT}${JSON.stringify({ ok: true })}`,
    ]);
    const element = new EgoComparisonBrowser({ upstreamUrl: UPSTREAM, runner: mismatch.runner });
    await element.begin("element-task", context(), signal);
    await expect(element.capture("element-task", context(), { width: 1672, height: 709 }, signal)).rejects.toThrow(
      /1405×877px must be fully visible and exactly match reference 1672×709px\. Pixel comparison needs identical sizes: select a target or region/,
    );
  });

  it("fails clearly when ego lite prints no result or the page script throws", async () => {
    const missing = new EgoComparisonBrowser({ upstreamUrl: UPSTREAM, runner: async () => "task space id: 3\n" });
    await expect(missing.begin("task-4", context(), new AbortController().signal)).rejects.toThrow(/did not report a verification result/);
    const thrown = new EgoComparisonBrowser({ upstreamUrl: UPSTREAM, runner: async () => `${RESULT}${JSON.stringify({ ok: false, kind: "error", error: "JavaScript evaluation failed at line 0, column 9: Error: Verification target has no valid supported selector. Target 1.\n    at <anonymous>:1:16; expression: (() => 1)()" })}` });
    await expect(thrown.begin("task-5", context(), new AbortController().signal)).rejects.toThrow("Verification target has no valid supported selector. Target 1.");
    await expect(thrown.capture("task-5", context(), { width: 1, height: 1 }, new AbortController().signal)).rejects.toThrow("No active verification page");
  });
});
