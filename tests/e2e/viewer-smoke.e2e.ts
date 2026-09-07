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

async function startFixture(authMode: "local" | "token" = "token"): Promise<RunningFixture> {
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
