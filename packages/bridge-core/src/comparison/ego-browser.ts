import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { CaptureResult, ComparisonMeasuredTarget, ContextBundle, Rect } from "@visual-remote/protocol";
import { redactText } from "../context/sanitize.js";
import {
  captureContext,
  collectTextTargets,
  cropMismatchMessage,
  decodeVisibleImages,
  diagnosticRoute,
  measureGeometry,
  prepareCaptureStyles,
  resolveVerificationUrl,
  restoreCaptureStyles,
  settlePage,
} from "./page-scripts.js";
import type { VerificationBrowserDriver } from "./router.js";

const TIMEOUT = 30_000;
/** Process start-up and task-space bookkeeping on top of the page deadline. */
const RUNTIME_OVERHEAD_MS = 15_000;
const RESULT_PREFIX = "__VISUAL_RESULT__";
const HELP = "ego lite verification runs in an isolated task space of your ego lite profile and reuses its login state. Only URL-addressable state is supported; the original tab's in-memory modals, form values and sessionStorage are not copied.";
const NOT_FOUND = "ego-browser command was not found. Install ego lite (https://lite.ego.app/) and finish onboarding, or choose the separate verification browser.";

export type EgoScriptRunner = (
  script: string,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<string>;

export interface EgoComparisonBrowserOptions {
  upstreamUrl: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  preflightTimeoutMs?: number;
  /** Name of the ego lite task space that hosts verification tabs. */
  taskSpaceName?: string;
  /** Replaces the `ego-browser nodejs` child process (tests). */
  runner?: EgoScriptRunner;
}

interface ActiveTask {
  id: string;
  url: string;
  /** Task-space name prefix shared by every script of this task, for cleanup. */
  spacePrefix: string;
  signal: AbortSignal;
}

interface ScriptFailure { ok: false; kind: "route" | "mismatch" | "error" | "crop"; error?: string; actual?: string; crop?: Rect }
interface BeginSuccess { ok: true; texts: Array<string | null>; rect: Rect }
interface CaptureSuccess { ok: true; pngBase64: string; targets: ComparisonMeasuredTarget[]; crop: Rect }
interface MeasureSuccess { ok: true; rect: Rect }

/** Resolves the ego lite CLI from PATH, falling back to its default install location. */
export async function findEgoBrowserExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const name = process.platform === "win32" ? "ego-browser.exe" : "ego-browser";
  const candidates = (environment.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => join(entry, name));
  candidates.push(join(environment.HOME ?? homedir(), ".local", "bin", name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  return undefined;
}

function tail(value: string, length = 400): string {
  const trimmed = value.trim();
  return redactText(trimmed.length > length ? `…${trimmed.slice(-length)}` : trimmed, length + 1);
}

export function createEgoScriptRunner(executable: string, environment: NodeJS.ProcessEnv = process.env): EgoScriptRunner {
  return (script, { timeoutMs, signal }) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(executable, ["nodejs"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: environment,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        child.kill("SIGKILL");
        finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Verification canceled.")));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`ego lite verification timed out after ${Math.round(timeoutMs / 1000)}s. ${HELP}`)));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (stdout.length < 64 * 1024 * 1024) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        if (stderr.length < 1024 * 1024) stderr += chunk.toString();
      });
      child.once("error", (error) => finish(() => reject(new Error(`Cannot run ego-browser: ${error.message}. ${NOT_FOUND}`))));
      child.once("close", (code) => finish(() => {
        // ego lite writes cliLog output to stderr when stdout is not a TTY.
        if (code === 0) resolve(`${stdout}\n${stderr}`);
        else reject(new Error(`ego-browser exited with code ${code ?? "unknown"}: ${tail(stderr || stdout) || "no output"}`));
      }));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.on("error", () => undefined);
      child.stdin.end(script);
    });
}

function parseResult<T extends { ok: boolean }>(output: string): T | ScriptFailure {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`ego lite did not report a verification result: ${tail(output) || "no output"}`);
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as T | ScriptFailure;
  } catch {
    throw new Error("ego lite reported an unreadable verification result.");
  }
}

/** Strips the evaluation wrapper ego lite adds around page-side exceptions. */
function pageErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const unwrapped = raw.replace(/^JavaScript evaluation failed[^:]*:\s*/u, "").replace(/^(?:[A-Za-z]*Error): /u, "");
  return unwrapped.split(/\n\s+at |; expression: /u)[0]?.trim() ?? raw;
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The Node side of a verification script. Page routines are embedded as
 * source strings and evaluated in the tab through ego lite's `js()`.
 *
 * Every script owns a fresh task space and closes it before exiting: a tab
 * created by an earlier `ego-browser nodejs` process stops producing
 * screenshots once that process is gone, so nothing is shared across runs.
 */
function scriptPrelude(args: Record<string, unknown>): string {
  return [
    `const ARGS = ${serialize(args)};`,
    `const PAGE = { settle: ${serialize(settlePage.toString())}, measure: ${serialize(measureGeometry.toString())}, decode: ${serialize(decodeVisibleImages.toString())}, collect: ${serialize(collectTextTargets.toString())}, prepare: ${serialize(prepareCaptureStyles.toString())}, restore: ${serialize(restoreCaptureStyles.toString())} };`,
    `const emit = (value) => cliLog(${serialize(RESULT_PREFIX)} + JSON.stringify(value));`,
    "const evalPage = (source, argument) => js('(' + source + ')(' + JSON.stringify(argument) + ')');",
    "const message = (error) => (error && typeof error === 'object' && 'message' in error) ? String(error.message) : String(error);",
    "const viewport = { width: ARGS.viewport.width, height: ARGS.viewport.height, deviceScaleFactor: 1, mobile: false };",
    "let space;",
    "async function openTaskTab() {",
    "  space = await useOrCreateTaskSpace(ARGS.spaceName);",
    "  const tab = await openOrReuseTab(ARGS.url, { wait: true, timeout: ARGS.timeoutSeconds });",
    "  await cdp('Page.bringToFront').catch(() => {});",
    "  await cdp('Emulation.setDeviceMetricsOverride', viewport);",
    "  await gotoAndWait(ARGS.url, { timeout: ARGS.timeoutSeconds });",
    "  return tab;",
    "}",
    "async function closeTaskSpace() {",
    "  if (space === undefined) return;",
    "  await completeTaskSpace(space.id, { keep: false }).catch(() => {});",
    "}",
    "async function checkRoute() {",
    "  const info = await pageInfo();",
    "  if (info && info.dialog) { await cdp('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); throw new Error('Verification page opened a dialog. ' + ARGS.help); }",
    "  if (!info || info.url !== ARGS.url) { emit({ ok: false, kind: 'route', actual: info ? info.url : undefined }); return false; }",
    "  return true;",
    "}",
  ].join("\n");
}

function beginScript(args: Record<string, unknown>): string {
  return `${scriptPrelude(args)}
try {
  await openTaskTab();
  if (!(await checkRoute())) throw null;
  await evalPage(PAGE.settle, ARGS.scroll);
  const deadline = Date.now() + ARGS.pollMs;
  let matching = 0, mismatch, last;
  while (matching < 2) {
    const measured = await evalPage(PAGE.measure, { context: ARGS.context, preflight: true, help: ARGS.help });
    if (measured && measured.mismatch) {
      matching = 0; mismatch = measured.mismatch;
      if (Date.now() > deadline) break;
      await wait(0.1);
      continue;
    }
    matching += 1; last = measured;
    if (matching < 2) await wait(0.1);
  }
  if (matching < 2) emit({ ok: false, kind: 'mismatch', error: mismatch });
  else emit({ ok: true, texts: last.texts.map((text) => text === undefined ? null : text), rect: last.rect });
} catch (error) {
  if (error !== null) emit({ ok: false, kind: 'error', error: message(error) });
} finally {
  await closeTaskSpace();
}
`;
}

function captureScript(args: Record<string, unknown>): string {
  return `${scriptPrelude(args)}
try {
  await openTaskTab();
  if (!(await checkRoute())) throw null;
  await evalPage(PAGE.settle, ARGS.scroll);
  const measure = async () => {
    const measured = await evalPage(PAGE.measure, { context: ARGS.context, preflight: false, help: ARGS.help });
    if (measured && measured.mismatch) throw new Error(measured.mismatch);
    return measured.rect;
  };
  let crop = await measure();
  await evalPage(PAGE.decode, crop);
  crop = await measure();
  const size = ARGS.size, page = ARGS.viewport;
  if (crop.width !== size.width || crop.height !== size.height || crop.x < 0 || crop.y < 0 || crop.x + crop.width > page.width || crop.y + crop.height > page.height) {
    emit({ ok: false, kind: 'crop', crop });
    throw null;
  }
  const targets = await evalPage(PAGE.collect, crop);
  await evalPage(PAGE.prepare, null);
  let shot;
  try {
    shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: crop.x, y: crop.y, width: crop.width, height: crop.height, scale: 1 }, captureBeyondViewport: false });
  } finally {
    await evalPage(PAGE.restore, null).catch(() => {});
  }
  const finalCrop = await measure();
  if (['x', 'y', 'width', 'height'].some((key) => crop[key] !== finalCrop[key])) throw new Error('Verification target moved during capture; wait for stable layout and retry.');
  emit({ ok: true, pngBase64: shot.data, targets, crop });
} catch (error) {
  if (error !== null) emit({ ok: false, kind: 'error', error: message(error) });
} finally {
  await closeTaskSpace();
}
`;
}

function measureScript(args: Record<string, unknown>): string {
  return `${scriptPrelude(args)}
try {
  await openTaskTab();
  if (!(await checkRoute())) throw null;
  await evalPage(PAGE.settle, ARGS.scroll);
  const measured = await evalPage(PAGE.measure, { context: ARGS.context, preflight: false, help: ARGS.help });
  if (measured && measured.mismatch) throw new Error(measured.mismatch);
  emit({ ok: true, rect: measured.rect });
} catch (error) {
  if (error !== null) emit({ ok: false, kind: 'error', error: message(error) });
} finally {
  await closeTaskSpace();
}
`;
}

function cleanupScript(args: Record<string, unknown>): string {
  return `${scriptPrelude(args)}
try {
  for (const candidate of await listTaskSpaces()) {
    if (typeof candidate.name === 'string' && candidate.name.startsWith(ARGS.spacePrefix)) {
      await completeTaskSpace(candidate.id, { keep: false }).catch(() => {});
    }
  }
} catch (error) {
  // Best effort: a killed script may have left a task space behind.
}
emit({ ok: true });
`;
}

/**
 * Verification browser backed by ego lite. Every operation runs a short
 * `ego-browser nodejs` script; ego lite keeps the task space and tab alive
 * between them, so the Bridge only stores their ids.
 */
export class EgoComparisonBrowser implements VerificationBrowserDriver {
  private active: ActiveTask | undefined;
  private closed = false;
  private readonly upstream: URL;
  private readonly runner: EgoScriptRunner | undefined;
  private runnerPromise: Promise<EgoScriptRunner> | undefined;

  constructor(private readonly options: EgoComparisonBrowserOptions) {
    this.upstream = new URL(options.upstreamUrl);
    if (!["http:", "https:"].includes(this.upstream.protocol) || this.upstream.username || this.upstream.password) throw new Error("Verification upstream must be an HTTP(S) URL without credentials.");
    if (options.preflightTimeoutMs !== undefined && (!Number.isFinite(options.preflightTimeoutMs) || options.preflightTimeoutMs <= 0 || options.preflightTimeoutMs > TIMEOUT)) throw new Error("Verification preflight timeout must be greater than zero and at most 30000 milliseconds.");
    this.runner = options.runner;
  }

  private async getRunner(): Promise<EgoScriptRunner> {
    if (this.runner) return this.runner;
    this.runnerPromise ??= (async () => {
      const executable = this.options.executable ?? (await findEgoBrowserExecutable(this.options.environment));
      if (!executable) throw new Error(NOT_FOUND);
      return createEgoScriptRunner(executable, this.options.environment);
    })();
    return this.runnerPromise;
  }

  private get spacePrefixBase(): string {
    return this.options.taskSpaceName ?? "Visual Remote verification";
  }

  private async run<T extends { ok: boolean }>(script: string, timeoutMs: number, signal?: AbortSignal): Promise<T | ScriptFailure> {
    if (this.closed) throw new Error("Verification browser is closed.");
    const runner = await this.getRunner();
    return parseResult<T>(await runner(script, { timeoutMs, ...(signal ? { signal } : {}) }));
  }

  async open(context?: ContextBundle): Promise<{ status: "ready"; message: string }> {
    resolveVerificationUrl(this.upstream, context);
    if (!(await findEgoBrowserExecutable(this.options.environment)) && !this.runner && !this.options.executable) throw new Error(NOT_FOUND);
    return { status: "ready", message: "ego lite reuses your current login state in an isolated task space; no separate sign-in is needed. In-memory state is not copied." };
  }

  private spaceName(task: ActiveTask, phase: string): string {
    return `${task.spacePrefix} ${phase} ${randomUUID().slice(0, 8)}`;
  }

  async begin(taskId: string, context: ContextBundle, signal: AbortSignal): Promise<void> {
    if (this.active) throw new Error("Verification browser is busy with another task.");
    signal.throwIfAborted();
    if (!context.selection.targets.length) throw new Error(`Verification state is unverifiable without a selected target. ${HELP}`);
    const { width, height } = context.page.viewport;
    if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192)) throw new Error("Verification viewport must have integer dimensions between 1 and 8192 pixels.");
    const task: ActiveTask = { id: taskId, url: resolveVerificationUrl(this.upstream, context), spacePrefix: `${this.spacePrefixBase} ${taskId.slice(0, 8)}`, signal };
    this.active = task;
    const preflightMs = this.options.preflightTimeoutMs ?? TIMEOUT;
    const deadline = Date.now() + preflightMs;
    try {
      let lastMismatch: string | undefined;
      for (;;) {
        signal.throwIfAborted();
        const remaining = Math.max(1_000, deadline - Date.now());
        const result = await this.run<BeginSuccess>(
          beginScript({ spaceName: this.spaceName(task, "preflight"), url: task.url, viewport: { width, height }, scroll: context.page.scroll, context, help: HELP, timeoutSeconds: Math.ceil(remaining / 1000), pollMs: remaining }),
          remaining + RUNTIME_OVERHEAD_MS,
          signal,
        );
        if (!result.ok) throw this.failure(task, result, lastMismatch);
        const mismatch = this.textMismatch(context, result.texts);
        if (!mismatch) return;
        lastMismatch = mismatch;
        if (Date.now() >= deadline) throw new Error(`${mismatch} The required state did not settle before the verification deadline.`);
      }
    } catch (error) {
      await this.finish(taskId);
      throw error;
    }
  }

  private failure(task: ActiveTask, result: ScriptFailure, lastMismatch?: string): Error {
    if (result.kind === "route") {
      return new Error(`Verification route redirected or changed. Expected: ${diagnosticRoute(task.url)}; actual: ${diagnosticRoute(result.actual)}. Query strings, fragments and credentials are omitted from these addresses; the full URLs must match exactly. Check application redirects and URL-addressable state, not only login. ${HELP}`);
    }
    if (result.kind === "mismatch") {
      return new Error(`${result.error ?? lastMismatch ?? "Verification target state did not match."} The required state did not settle before the verification deadline.`);
    }
    return new Error(pageErrorMessage(result.error ?? "ego lite verification failed."));
  }

  private textMismatch(context: ContextBundle, texts: Array<string | null>): string | undefined {
    for (const [index, text] of texts.entries()) {
      if (text !== null && redactText(text) !== context.selection.targets[index]!.dom.text) {
        return `Verification target text does not match the original page. Target ${index + 1} (selection.targets[${index}].dom.locatorCandidates). Check that ego lite is signed in to the same account and shows the expected application data. ${HELP}`;
      }
    }
    return undefined;
  }

  async capture(taskId: string, context: ContextBundle, size: { width: number; height: number }, signal: AbortSignal): Promise<CaptureResult> {
    const task = this.active;
    if (!task || task.id !== taskId) throw new Error("No active verification page for this task.");
    try {
      signal.throwIfAborted();
      if (resolveVerificationUrl(this.upstream, context) !== task.url) throw new Error("Verification context route changed during the task.");
      if (![size.width, size.height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192) || size.width * size.height > 16_777_216) throw new Error("Unsupported verification image dimensions.");
      const effective = captureContext(context, size);
      const result = await this.run<CaptureSuccess>(
        captureScript({ spaceName: this.spaceName(task, "capture"), url: task.url, viewport: effective.page.viewport, scroll: effective.page.scroll, context: effective, size, help: HELP, timeoutSeconds: Math.ceil(TIMEOUT / 1000) }),
        TIMEOUT + RUNTIME_OVERHEAD_MS,
        signal,
      );
      if (!result.ok) {
        if (result.kind === "crop" && result.crop) throw new Error(cropMismatchMessage(result.crop, size, context.selection.mode));
        throw this.failure(task, result);
      }
      if (typeof result.pngBase64 !== "string" || !Array.isArray(result.targets)) throw new Error("ego lite returned an incomplete capture.");
      signal.throwIfAborted();
      return { requestId: randomUUID(), taskId, ...size, targets: result.targets, pngBase64: result.pngBase64 };
    } catch (error) {
      await this.finish(taskId);
      throw error;
    }
  }

  async measure(taskId: string, context: ContextBundle, signal: AbortSignal): Promise<Rect> {
    const task = this.active;
    if (!task || task.id !== taskId) throw new Error("No active verification page for this task.");
    signal.throwIfAborted();
    if (resolveVerificationUrl(this.upstream, context) !== task.url) throw new Error("Verification context route changed during the task.");
    const result = await this.run<MeasureSuccess>(
      measureScript({ spaceName: this.spaceName(task, "measure"), url: task.url, viewport: context.page.viewport, scroll: context.page.scroll, context, help: HELP, timeoutSeconds: Math.ceil(TIMEOUT / 1000) }),
      TIMEOUT + RUNTIME_OVERHEAD_MS,
      signal,
    );
    if (!result.ok) throw this.failure(task, result);
    return result.rect;
  }

  async finish(taskId: string): Promise<void> {
    const task = this.active;
    if (!task || task.id !== taskId) return;
    this.active = undefined;
    try {
      await this.run(cleanupScript({ spacePrefix: task.spacePrefix, url: task.url, viewport: { width: 1, height: 1 }, help: HELP }), RUNTIME_OVERHEAD_MS);
    } catch {
      // Best effort: every script closes its own task space on exit.
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const task = this.active;
    if (task) {
      this.closed = false;
      try {
        await this.finish(task.id);
      } finally {
        this.closed = true;
      }
    }
  }
}
