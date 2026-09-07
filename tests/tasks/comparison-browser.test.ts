import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextBundle } from "@visual-remote/protocol";
import { ComparisonBrowser } from "../../packages/bridge-core/src/comparison/browser.js";
import { decodePng } from "../../packages/bridge-core/src/comparison/metrics.js";
import { sanitizeContextBundle } from "../../packages/bridge-core/src/context/sanitize.js";
import { compactText } from "../../packages/overlay/src/helpers.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function context(path = "/frame?view=one#target"): ContextBundle {
  return { version: 1, projectId: "browser-test", browserSessionId: randomUUID(), page: { url: `http://original.invalid${path}`, pathname: path.split("?")[0]!, title: "Original", viewport: { width: 320, height: 240 }, devicePixelRatio: 2, scroll: { x: 0, y: 0 }, renderRevision: 0 }, selection: { mode: "element", targets: [{ targetId: "selected", order: 0, dom: { tagName: "div", id: "target", classNames: [], text: "Original", attributes: {}, rect: { x: 20, y: 30, width: 120, height: 60 }, locatorCandidates: [{ type: "id", value: "target", confidence: 1 }], parentPath: [] }, styles: {}, source: { stack: [], confidence: "unknown" } }] }, request: { text: "Compare", scope: "instance" } };
}
// Read-only inspection of the real owned context: no mocked launch/pages/screenshots.
function owned(manager: ComparisonBrowser): { browserContext: BrowserContext; setupPage: Page; active: { page: Page; mismatch?: string } | undefined } {
  return manager as unknown as ReturnType<typeof owned>;
}
async function fixture(upstreamHostname = "127.0.0.1", preflightTimeoutMs = 3_000) {
  let text = "Original";
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === "/slow") return;
    if (request.url === "/private" && !request.headers.cookie?.includes("logged=yes")) { response.writeHead(302, { location: "/login" }); response.end(); return; }
    if (request.url?.startsWith("/redirect?")) { response.writeHead(302, { location: "/destination?token=redirect-secret#redirect-fragment" }); response.end(); return; }
    if (request.url === "/signin") response.setHeader("set-cookie", "logged=yes; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax");
    if (request.url?.startsWith("/host-state")) {
      response.setHeader("content-type", "text/html");
      const logged = request.headers.cookie?.includes("host-login=yes") ?? false;
      response.end(`<!doctype html><style>body{margin:0}#target{position:absolute;left:20px;top:30px;width:120px;height:60px}</style><div id="target"></div><script>document.querySelector('#target').textContent = location.hostname + ' ' + (${logged} ? 'signed-in' : 'signed-out') + ' ' + (localStorage.getItem('account') || 'none');</script>`);
      return;
    }
    response.setHeader("content-type", "text/html");
    const body = request.url === "/missing" || request.url === "/login" ? "<h1>Sign in</h1>" : `<div id="target">${text}</div>`;
    response.end(`<!doctype html><style>body{margin:0;height:1200px}#target{position:absolute;left:20px;top:30px;width:120px;height:60px;background:rgb(0,128,0);font:16px Arial;color:white}#__visual_bridge_root{position:fixed;inset:0;background:red;z-index:999}</style>${body}<div id="__visual_bridge_root">Do not capture overlay</div><script src="/_visual/client.js"></script><script>sessionStorage.setItem('loads',String(Number(sessionStorage.getItem('loads')||0)+1))</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const upstreamUrl = `http://${upstreamHostname}:${address.port}`;
  const profileDirectory = await mkdtemp(join(tmpdir(), "verification-browser-"));
  cleanups.push(() => rm(profileDirectory, { recursive: true, force: true }));
  const makeManager = () => {
    const manager = new ComparisonBrowser({ profileDirectory, upstreamUrl, headless: true, executablePath: chromium.executablePath(), preflightTimeoutMs });
    cleanups.push(() => manager.close());
    return manager;
  };
  return { manager: makeManager(), makeManager, profileDirectory, upstreamUrl, requests, setText: (value: string) => { text = value; } };
}

describe("dedicated persistent verification browser", () => {
  it("keeps setup untouched, maps only upstream, captures real pixels without overlay and reuses only the task page", async () => {
    const f = await fixture(), ctx = context(), signal = new AbortController().signal, id = randomUUID();
    await f.manager.open(ctx);
    const setup = owned(f.manager).setupPage;
    await setup.evaluate(() => { sessionStorage.setItem("private-state", "setup-only"); document.title = "Setup untouched"; });
    const setupViewport = setup.viewportSize();
    expect(setupViewport).toBeNull();
    await f.manager.begin(id, ctx, signal);
    const page = owned(f.manager).active!.page;
    expect(page).not.toBe(setup);
    expect(page.viewportSize()).toEqual(ctx.page.viewport);
    expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(ctx.page.viewport);
    expect(page.url()).toBe(`${f.upstreamUrl}/frame?view=one#target`);
    expect(await page.evaluate(() => sessionStorage.getItem("private-state"))).toBeNull();
    await expect(f.manager.open()).rejects.toThrow(/busy/);
    await expect(f.manager.begin(randomUUID(), ctx, signal)).rejects.toThrow(/busy/);
    const first = await f.manager.capture(id, ctx, { width: 120, height: 60 }, signal);
    const image = decodePng(Buffer.from(first.pngBase64!, "base64"));
    expect([image.width, image.height]).toEqual([120, 60]);
    expect([...image.data.subarray((59 * 120 + 119) * 4, (59 * 120 + 119) * 4 + 4)]).toEqual([0, 128, 0, 255]);
    expect(first.targets?.map((target) => target.text)).toEqual(["Original"]);
    expect(first.targets?.[0]?.styles.fontSize).toBe("16px");
    f.setText("Edited");
    const next = await f.manager.capture(id, ctx, { width: 120, height: 60 }, signal);
    expect(next.targets?.map((target) => target.text)).toEqual(["Edited"]);
    expect(owned(f.manager).active!.page).toBe(page);
    expect(await page.evaluate(() => Number(sessionStorage.getItem("loads")))).toBe(3);
    expect(await setup.title()).toBe("Setup untouched");
    expect(setup.viewportSize()).toEqual(setupViewport);
    expect(await setup.evaluate(() => sessionStorage.getItem("private-state"))).toBe("setup-only");
    expect(f.requests).not.toContain("/_visual/client.js");
    await f.manager.finish("unrelated");
    expect(page.isClosed()).toBe(false);
    await f.manager.finish(id);
    expect(page.isClosed()).toBe(true);
    f.setText("Original");
    await f.manager.begin(randomUUID(), ctx, signal);
    expect(owned(f.manager).active!.page).not.toBe(page);
    expect(await owned(f.manager).active!.page.evaluate(() => sessionStorage.getItem("loads"))).toBe("1");
  }, 60_000);

  it("persists only its own login cookie across tasks and profile reopen", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    await expect(f.manager.begin(randomUUID(), context("/private"), signal)).rejects.toThrow(/redirected.*login/);
    await f.manager.open(context("/signin"));
    const id = randomUUID();
    await f.manager.begin(id, context("/private"), signal);
    await f.manager.finish(id);
    expect((await stat(f.profileDirectory)).mode & 0o777).toBe(0o700);
    await f.manager.close();
    const reopened = f.makeManager();
    await reopened.begin(randomUUID(), context("/private"), signal);
    expect(owned(reopened).active!.page.url()).toBe(`${f.upstreamUrl}/private`);
  }, 60_000);

  it.each([
    ["127.0.0.1", "localhost"],
    ["localhost", "127.0.0.1"],
  ])("keeps %s upstream port with %s source host for setup, login and capture", async (upstreamHostname, sourceHostname) => {
    const f = await fixture(upstreamHostname), ctx = context("/host-state?view=one#target"), signal = new AbortController().signal;
    // Neither the source protocol nor the source port can override the upstream.
    ctx.page.url = `https://${sourceHostname}:1/host-state?view=one#target`;
    const expected = new URL(f.upstreamUrl);
    expected.hostname = sourceHostname;
    expected.pathname = "/host-state";
    expected.search = "?view=one";
    expected.hash = "#target";
    await f.manager.open(ctx);
    const setup = owned(f.manager).setupPage;
    expect(setup.url()).toBe(expected.href);
    await setup.evaluate(() => {
      document.cookie = "host-login=yes; Path=/; SameSite=Lax";
      localStorage.setItem("account", "verification-account");
      sessionStorage.setItem("private-state", "setup-only");
      document.title = "Setup unchanged";
    });
    const cookies = await owned(f.manager).browserContext.cookies(expected.href);
    expect(cookies.find((cookie) => cookie.name === "host-login")?.domain).toBe(sourceHostname);
    ctx.selection.targets[0]!.dom.text = `${sourceHostname} signed-in verification-account`;
    const id = randomUUID();
    await f.manager.begin(id, ctx, signal);
    const taskPage = owned(f.manager).active!.page;
    expect(taskPage.url()).toBe(expected.href);
    expect(await taskPage.evaluate(() => sessionStorage.getItem("private-state"))).toBeNull();
    const result = await f.manager.capture(id, ctx, { width: 120, height: 60 }, signal);
    expect(result.targets?.[0]?.text).toBe(ctx.selection.targets[0]!.dom.text);
    expect(setup.url()).toBe(expected.href);
    expect(await setup.title()).toBe("Setup unchanged");
    await f.manager.finish(id);
    const external = context("/frame?view=one#target");
    external.page.url = "https://untrusted.invalid:444/frame?view=one#target";
    await f.manager.open(external);
    expect(setup.url()).toBe(`${f.upstreamUrl}/frame?view=one#target`);
    await f.manager.begin(randomUUID(), external, signal);
    expect(owned(f.manager).active!.page.url()).toBe(`${f.upstreamUrl}/frame?view=one#target`);
  }, 60_000);

  it("reports safe expected and actual redirect routes without accepting the changed URL", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    const error = await f.manager.begin(randomUUID(), context("/redirect?token=source-secret#source-fragment"), signal).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`Expected: ${f.upstreamUrl}/redirect; actual: ${f.upstreamUrl}/destination.`);
    expect(message).toContain("Check application redirects and URL-addressable state, not only login");
    for (const secret of ["source-secret", "source-fragment", "redirect-secret", "redirect-fragment", "?token=", "#"]) expect(message).not.toContain(secret);
    expect(owned(f.manager).active).toBeUndefined();
    await f.manager.begin(randomUUID(), context(), signal);
  }, 60_000);

  it("still rejects query-only and fragment-only route changes with redacted diagnostics", async () => {
    const f = await fixture(), signal = new AbortController().signal, ctx = context();
    for (const suffix of ["?view=changed-secret#target", "?view=one#changed-fragment"]) {
      const id = randomUUID();
      await f.manager.begin(id, ctx, signal);
      const page = owned(f.manager).active!.page;
      await page.evaluate((suffix) => history.replaceState(null, "", `/frame${suffix}`), suffix);
      const error = await f.manager.capture(id, ctx, { width: 120, height: 60 }, signal).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`Expected: ${f.upstreamUrl}/frame; actual: ${f.upstreamUrl}/frame.`);
      expect(message).toContain("the full URLs must match exactly");
      expect(message).not.toContain("changed-secret");
      expect(message).not.toContain("changed-fragment");
      expect(page.isClosed()).toBe(true);
      expect(owned(f.manager).active).toBeUndefined();
    }
  }, 60_000);

  it("rejects malformed selector input without waiting for hydration", async () => {
    const f = await fixture("127.0.0.1", 10_000), ctx = context();
    await f.manager.open(ctx);
    // CSS accepts an EOF-terminated attribute selector such as `[name`.
    // An empty attribute value is invalid rather than merely unmatched.
    ctx.selection.targets[0]!.dom.locatorCandidates = [{ type: "css", value: "[private-invalid=]", confidence: 1 }];
    const started = Date.now();
    const error = await f.manager.begin(randomUUID(), ctx, new AbortController().signal).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no valid supported selector/);
    expect((error as Error).message).not.toContain("private-invalid");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(owned(f.manager).active).toBeUndefined();
  }, 60_000);

  it.each(["placeholder", "missing", "hidden", "ui-state"])("waits for asynchronous %s to reproduce the selected target", async (kind) => {
    const f = await fixture(), ctx = context(), signal = new AbortController().signal;
    await f.manager.open(ctx);
    await owned(f.manager).browserContext.addInitScript((kind) => {
      document.addEventListener("DOMContentLoaded", () => {
        const target = document.querySelector<HTMLElement>("#target")!;
        if (kind === "missing") target.remove();
        else if (kind === "hidden") target.style.visibility = "hidden";
        else if (kind === "ui-state") target.setAttribute("aria-expanded", "false");
        else target.textContent = "Loading private placeholder";
        window.addEventListener("fixture-hydrate", () => {
          if (kind === "missing") document.body.append(target);
          target.style.visibility = "visible";
          target.removeAttribute("aria-expanded");
          target.textContent = "Original";
        }, { once: true });
      });
    }, kind);
    const pending = f.manager.begin(randomUUID(), ctx, signal);
    const completed = expect(pending).resolves.toBeUndefined();
    // Release hydration only after preflight has observed the initial mismatch.
    await expect.poll(() => owned(f.manager).active?.mismatch).toBeDefined();
    const page = owned(f.manager).active!.page;
    await page.evaluate(() => window.dispatchEvent(new Event("fixture-hydrate")));
    await completed;
    expect(await page.locator("#target").innerText()).toBe("Original");
    expect(await page.locator("#target").isVisible()).toBe(true);
    expect(await page.locator("#target").getAttribute("aria-expanded")).toBeNull();
  }, 60_000);

  it("uses capture compaction followed by server redaction without weakening other text checks", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    const values = ["  Original \n\t account  ", `${"x".repeat(498)}  boundary and more`, "Account Alpha api_key=private-key-123456 secret suffix", `Bearer ${"a".repeat(490)} end`];
    for (const value of values) {
      f.setText(value);
      const ctx = context();
      ctx.selection.targets[0]!.dom.text = compactText(value, 500);
      const sanitized = sanitizeContextBundle(ctx), id = randomUUID();
      await f.manager.begin(id, sanitized, signal);
      await f.manager.finish(id);
    }
    f.setText("Account Beta api_key=private-key-123456 secret suffix");
    const wrong = context();
    wrong.selection.targets[0]!.dom.text = "Account Alpha api_key=private-key-123456 secret suffix";
    await expect(f.manager.begin(randomUUID(), sanitizeContextBundle(wrong), signal)).rejects.toThrow(/text does not match/);
  }, 60_000);

  it("cancels an active text-state wait promptly and preserves setup", async () => {
    const f = await fixture("127.0.0.1", 10_000), ctx = context();
    await f.manager.open(ctx);
    f.setText("Private pending account");
    const controller = new AbortController(), nextPage = owned(f.manager).browserContext.waitForEvent("page");
    const pending = f.manager.begin(randomUUID(), ctx, controller.signal);
    const rejection = expect(pending).rejects.toThrow(/Canceled state wait/);
    const page = await nextPage;
    await page.waitForFunction(() => document.querySelector("#target")?.textContent === "Private pending account");
    const started = Date.now();
    controller.abort(new Error("Canceled state wait"));
    await rejection;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(page.isClosed()).toBe(true);
    expect(owned(f.manager).setupPage.isClosed()).toBe(false);
    expect(owned(f.manager).active).toBeUndefined();
    f.setText("Original");
    await f.manager.begin(randomUUID(), ctx, new AbortController().signal);
  }, 60_000);

  it("does not retry route or browser runtime errors as text mismatches", async () => {
    const f = await fixture("127.0.0.1", 10_000), ctx = context(), signal = new AbortController().signal;
    await f.manager.open(ctx);
    f.setText("Private pending account");
    for (const failure of ["route", "closed"] as const) {
      const nextPage = owned(f.manager).browserContext.waitForEvent("page");
      const pending = f.manager.begin(randomUUID(), ctx, signal);
      const rejection = expect(pending).rejects.toThrow(failure === "route" ? /route redirected or changed/ : /closed/);
      const page = await nextPage;
      await page.waitForFunction(() => document.querySelector("#target")?.textContent === "Private pending account");
      const started = Date.now();
      if (failure === "route") await page.evaluate(() => history.replaceState(null, "", "/other?private=secret"));
      else await page.close();
      await rejection;
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(owned(f.manager).active).toBeUndefined();
    }
  }, 60_000);

  it("rejects missing, ambiguous, mismatched and unverifiable state before edits and releases ownership", async () => {
    const f = await fixture(), signal = new AbortController().signal;
    await expect(f.manager.begin(randomUUID(), context("/missing"), signal)).rejects.toThrow(/missing or ambiguous/);
    const mismatch = context(); mismatch.selection.targets[0]!.dom.text = "Unsaved modal";
    const mismatchError = await f.manager.begin(randomUUID(), mismatch, signal).catch((error: unknown) => error);
    expect(mismatchError).toBeInstanceOf(Error);
    expect((mismatchError as Error).message).toMatch(/text does not match.*localhost\/127\.0\.0\.1.*login, account and application data/);
    expect((mismatchError as Error).message).not.toContain("Unsaved modal");
    expect((mismatchError as Error).message).not.toContain("Original");
    expect((mismatchError as Error).message).toContain("Target 1 (selection.targets[0].dom.locatorCandidates)");
    expect((mismatchError as Error).message).toContain("did not settle before the verification deadline");
    const ambiguous = context(); ambiguous.selection.targets[0]!.dom.locatorCandidates = [{ type: "css", value: "div", confidence: 1 }];
    await expect(f.manager.begin(randomUUID(), ambiguous, signal)).rejects.toThrow(/ambiguous/);
    const empty = context(); empty.selection = { mode: "page", targets: [] };
    await expect(f.manager.begin(randomUUID(), empty, signal)).rejects.toThrow(/unverifiable/);
    const id = randomUUID();
    await f.manager.begin(id, context(), signal);
    const page = owned(f.manager).active!.page;
    await expect(f.manager.capture(id, context(), { width: 121, height: 60 }, signal)).rejects.toThrow(/exactly match/);
    expect(page.isClosed()).toBe(true);
    await f.manager.open();
  }, 60_000);

  it("rejects changed and newly present ARIA state before comparison", async () => {
    const f = await fixture(), ctx = context(), signal = new AbortController().signal;
    await f.manager.open(ctx);
    await owned(f.manager).browserContext.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        document.querySelector("#target")?.setAttribute("aria-expanded", localStorage.getItem("fixture-expanded") ?? "false");
      });
    });
    ctx.selection.targets[0]!.dom.attributes["aria-expanded"] = "true";
    await expect(f.manager.begin(randomUUID(), ctx, signal)).rejects.toThrow(/UI state does not match/);
    await owned(f.manager).setupPage.evaluate(() => localStorage.setItem("fixture-expanded", "true"));
    delete ctx.selection.targets[0]!.dom.attributes["aria-expanded"];
    await expect(f.manager.begin(randomUUID(), ctx, signal)).rejects.toThrow(/UI state does not match/);
    ctx.selection.targets[0]!.dom.attributes["aria-expanded"] = "true";
    await f.manager.begin(randomUUID(), ctx, signal);
  }, 60_000);

  it("captures a scrolled region in CSS pixels and rejects impossible scroll", async () => {
    const f = await fixture(), ctx = context(), signal = new AbortController().signal;
    ctx.page.scroll.y = 20;
    ctx.selection = { mode: "region", region: { x: 20, y: 10, width: 120, height: 60 }, targets: ctx.selection.targets };
    const id = randomUUID();
    await f.manager.begin(id, ctx, signal);
    const result = await f.manager.capture(id, ctx, { width: 120, height: 60 }, signal);
    const image = decodePng(Buffer.from(result.pngBase64!, "base64"));
    expect([...image.data.subarray((59 * 120 + 119) * 4, (59 * 120 + 119) * 4 + 4)]).toEqual([0, 128, 0, 255]);
    expect(await owned(f.manager).active!.page.evaluate(() => scrollY)).toBe(20);
    await f.manager.finish(id);
    ctx.page.scroll.y = 5000;
    await expect(f.manager.begin(randomUUID(), ctx, signal)).rejects.toThrow(/scroll/);
  }, 60_000);

  it("closes capture on cancellation and does not close a different task", async () => {
    const f = await fixture(), ctx = context(), signal = new AbortController().signal, id = randomUUID();
    await f.manager.begin(id, ctx, signal);
    const page = owned(f.manager).active!.page;
    const controller = new AbortController();
    controller.abort(new Error("Capture canceled"));
    await expect(f.manager.capture(id, ctx, { width: 120, height: 60 }, controller.signal)).rejects.toThrow(/canceled/);
    expect(page.isClosed()).toBe(true);
    const next = randomUUID();
    await f.manager.begin(next, ctx, signal);
    await f.manager.finish(id);
    expect(owned(f.manager).active!.page.isClosed()).toBe(false);
  }, 60_000);

  it("closes an aborted pending task without closing setup and accepts the next task", async () => {
    const f = await fixture();
    await f.manager.open(context());
    const setup = owned(f.manager).setupPage, controller = new AbortController(), id = randomUUID();
    const nextPage = owned(f.manager).browserContext.waitForEvent("page");
    const result = f.manager.begin(id, context("/slow"), controller.signal);
    const rejection = expect(result).rejects.toThrow();
    const page = await nextPage;
    controller.abort(new Error("Stopped by test"));
    await rejection;
    expect(page.isClosed()).toBe(true);
    expect(setup.isClosed()).toBe(false);
    await f.manager.begin(randomUUID(), context(), new AbortController().signal);
    await f.manager.close();
    expect(setup.isClosed()).toBe(true);
  }, 60_000);
});
