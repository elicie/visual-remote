/// <reference lib="dom" />
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { CaptureResult, ComparisonMeasuredTarget, ContextBundle, Rect } from "@visual-remote/protocol";
import { redactText } from "../context/sanitize.js";

const TIMEOUT = 30_000;
const HELP = "Open the verification browser and sign in to its separate profile. Only URL-addressable state is supported; original-tab in-memory modals, form values and sessionStorage are not copied.";
const INSTALL = "Verification browser is not installed. Install Google Chrome or run `npx --yes --package playwright@1.62.1 playwright install chromium`, then retry.";
const missingExecutable = (message: string) => /executable (?:doesn't exist|does not exist)|distribution ['"]?chrome['"]? is not found/i.test(message);
class VerificationStateMismatch extends Error {}
function diagnosticRoute(value: string | undefined): string {
  if (!value) return "unavailable";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? `${url.origin}${url.pathname}` : "non-HTTP(S) page";
  } catch { return "invalid URL"; }
}
export interface ComparisonBrowserOptions { profileDirectory: string; upstreamUrl: string; headless?: boolean; executablePath?: string; preflightTimeoutMs?: number }
interface ActiveTask { id: string; url: string; page?: Page; creating?: Promise<Page>; signal: AbortSignal; abort: () => void; mismatch?: string }

/** Owns only a dedicated persistent profile, never the user's existing browser. */
export class ComparisonBrowser {
  private browserContext: BrowserContext | undefined;
  private launching: Promise<BrowserContext> | undefined;
  private setupPage: Page | undefined;
  private active: ActiveTask | undefined;
  private opening = false;
  private closed = false;
  private readonly upstream: URL;
  constructor(private readonly options: ComparisonBrowserOptions) {
    this.upstream = new URL(options.upstreamUrl);
    if (!["http:", "https:"].includes(this.upstream.protocol) || this.upstream.username || this.upstream.password) throw new Error("Verification upstream must be an HTTP(S) URL without credentials.");
    if (options.preflightTimeoutMs !== undefined && (!Number.isFinite(options.preflightTimeoutMs) || options.preflightTimeoutMs <= 0 || options.preflightTimeoutMs > TIMEOUT)) throw new Error("Verification preflight timeout must be greater than zero and at most 30000 milliseconds.");
  }
  private taskUrl(context?: ContextBundle): string {
    if (!context) return this.upstream.href;
    const source = new URL(context.page.url);
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) throw new Error("Verification page must be an HTTP(S) URL without credentials.");
    const destination = new URL(this.upstream.origin);
    // Loopback aliases are distinct cookie/storage hosts; keep the source identity,
    // but never let source URLs select an arbitrary upstream or its protocol/port.
    if (["localhost", "127.0.0.1"].includes(this.upstream.hostname) && ["localhost", "127.0.0.1"].includes(source.hostname)) destination.hostname = source.hostname;
    destination.pathname = source.pathname;
    destination.search = source.search;
    destination.hash = source.hash;
    return destination.href;
  }
  private async getBrowser(): Promise<BrowserContext> {
    if (this.closed) throw new Error("Verification browser is closed.");
    if (this.browserContext) return this.browserContext;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      await mkdir(this.options.profileDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.options.profileDirectory, 0o700);
      const options = { headless: this.options.headless ?? false, viewport: null, timeout: TIMEOUT, ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}) };
      const chrome = !this.options.executablePath && !this.options.headless;
      let browser: BrowserContext;
      try { browser = await chromium.launchPersistentContext(this.options.profileDirectory, { ...options, ...(chrome ? { channel: "chrome" } : {}) }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!missingExecutable(message) || this.options.executablePath) throw new Error(`Cannot launch verification browser with its existing profile: ${message}`);
        if (!chrome) throw new Error(INSTALL);
        try { browser = await chromium.launchPersistentContext(this.options.profileDirectory, options); }
        catch (fallbackError) {
          const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          if (missingExecutable(detail)) throw new Error(INSTALL);
          throw new Error(`Cannot launch verification browser with its existing profile: ${detail}`);
        }
      }
      try {
        await browser.route(/\/_visual\/(?:client|viewer)\.js(?:\?|$)/, (route) => route.abort());
        browser.setDefaultTimeout(TIMEOUT);
        browser.setDefaultNavigationTimeout(TIMEOUT);
        if (this.closed) throw new Error("Verification browser is closed.");
        this.browserContext = browser;
        browser.on("close", () => { if (this.browserContext === browser) this.browserContext = undefined; this.setupPage = undefined; });
        return browser;
      } catch (error) { await browser.close(); throw error; }
    })();
    try { return await this.launching; } finally { this.launching = undefined; }
  }
  async open(context?: ContextBundle): Promise<{ status: "ready"; message: string }> {
    if (this.active || this.opening) throw new Error("Verification browser is busy with a comparison or setup request.");
    const url = this.taskUrl(context);
    this.opening = true;
    try {
      const browser = await this.getBrowser();
      if (!this.setupPage || this.setupPage.isClosed()) this.setupPage = await browser.newPage();
      await this.setupPage.goto(url, { waitUntil: "domcontentloaded" });
      await this.setupPage.bringToFront();
      return { status: "ready", message: "Verification browser opened. Sign in here once; comparisons use new tabs in this separate profile. In-memory state is not copied." };
    } finally { this.opening = false; }
  }
  async begin(taskId: string, context: ContextBundle, signal: AbortSignal): Promise<void> {
    if (this.active || this.opening) throw new Error("Verification browser is busy with another task or setup request.");
    signal.throwIfAborted();
    const task: ActiveTask = { id: taskId, url: this.taskUrl(context), signal, abort: () => { void task.page?.close().catch(() => {}); } };
    this.active = task;
    signal.addEventListener("abort", task.abort, { once: true });
    try {
      await this.bounded(task, async () => {
        if (!context.selection.targets.length) throw new Error(`Verification state is unverifiable without a selected target. ${HELP}`);
        const { width, height } = context.page.viewport;
        if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192)) throw new Error("Verification viewport must have integer dimensions between 1 and 8192 pixels.");
        const browser = await this.getBrowser();
        signal.throwIfAborted();
        if (this.active !== task) throw new Error("Verification task was finished.");
        task.creating = browser.newPage();
        const page = await task.creating;
        task.page = page;
        if (this.active !== task || signal.aborted) { await page.close(); signal.throwIfAborted(); throw new Error("Verification task was finished."); }
        await page.setViewportSize({ width, height });
        await this.navigate(task, context);
        let matchingPolls = 0;
        while (matchingPolls < 2) {
          signal.throwIfAborted();
          if (this.active !== task) throw new Error("Verification task was finished.");
          try {
            await this.geometry(task, context, true);
            matchingPolls += 1;
          } catch (error) {
            if (!(error instanceof VerificationStateMismatch)) throw error;
            matchingPolls = 0;
            task.mismatch = error.message;
          }
          // Retry only reproducible state mismatches; navigation/runtime errors
          // are terminal. Require consecutive matches rather than a fixed sleep.
          if (matchingPolls < 2) await delay(100, undefined, { signal });
        }
        delete task.mismatch;
      }, this.options.preflightTimeoutMs ?? TIMEOUT);
    } catch (error) { await this.finish(taskId); throw error; }
  }
  private checkRoute(task: ActiveTask): void {
    const actual = task.page?.url();
    if (actual !== task.url) throw new Error(`Verification route redirected or changed. Expected: ${diagnosticRoute(task.url)}; actual: ${diagnosticRoute(actual)}. Query strings, fragments and credentials are omitted from these addresses; the full URLs must match exactly. Check application redirects and URL-addressable state, not only login. ${HELP}`);
  }
  private async navigate(task: ActiveTask, context: ContextBundle, reload = false): Promise<void> {
    const response = reload
      ? await task.page!.reload({ waitUntil: "load" })
      : await task.page!.goto(task.url, { waitUntil: "load" });
    this.checkRoute(task);
    if (response && !response.ok()) throw new Error(`Verification page returned HTTP ${response.status()}. ${HELP}`);
    await task.page!.evaluate(async (scroll) => {
      await document.fonts.ready;
      window.scrollTo({ left: scroll.x, top: scroll.y, behavior: "instant" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, context.page.scroll);
  }
  private async bounded<T>(task: ActiveTask, operation: () => Promise<T>, timeout = TIMEOUT): Promise<T> {
    task.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        onAbort = () => reject(task.signal.reason ?? new Error("Verification canceled."));
        task.signal.addEventListener("abort", onAbort, { once: true });
        if (task.signal.aborted) onAbort();
        timer = setTimeout(() => reject(new Error(task.mismatch ? `${task.mismatch} The required state did not settle before the verification deadline.` : `Verification browser timed out waiting for the page, fonts or images. ${HELP}`)), timeout);
      })]);
    } finally { clearTimeout(timer); if (onAbort) task.signal.removeEventListener("abort", onAbort); }
  }
  private async geometry(task: ActiveTask, context: ContextBundle, preflight: boolean): Promise<Rect> {
    this.checkRoute(task);
    const measured = await task.page!.evaluate(({ context, preflight, help }) => {
      try {
      if (innerWidth !== context.page.viewport.width || innerHeight !== context.page.viewport.height || scrollX !== context.page.scroll.x || scrollY !== context.page.scroll.y) throw new Error("Verification viewport or scroll cannot reproduce the original page exactly. " + help);
      const texts: Array<string | undefined> = [];
      const rects = context.selection.targets.map((target, index) => {
        const identity = `Target ${index + 1} (selection.targets[${index}].dom.locatorCandidates). `;
        let element: Element | undefined;
        let usableLocator = false;
        for (const locator of target.dom.locatorCandidates) {
          let selector: string;
          if (locator.type === "id") selector = `#${CSS.escape(locator.value)}`;
          else if (locator.type === "testid") selector = `[data-testid="${CSS.escape(locator.value)}"],[data-test-id="${CSS.escape(locator.value)}"]`;
          else if (locator.type === "css" || locator.type === "dom-path") selector = locator.value;
          else continue;
          try {
            const matches = document.querySelectorAll(selector);
            usableLocator = true;
            if (matches.length === 1 && matches[0]!.tagName.toLowerCase() === target.dom.tagName.toLowerCase()) { element = matches[0]; break; }
          } catch { /* Invalid/stale locators cannot establish identity. */ }
        }
        if (!usableLocator) throw new Error("Verification target has no valid supported selector. " + identity + help);
        if (!element) throw { verificationStateMismatch: true, message: "Verification target is missing or ambiguous. " + identity + help };
        const rect = element.getBoundingClientRect();
        for (let parent: Element | null = element; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) throw { verificationStateMismatch: true, message: "Verification target is hidden. " + identity + help };
        }
        if (!rect.width || !rect.height || rect.right <= 0 || rect.bottom <= 0 || rect.x >= innerWidth || rect.y >= innerHeight) throw { verificationStateMismatch: true, message: "Verification target is not visible. " + identity + help };
        if (preflight) {
          if (element.matches("input,textarea,select")) throw new Error("Verification cannot establish transient form values without copying private state. Select a URL-addressable non-form target. " + identity + help);
          const text = ((element as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
          texts.push(target.dom.text === undefined ? undefined : text.length <= 500 ? text : `${text.slice(0, 499).trimEnd()}…`);
          for (const key of ["role", "aria-expanded", "aria-pressed", "aria-checked", "aria-selected", "aria-modal", "open", "disabled", "type"]) {
            const expected = target.dom.attributes[key];
            if (element.getAttribute(key) !== (expected ?? null)) throw { verificationStateMismatch: true, message: "Verification target UI state does not match the original page. " + identity + help };
          }
        }
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      if (context.selection.mode === "page") return { rect: { x: 0, y: 0, width: innerWidth, height: innerHeight }, texts };
      if (context.selection.mode === "region") return { rect: context.selection.region, texts };
      const x = Math.min(...rects.map((rect) => rect.x)), y = Math.min(...rects.map((rect) => rect.y));
      return { rect: { x, y, width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x, height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y }, texts };
      } catch (error) {
        if (typeof error === "object" && error !== null && "verificationStateMismatch" in error && error.verificationStateMismatch === true && "message" in error && typeof error.message === "string") return { mismatch: error.message };
        throw error;
      }
    }, { context, preflight, help: HELP });
    if (measured.mismatch !== undefined) throw new VerificationStateMismatch(measured.mismatch);
    for (const [index, text] of measured.texts.entries()) {
      if (text !== undefined && redactText(text) !== context.selection.targets[index]!.dom.text) throw new VerificationStateMismatch(`Verification target text does not match the original page. Target ${index + 1} (selection.targets[${index}].dom.locatorCandidates). Check that the verification browser uses the same localhost/127.0.0.1 hostname and the expected login, account and application data. ${HELP}`);
    }
    return measured.rect;
  }
  async capture(taskId: string, context: ContextBundle, size: { width: number; height: number }, signal: AbortSignal): Promise<CaptureResult> {
    const task = this.active;
    if (!task || task.id !== taskId || !task.page) throw new Error("No active verification page for this task.");
    const abort = () => { void task.page?.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      return await this.bounded(task, async () => {
        if (this.taskUrl(context) !== task.url) throw new Error("Verification context route changed during the task.");
        if (![size.width, size.height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192) || size.width * size.height > 16_777_216) throw new Error("Unsupported verification image dimensions.");
        // Reload the same task page so applications without HMR also show current edits.
        this.checkRoute(task);
        await this.navigate(task, context, true);
        const page = task.page!;
        let crop = await this.geometry(task, context, false);
        await page.evaluate(async (crop) => {
          await document.fonts.ready;
          await Promise.all(Array.from(document.images).filter((image) => {
            if (image.closest("#__visual_bridge_root")) return false;
            const rect = image.getBoundingClientRect();
            if (!rect.width || !rect.height || rect.right <= crop.x || rect.bottom <= crop.y || rect.x >= crop.x + crop.width || rect.y >= crop.y + crop.height) return false;
            for (let element: Element | null = image; element; element = element.parentElement) {
              const style = getComputedStyle(element);
              if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
            }
            return true;
          }).map((image) => image.decode()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }, crop);
        crop = await this.geometry(task, context, false);
        if (crop.width !== size.width || crop.height !== size.height || crop.x < 0 || crop.y < 0 || crop.x + crop.width > context.page.viewport.width || crop.y + crop.height > context.page.viewport.height) throw new Error(`Verification crop ${crop.width}×${crop.height}px must be fully visible and exactly match reference ${size.width}×${size.height}px.`);
        const targets = await page.evaluate((crop): ComparisonMeasuredTarget[] => {
          const targets: ComparisonMeasuredTarget[] = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const element = node.parentElement, text = node.textContent?.replace(/\s+/g, " ").trim();
            if (!element || !text || element.closest('#__visual_bridge_root,script,style,noscript,textarea,input,select,[hidden],[aria-hidden="true"]')) continue;
            let visible = true;
            for (let parent: Element | null = element; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0) { visible = false; break; }
            }
            if (!visible) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = range.getBoundingClientRect();
            if (!rect.width || !rect.height || rect.right <= crop.x || rect.bottom <= crop.y || rect.x >= crop.x + crop.width || rect.y >= crop.y + crop.height) continue;
            if (targets.length >= 2000 || text.length > 10_000) throw new Error("Too much verification text; select a smaller region.");
            const style = getComputedStyle(element);
            targets.push({ text, rect: { x: rect.x - crop.x, y: rect.y - crop.y, width: rect.width, height: rect.height }, styles: { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight, fontFamily: style.fontFamily, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing } });
          }
          return targets;
        }, crop);
        // Non-full-page Playwright clips are viewport-relative; Chromium adds scroll internally.
        const png = await page.screenshot({ type: "png", clip: crop, scale: "css", animations: "disabled", caret: "hide", style: "#__visual_bridge_root{visibility:hidden!important}", timeout: TIMEOUT });
        const finalCrop = await this.geometry(task, context, false);
        if ((["x", "y", "width", "height"] as const).some((key) => crop[key] !== finalCrop[key])) throw new Error("Verification target moved during capture; wait for stable layout and retry.");
        signal.throwIfAborted();
        return { requestId: randomUUID(), taskId, ...size, targets, pngBase64: png.toString("base64") };
      });
    } catch (error) { await this.finish(taskId); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }
  async finish(taskId: string): Promise<void> {
    const task = this.active;
    if (!task || task.id !== taskId) return;
    task.signal.removeEventListener("abort", task.abort);
    try {
      // A page event may precede newPage() resolution. Await creation before releasing ownership.
      const page = task.page ?? await task.creating;
      await page?.close();
    } finally { if (this.active === task) this.active = undefined; }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.active) await this.finish(this.active.id);
    const browser = this.browserContext ?? await this.launching?.catch(() => undefined);
    await browser?.close();
    this.browserContext = undefined;
    this.setupPage = undefined;
  }
}
