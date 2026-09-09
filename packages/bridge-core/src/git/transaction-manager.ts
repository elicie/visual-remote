import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  opendir,
  readFile,
  readlink,
  realpath,
  rmdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

import { CommitConflictError, RevertConflictError, RepositorySafetyError } from "./errors.js";
import { gitText, literalPathspec, runGit } from "./git-command.js";
import { PathPolicy, type PathPolicyOptions } from "./path-policy.js";
import { discoverGitRepository, type GitRepository } from "./repository.js";

export interface RepositoryGuard {
  head: string;
  indexTree: string;
  statusPorcelainV2: string;
  restrictedFingerprint: string;
}

export interface GitSnapshot {
  ref: string;
  commit: string;
  tree: string;
}

export interface TaskDiff {
  text: string;
  files: string[];
}

export interface GuardVerification {
  safe: boolean;
  headChanged: boolean;
  indexChanged: boolean;
  restrictedPathsChanged: boolean;
  restrictedPaths: string[];
}

export interface RevertResult {
  restoredFiles: string[];
  snapshot: GitSnapshot;
}

export interface CommitResult {
  sha: string;
  files: string[];
}

interface NameStatusEntry {
  status: string;
  paths: string[];
}

const SNAPSHOT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Visual Bridge",
  GIT_AUTHOR_EMAIL: "visual-bridge@localhost",
  GIT_COMMITTER_NAME: "Visual Bridge",
  GIT_COMMITTER_EMAIL: "visual-bridge@localhost",
};

const RESTRICTED_STATE_PREFIX = "restricted-paths-v1:";

function serializeRestrictedState(entries: ReadonlyArray<readonly [string, string]>): string {
  return `${RESTRICTED_STATE_PREFIX}${JSON.stringify(entries)}`;
}

function parseRestrictedState(value: string): Map<string, string> | undefined {
  if (!value.startsWith(RESTRICTED_STATE_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(value.slice(RESTRICTED_STATE_PREFIX.length)) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const entries = new Map<string, string>();
    for (const entry of parsed) {
      if (
        !Array.isArray(entry)
        || entry.length !== 2
        || typeof entry[0] !== "string"
        || typeof entry[1] !== "string"
      ) {
        return undefined;
      }
      entries.set(entry[0], entry[1]);
    }
    return entries;
  } catch {
    return undefined;
  }
}

function legacyRestrictedFingerprint(entries: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const [path, fingerprint] of [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    hash.update(path);
    hash.update("\0");
    hash.update(fingerprint);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function restrictedStatesMatch(before: string, after: string): boolean {
  if (before === after) return true;
  const beforeEntries = parseRestrictedState(before);
  const afterEntries = parseRestrictedState(after);
  if (beforeEntries !== undefined && afterEntries !== undefined) return false;
  if (beforeEntries !== undefined && /^[a-f0-9]{64}$/.test(after)) {
    return legacyRestrictedFingerprint(beforeEntries) === after;
  }
  if (afterEntries !== undefined && /^[a-f0-9]{64}$/.test(before)) {
    return legacyRestrictedFingerprint(afterEntries) === before;
  }
  return false;
}

function changedRestrictedPaths(before: string, after: string): string[] {
  const beforeEntries = parseRestrictedState(before);
  const afterEntries = parseRestrictedState(after);
  if (beforeEntries === undefined || afterEntries === undefined) return [];
  return [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])]
    .filter((path) => beforeEntries.get(path) !== afterEntries.get(path))
    .sort();
}

function nulPaths(buffer: Buffer): string[] {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

function chunks<T>(items: T[], size = 512): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function snapshotRef(taskId: string, kind: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw new RepositorySafetyError("INVALID_TASK_ID", `Unsafe task id: ${taskId}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) {
    throw new RepositorySafetyError("INVALID_SNAPSHOT_KIND", `Unsafe snapshot kind: ${kind}`);
  }
  return `refs/visual/tasks/${taskId}/${kind}`;
}

async function hashPath(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  try {
    const stats = await lstat(absolute);
    const hash = createHash("sha256");
    if (stats.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(await readlink(absolute));
    } else if (stats.isFile()) {
      hash.update("file\0");
      hash.update(String(stats.mode & 0o777));
      hash.update("\0");
      hash.update(await readFile(absolute));
    } else {
      hash.update("other\0");
      hash.update(String(stats.mode));
    }
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export class GitTransactionManager {
  readonly repository: GitRepository;
  readonly pathPolicy: PathPolicy;

  private constructor(repository: GitRepository, pathOptions: PathPolicyOptions) {
    this.repository = repository;
    this.pathPolicy = new PathPolicy(repository.root, pathOptions);
  }

  static async open(
    startPath: string,
    pathOptions: PathPolicyOptions = {},
  ): Promise<GitTransactionManager> {
    return new GitTransactionManager(await discoverGitRepository(startPath), pathOptions);
  }

  get repoRoot(): string {
    return this.repository.root;
  }

  async captureGuard(): Promise<RepositoryGuard> {
    return {
      head: await this.#head(),
      indexTree: await gitText(["write-tree"], { cwd: this.repoRoot }),
      statusPorcelainV2: (
        await runGit(["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
          cwd: this.repoRoot,
        })
      ).stdout.toString("utf8"),
      restrictedFingerprint: await this.#restrictedFingerprint(),
    };
  }

  async verifyGuard(before: RepositoryGuard): Promise<GuardVerification> {
    const after = await this.captureGuard();
    const headChanged = before.head !== after.head;
    const indexChanged = before.indexTree !== after.indexTree;
    const restrictedPathsChanged = !restrictedStatesMatch(
      before.restrictedFingerprint,
      after.restrictedFingerprint,
    );
    const restrictedPaths = restrictedPathsChanged
      ? changedRestrictedPaths(
          before.restrictedFingerprint,
          after.restrictedFingerprint,
        )
      : [];
    return {
      safe: !headChanged && !indexChanged && !restrictedPathsChanged,
      headChanged,
      indexChanged,
      restrictedPathsChanged,
      restrictedPaths,
    };
  }

  async createSnapshot(taskId: string, kind: "before" | "after" | "revert"): Promise<GitSnapshot> {
    const ref = snapshotRef(taskId, kind);
    const commitData = await this.#createWorktreeCommit(`visual task ${kind}\n`);
    await runGit(["update-ref", ref, commitData.commit], { cwd: this.repoRoot });
    return { ref, ...commitData };
  }

  async diff(beforeRef: string, afterRef: string): Promise<TaskDiff> {
    await this.#assertSnapshotRef(beforeRef);
    await this.#assertSnapshotRef(afterRef);
    const entries = await this.#nameStatus(beforeRef, afterRef);
    const files = [...new Set(entries.flatMap((entry) => entry.paths))].filter((path) =>
      this.pathPolicy.allows(path),
    );
    const args = [
      "diff",
      "--binary",
      "--find-renames",
      beforeRef,
      afterRef,
      "--",
      ...files.map(literalPathspec),
    ];
    const text =
      files.length === 0
        ? ""
        : (
            await runGit(args, {
              cwd: this.repoRoot,
              maxOutputBytes: 128 * 1024 * 1024,
            })
          ).stdout.toString("utf8");
    return { text, files };
  }

  /**
   * Commits exactly the files a task changed (before → after snapshot) with the
   * user's own Git identity. Other staged or unstaged changes are left alone;
   * files the user edited after the task completed abort the commit.
   */
  async commit(beforeRef: string, afterRef: string, message: string): Promise<CommitResult> {
    if (!message.trim()) {
      throw new RepositorySafetyError("EMPTY_COMMIT_MESSAGE", "Commit message must not be empty");
    }
    await this.#assertSnapshotRef(beforeRef);
    await this.#assertSnapshotRef(afterRef);
    const entries = await this.#nameStatus(beforeRef, afterRef);
    const files = [...new Set(entries.flatMap((entry) => entry.paths))];
    for (const path of files) this.pathPolicy.assertLexicallyAllowed(path);
    if (files.length === 0) {
      throw new RepositorySafetyError("NOTHING_TO_COMMIT", "The task did not change any files");
    }

    const current = await this.#createWorktreeCommit("visual task commit guard\n");
    const changedSinceAfter = await this.#changedNames(afterRef, current.commit, files);
    if (changedSinceAfter.length > 0) throw new CommitConflictError(changedSinceAfter);

    for (const group of chunks(files)) {
      await runGit(["add", "-A", "--", ...group.map(literalPathspec)], { cwd: this.repoRoot });
    }
    await runGit(["commit", "--quiet", "-F", "-", "--", ...files.map(literalPathspec)], {
      cwd: this.repoRoot,
      input: message.endsWith("\n") ? message : `${message}\n`,
    });
    const sha = await gitText(["rev-parse", "--verify", "HEAD"], { cwd: this.repoRoot });
    return { sha, files };
  }

  async revert(taskId: string, beforeRef: string, afterRef: string): Promise<RevertResult> {
    await this.#assertSnapshotRef(beforeRef);
    await this.#assertSnapshotRef(afterRef);
    const entries = await this.#nameStatus(beforeRef, afterRef);
    const files = [...new Set(entries.flatMap((entry) => entry.paths))];
    for (const path of files) this.pathPolicy.assertLexicallyAllowed(path);

    const current = await this.#createWorktreeCommit("visual task revert guard\n");
    const changedSinceAfter = await this.#changedNames(afterRef, current.commit, files);
    if (changedSinceAfter.length > 0) throw new RevertConflictError(changedSinceAfter);

    const beforeFiles = new Set(await this.#treeFiles(beforeRef));
    const absentBefore = files
      .filter((path) => !beforeFiles.has(path))
      .sort((left, right) => right.split("/").length - left.split("/").length);
    for (const path of absentBefore) await this.#removeAddedPath(path);

    const restore = files.filter((path) => beforeFiles.has(path));
    for (const group of chunks(restore)) {
      await runGit(
        ["restore", `--source=${beforeRef}`, "--worktree", "--", ...group.map(literalPathspec)],
        { cwd: this.repoRoot },
      );
    }

    return {
      restoredFiles: files,
      snapshot: await this.createSnapshot(taskId, "revert"),
    };
  }

  async #head(): Promise<string> {
    const result = await runGit(["rev-parse", "--verify", "HEAD"], {
      cwd: this.repoRoot,
      allowFailure: true,
    });
    return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : "";
  }

  async #candidatePaths(): Promise<string[]> {
    const current = nulPaths(
      (
        await runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
          cwd: this.repoRoot,
        })
      ).stdout,
    );
    const head = await this.#head();
    const fromHead = head
      ? nulPaths(
          (
            await runGit(["ls-tree", "-r", "--name-only", "-z", head], {
              cwd: this.repoRoot,
            })
          ).stdout,
        )
      : [];
    return [...new Set([...current, ...fromHead])];
  }

  async #restrictedFingerprint(): Promise<string> {
    const candidates = [
      ...new Set([
        ...(await this.#candidatePaths()).filter((path) => !this.pathPolicy.allows(path)),
        ...(await this.#scanRestrictedFiles()),
      ]),
    ].sort();
    // Git-ignored files outside the allowed patterns are build artifacts
    // (tsconfig.tsbuildinfo, coverage output, caches) that agent commands
    // such as `tsc` rewrite as a side effect. Only explicitly denied paths
    // (.env, keys, ...) stay guarded when Git ignores them.
    const ignored = await this.#ignoredPaths(candidates.filter((path) => !this.pathPolicy.denies(path)));
    const restricted = candidates.filter((path) => !ignored.has(path));
    const entries: Array<readonly [string, string]> = [];
    for (const path of restricted) {
      entries.push([path, await hashPath(this.repoRoot, path)]);
    }
    return serializeRestrictedState(entries);
  }

  async #ignoredPaths(paths: readonly string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    // check-ignore exits with 1 when no path is ignored; tracked files are
    // never reported as ignored without --no-index, so they stay guarded.
    const result = await runGit(["check-ignore", "-z", "--stdin"], {
      cwd: this.repoRoot,
      input: `${paths.join("\0")}\0`,
      allowFailure: true,
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new RepositorySafetyError(
        "RESTRICTED_SCAN_FAILED",
        `git check-ignore failed: ${result.stderr.toString("utf8").trim()}`,
      );
    }
    return new Set(nulPaths(result.stdout));
  }

  async #scanRestrictedFiles(): Promise<string[]> {
    const found: string[] = [];
    const pending = [this.repoRoot];
    let visited = 0;
    const neverScan = new Set([".git", "node_modules", ".next", "dist"]);
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) break;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        visited += 1;
        if (visited > 50_000) {
          throw new RepositorySafetyError(
            "RESTRICTED_SCAN_LIMIT",
            "Repository safety scan exceeded 50,000 filesystem entries",
          );
        }
        const absolute = resolve(directory, entry.name);
        const relativePath = relative(this.repoRoot, absolute).replaceAll("\\", "/");
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (!neverScan.has(entry.name)) pending.push(absolute);
        } else if (!this.pathPolicy.allows(relativePath)) {
          found.push(relativePath);
        }
      }
    }
    return found;
  }

  async #createWorktreeCommit(message: string): Promise<{ commit: string; tree: string }> {
    if ((await realpath(this.repoRoot)) !== this.repoRoot) {
      throw new RepositorySafetyError(
        "REPOSITORY_ROOT_CHANGED",
        "Repository root no longer resolves to its original path",
      );
    }
    const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "visual-git-index-"));
    const indexFile = resolve(temporaryDirectory, "index");
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexFile };
    try {
      const head = await this.#head();
      if (head) await runGit(["read-tree", head], { cwd: this.repoRoot, env });
      else await runGit(["read-tree", "--empty"], { cwd: this.repoRoot, env });

      const candidates = (await this.#candidatePaths()).filter((path) =>
        this.pathPolicy.allows(path),
      );
      for (const group of chunks(candidates)) {
        await runGit(["add", "-A", "--", ...group.map(literalPathspec)], {
          cwd: this.repoRoot,
          env,
        });
      }
      const tree = await gitText(["write-tree"], { cwd: this.repoRoot, env });
      const commitArgs = ["commit-tree", tree];
      if (head) commitArgs.push("-p", head);
      const commit = await gitText(commitArgs, {
        cwd: this.repoRoot,
        env: { ...env, ...SNAPSHOT_ENV },
        input: message,
      });
      return { commit, tree };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async #nameStatus(beforeRef: string, afterRef: string): Promise<NameStatusEntry[]> {
    const output = (
      await runGit(["diff", "--name-status", "-z", "--find-renames", beforeRef, afterRef], {
        cwd: this.repoRoot,
      })
    ).stdout.toString("utf8");
    const fields = output.split("\0");
    const entries: NameStatusEntry[] = [];
    for (let index = 0; index < fields.length; ) {
      const status = fields[index++];
      if (!status) break;
      const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
      const paths = fields.slice(index, index + pathCount);
      index += pathCount;
      if (paths.length === pathCount && paths.every(Boolean)) entries.push({ status, paths });
    }
    return entries;
  }

  async #changedNames(left: string, right: string, paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const result = await runGit(
      [
        "diff",
        "--name-only",
        "-z",
        left,
        right,
        "--",
        ...paths.map(literalPathspec),
      ],
      { cwd: this.repoRoot },
    );
    return nulPaths(result.stdout);
  }

  async #treeFiles(ref: string): Promise<string[]> {
    return nulPaths(
      (
        await runGit(["ls-tree", "-r", "--name-only", "-z", ref], {
          cwd: this.repoRoot,
        })
      ).stdout,
    );
  }

  async #removeAddedPath(path: string): Promise<void> {
    const normalized = this.pathPolicy.assertLexicallyAllowed(path);
    const absolute = resolve(this.repoRoot, normalized);
    const lexicalRelative = relative(this.repoRoot, absolute);
    if (
      lexicalRelative === "" ||
      lexicalRelative === ".." ||
      lexicalRelative.startsWith(`..${sep}`)
    ) {
      throw new RepositorySafetyError("PATH_OUTSIDE_REPOSITORY", `Unsafe revert path: ${path}`);
    }
    try {
      const stats = await lstat(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        throw new RepositorySafetyError(
          "UNEXPECTED_DIRECTORY",
          `Refusing to recursively remove directory during revert: ${path}`,
        );
      }
      await rm(absolute, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.#removeEmptyParents(dirname(absolute));
  }

  async #removeEmptyParents(start: string): Promise<void> {
    let cursor = start;
    while (cursor !== this.repoRoot) {
      try {
        await rmdir(cursor);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          cursor = dirname(cursor);
          continue;
        }
        if (code === "ENOTEMPTY" || code === "EEXIST") return;
        throw error;
      }
      cursor = dirname(cursor);
    }
  }

  async #assertSnapshotRef(ref: string): Promise<void> {
    if (!/^refs\/visual\/tasks\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:before|after|revert)$/.test(ref)) {
      throw new RepositorySafetyError("INVALID_SNAPSHOT_REF", `Unsafe snapshot ref: ${ref}`);
    }
    const result = await runGit(["show-ref", "--verify", "--quiet", ref], {
      cwd: this.repoRoot,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      throw new RepositorySafetyError("MISSING_SNAPSHOT_REF", `Snapshot does not exist: ${ref}`);
    }
  }
}
