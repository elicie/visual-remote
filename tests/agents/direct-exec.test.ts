import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DirectExecPolicyError,
  executeReadOnlyBatch,
  validateDirectExecArgv,
} from "@visual-remote/bridge-core";
import { describe, expect, it } from "vitest";

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe("direct read-only command execution", () => {
  it("runs argv batches in the registered workspace and applies RTK without a shell", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "visual-direct-exec-"));
    const workspaceRoot = join(repoRoot, "workspace");
    const binDirectory = join(repoRoot, "bin");
    await Promise.all([mkdir(workspaceRoot), mkdir(binDirectory)]);
    const fakeRtk = join(binDirectory, "rtk");
    await writeFile(
      fakeRtk,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] === '--version') console.log('rtk 0.44.2');",
        "else console.log(JSON.stringify(process.argv.slice(2)));",
        "",
      ].join("\n"),
    );
    await chmod(fakeRtk, 0o755);

    const batch = await executeReadOnlyBatch(
      {
        commands: [
          { argv: ["pwd"] },
          { argv: ["git", "status", "--short"] },
        ],
      },
      { repoRoot, workspaceRoot, rtkExecutable: fakeRtk },
    );

    expect(batch.stoppedEarly).toBe(false);
    expect(batch.results[0]).toMatchObject({
      cwd: workspaceRoot,
      exitCode: 0,
      stdout: workspaceRoot,
      usedRtk: false,
    });
    expect(batch.results[1]).toMatchObject({
      exitCode: 0,
      stdout: '["git","status","--short"]',
      usedRtk: true,
    });
    expect(batch.results[1]?.argv).toEqual([
      fakeRtk,
      "git",
      "status",
      "--short",
    ]);
  });

  it("rejects shells, mutating commands, escape paths, and cwd outside the worktree", async () => {
    expect(() => validateDirectExecArgv(["zsh", "-lc", "pwd"])).toThrow(
      DirectExecPolicyError,
    );
    expect(() => validateDirectExecArgv(["git", "checkout", "main"])).toThrow(
      /read-only Git commands/u,
    );
    expect(() => validateDirectExecArgv(["git", "show", "--textconv"])).toThrow(
      /path\/config\/output overrides/u,
    );
    expect(() => validateDirectExecArgv(["find", ".", "-delete"])).toThrow(
      /find option or action/u,
    );
    expect(() => validateDirectExecArgv(["find", ".", "-fprint0", "created.txt"])).toThrow(
      /find option or action/u,
    );
    expect(() => validateDirectExecArgv(["find", "-files0-from", "paths.txt"])).toThrow(
      /find option or action/u,
    );
    expect(() => validateDirectExecArgv(["find", ".", "-follow"])).toThrow(
      /find option or action/u,
    );
    expect(() =>
      validateDirectExecArgv(["find", ".", "-maxdepth", "3", "-type", "f", "-print"]),
    ).not.toThrow();
    expect(() => validateDirectExecArgv(["rg", "--file=patterns.txt", "."])).toThrow(
      /rg file inputs/u,
    );
    expect(() => validateDirectExecArgv(["git", "-C/tmp", "status"])).toThrow(
      /path\/config\/output overrides/u,
    );
    expect(() => validateDirectExecArgv(["git", "-ccore.fsmonitor=echo", "status"])).toThrow(
      /path\/config\/output overrides/u,
    );
    expect(() => validateDirectExecArgv(["git", "grep", "-Osh", "needle"])).toThrow(
      /path\/config\/output overrides/u,
    );
    expect(() => validateDirectExecArgv(["cat", "/etc/passwd"])).toThrow(
      /outside the registered worktree/u,
    );

    const repoRoot = await mkdtemp(join(tmpdir(), "visual-direct-policy-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "visual-direct-outside-"));
    const outsideFile = join(outsideRoot, "secret.txt");
    await writeFile(outsideFile, "not-readable-through-direct-exec");
    await symlink(outsideFile, join(repoRoot, "escaped-link"));
    await symlink(outsideFile, join(repoRoot, "-escaped-link"));
    await expect(
      executeReadOnlyBatch(
        { commands: [{ argv: ["pwd"], cwd: tmpdir() }] },
        { repoRoot, workspaceRoot: repoRoot, rtkExecutable: false },
      ),
    ).rejects.toThrow(/cwd must stay inside/u);
    await expect(
      executeReadOnlyBatch(
        { commands: [{ argv: ["cat", "escaped-link"] }] },
        { repoRoot, workspaceRoot: repoRoot, rtkExecutable: false },
      ),
    ).rejects.toThrow(/symlink outside/u);
    await expect(
      executeReadOnlyBatch(
        { commands: [{ argv: ["cat", "--", "-escaped-link"] }] },
        { repoRoot, workspaceRoot: repoRoot, rtkExecutable: false },
      ),
    ).rejects.toThrow(/symlink outside/u);
  });

  it.skipIf(process.platform === "win32")(
    "terminates an RTK command process tree when direct inspection times out",
    async () => {
      const repoRoot = await mkdtemp(join(tmpdir(), "visual-direct-timeout-"));
      const fakeRtk = resolve(repoRoot, "fake-rtk.mjs");
      const readyMarker = resolve(repoRoot, "descendant-ready");
      const stoppedMarker = resolve(repoRoot, "descendant-stopped");
      await writeFile(
        fakeRtk,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
const childSource = \`
  const fs = require("node:fs");
  fs.writeFileSync(process.env.READY_MARKER, "ready");
  process.on("SIGTERM", () => {
    fs.writeFileSync(process.env.STOPPED_MARKER, "stopped");
    process.exit(0);
  });
  setInterval(() => {}, 1000);
\`;
spawn(process.execPath, ["-e", childSource], { env: process.env, stdio: "ignore" });
setInterval(() => {}, 1000);
`,
      );
      await chmod(fakeRtk, 0o755);

      const batch = await executeReadOnlyBatch(
        {
          commands: [{ argv: ["find", ".", "-type", "f"] }],
          timeoutMs: 150,
        },
        {
          repoRoot,
          workspaceRoot: repoRoot,
          rtkExecutable: fakeRtk,
          rtkAvailable: true,
          environment: {
            ...process.env,
            READY_MARKER: readyMarker,
            STOPPED_MARKER: stoppedMarker,
          },
        },
      );

      await waitForFile(readyMarker);
      await waitForFile(stoppedMarker);
      expect(batch.results[0]).toMatchObject({
        exitCode: 124,
        timedOut: true,
        usedRtk: true,
      });
      await expect(readFile(stoppedMarker, "utf8")).resolves.toBe("stopped");
    },
  );
});
