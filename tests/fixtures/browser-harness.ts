import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PNG } from "pngjs";

import {
  createTaskControlService,
  FakeAgentAdapter,
  GitTransactionManager,
  SqliteTaskStore,
  TaskService,
} from "@visual-remote/bridge-core";
import { createGatewayServer } from "@visual-remote/gateway";

const gatewayPort = Number.parseInt(
  process.env.VISUAL_FIXTURE_GATEWAY_PORT ?? "10001",
  10,
);
const upstreamPort = Number.parseInt(
  process.env.VISUAL_FIXTURE_UPSTREAM_PORT ?? "10004",
  10,
);
const projectId = "browser-fixture";
const pairingToken = "visual-browser-fixture-token";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

const repoRoot = await mkdtemp(join(tmpdir(), "visual-browser-fixture-"));
git(repoRoot, ["init", "-q"]);
git(repoRoot, ["config", "user.name", "Visual Fixture"]);
git(repoRoot, ["config", "user.email", "visual@example.test"]);
await mkdir(join(repoRoot, "src"), { recursive: true });
await writeFile(
  join(repoRoot, "src", "screen.ts"),
  "export const buttonTone = 'blue';\n",
);
git(repoRoot, ["add", "."]);
git(repoRoot, ["commit", "-qm", "fixture"]);

const upstream = createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Visual Bridge Browser Fixture</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #edf2f7; font: 16px/1.5 system-ui, sans-serif; color: #17212b; }
      main { width: min(680px, calc(100vw - 40px)); padding: 48px; background: white; border: 1px solid #c7d0da; }
      h1 { margin: 0 0 12px; font-size: 30px; }
      p { margin: 0 0 28px; color: #52606d; }
      #primary { min-height: 44px; padding: 0 20px; border: 0; border-radius: 8px; background: #1f6feb; color: white; font-weight: 700; }
    </style>
  </head>
  <body>
    <main data-source-file="src/screen.ts" data-source-line="1">
      <h1>Remote preview fixture</h1>
      <p>Select the button and dispatch a safe test change.</p>
      <button id="primary" data-testid="primary-action" data-source-file="src/screen.ts" data-source-line="1">Save changes</button>
      ${process.env.VISUAL_FIXTURE_COMPARISON === "true" ? '<div id="comparison-target" data-source-file="src/screen.ts" data-source-line="1" style="width:64px;height:64px;background:rgb(31,111,235)"></div>' : ""}
    </main>
  </body>
</html>`);
});

await new Promise<void>((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(upstreamPort, "0.0.0.0", resolve);
});

const gitManager = await GitTransactionManager.open(repoRoot, {
  allowed: ["src/**"],
});
const adapter = new FakeAgentAdapter(async (input) => {
  const artifactDirectory = input.prompt.match(/^COMPARISON_ARTIFACT_DIRECTORY=(.+)$/m)?.[1];
  if (artifactDirectory && input.prompt.includes("COMPARISON_PHASE=REFERENCE_ONLY")) {
    const png = new PNG({ width: 64, height: 64 });
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = 31; png.data[index + 1] = 111; png.data[index + 2] = 235; png.data[index + 3] = 255;
    }
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(join(artifactDirectory, "reference.png"), PNG.sync.write(png));
    await writeFile(join(artifactDirectory, "reference.json"), JSON.stringify({
      width: 64, height: 64, targets: [],
      sourceUrl: "https://www.figma.com/design/fixture/Test?node-id=1-2", nodeId: "1:2",
    }));
    return [{ type: "complete" as const, summary: "Fixture reference prepared." }];
  }
  await delay(350);
  await writeFile(
    join(repoRoot, "src", "screen.ts"),
    "export const buttonTone = 'green';\n",
  );
  return [
    { type: "phase", name: "fixture-edit" },
    { type: "file_hint", path: "src/screen.ts" },
    { type: "complete", summary: "Changed the fixture button tone." },
  ];
});
const comparisonRoot = await mkdtemp(join(tmpdir(), "visual-comparison-fixture-"));
const taskService = new TaskService({
  projectId,
  workspaceRoot: repoRoot,
  adapter,
  store: new SqliteTaskStore(":memory:"),
  git: gitManager,
  comparisonRoot,
});
const controlService = createTaskControlService({
  taskService,
  hmrWaitMs: 100,
  project: {
    id: projectId,
    repoRoot,
    workspaceRoot: repoRoot,
    mode: "attach",
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
  },
});
const gateway = createGatewayServer({
  upstream: `http://127.0.0.1:${upstreamPort}`,
  pairingToken,
  authMode: process.env.VISUAL_FIXTURE_AUTH_MODE === "local" ? "local" : "token",
  projectId,
  controlService,
  host: process.env.VISUAL_FIXTURE_AUTH_MODE === "local" ? "127.0.0.1" : "0.0.0.0",
  port: gatewayPort,
});
await gateway.start();

process.stdout.write(
  `Browser fixture ready: http://127.0.0.1:${gatewayPort}/\n`,
);

let closing = false;
const close = async () => {
  if (closing) {
    return;
  }
  closing = true;
  await gateway.close();
  await controlService.close?.();
  await new Promise<void>((resolve, reject) => {
    upstream.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(repoRoot, { recursive: true, force: true });
  await rm(comparisonRoot, { recursive: true, force: true });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
