import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  installEmergencyChildExitHook,
  startManagedProcess,
} from "@visual-remote/bridge-core";

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 20);
      });
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe.skipIf(process.platform === "win32")("managed process lifecycle", () => {
  it("synchronously kills a detached child from the emergency exit hook", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    const processLike = new EventEmitter();
    const removeHook = installEmergencyChildExitHook(
      child,
      processLike as unknown as Pick<NodeJS.Process, "once" | "off">,
    );

    try {
      expect(processLike.listenerCount("exit")).toBe(1);
      processLike.emit("exit", 1);
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      expect(child.signalCode).toBe("SIGKILL");
      expect(processLike.listenerCount("exit")).toBe(0);
    } finally {
      removeHook();
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Expected once the emergency hook has terminated the group.
      }
    }
  });

  it("terminates the remaining process group after its leader exits", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "visual-managed-process-"));
    const executable = resolve(directory, "managed-dev.mjs");
    const readyMarker = resolve(directory, "descendant-ready");
    const stoppedMarker = resolve(directory, "descendant-stopped");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const descendant = \`
  const fs = require("node:fs");
  fs.writeFileSync(process.env.READY_MARKER, "ready");
  process.on("SIGTERM", () => {
    fs.writeFileSync(process.env.STOPPED_MARKER, "stopped");
    process.exit(0);
  });
  setInterval(() => {}, 1000);
\`;
spawn(process.execPath, ["-e", descendant], { env: process.env, stdio: "ignore" });
setInterval(() => {
  if (existsSync(process.env.READY_MARKER)) process.exit(0);
}, 10);
`,
    );
    await chmod(executable, 0o755);

    const managed = await startManagedProcess({
      command: [executable],
      cwd: directory,
      upstreamPort: 10_001,
      killGraceMs: 250,
      environment: {
        ...process.env,
        READY_MARKER: readyMarker,
        STOPPED_MARKER: stoppedMarker,
      },
    });

    try {
      await waitForFile(readyMarker);
      await managed.exit;
      await Promise.all([managed.stop(), managed.stop()]);
      await waitForFile(stoppedMarker);
      await expect(readFile(stoppedMarker, "utf8")).resolves.toBe("stopped");
    } finally {
      await managed.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
