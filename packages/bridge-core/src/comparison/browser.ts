/// <reference lib="dom" />
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { CaptureResult, ComparisonMeasuredTarget, ContextBundle, Rect } from "@visual-remote/protocol";

const TIMEOUT = 30_000;
const HELP = "Open the verification browser and sign in to its separate profile. Only URL-addressable state is supported; original-tab in-memory modals, form values and sessionStorage are not copied.";
const INSTALL = "Verification browser is not installed. Install Google Chrome or run `npx --yes --package playwright@1.62.1 playwright install chromium`, then retry.";
const missingExecutable = (message: string) => /executable (?:doesn't exist|does not exist)|distribution ['"]?chrome['"]? is not found/i.test(message);
export interface ComparisonBrowserOptions { profileDirectory: string; upstreamUrl: string; headless?: boolean; executablePath?: string }
interface ActiveTask { id: string; url: string; page?: Page; creating?: Promise<Page>; signal: AbortSignal; abort: () => void }

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
  }
  private taskUrl(context?: ContextBundle): string {
    if (!context) return this.upstream.href;
    const source = new URL(context.page.url);
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) throw new Error("Verification page must be an HTTP(S) URL without credentials.");
    const destination = new URL(this.upstream.origin);
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
      const options = { headless: this.options.headless ?? false, deviceScaleFactor: 1, timeout: TIMEOUT, ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}) };
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
        await this.geometry(task, context, true);
      });
    } catch (error) { await this.finish(taskId); throw error; }
  }
  private checkRoute(task: ActiveTask): void {
    if (task.page?.url() !== task.url) throw new Error(`Verification route redirected or changed (possibly login). ${HELP}`);
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
  private async bounded<T>(task: ActiveTask, operation: () => Promise<T>): Promise<T> {
    task.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        onAbort = () => reject(task.signal.reason ?? new Error("Verification canceled."));
        task.signal.addEventListener("abort", onAbort, { once: true });
        if (task.signal.aborted) onAbort();
        timer = setTimeout(() => reject(new Error(`Verification browser timed out waiting for the page, fonts or images. ${HELP}`)), TIMEOUT);
      })]);
    } finally { clearTimeout(timer); if (onAbort) task.signal.removeEventListener("abort", onAbort); }
  }
  private async geometry(task: ActiveTask, context: ContextBundle, preflight: boolean): Promise<Rect> {
    this.checkRoute(task);
    return task.page!.evaluate(({ context, preflight, help }) => {
      if (innerWidth !== context.page.viewport.width || innerHeight !== context.page.viewport.height || scrollX !== context.page.scroll.x || scrollY !== context.page.scroll.y) throw new Error("Verification viewport or scroll cannot reproduce the original page exactly. " + help);
      const rects = context.selection.targets.map((target) => {
        let element: Element | undefined;
        for (const locator of target.dom.locatorCandidates) {
          let selector: string;
          if (locator.type === "id") selector = `#${CSS.escape(locator.value)}`;
          else if (locator.type === "testid") selector = `[data-testid="${CSS.escape(locator.value)}"],[data-test-id="${CSS.escape(locator.value)}"]`;
          else if (locator.type === "css" || locator.type === "dom-path") selector = locator.value;
          else continue;
          try {
            const matches = document.querySelectorAll(selector);
            if (matches.length === 1 && matches[0]!.tagName.toLowerCase() === target.dom.tagName.toLowerCase()) { element = matches[0]; break; }
          } catch { /* Invalid/stale locators cannot establish identity. */ }
        }
        if (!element) throw new Error("Verification target is missing or ambiguous. " + help);
        const rect = element.getBoundingClientRect();
        for (let parent: Element | null = element; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) throw new Error("Verification target is hidden. " + help);
        }
        if (!rect.width || !rect.height || rect.right <= 0 || rect.bottom <= 0 || rect.x >= innerWidth || rect.y >= innerHeight) throw new Error("Verification target is not visible. " + help);
        if (preflight) {
          const text = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
          const compacted = text.length <= 500 ? text : `${text.slice(0, 499).trimEnd()}…`;
          if (target.dom.text !== undefined && compacted !== target.dom.text.replace(/\s+/g, " ").trim()) throw new Error("Verification target text does not match the original page. " + help);
          for (const key of ["role", "aria-expanded", "aria-pressed", "aria-checked", "aria-selected", "aria-modal", "open", "disabled", "type"]) {
            const expected = target.dom.attributes[key];
            if (element.getAttribute(key) !== (expected ?? null)) throw new Error("Verification target UI state does not match the original page. " + help);
          }
          if (element.matches("input,textarea,select")) throw new Error("Verification cannot establish transient form values without copying private state. Select a URL-addressable non-form target. " + help);
        }
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      if (context.selection.mode === "page") return { x: 0, y: 0, width: innerWidth, height: innerHeight };
      if (context.selection.mode === "region") return context.selection.region;
      const x = Math.min(...rects.map((rect) => rect.x)), y = Math.min(...rects.map((rect) => rect.y));
      return { x, y, width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x, height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y };
    }, { context, preflight, help: HELP });
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
