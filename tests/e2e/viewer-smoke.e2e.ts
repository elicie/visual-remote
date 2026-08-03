import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, test, type APIRequestContext } from "@playwright/test";
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

async function startFixture(): Promise<RunningFixture> {
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
  await expect(compactTask).toContainText("browser-fixture");
  await expect(compactTask).toContainText(overlayRequestText);
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
