import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runVerificationCommand } from "@visual-remote/bridge-core";

describe("verification commands", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map(async (path) => await rm(path, { recursive: true })),
    );
  });

  it("runs argv directly from the workspace and captures bounded output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "visual-verify-"));
    cleanups.push(workspace);
    const literalArgument = "$HOME; echo not-a-shell";
    const result = await runVerificationCommand(
      {
        name: "cwd",
        command: [
          process.execPath,
          "-e",
          "process.stdout.write(`${process.cwd()}\\n${process.argv[1]}\\n${'x'.repeat(12000)}`)",
          literalArgument,
        ],
        timeoutMs: 2_000,
      },
      workspace,
    );

    expect(result.status).toBe("passed");
    expect(result.output).toContain(workspace);
    expect(result.output).toContain(literalArgument);
    expect(result.output.length).toBe(8_000);
  });

  it("terminates commands at their configured timeout", async () => {
    const result = await runVerificationCommand(
      {
        name: "timeout",
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 20,
      },
      process.cwd(),
    );

    expect(result.status).toBe("timeout");
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it.skipIf(process.platform === "win32")(
    "does not return from a timeout while a stubborn descendant is alive",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "visual-verify-tree-"));
      cleanups.push(workspace);
      const groupMarker = join(workspace, "process-group");
      const readyMarker = join(workspace, "descendant-ready");
      const termMarker = join(workspace, "descendant-signaled");
      let processGroupId: number | undefined;

      try {
        const descendantSource = `
const { writeFileSync } = require("node:fs");
writeFileSync(process.argv[2], "ready");
process.on("SIGTERM", () => {
  writeFileSync(process.argv[1], "term-received");
});
setInterval(() => {}, 1000);
`;
        const parentSource = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
writeFileSync(process.argv[1], String(process.pid));
spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}, process.argv[2], process.argv[3]], {
  stdio: "ignore",
});
setInterval(() => {}, 1000);
`;
        const result = await runVerificationCommand(
          {
            name: "timeout-tree",
            command: [
              process.execPath,
              "-e",
              parentSource,
              groupMarker,
              termMarker,
              readyMarker,
            ],
            timeoutMs: 750,
          },
          workspace,
        );

        processGroupId = Number(await readFile(groupMarker, "utf8"));
        expect(result.status).toBe("timeout");
        await expect(readFile(readyMarker, "utf8")).resolves.toBe("ready");
        await expect(readFile(termMarker, "utf8")).resolves.toBe("term-received");
        expect(() => process.kill(-processGroupId!, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        if (
          processGroupId !== undefined &&
          Number.isSafeInteger(processGroupId) &&
          processGroupId > 1
        ) {
          try {
            process.kill(-processGroupId, "SIGKILL");
          } catch {
            // The verification runner already terminated the group.
          }
        }
      }
    },
  );
});
