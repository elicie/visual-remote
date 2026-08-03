import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DirectExecPolicyError,
  executeReadOnlyBatch,
  validateDirectExecArgv,
} from "@visual-remote/bridge-core";
import { describe, expect, it } from "vitest";

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
      /find actions/u,
    );
    expect(() => validateDirectExecArgv(["cat", "/etc/passwd"])).toThrow(
      /outside the registered worktree/u,
    );

    const repoRoot = await mkdtemp(join(tmpdir(), "visual-direct-policy-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "visual-direct-outside-"));
    const outsideFile = join(outsideRoot, "secret.txt");
    await writeFile(outsideFile, "not-readable-through-direct-exec");
    await symlink(outsideFile, join(repoRoot, "escaped-link"));
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
  });
});
