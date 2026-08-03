import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  GitTransactionManager,
  PathPolicy,
  RevertConflictError,
  rebaseWorkspacePatterns,
} from "@visual-remote/bridge-core";
import { createFixtureRepository } from "./helpers.js";

describe("GitTransactionManager", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(async (path) => await rm(path, { recursive: true })));
  });

  it("rebases configured path patterns to a nested service workspace", () => {
    const allowed = rebaseWorkspacePatterns(
      "/repo",
      "/repo/apps/web",
      ["src/**", "package.json"],
    );
    const denied = rebaseWorkspacePatterns(
      "/repo",
      "/repo/apps/web",
      [".env", "node_modules/**"],
    );
    const policy = new PathPolicy("/repo", { allowed, denied });

    expect(allowed).toEqual([
      "apps/web/src/**",
      "apps/web/package.json",
    ]);
    expect(policy.allows("apps/web/src/App.tsx")).toBe(true);
    expect(policy.allows("apps/web/package.json")).toBe(true);
    expect(policy.allows("src/App.tsx")).toBe(false);
    expect(policy.allows("apps/web/.env")).toBe(false);
  });

  it("isolates task changes from a dirty tracked and untracked baseline and reverts them", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    await fixture.write("tracked.txt", "base\ndirty-before\n");
    await fixture.write("untracked.txt", "preexisting\n");
    const manager = await GitTransactionManager.open(fixture.root);

    const before = await manager.createSnapshot("task-1", "before");
    await fixture.write("tracked.txt", "base\ndirty-before\ntask-change\n");
    await fixture.write("untracked.txt", "preexisting\ntask-change\n");
    await fixture.write("new.txt", "created by task\n");
    await rm(resolve(fixture.root, "delete.txt"));
    const after = await manager.createSnapshot("task-1", "after");
    const diff = await manager.diff(before.ref, after.ref);

    expect(diff.files.sort()).toEqual(
      ["delete.txt", "new.txt", "tracked.txt", "untracked.txt"].sort(),
    );
    expect(diff.text).toContain("+task-change");
    expect(diff.text).not.toContain("+dirty-before");

    const reverted = await manager.revert("task-1", before.ref, after.ref);
    expect(reverted.restoredFiles.sort()).toEqual(diff.files.sort());
    await expect(readFile(resolve(fixture.root, "tracked.txt"), "utf8")).resolves.toBe(
      "base\ndirty-before\n",
    );
    await expect(readFile(resolve(fixture.root, "untracked.txt"), "utf8")).resolves.toBe(
      "preexisting\n",
    );
    await expect(readFile(resolve(fixture.root, "delete.txt"), "utf8")).resolves.toBe("keep\n");
    await expect(stat(resolve(fixture.root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite a file changed after the after snapshot", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    const manager = await GitTransactionManager.open(fixture.root);
    const before = await manager.createSnapshot("task-conflict", "before");
    await fixture.write("tracked.txt", "task version\n");
    const after = await manager.createSnapshot("task-conflict", "after");
    await fixture.write("tracked.txt", "user version after task\n");

    await expect(
      manager.revert("task-conflict", before.ref, after.ref),
    ).rejects.toBeInstanceOf(RevertConflictError);
    await expect(readFile(resolve(fixture.root, "tracked.txt"), "utf8")).resolves.toBe(
      "user version after task\n",
    );
  });

  it("detects a modification to an ignored denied .env file", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    await fixture.write(".env", "SECRET=before\n");
    const manager = await GitTransactionManager.open(fixture.root);
    const guard = await manager.captureGuard();
    await writeFile(resolve(fixture.root, ".env"), "SECRET=after\n");

    await expect(manager.verifyGuard(guard)).resolves.toMatchObject({
      safe: false,
      restrictedPathsChanged: true,
      restrictedPaths: [".env"],
    });
  });

  it("accepts a persisted legacy restricted fingerprint after an upgrade", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    await fixture.write(".env", "SECRET=unchanged\n");
    const manager = await GitTransactionManager.open(fixture.root);
    const guard = await manager.captureGuard();
    const prefix = "restricted-paths-v1:";
    expect(guard.restrictedFingerprint.startsWith(prefix)).toBe(true);
    const entries = JSON.parse(
      guard.restrictedFingerprint.slice(prefix.length),
    ) as Array<[string, string]>;
    const legacy = createHash("sha256");
    for (const [path, fingerprint] of entries) {
      legacy.update(path);
      legacy.update("\0");
      legacy.update(fingerprint);
      legacy.update("\0");
    }

    await expect(
      manager.verifyGuard({
        ...guard,
        restrictedFingerprint: legacy.digest("hex"),
      }),
    ).resolves.toMatchObject({
      safe: true,
      restrictedPathsChanged: false,
      restrictedPaths: [],
    });
  });

  it("reverts added paths without rewriting valid Git filename characters", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.parent);
    await fixture.write("src/a", "tracked neighbor\n");
    await fixture.git(["add", "src/a"]);
    await fixture.git(["commit", "-qm", "add neighbor"]);
    const manager = await GitTransactionManager.open(fixture.root);

    const before = await manager.createSnapshot("task-path-bytes", "before");
    const addedPaths = [" tracked.txt", "tracked.txt ", "src/a#b", "src/a?b"];
    for (const path of addedPaths) {
      await fixture.write(path, `task file: ${path}\n`);
    }
    const after = await manager.createSnapshot("task-path-bytes", "after");

    const reverted = await manager.revert(
      "task-path-bytes",
      before.ref,
      after.ref,
    );

    expect(reverted.restoredFiles.sort()).toEqual(addedPaths.sort());
    await expect(readFile(resolve(fixture.root, "tracked.txt"), "utf8")).resolves.toBe(
      "base\n",
    );
    await expect(readFile(resolve(fixture.root, "src/a"), "utf8")).resolves.toBe(
      "tracked neighbor\n",
    );
    for (const path of addedPaths) {
      await expect(stat(resolve(fixture.root, path))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
});
