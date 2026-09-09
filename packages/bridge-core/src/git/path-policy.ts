import { lstat, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { PathSafetyError } from "./errors.js";

export interface PathPolicyOptions {
  allowed?: string[];
  denied?: string[];
}

const DEFAULT_DENIED = [
  ".git/**",
  ".env",
  ".env.*",
  "**/*.pem",
  "**/*.key",
  "node_modules/**",
  ".next/**",
  "dist/**",
];

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function repositoryRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join("/");
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globRegex(pattern: string): RegExp {
  const normalized = normalizeSlashes(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? "";
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(character);
    }
  }
  source += "$";
  return new RegExp(source);
}

interface CompiledPattern {
  source: string;
  regex: RegExp;
  directoryBase?: string;
}

function compile(pattern: string): CompiledPattern {
  const source = normalizeSlashes(pattern);
  const compiled: CompiledPattern = { source, regex: globRegex(source) };
  if (source.endsWith("/**")) compiled.directoryBase = source.slice(0, -3);
  return compiled;
}

function patternMatches(pattern: CompiledPattern, path: string): boolean {
  return pattern.regex.test(path) || pattern.directoryBase === path;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function rebaseWorkspacePatterns(
  repoRoot: string,
  workspaceRoot: string,
  patterns: readonly string[],
): string[] {
  const repository = resolve(repoRoot);
  const workspace = resolve(workspaceRoot);
  if (!isWithin(repository, workspace)) {
    throw new PathSafetyError(
      "PATH_OUTSIDE_REPOSITORY",
      workspaceRoot,
      `Workspace is outside the repository: ${workspaceRoot}`,
    );
  }
  const prefix = repositoryRelative(repository, workspace);
  if (!prefix) return [...patterns];
  return patterns.map((pattern) => normalizeSlashes(`${prefix}/${pattern}`));
}

export class PathPolicy {
  readonly repoRoot: string;
  readonly allowedPatterns: readonly string[];
  readonly deniedPatterns: readonly string[];
  readonly #allowed: CompiledPattern[];
  readonly #denied: CompiledPattern[];

  constructor(repoRoot: string, options: PathPolicyOptions = {}) {
    this.repoRoot = resolve(repoRoot);
    this.allowedPatterns = options.allowed?.length ? [...options.allowed] : ["**"];
    this.deniedPatterns = [...DEFAULT_DENIED, ...(options.denied ?? [])];
    this.#allowed = this.allowedPatterns.map(compile);
    this.#denied = this.deniedPatterns.map(compile);
  }

  normalizeRelative(path: string): string {
    if (path.includes("\0")) {
      throw new PathSafetyError("INVALID_PATH", path, "Paths may not contain NUL bytes");
    }
    const candidate = path;
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(this.repoRoot, candidate);
    if (!isWithin(this.repoRoot, absolute) || absolute === this.repoRoot) {
      throw new PathSafetyError(
        "PATH_OUTSIDE_REPOSITORY",
        path,
        `Path is outside the repository: ${path}`,
      );
    }
    const normalized = repositoryRelative(this.repoRoot, absolute);
    if (!normalized || normalized === "." || normalized.startsWith("../")) {
      throw new PathSafetyError("INVALID_PATH", path, `Invalid repository path: ${path}`);
    }
    return normalized;
  }

  allows(path: string): boolean {
    let normalized: string;
    try {
      normalized = this.normalizeRelative(path);
    } catch {
      return false;
    }
    if (this.#isDenied(normalized)) return false;
    return this.#allowed.some((pattern) => patternMatches(pattern, normalized));
  }

  /**
   * True when a path matches an explicit deny rule (or lives under `.git`),
   * as opposed to merely falling outside the allowed patterns.
   */
  denies(path: string): boolean {
    try {
      return this.#isDenied(this.normalizeRelative(path));
    } catch {
      return true;
    }
  }

  #isDenied(normalized: string): boolean {
    if (normalized === ".git" || normalized.startsWith(".git/")) return true;
    return this.#denied.some((pattern) => patternMatches(pattern, normalized));
  }

  assertLexicallyAllowed(path: string): string {
    const normalized = this.normalizeRelative(path);
    if (!this.allows(normalized)) {
      throw new PathSafetyError("PATH_DENIED", path, `Path is not allowed: ${path}`);
    }
    return normalized;
  }

  async assertFilesystemPathAllowed(path: string, allowMissing = false): Promise<string> {
    const normalized = this.assertLexicallyAllowed(path);
    const absolute = resolve(this.repoRoot, normalized);
    let resolved: string;
    try {
      resolved = await realpath(absolute);
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      resolved = await this.#resolveMissingPath(absolute);
    }
    if (!isWithin(this.repoRoot, resolved)) {
      throw new PathSafetyError(
        "SYMLINK_ESCAPE",
        path,
        `Path resolves outside the repository: ${path}`,
      );
    }
    return repositoryRelative(this.repoRoot, resolved);
  }

  async fingerprintEntry(path: string): Promise<string> {
    const normalized = this.normalizeRelative(path);
    const absolute = resolve(this.repoRoot, normalized);
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) return `symlink:${await readlink(absolute)}`;
      if (stats.isFile()) return `file:${stats.mode & 0o777}:${stats.size}:${stats.mtimeMs}`;
      return `other:${stats.mode & 0o777}:${stats.size}:${stats.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  async #resolveMissingPath(absolute: string): Promise<string> {
    const suffix: string[] = [];
    let cursor = absolute;
    while (cursor !== this.repoRoot) {
      try {
        const parent = await realpath(cursor);
        return resolve(parent, ...suffix.reverse());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = resolve(cursor, "..");
      suffix.push(cursor.slice(next.length + (next.endsWith(sep) ? 0 : 1)));
      cursor = next;
    }
    return resolve(await realpath(this.repoRoot), ...suffix.reverse());
  }
}
