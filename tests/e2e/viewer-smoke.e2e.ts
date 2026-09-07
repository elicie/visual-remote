import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from "@playwright/test";
import { findAvailablePort } from "@visual-remote/bridge-core";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const controlToken = "visual-browser-fixture-token";

interface RunningFixture {
  child: ChildProcess;
  origin: string;
}

interface ListedTask {
  id: string;
  requestText: string;
  status: string;
}

async function findTask(
  request: APIRequestContext,
  origin: string,
  requestText: string,
): Promise<ListedTask | undefined> {
  const response = await request.get(`${origin}/_visual/api/tasks`, {
    headers: { authorization: `Bearer ${controlToken}` },
  });
  if (!response.ok()) {
    return undefined;
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    return undefined;
  }
  return payload.find(
    (task): task is ListedTask =>
      typeof task === "object"
      && task !== null
      && "id" in task
      && typeof task.id === "string"
      && "requestText" in task
      && task.requestText === requestText
      && "status" in task
      && typeof task.status === "string",
  );
}

async function waitUntilReady(
  child: ChildProcess,
  origin: string,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Browser fixture exited before it was ready.\n${output()}`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok && (await response.text()).includes("/_visual/client.js")) {
        return;
      }
    } catch {
      // The fixture owns both listeners and may still be starting.
    }
    await delay(100);
  }
  throw new Error(`Browser fixture did not become ready.\n${output()}`);
}

async function startFixture(authMode: "local" | "token" = "token", comparison = false): Promise<RunningFixture> {
  const gatewayPort = await findAvailablePort(10_001, "0.0.0.0");
  const upstreamPort = await findAvailablePort(
    gatewayPort + 1,
    "0.0.0.0",
    new Set([gatewayPort]),
  );
  const origin = `http://127.0.0.1:${gatewayPort}`;
  let processOutput = "";
  const child = spawn(
    "corepack",
    ["pnpm", "exec", "tsx", "tests/fixtures/browser-harness.ts"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        VISUAL_FIXTURE_GATEWAY_PORT: String(gatewayPort),
        VISUAL_FIXTURE_UPSTREAM_PORT: String(upstreamPort),
        VISUAL_FIXTURE_AUTH_MODE: authMode,
        VISUAL_FIXTURE_COMPARISON: String(comparison),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    processOutput += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    processOutput += chunk.toString();
  });
  const output = () => processOutput;
  const fixture = { child, origin };
  try {
    await waitUntilReady(child, origin, output);
    return fixture;
  } catch (error) {
    await stopFixture(fixture);
    throw error;
  }
}

async function stopFixture(fixture: RunningFixture): Promise<void> {
  const { child } = fixture;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  }
}

function taskPayload(origin: string, requestText: string): unknown {
  return {
    contextBundle: {
      version: 1,
      projectId: "browser-fixture",
      browserSessionId: randomUUID(),
      page: {
        url: `${origin}/`,
        pathname: "/",
        title: "Visual Bridge Browser Fixture",
        viewport: { width: 1_280, height: 900 },
        devicePixelRatio: 1,
        scroll: { x: 0, y: 0 },
        renderRevision: 1,
      },
      selection: { mode: "page", targets: [] },
      request: { text: requestText, scope: "page" },
    },
  };
}

let fixture: RunningFixture;

test.beforeAll(async () => {
  fixture = await startFixture();
});

test.afterAll(async () => {
  if (fixture) await stopFixture(fixture);
});

test("standalone viewer covers bootstrap, live review, read-only access, and mobile layout", async ({
  context,
  page,
  request,
}) => {
  const requestText = "Playwright 실시간 작업 보드 회귀 테스트";
  const overlayRequestText = "Overlay 연속 선택 회귀 테스트";
  const browserErrors: string[] = [];
  const collectBrowserErrors = (candidate: typeof page) => {
    candidate.on("pageerror", (error) => browserErrors.push(error.message));
    candidate.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
  };
  collectBrowserErrors(page);
  context.on("page", collectBrowserErrors);

  await page.goto(`${fixture.origin}/#visual-pair=${controlToken}`);

  const visualToolbar = page.getByRole("navigation", {
    name: "Visual Bridge 도구",
  });
  await expect(visualToolbar).toBeVisible();
  await visualToolbar.getByRole("button", { name: "영역" }).click();
  const fixtureMain = await page.locator("main").boundingBox();
  expect(fixtureMain).not.toBeNull();
  await page.mouse.move(fixtureMain!.x + 20, fixtureMain!.y + 20);
  await page.mouse.down();
  await page.mouse.move(
    fixtureMain!.x + fixtureMain!.width - 20,
    fixtureMain!.y + fixtureMain!.height - 20,
  );
  await page.mouse.up();

  const regionRequest = page.getByRole("region", {
    name: "영역 수정 요청 작성",
  });
  await expect(regionRequest).toContainText("드래그한 화면 영역");
  await expect(regionRequest).toContainText("영역 선택됨");
  await expect(regionRequest).toContainText(/범위 안 요소 \d+개 포함/);
  await expect(page.locator(".region-box-label")).toHaveText("영역");
  await expect(page.locator('.reticle[data-kind="selected"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  await visualToolbar
    .getByRole("button", { name: "요소", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes" }).click();
  const overlayRequest = page.getByPlaceholder(
    "선택한 화면을 어떻게 바꿀까요?",
  );
  await expect(overlayRequest).toBeVisible();
  await overlayRequest.fill(overlayRequestText);
  await page.getByRole("button", { name: "요청 보내기" }).click();

  await page.getByRole("button", { name: "작업 최소화" }).click();
  const compactTask = page.getByRole("region", { name: "최소화된 작업 상태" });
  await expect(compactTask).toBeVisible();
  await expect(compactTask).toContainText(overlayRequestText);
  await expect(compactTask).not.toContainText("browser-fixture");
  await expect(
    compactTask.getByRole("button", {
      name: new RegExp(`${overlayRequestText} 작업 상세 펼치기`),
    }),
  ).toBeVisible();
  await page.getByRole("heading", { name: "Remote preview fixture" }).click();
  await expect(overlayRequest).toBeVisible();
  await expect(overlayRequest).toHaveValue("");
  await page.keyboard.press("Escape");

  let overlayTaskId = "";
  await expect
    .poll(async () => {
      const task = await findTask(request, fixture.origin, overlayRequestText);
      overlayTaskId = task?.id ?? overlayTaskId;
      return task?.status;
    })
    .toBe("review");

  await page.getByRole("button", { name: "작업 펼치기" }).click();
  await expect(compactTask).toHaveCount(0);
  const taskStrip = page.getByRole("region", { name: "작업 진행과 검토" });
  await expect(taskStrip.getByRole("status")).toContainText("검토 대기");
  await page.getByRole("button", { name: "닫기" }).click();
  await expect(taskStrip).toHaveCount(0);

  await page.getByRole("heading", { name: "Remote preview fixture" }).click();
  await expect(overlayRequest).toBeVisible();
  await page.keyboard.press("Escape");

  const revertedOverlayTask = await request.post(
    `${fixture.origin}/_visual/api/tasks/${overlayTaskId}/revert`,
    { headers: { authorization: `Bearer ${controlToken}` } },
  );
  expect(revertedOverlayTask.ok()).toBe(true);

  const workBoardLink = page.getByRole("link", {
    name: "전체화면 작업 보드를 새 탭에서 열기",
  });
  await expect(workBoardLink).toBeVisible();
  const viewerHref = await workBoardLink.getAttribute("href");
  expect(viewerHref).toMatch(/^\/_visual\/viewer#visual-view=/);

  const issuedViewerUrl = new URL(viewerHref!, fixture.origin);
  const viewerToken = decodeURIComponent(
    issuedViewerUrl.hash.slice("#visual-view=".length),
  );
  expect(viewerToken).not.toBe(controlToken);

  const [viewerPage] = await Promise.all([
    context.waitForEvent("page"),
    workBoardLink.click(),
  ]);
  await expect(viewerPage).toHaveURL(`${fixture.origin}/_visual/viewer`);
  await expect(
    viewerPage.getByRole("heading", { name: "프로젝트 작업 흐름" }),
  ).toBeVisible();
  await expect(viewerPage.locator(".connection-readout strong")).toHaveText(
    "실시간",
  );
  expect(new URL(viewerPage.url()).hash).toBe("");

  await viewerPage.reload();
  await expect(viewerPage.locator(".connection-readout strong")).toHaveText(
    "실시간",
  );

  const deniedMutation = await request.post(
    `${fixture.origin}/_visual/api/tasks`,
    {
      headers: { authorization: `Bearer ${viewerToken}` },
      data: { request: "viewer must remain read only" },
    },
  );
  expect(deniedMutation.status()).toBe(403);
  await expect(deniedMutation.json()).resolves.toMatchObject({
    error: { code: "read_only_token" },
  });

  const created = await request.post(`${fixture.origin}/_visual/api/tasks`, {
    headers: { authorization: `Bearer ${controlToken}` },
    data: taskPayload(fixture.origin, requestText),
  });
  expect(created.status()).toBe(201);

  await viewerPage
    .getByRole("button", { name: new RegExp(`^${requestText}`) })
    .click();
  await expect(
    viewerPage.getByRole("heading", { name: requestText }),
  ).toBeVisible();
  await expect(viewerPage.locator(".detail-status")).toHaveText("검토 대기");
  await expect(viewerPage.getByTitle("src/screen.ts")).toBeVisible();
  await expect(viewerPage.locator(".logs-block")).toContainText(
    "Changed the fixture button tone.",
  );
  await expect(viewerPage.locator(".diff-block pre")).toContainText(
    "-export const buttonTone = 'blue';",
  );
  await expect(viewerPage.locator(".diff-block pre")).toContainText(
    "+export const buttonTone = 'green';",
  );

  const search = viewerPage.getByRole("searchbox", { name: "작업 검색" });
  await search.fill("존재하지 않는 회귀 작업");
  await expect(viewerPage.getByText("검색 결과가 없습니다.")).toBeVisible();
  await search.fill("Playwright 실시간");
  await expect(viewerPage.locator(".task-row")).toContainText(requestText);
  await search.clear();

  await viewerPage.getByRole("button", { name: /검토 필요/ }).click();
  await expect(viewerPage.locator(".task-row")).toContainText(requestText);
  await viewerPage.getByRole("button", { name: /문제/ }).click();
  await expect(viewerPage.getByText("이 상태의 작업이 없습니다.")).toBeVisible();
  await viewerPage.getByRole("button", { name: /전체/ }).click();
  await expect(
    viewerPage.getByRole("heading", { name: requestText }),
  ).toBeVisible();

  await viewerPage.setViewportSize({ width: 320, height: 900 });
  await expect(viewerPage.getByRole("button", { name: /문제/ })).toBeVisible();
  await expect
    .poll(async () =>
      await viewerPage.evaluate(() => {
        const rail = document.querySelector<HTMLElement>(".status-rail");
        if (!rail) return false;
        const railRect = rail.getBoundingClientRect();
        const filtersFit = [...rail.querySelectorAll("button")].every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= railRect.left && rect.right <= railRect.right + 0.5;
        });
        return (
          document.documentElement.scrollWidth <= document.documentElement.clientWidth
          && rail.scrollWidth <= rail.clientWidth
          && filtersFit
        );
      }),
    )
    .toBe(true);

  expect(browserErrors).toEqual([]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function overlayTask(id: string, sessionId: string, status = "review") {
  return {
    id,
    projectId: "browser-fixture",
    originBrowserSessionId: sessionId,
    requestText: `Overlay race ${id}`,
    scope: "page",
    status,
    changedFiles: [],
    createdAt: new Date().toISOString(),
  };
}

async function routeOverlaySocket(page: Page, sessionId: string) {
  const connected = deferred<WebSocketRoute>();
  await page.addInitScript((id) => {
    sessionStorage.setItem("visual-bridge:browser-session", id);
    sessionStorage.removeItem("visual-bridge:last-sequence");
  }, sessionId);
  await page.routeWebSocket("**/_visual/ws", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string };
      if (message.type === "auth") {
        socket.send(JSON.stringify({ type: "auth.ok", projectId: "browser-fixture" }));
      }
      if (message.type === "browser.hello") connected.resolve(socket);
    });
  });
  await page.route("**/_visual/api/tasks/*/files", (route) => route.fulfill({ json: [] }));
  await page.route("**/_visual/api/tasks/*/logs", (route) => route.fulfill({ json: [] }));
  await page.route("**/_visual/api/tasks/*/diff", (route) => route.fulfill({ json: { diff: "" } }));
  return { connected: connected.promise };
}

for (const hydration of ["snapshot", "empty", "failed"] as const) {
  test(`overlay reconciles completion during ${hydration} hydration`, async ({ page }) => {
    const sessionId = randomUUID();
    const task = overlayTask("hydrated-task", sessionId, "running_agent");
    const releaseSnapshot = deferred<void>();
    const snapshotRequested = deferred<void>();
    await page.route("**/_visual/api/tasks", async (route) => {
      snapshotRequested.resolve();
      await releaseSnapshot.promise;
      await route.fulfill({
        status: hydration === "failed" ? 503 : 200,
        json: hydration === "snapshot" ? [task] : [],
      });
    });
    // Do not await the socket until the page that opens it has loaded.
    const socketReady = await routeOverlaySocket(page, sessionId);
    await page.goto(`${fixture.origin}/#visual-pair=${controlToken}`);
    const socket = await socketReady.connected;
    await snapshotRequested.promise;
    socket.send(JSON.stringify({
      type: "task.completed", seq: 1, taskId: task.id,
      payload: { ...task, status: "review" },
    }));
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("visual-bridge:last-sequence"))).toBe("1");
    releaseSnapshot.resolve();
    const strip = page.locator("#visual-task-strip");
    await expect(strip.locator(".phase-mark")).toHaveAttribute("data-state", "review");
    await expect(strip.getByRole("button", { name: "변경 유지", exact: true })).toBeEnabled();
    socket.send(JSON.stringify({
      type: "task.log", seq: 2, taskId: task.id, payload: { message: "single live log" },
    }));
    socket.send(JSON.stringify({
      type: "task.log", seq: 2, taskId: task.id, payload: { message: "single live log" },
    }));
    await expect(strip.locator(".log-summary li", { hasText: "single live log" })).toHaveCount(1);
  });
}

test("overlay bounds hanging hydration and ignores its late snapshot", async ({ page }) => {
  const sessionId = randomUUID();
  const taskA = overlayTask("timed-out-task", sessionId, "queued");
  const taskB = overlayTask("live-after-timeout", sessionId, "queued");
  const releaseSnapshot = deferred<void>();
  const snapshotRequested = deferred<void>();
  const clockTime = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: clockTime });
  // Simulate a transport that still resolves after cancellation, so the test
  // checks the stale-result guard as well as the deadline's abort signal.
  await page.addInitScript(() => {
    const originalSetTimeout = window.setTimeout.bind(window);
    Object.defineProperty(window, "setTimeout", {
      value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 3_000) {
          (window as Window & { hydrationDeadline?: number }).hydrationDeadline = Date.now() + timeout;
        }
        return originalSetTimeout(handler, timeout, ...args);
      },
    });
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (input === "/_visual/api/tasks") {
        const { signal, ...requestInit } = init ?? {};
        (window as Window & { hydrationSignal?: AbortSignal | null }).hydrationSignal = signal ?? null;
        return originalFetch(input, requestInit);
      }
      return originalFetch(input, init);
    };
  });
  await page.route("**/_visual/api/tasks", async (route) => {
    snapshotRequested.resolve();
    await releaseSnapshot.promise;
    await route.fulfill({ json: [{ ...taskA, status: "running_agent" }] });
  });
  const socketReady = await routeOverlaySocket(page, sessionId);
  await page.goto(`${fixture.origin}/#visual-pair=${controlToken}`);
  const socket = await socketReady.connected;
  await snapshotRequested.promise;
  socket.send(JSON.stringify({ type: "task.queued", seq: 1, taskId: taskA.id, payload: taskA }));
  socket.send(JSON.stringify({
    type: "task.completed", seq: 2, taskId: taskA.id,
    payload: { ...taskA, status: "review" },
  }));
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("visual-bridge:last-sequence"))).toBe("2");
  const strip = page.locator("#visual-task-strip");
  const deadline = await page.evaluate(() =>
    (window as Window & { hydrationDeadline?: number }).hydrationDeadline,
  );
  expect(deadline).toBeDefined();
  // Let Preact effects and socket startup run normally, then stop immediately
  // before the captured hydration deadline rather than guessing startup time.
  await page.clock.pauseAt(new Date(deadline! - 1));
  await expect(strip).toHaveCount(0);
  await page.clock.runFor(1);
  await page.clock.resume();
  await expect(strip.locator(".phase-mark")).toHaveAttribute("data-state", "review");
  await expect(strip.locator(".strip-title")).toHaveText(taskA.requestText);
  await expect(strip.getByRole("button", { name: "변경 유지", exact: true })).toBeEnabled();
  expect(await page.evaluate(() =>
    (window as Window & { hydrationSignal?: AbortSignal }).hydrationSignal?.aborted,
  )).toBe(true);

  socket.send(JSON.stringify({ type: "task.queued", seq: 3, taskId: taskB.id, payload: taskB }));
  socket.send(JSON.stringify({
    type: "task.completed", seq: 4, taskId: taskB.id,
    payload: { ...taskB, status: "review" },
  }));
  await expect(strip.locator(".strip-title")).toHaveText(taskB.requestText);
  await expect(strip.locator(".phase-mark")).toHaveAttribute("data-state", "review");
  const snapshotResponse = page.waitForResponse("**/_visual/api/tasks");
  releaseSnapshot.resolve();
  await (await snapshotResponse).finished();
  // A live event after the stale response also proves the active task binding
  // and connection remain usable, not merely that the old strip stayed visible.
  socket.send(JSON.stringify({
    type: "task.log", seq: 5, taskId: taskB.id, payload: { message: "live after stale snapshot" },
  }));
  await expect(strip.locator(".log-summary")).toHaveText("live after stale snapshot");
  await expect(strip.locator(".strip-title")).toHaveText(taskB.requestText);
  await expect(strip.locator(".phase-mark")).toHaveAttribute("data-state", "review");
  await expect(strip.getByRole("button", { name: "변경 유지", exact: true })).toBeEnabled();
});

for (const outcome of ["success", "error"] as const) {
  for (const newerAction of [false, true]) {
    test(`overlay isolates delayed A ${outcome} with B action ${newerAction}`, async ({ page }) => {
      const sessionId = randomUUID();
      const taskA = overlayTask("task-a", sessionId);
      const taskB = overlayTask("task-b", sessionId);
      await page.route("**/_visual/api/tasks", (route) => route.fulfill({ json: [taskA] }));
      const releaseA = deferred<void>();
      const requestedA = deferred<void>();
      const releaseB = deferred<void>();
      const requestedB = deferred<void>();
      await page.route("**/_visual/api/tasks/task-a/accept", async (route) => {
        requestedA.resolve();
        await releaseA.promise;
        await route.fulfill({ status: outcome === "success" ? 200 : 409, json: { message: "old A response" } });
      });
      await page.route("**/_visual/api/tasks/task-b/accept", async (route) => {
        requestedB.resolve();
        await releaseB.promise;
        await route.fulfill({ json: {} });
      });
      const socketReady = await routeOverlaySocket(page, sessionId);
      await page.goto(`${fixture.origin}/#visual-pair=${controlToken}`);
      const socket = await socketReady.connected;
      const strip = page.locator("#visual-task-strip");
      const accept = strip.getByRole("button", { name: "변경 유지", exact: true });
      await accept.click();
      await requestedA.promise;
      socket.send(JSON.stringify({ type: "task.queued", seq: 1, taskId: taskB.id, payload: taskB }));
      await expect(strip.locator(".strip-title")).toHaveText(taskB.requestText);
      await expect(accept).toBeEnabled();
      if (newerAction) {
        await accept.click();
        await requestedB.promise;
        await expect(accept).toBeDisabled();
      }
      const responseA = page.waitForResponse("**/_visual/api/tasks/task-a/accept");
      releaseA.resolve();
      await (await responseA).finished();
      // A later socket event is an observable barrier after the action response.
      socket.send(JSON.stringify({ type: "task.log", seq: 2, taskId: taskB.id, payload: { message: "B remains current" } }));
      await expect(strip.locator(".log-summary")).toHaveText("B remains current");
      await expect(strip.locator(".phase-mark")).toHaveAttribute("data-state", "review");
      await expect(strip.getByRole("alert")).toHaveCount(0);
      if (newerAction) {
        await expect(accept).toBeDisabled();
        releaseB.resolve();
        await expect(strip.locator(".phase-mark")).toHaveAttribute("data-state", "accepted");
      } else {
        await expect(accept).toBeEnabled();
      }
    });
  }
}

test("local ordinary URLs ignore stale tokens and connect control and read-only viewer", async ({ context, page, request }) => {
  const local = await startFixture("local");
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const frames: Array<{ type: string; payload?: { mode?: string } }> = [];
  context.on("request", (entry) => {
    if (entry.url().includes("/_visual/")) requests.push({ url: entry.url(), headers: entry.headers() });
  });
  const observeFrames = (target: Page) => target.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => frames.push(JSON.parse(String(payload))));
  });
  observeFrames(page);
  context.on("page", observeFrames);
  await context.addInitScript(() => {
    sessionStorage.setItem("visual-bridge:pairing-token", "stale-control-token");
    sessionStorage.setItem("visual-bridge:viewer-token", "stale-viewer-token");
  });
  try {
    await page.goto(local.origin);
    const toolbar = page.getByRole("navigation", { name: "Visual Bridge 도구" });
    await expect(toolbar).toBeVisible();
    await expect.poll(() => frames.some((frame) => frame.type === "browser.hello")).toBe(true);
    await expect(toolbar.getByRole("link", { name: "전체화면 작업 보드를 새 탭에서 열기" })).toHaveAttribute("href", "/_visual/viewer");
    await page.reload();
    await expect(toolbar).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByPlaceholder("선택한 화면을 어떻게 바꿀까요?").fill("Local token-free request");
    await page.getByRole("button", { name: "요청 보내기" }).click();
    await expect(page.locator("#visual-task-strip .phase-mark")).toHaveAttribute("data-state", "review");
    const viewer = await context.newPage();
    await viewer.goto(`${local.origin}/_visual/viewer`);
    await expect(viewer.getByRole("heading", { name: "프로젝트 작업 흐름" })).toBeVisible();
    await expect(viewer.locator(".connection-readout")).toHaveAttribute("data-state", "connected");
    await expect(viewer.locator(".task-ledger")).toContainText("Local token-free request");
    await expect(viewer.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => requests.some((entry) => entry.url.includes("/files") && entry.headers["x-visual-mode"] === "viewer")).toBe(true);
    const denied = await request.post(`${local.origin}/_visual/api/tasks`, {
      headers: { "X-Visual-Mode": "viewer", Origin: local.origin },
      data: taskPayload(local.origin, "Viewer must not write"),
    });
    expect(denied.status()).toBe(403);
    expect(frames.filter((frame) => frame.type === "session.open").map((frame) => frame.payload?.mode)).toEqual(expect.arrayContaining(["control", "viewer"]));
    expect(frames.some((frame) => frame.type === "auth")).toBe(false);
    expect(requests.some((entry) => entry.headers.authorization)).toBe(false);
    expect(requests.some((entry) => entry.url.includes("/viewer-session"))).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem("visual-bridge:pairing-token"))).toBe("stale-control-token");
    expect(await viewer.evaluate(() => sessionStorage.getItem("visual-bridge:viewer-token"))).toBe("stale-viewer-token");
  } finally {
    await stopFixture(local);
  }
});

for (const path of ["/", "/_visual/viewer"]) {
  test(`bootstrap failure is visible and never guesses local mode on ${path}`, async ({ page }) => {
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.route("**/_visual/bootstrap", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
    await page.goto(`${fixture.origin}${path}`);
    await expect(page.getByRole("alert")).toContainText("Bridge 설정을 불러오지 못했습니다");
    await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
    expect(sockets).toEqual([]);
  });
}

test("local bootstrap selects session.open before any token handshake", async ({ page }) => {
  const frames: Array<{ type: string; payload?: { mode?: string } }> = [];
  await page.route("**/_visual/bootstrap", (route) => route.fulfill({
    json: { authMode: "local", projectId: "browser-fixture" },
  }));
  await page.route("**/_visual/api/tasks", (route) => route.fulfill({ json: [] }));
  await page.route("**/_visual/api/project", (route) => route.fulfill({ json: { projectId: "browser-fixture" } }));
  await page.routeWebSocket("**/_visual/ws", (socket) => {
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      frames.push(frame);
      if (frame.type === "session.open") socket.send(JSON.stringify({
        type: "session.ready", projectId: "browser-fixture", payload: { access: "control" },
      }));
    });
  });
  await page.goto(fixture.origin);
  await expect(page.getByRole("navigation", { name: "Visual Bridge 도구" })).toBeVisible();
  await expect.poll(() => frames.some((frame) => frame.type === "browser.hello")).toBe(true);
  expect(frames[0]).toEqual({ type: "session.open", payload: { mode: "control" } });
  expect(frames.some((frame) => frame.type === "auth")).toBe(false);
});

test("viewer preserves full persisted and live multiline logs with older entries and repeats", async ({ page }) => {
  const task = overlayTask("full-viewer-logs", "logs-session", "running_agent");
  const longMessage = `  Claude persisted output\n${"long multiline content ".repeat(80)}\n  PERSISTED END\n`;
  const liveMessage = `  Claude live output\n${"live multiline content ".repeat(80)}\n  LIVE END\n`;
  const persisted = [
    "oldest persisted entry",
    ...Array.from({ length: 42 }, (_, index) => `persisted entry ${index}`),
    "repeated persisted entry",
    "repeated persisted entry",
    longMessage,
  ];
  const connected = deferred<WebSocketRoute>();
  await page.route("**/_visual/bootstrap", (route) => route.fulfill({
    json: { authMode: "local", projectId: "browser-fixture" },
  }));
  await page.route("**/_visual/api/project", (route) => route.fulfill({ json: { projectId: "browser-fixture" } }));
  await page.route(/\/_visual\/api\/tasks(?:\?.*)?$/u, (route) => route.fulfill({ json: [task] }));
  await page.route("**/_visual/api/tasks/*/files", (route) => route.fulfill({ json: [] }));
  await page.route("**/_visual/api/tasks/*/diff", (route) => route.fulfill({ json: { diff: "" } }));
  await page.route("**/_visual/api/tasks/*/logs", (route) => route.fulfill({
    json: persisted.map((message, index) => ({ id: `log-${index}`, event: { type: "message", message } })),
  }));
  await page.routeWebSocket("**/_visual/ws", (socket) => {
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "session.open") socket.send(JSON.stringify({
        type: "session.ready", projectId: "browser-fixture", payload: { access: "viewer" },
      }));
      if (frame.type === "browser.hello") connected.resolve(socket);
    });
  });
  await page.goto(`${fixture.origin}/_visual/viewer`);
  const logs = page.getByRole("list", { name: "작업 로그 목록" });
  await expect(logs.locator("li")).toHaveCount(40);
  await expect(logs.getByText("oldest persisted entry", { exact: true })).toHaveCount(0);
  await expect(logs.getByText("repeated persisted entry", { exact: true })).toHaveCount(2);
  const persistedEntry = logs.locator("li").last();
  await expect(persistedEntry.locator("pre")).toBeHidden();
  await persistedEntry.locator(".log-toggle .log-text").click();
  expect(await persistedEntry.locator("pre").textContent()).toBe(longMessage);
  await expect(persistedEntry.locator("pre")).toHaveCSS("white-space", "pre-wrap");
  await persistedEntry.getByRole("button", { name: "로그 접기" }).focus();
  await page.keyboard.press("Enter");
  await expect(persistedEntry.locator("pre")).toBeHidden();
  await expect(persistedEntry.locator(".log-toggle .log-text")).not.toContainText("PERSISTED END");
  await page.getByRole("button", { name: /이전 로그 .*더 보기/ }).click();
  await expect(logs.locator("li")).toHaveCount(persisted.length);
  await expect(logs.getByText("oldest persisted entry", { exact: true })).toBeVisible();
  const socket = await connected.promise;
  const live = [...Array.from({ length: 45 }, (_, index) => `live entry ${index}`), liveMessage, liveMessage];
  for (const [index, message] of live.entries()) socket.send(JSON.stringify({
    seq: index + 1, type: "task.agent_output", projectId: "browser-fixture", taskId: task.id,
    payload: { event: { type: "message", message } }, createdAt: new Date().toISOString(),
  }));
  await expect(page.locator(".logs-block > header .machine")).toHaveText(String(persisted.length + live.length));
  const liveEntries = logs.locator("li").filter({ hasText: "Claude live output" });
  await expect(liveEntries).toHaveCount(2);
  await liveEntries.last().locator(".log-toggle .log-text").click();
  expect(await liveEntries.last().locator("pre").textContent()).toBe(liveMessage);
  await page.getByRole("button", { name: /이전 로그 .*더 보기/ }).click();
  await expect(logs.locator("li")).toHaveCount(persisted.length + live.length);
  await expect(logs.getByText("oldest persisted entry", { exact: true })).toHaveCount(1);
  await expect(logs.getByText("live entry 0", { exact: true })).toHaveCount(1);
});

test("overlay expands persisted and live logs by clicking the visible preview", async ({ page }) => {
  const sessionId = randomUUID();
  const task = overlayTask("full-overlay-logs", sessionId, "running_agent");
  const persisted = `  # Stored markdown\n\n${"long persisted output ".repeat(80)}\n  PERSISTED END\n`;
  const live = `  # Live markdown\n\n${"long live output ".repeat(80)}\n  LIVE END\n`;
  const socketReady = await routeOverlaySocket(page, sessionId);
  await page.route("**/_visual/api/tasks", (route) => route.fulfill({ json: [task] }));
  await page.route("**/_visual/api/tasks/*/logs", (route) => route.fulfill({
    json: [{ event: { type: "message", message: persisted } }],
  }));
  await page.goto(`${fixture.origin}/#visual-pair=${controlToken}`);
  const logs = page.getByRole("list", { name: "최근 작업 로그" });
  const storedEntry = logs.locator("li").first();
  await expect(storedEntry.locator(".log-toggle .log-text")).not.toContainText("PERSISTED END");
  await storedEntry.locator(".log-toggle .log-text").click();
  await expect(storedEntry.locator("pre")).toBeVisible();
  expect(await storedEntry.locator("pre").textContent()).toBe(persisted);
  await expect(storedEntry.locator("pre")).toHaveCSS("white-space", "pre-wrap");
  await storedEntry.getByRole("button", { name: "로그 접기" }).focus();
  await page.keyboard.press("Enter");
  await expect(storedEntry.locator("pre")).toBeHidden();
  const socket = await socketReady.connected;
  socket.send(JSON.stringify({
    type: "task.agent_output", seq: 1, taskId: task.id,
    payload: { event: { type: "message", message: live } },
  }));
  const liveEntry = logs.locator("li").last();
  await expect(liveEntry.locator(".log-toggle .log-text")).toContainText("Live markdown");
  await expect(liveEntry.locator(".log-toggle .log-text")).not.toContainText("LIVE END");
  await liveEntry.locator(".log-toggle .log-text").click();
  await expect(liveEntry.locator("pre")).toBeVisible();
  expect(await liveEntry.locator("pre").textContent()).toBe(live);
  await expect(liveEntry.locator("pre")).toHaveCSS("white-space", "pre-wrap");
  await liveEntry.getByRole("button", { name: "로그 접기" }).focus();
  await page.keyboard.press("Space");
  await expect(liveEntry.locator("pre")).toBeHidden();
});

for (const outcome of ["http", "socket", "newer", "error"] as const) {
  test(`overlay permission approval scopes tools and handles ${outcome} response`, async ({ page }) => {
    const sessionId = randomUUID();
    const tools = ["mcp__figma__download_image", "mcp__figma__get_design_context"];
    const denied = {
      ...overlayTask("denied-tools", sessionId, "failed"),
      error: { code: "AGENT_PERMISSION_DENIED", message: "Claude 도구 권한 거부" },
      permissionDeniedTools: [...tools, "Bash", "mcp__figma__*"],
    };
    const retry = overlayTask("approved-retry", sessionId, "queued");
    const newer = overlayTask("newer-request", sessionId, "running_agent");
    const socketReady = await routeOverlaySocket(page, sessionId);
    await page.route("**/_visual/api/tasks", (route) => route.fulfill({ json: [denied] }));
    const requested = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    await page.route("**/_visual/api/tasks/denied-tools/approve-tools", async (route) => {
      calls++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers().authorization).toBe(`Bearer ${controlToken}`);
      expect(route.request().postDataJSON()).toEqual({ tools });
      requested.resolve();
      await release.promise;
      await route.fulfill({ status: outcome === "error" ? 409 : 200, json: outcome === "error" ? { message: "승인 재시도 실패" } : retry });
    });
    await page.goto(`${fixture.origin}/#visual-pair=${controlToken}`);
    const socket = await socketReady.connected;
    const strip = page.locator("#visual-task-strip");
    const approve = strip.getByRole("button", { name: "해당 MCP 도구 허용 후 재시도", exact: true });
    await expect(strip.getByRole("list", { name: "재시도에서 허용할 MCP 도구" }).locator("li")).toHaveText(tools);
    await expect(strip.getByText(/모든 인수의 호출/)).toBeVisible();
    await approve.click();
    await requested.promise;
    await expect(approve).toBeDisabled();
    expect(calls).toBe(1);
    if (outcome === "socket" || outcome === "newer") {
      socket.send(JSON.stringify({ type: "task.queued", seq: 1, taskId: retry.id, payload: retry }));
      socket.send(JSON.stringify({ type: "task.completed", seq: 2, taskId: retry.id, payload: { ...retry, status: "review" } }));
      if (outcome === "newer") socket.send(JSON.stringify({ type: "task.queued", seq: 3, taskId: newer.id, payload: newer }));
      await expect(strip.locator(".phase-mark")).toHaveAttribute("data-state", outcome === "newer" ? "running_agent" : "review");
    }
    const response = page.waitForResponse("**/_visual/api/tasks/denied-tools/approve-tools");
    release.resolve();
    await (await response).finished();
    if (outcome === "error") {
      await expect(strip.getByRole("alert")).toContainText("승인 재시도 실패");
      await expect(approve).toBeEnabled();
      await expect(strip.locator(".strip-title")).toHaveText(denied.requestText);
    } else {
      const current = outcome === "newer" ? newer : retry;
      await expect(strip.locator(".strip-title")).toHaveText(current.requestText);
      socket.send(JSON.stringify({ type: "task.log", seq: 4, taskId: current.id, payload: { message: "retry binding remains current" } }));
      await expect(strip.locator(".log-summary")).toContainText("retry binding remains current");
      await expect(strip.locator(".phase-mark")).toHaveAttribute("data-state", outcome === "http" ? "queued" : outcome === "socket" ? "review" : "running_agent");
      await expect(approve).toHaveCount(0);
    }
    expect(calls).toBe(1);
  });
}

for (const tools of [[], ["Bash"], ["mcp__figma__*", "mcp__figma__download image"]]) {
  test(`overlay guides local permissions without approval for ${JSON.stringify(tools)}`, async ({ page }) => {
    const sessionId = randomUUID();
    await routeOverlaySocket(page, sessionId);
    await page.route("**/_visual/api/tasks", (route) => route.fulfill({ json: [{
      ...overlayTask("non-approvable", sessionId, "failed"),
      error: { code: "AGENT_PERMISSION_DENIED", message: "도구 권한 거부" },
      permissionDeniedTools: tools,
    }] }));
    await page.goto(`${fixture.origin}/#visual-pair=${controlToken}`);
    const strip = page.locator("#visual-task-strip");
    await expect(strip.getByText(/로컬 Claude CLI의 권한 설정을 확인/)).toBeVisible();
    await expect(strip.getByRole("button", { name: "해당 MCP 도구 허용 후 재시도" })).toHaveCount(0);
  });
}

test("viewer shows denied tools without approval mutations", async ({ page }) => {
  const tool = "mcp__figma__download_image";
  const denied = {
    ...overlayTask("viewer-denied", "viewer-denied-session", "failed"),
    error: { code: "AGENT_PERMISSION_DENIED", message: "Claude 도구 권한 거부" },
    permissionDeniedTools: [tool],
  };
  let approvalCalls = 0;
  await page.route("**/_visual/bootstrap", (route) => route.fulfill({ json: { authMode: "local", projectId: "browser-fixture" } }));
  await page.route("**/_visual/api/project", (route) => route.fulfill({ json: { projectId: "browser-fixture" } }));
  await page.route(/\/_visual\/api\/tasks(?:\?.*)?$/u, (route) => route.fulfill({ json: [denied] }));
  await page.route("**/_visual/api/tasks/*/files", (route) => route.fulfill({ json: [] }));
  await page.route("**/_visual/api/tasks/*/logs", (route) => route.fulfill({ json: [] }));
  await page.route("**/_visual/api/tasks/*/diff", (route) => route.fulfill({ json: { diff: "" } }));
  await page.route("**/approve-tools", (route) => { approvalCalls++; return route.fulfill({ status: 403 }); });
  await page.routeWebSocket("**/_visual/ws", (socket) => {
    socket.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === "session.open") socket.send(JSON.stringify({ type: "session.ready", projectId: "browser-fixture", payload: { access: "viewer" } }));
    });
  });
  await page.goto(`${fixture.origin}/_visual/viewer`);
  await expect(page.getByText("Claude 도구 권한 거부", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "거부된 도구", exact: true }).getByText(tool, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "해당 MCP 도구 허용 후 재시도" })).toHaveCount(0);
  expect(approvalCalls).toBe(0);
});

async function forbidMediaCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const forbidden = () => {
      document.documentElement.dataset.mediaCalls = String(Number(document.documentElement.dataset.mediaCalls ?? 0) + 1);
      throw new Error("The user's tab must never be captured");
    };
    const devices = navigator.mediaDevices ?? {};
    if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: devices });
    for (const name of ["getDisplayMedia", "getUserMedia", "setCaptureHandleConfig"]) {
      Object.defineProperty(devices, name, { configurable: true, value: forbidden });
    }
  });
}

test("Figma auto detection submits without browser setup and explicit opt-out preserves normal requests", async ({ page }) => {
  await forbidMediaCapture(page);
  const frames: Array<{ type: string; payload?: { request?: { comparison?: { enabled: boolean; url?: string } }; selection?: { targets?: unknown[] } } }> = [];
  let browserOpens = 0;
  await page.route("**/_visual/api/comparison-browser", (route) => { browserOpens++; return route.fulfill({ json: { status: "ready", message: "Ready" } }); });
  await page.route("**/_visual/bootstrap", (route) => route.fulfill({ json: { authMode: "local", projectId: "browser-fixture" } }));
  await page.route(/\/_visual\/api\/tasks(?:\?.*)?$/u, (route) => route.fulfill({ json: [] }));
  await page.routeWebSocket("**/_visual/ws", (socket) => socket.onMessage((raw) => {
    const frame = JSON.parse(String(raw)); frames.push(frame);
    if (frame.type === "session.open") socket.send(JSON.stringify({ type: "session.ready", projectId: "browser-fixture", payload: { access: "control" } }));
  }));
  await page.goto(fixture.origin);
  await page.locator("#primary").evaluate((element) => element.setAttribute("aria-expanded", "true"));
  await page.getByRole("button", { name: "Save changes" }).click();
  const request = page.getByPlaceholder("선택한 화면을 어떻게 바꿀까요?");
  const url = "https://www.figma.com/design/Abc/Frame?node-id=1-2";
  await request.fill(`Match ${url}`);
  const compare = page.getByRole("checkbox", { name: "Figma 디자인과 자동 비교" });
  await expect(compare).toBeChecked();
  await expect(page.getByRole("button", { name: "요청 보내기" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Figma 프레임 링크" })).toHaveValue(url);
  await page.getByRole("button", { name: "요청 보내기" }).click();
  await expect.poll(() => frames.filter((frame) => frame.type === "task.create").length).toBe(1);
  expect(frames.find((frame) => frame.type === "task.create")?.payload?.request?.comparison).toMatchObject({ enabled: true, url });
  expect(frames.find((frame) => frame.type === "task.create")?.payload?.selection?.targets).toHaveLength(1);
  expect(frames.find((frame) => frame.type === "task.create")?.payload?.selection?.targets?.[0]).toMatchObject({ dom: { attributes: { "aria-expanded": "true" } } });
  await page.getByRole("button", { name: "작업 최소화", exact: true }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await request.fill(`Another comparison ${url}`);
  await page.getByRole("button", { name: "요청 보내기" }).click();
  await expect.poll(() => frames.filter((frame) => frame.type === "task.create").length).toBe(2);
  expect(frames.filter((frame) => frame.type === "task.create")[1]?.payload?.request?.comparison).toMatchObject({ enabled: true, url });
  await page.getByRole("button", { name: "작업 최소화", exact: true }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await request.fill(`Normal edit mentioning ${url}`);
  await compare.uncheck();
  await page.getByRole("button", { name: "요청 보내기" }).click();
  await expect.poll(() => frames.filter((frame) => frame.type === "task.create").length).toBe(3);
  expect(frames.filter((frame) => frame.type === "task.create")[2]?.payload?.request?.comparison?.enabled).toBe(false);
  expect(browserOpens).toBe(0);
  expect(await page.evaluate(() => document.documentElement.dataset.mediaCalls ?? "0")).toBe("0");
});

for (const authMode of ["local", "token"] as const) {
  test(`verification browser opens only on click with busy and retryable errors (${authMode})`, async ({ page }) => {
    await forbidMediaCapture(page);
    const release = deferred<void>();
    let browserOpens = 0;
    await page.route("**/_visual/bootstrap", (route) => route.fulfill({ json: { authMode, projectId: "browser-fixture" } }));
    await page.route("**/_visual/api/project", (route) => route.fulfill({ json: { projectId: "browser-fixture" } }));
    await page.route(/\/_visual\/api\/tasks(?:\?.*)?$/u, (route) => route.fulfill({ json: [] }));
    await page.routeWebSocket("**/_visual/ws", (socket) => socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "session.open") socket.send(JSON.stringify({ type: "session.ready", projectId: "browser-fixture", payload: { access: "control" } }));
      if (frame.type === "auth") socket.send(JSON.stringify({ type: "auth.ok", projectId: "browser-fixture", payload: { access: "control" } }));
    }));
    await page.route("**/_visual/api/comparison-browser", async (route) => {
      browserOpens++;
      expect(route.request().method()).toBe("POST");
      const payload = route.request().postDataJSON();
      expect(payload.context.page.url).toBe(`${fixture.origin}/?view=setup#current-section`);
      expect(payload.context.page.pathname).toBe("/");
      expect(payload.context.page.viewport).toEqual(page.viewportSize());
      expect(payload.context.projectId).toBe("browser-fixture");
      expect(payload.context.selection.mode).toBe("element");
      expect(payload.context.selection.targets[0].dom.text).toBe("Save changes");
      expect(payload.context.request.text).toBe("검증 브라우저 설정");
      for (const secret of [controlToken, "attribute-secret", "cookie-secret", "storage-secret", "form-secret", "request-secret", "visual-pair="]) {
        expect(JSON.stringify(payload)).not.toContain(secret);
      }
      expect(route.request().headers().authorization).toBe(authMode === "token" ? `Bearer ${controlToken}` : undefined);
      if (browserOpens === 1) {
        await release.promise;
        await route.fulfill({ status: 409, body: "비교 작업이 진행 중입니다. 완료 후 다시 시도하세요." });
      } else await route.fulfill({ json: { status: "ready", message: "검증 브라우저가 열렸습니다." } });
    });
    await page.goto(`${fixture.origin}${authMode === "token" ? `#visual-pair=${controlToken}` : ""}`);
    await page.evaluate(() => {
      history.replaceState(null, "", "/?view=setup#current-section");
      document.cookie = "setup-private=cookie-secret; Path=/";
      localStorage.setItem("setup-private", "storage-secret");
      document.querySelector("button")?.setAttribute("data-token", "attribute-secret");
      const input = document.createElement("input");
      input.type = "password";
      input.value = "form-secret";
      document.body.append(input);
    });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByPlaceholder("선택한 화면을 어떻게 바꿀까요?").fill("request-secret Match https://www.figma.com/design/Abc/Frame?node-id=1-2");
    const viewport = page.viewportSize();
    const location = page.url();
    expect(browserOpens).toBe(0);
    await page.getByRole("button", { name: "검증 브라우저 열기", exact: true }).click();
    await expect(page.getByRole("button", { name: "검증 브라우저 여는 중…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "요청 보내기" })).toBeEnabled();
    release.resolve();
    await expect(page.getByRole("alert")).toContainText("비교 작업이 진행 중입니다");
    await page.getByRole("button", { name: "검증 브라우저 열기", exact: true }).click();
    await expect(page.getByText("검증 브라우저가 열렸습니다.", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(browserOpens).toBe(2);
    expect(page.viewportSize()).toEqual(viewport);
    expect(page.url()).toBe(location);
    await expect(page.getByRole("navigation", { name: "Visual Bridge 도구" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.mediaCalls ?? "0")).toBe("0");
  });
}

test("viewer displays recorded comparison criteria and authorized PNG evidence", async ({ page }) => {
  const task = { ...overlayTask("comparison-viewer", "comparison-session", "review"), comparison: {
    status: "unmatched", url: "https://www.figma.com/design/fixture/Test?node-id=1-2", iteration: 1, maxIterations: 4, targetMatch: 97, threshold: 12,
    iterations: [{ iteration: 1, overallMatch: 94.5, regions: { center: 93 }, structuralMismatches: 2, missingTargets: 1, issues: ["Missing title"], referenceArtifactId: "reference", screenshotArtifactId: "capture", heatmapArtifactId: "heatmap", overlayArtifactId: "overlay" }],
  } };
  const modes: Array<string | undefined> = [];
  await page.route("**/_visual/bootstrap", (route) => route.fulfill({ json: { authMode: "local", projectId: "browser-fixture" } }));
  await page.route("**/_visual/api/project", (route) => route.fulfill({ json: { projectId: "browser-fixture" } }));
  await page.routeWebSocket("**/_visual/ws", (socket) => socket.onMessage((raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === "session.open") socket.send(JSON.stringify({ type: "session.ready", projectId: "browser-fixture", payload: { access: "viewer" } }));
  }));
  await page.route(/\/_visual\/api\/tasks(?:\?.*)?$/u, (route) => route.fulfill({ json: [task] }));
  await page.route("**/_visual/api/tasks/*/files", (route) => route.fulfill({ json: [] }));
  await page.route("**/_visual/api/tasks/*/logs", (route) => route.fulfill({ json: [] }));
  await page.route("**/_visual/api/tasks/*/diff", (route) => route.fulfill({ json: { diff: "" } }));
  await page.route("**/_visual/api/artifacts/*", async (route) => {
    modes.push(route.request().headers()["x-visual-mode"]);
    await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64") });
  });
  await page.goto(`${fixture.origin}/_visual/viewer`);
  const panel = page.getByRole("region", { name: "Figma 디자인 비교" });
  await expect(panel).toContainText("비교 기준 미달");
  await expect(panel).toContainText("97% 이상 · RGB 차이 허용 12/255");
  await expect(panel).toContainText("94.50%");
  await expect(panel).toContainText("Missing title");
  await expect(panel.getByRole("img")).toHaveCount(4);
  await expect(panel.getByRole("link", { name: "원본 크기로 열기" })).toHaveCount(4);
  expect(modes).toEqual(["viewer", "viewer", "viewer", "viewer"]);
});

test("comparison completes real verification browser control engine storage and viewer flow", async ({ page, request, context }) => {
  const comparisonFixture = await startFixture("local", true);
  try {
    // The fixture agent supplies the reference; the dedicated server browser captures the app.
    await forbidMediaCapture(page);
    await page.goto(comparisonFixture.origin);
    await expect(page.getByRole("navigation", { name: "Visual Bridge 도구" })).toBeVisible();
    await page.evaluate(() => {
      const image = document.createElement("img");
      image.src = "data:image/png;base64,broken";
      image.style.cssText = "position:fixed;left:-1000px;top:-1000px;width:20px;height:20px";
      document.body.append(image);
    });
    await page.locator("#comparison-target").click();
    const text = "Match https://www.figma.com/design/fixture/Test?node-id=1-2";
    await page.getByPlaceholder("선택한 화면을 어떻게 바꿀까요?").fill(text);
    await page.getByRole("button", { name: "요청 보내기" }).click();
    let taskId = "";
    await expect.poll(async () => {
      const response = await request.get(`${comparisonFixture.origin}/_visual/api/tasks`);
      expect(response.ok()).toBe(true);
      const tasks = await response.json() as Array<{ id: string; requestText: string; comparison?: { status: string; message?: string }; error?: { message?: string } }>;
      const task = tasks.find((item) => item.requestText === text);
      taskId = task?.id ?? "";
      return { status: task?.comparison?.status, message: task?.comparison?.message, error: task?.error?.message };
    }, { timeout: 25_000 }).toMatchObject({ status: "passed" });
    expect(taskId).not.toBe("");
    const viewer = await context.newPage();
    await viewer.goto(`${comparisonFixture.origin}/_visual/viewer`);
    const panel = viewer.getByRole("region", { name: "Figma 디자인 비교" });
    await expect(panel).toContainText("비교 기준 통과");
    await expect(panel).toContainText("100.00%");
    await expect(panel).toContainText("RGB 차이 허용 30/255");
    await expect(panel.getByRole("img")).toHaveCount(4);
    await expect.poll(() => panel.getByRole("img").evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 64 && image.naturalHeight === 64))).toBe(true);
    await expect(page.getByRole("navigation", { name: "Visual Bridge 도구" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.mediaCalls ?? "0")).toBe("0");
    await viewer.close();
    await page.getByRole("button", { name: "후속 수정", exact: true }).click();
    await page.getByRole("textbox", { name: "후속 수정 내용" }).fill("Keep matching the same frame without repeating its link");
    await page.getByRole("button", { name: "후속 요청 보내기", exact: true }).click();
    await expect.poll(async () => {
      const response = await request.get(`${comparisonFixture.origin}/_visual/api/tasks`);
      const tasks = await response.json() as Array<{ parentTaskId?: string; comparison?: { status: string; message?: string }; error?: { message?: string } }>;
      const task = tasks.find((item) => item.parentTaskId === taskId);
      return { status: task?.comparison?.status, message: task?.comparison?.message, error: task?.error?.message };
    }, { timeout: 25_000 }).toMatchObject({ status: "passed" });
  } finally { await stopFixture(comparisonFixture); }
});
