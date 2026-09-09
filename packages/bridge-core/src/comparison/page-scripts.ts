/// <reference lib="dom" />
import type { ComparisonMeasuredTarget, ContextBundle, Rect } from "@visual-remote/protocol";

/**
 * Browser-side routines shared by every verification browser driver.
 *
 * Each function is self-contained: it only touches its argument and DOM
 * globals, never module scope, so it can be serialized with `toString()` and
 * evaluated inside a page by Playwright (`page.evaluate(fn, arg)`) or by an
 * external runtime such as ego lite (`js(pageScript(fn, arg))`).
 */

export interface GeometryInput {
  context: ContextBundle;
  preflight: boolean;
  help: string;
}

export type GeometryResult =
  | { rect: Rect; texts: Array<string | undefined>; mismatch?: undefined }
  | { mismatch: string; rect?: undefined; texts?: undefined };

/** Builds a one-shot expression that runs `fn` with a JSON-serialized argument. */
export function pageScript<T>(fn: (argument: T) => unknown, argument: T): string {
  return `(${fn.toString()})(${JSON.stringify(argument)})`;
}

export async function settlePage(scroll: { x: number; y: number }): Promise<void> {
  await document.fonts.ready;
  window.scrollTo({ left: scroll.x, top: scroll.y, behavior: "instant" });
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export function measureGeometry({ context, preflight, help }: GeometryInput): GeometryResult {
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
}

export async function decodeVisibleImages(crop: Rect): Promise<void> {
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
}

export function collectTextTargets(crop: Rect): ComparisonMeasuredTarget[] {
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
}

/** Hides an injected Overlay root (and stops animations/caret) before a raw CDP capture. */
export function prepareCaptureStyles(_argument: null): void {
  const id = "__visual_capture_style";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = "#__visual_bridge_root{visibility:hidden!important}*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}";
  document.head.append(style);
}

export function restoreCaptureStyles(_argument: null): void {
  document.getElementById("__visual_capture_style")?.remove();
}

/**
 * Maps the page the user selected onto the configured upstream. Loopback
 * aliases are distinct cookie/storage hosts, so the source hostname is kept
 * when both sides are loopback; protocol and port always come from upstream.
 */
export function resolveVerificationUrl(upstream: URL, context?: ContextBundle): string {
  if (!context) return upstream.href;
  const source = new URL(context.page.url);
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) throw new Error("Verification page must be an HTTP(S) URL without credentials.");
  const destination = new URL(upstream.origin);
  if (["localhost", "127.0.0.1"].includes(upstream.hostname) && ["localhost", "127.0.0.1"].includes(source.hostname)) destination.hostname = source.hostname;
  destination.pathname = source.pathname;
  destination.search = source.search;
  destination.hash = source.hash;
  return destination.href;
}

/**
 * Page-mode captures adopt the reference frame size as the verification
 * viewport, so a responsive page is compared at the size the design was made
 * for. Element and region selections keep the original viewport.
 */
export function captureContext(context: ContextBundle, size: { width: number; height: number }): ContextBundle {
  if (context.selection.mode !== "page") return context;
  if (context.page.viewport.width === size.width && context.page.viewport.height === size.height) return context;
  return { ...context, page: { ...context.page, viewport: { width: size.width, height: size.height } } };
}

export function cropMismatchMessage(crop: Rect, size: { width: number; height: number }, mode: ContextBundle["selection"]["mode"]): string {
  const base = `Verification crop ${crop.width}×${crop.height}px must be fully visible and exactly match reference ${size.width}×${size.height}px.`;
  if (crop.width === size.width && crop.height === size.height) return base;
  return `${base} Pixel comparison needs identical sizes: ${mode === "page" ? "the page could not adopt the frame size; check minimum sizes and scrollbars" : "select a target or region of exactly the frame size, pick a Figma frame that matches the selected element, or use page mode so the verification viewport adopts the frame size"}.`;
}

export function diagnosticRoute(value: string | undefined): string {
  if (!value) return "unavailable";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? `${url.origin}${url.pathname}` : "non-HTTP(S) page";
  } catch { return "invalid URL"; }
}
