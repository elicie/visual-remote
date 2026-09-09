import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult, ContextBundle } from "@visual-remote/protocol";
import { adaptContextToFrame, resamplePng, scaleTargets } from "../../packages/bridge-core/src/comparison/fit.js";
import { runDesignComparison } from "../../packages/bridge-core/src/comparison/engine.js";

const FIGMA = "https://www.figma.com/design/abc123/Test?node-id=1-2";

function context(mode: "element" | "region" | "page" = "element"): ContextBundle {
  const target = { targetId: "t", order: 0, dom: { tagName: "div", id: "target", classNames: [], text: "Original", attributes: {}, rect: { x: 0, y: 0, width: 320, height: 240 }, locatorCandidates: [{ type: "id" as const, value: "target", confidence: 1 }], parentPath: [] }, styles: {}, source: { stack: [], confidence: "unknown" as const } };
  return {
    version: 1, projectId: "fit-test", browserSessionId: randomUUID(),
    page: { url: "http://localhost:9011/screen", pathname: "/screen", title: "Screen", viewport: { width: 320, height: 240 }, devicePixelRatio: 2, scroll: { x: 0, y: 0 }, renderRevision: 0 },
    selection: mode === "region" ? { mode, region: { x: 10, y: 20, width: 100, height: 50 }, targets: [target] } : mode === "page" ? { mode, targets: [target] } : { mode, targets: [target] },
    request: { text: "match figma", scope: "instance", comparison: { enabled: true, url: FIGMA, maxIterations: 1, targetMatch: 99, threshold: 30 } },
  };
}

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = rgb[0]; png.data[index + 1] = rgb[1]; png.data[index + 2] = rgb[2]; png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("fitting the selection to the Figma frame", () => {
  it("grows or shrinks the viewport by the measured difference for full-bleed elements", () => {
    const adapted = adaptContextToFrame(context(), { width: 320, height: 240 }, { width: 1920, height: 1080 });
    expect(adapted?.page.viewport).toEqual({ width: 1920, height: 1080 });
    const smaller = adaptContextToFrame(context(), { width: 200, height: 100 }, { width: 100, height: 40 });
    expect(smaller?.page.viewport).toEqual({ width: 220, height: 180 });
    expect(adaptContextToFrame(context(), { width: 64, height: 64 }, { width: 64, height: 64 })).toBeUndefined();
  });

  it("resizes a region in place and enlarges the viewport only when the frame would not fit", () => {
    const fits = adaptContextToFrame(context("region"), { width: 100, height: 50 }, { width: 200, height: 100 });
    expect(fits?.selection).toMatchObject({ mode: "region", region: { x: 10, y: 20, width: 200, height: 100 } });
    expect(fits?.page.viewport).toEqual({ width: 320, height: 240 });
    const grows = adaptContextToFrame(context("region"), { width: 100, height: 50 }, { width: 400, height: 300 });
    expect(grows?.page.viewport).toEqual({ width: 410, height: 320 });
    expect(adaptContextToFrame(context("page"), { width: 320, height: 240 }, { width: 1672, height: 709 })?.page.viewport).toEqual({ width: 1672, height: 709 });
  });

  it("resamples captures and scales text rectangles consistently", () => {
    const source = PNG.sync.read(solidPng(40, 20, [31, 111, 235]));
    const scaled = resamplePng(source, 64, 64);
    expect([scaled.width, scaled.height]).toEqual([64, 64]);
    expect([...scaled.data.subarray(0, 4)]).toEqual([31, 111, 235, 255]);
    expect([...scaled.data.subarray(scaled.data.length - 4)]).toEqual([31, 111, 235, 255]);
    expect(scaleTargets([{ text: "a", rect: { x: 10, y: 5, width: 20, height: 10 }, styles: {} }], 1.6, 3.2)).toEqual([
      { text: "a", rect: { x: 16, y: 16, width: 32, height: 32 }, styles: {} },
    ]);
  });
});

describe("design comparison keeps going when sizes differ", () => {
  const cleanups: string[] = [];
  afterEach(async () => { for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true }); });

  async function run(mode: "element" | "region", measure: (context: ContextBundle) => { width: number; height: number }) {
    const root = await mkdtemp(join(tmpdir(), "visual-fit-"));
    cleanups.push(root);
    const taskId = "task-fit";
    const states: string[] = [];
    const captures: Array<{ size: { width: number; height: number }; viewport: { width: number; height: number } }> = [];
    const measureSpy = vi.fn(async (working: ContextBundle) => measure(working));
    const result = await runDesignComparison({
      taskId, context: context(mode), root, signal: new AbortController().signal,
      runAgent: async (prompt) => {
        if (!prompt.includes("COMPARISON_PHASE=REFERENCE_ONLY")) return;
        const directory = join(root, taskId);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "reference.png"), solidPng(64, 64, [31, 111, 235]));
        await writeFile(join(directory, "reference.json"), JSON.stringify({ width: 64, height: 64, targets: [], sourceUrl: FIGMA, nodeId: "1:2" }));
      },
      measure: measureSpy,
      capture: async (size, working): Promise<CaptureResult> => {
        captures.push({ size, viewport: working.page.viewport });
        return { requestId: randomUUID(), taskId, ...size, targets: [], pngBase64: solidPng(size.width, size.height, [31, 111, 235]).toString("base64") };
      },
      onState: (state) => states.push(`${state.status}: ${state.message ?? ""}`),
    });
    return { result, states, captures, measureSpy };
  }

  it("adapts the verification viewport so a responsive element renders at the frame size", async () => {
    const { result, captures, measureSpy } = await run("element", (working) =>
      working.page.viewport.width === 320 + 32 ? { width: 64, height: 64 } : { width: 32, height: 32 },
    );
    expect(result.status).toBe("passed");
    expect(measureSpy).toHaveBeenCalledTimes(2);
    expect(captures).toEqual([{ size: { width: 64, height: 64 }, viewport: { width: 352, height: 272 } }]);
    expect(result.iterations[0]?.scaled).toBeUndefined();
  });

  it("scales captures of fixed-size elements instead of failing", async () => {
    const { result, states, captures } = await run("element", () => ({ width: 40, height: 20 }));
    expect(result.status).toBe("passed");
    expect(captures.at(-1)?.size).toEqual({ width: 40, height: 20 });
    expect(result.iterations[0]?.scaled).toEqual({ width: 40, height: 20 });
    expect(states.some((entry) => entry.includes("renders at 40×20px while the Figma frame is 64×64px"))).toBe(true);
  });
});
