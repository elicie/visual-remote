import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  installEmergencyChildExitHook,
  terminateChildProcessTree,
} from "../runtime/managed-process.js";

const MAX_COMMANDS = 8;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 4_096;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1_024;
const KILL_GRACE_MS = 250;

const READ_ONLY_GIT_COMMANDS = new Set([
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);
const SAFE_NATIVE_PROGRAMS = new Set([
  "cat",
  "find",
  "git",
  "ls",
  "pwd",
  "rg",
  "wc",
]);
const VERSION_PROGRAMS = new Set([
  "codex",
  "corepack",
  "node",
  "npm",
  "pnpm",
  "rtk",
  "visual",
  "visual-remote",
]);
const SAFE_RTK_COMMANDS = new Set([
  "deps",
  "diff",
  "find",
  "git",
  "ls",
  "read",
  "rg",
  "wc",
]);
const FORBIDDEN_GIT_OPTIONS = [
  "-C",
  "-O",
  "-c",
  "--config-env",
  "--ext-diff",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--no-index",
  "--open-files-in-pager",
  "--output",
  "--pathspec-from-file",
  "--show-signature",
  "--textconv",
  "--work-tree",
];
const SAFE_FIND_FLAGS = new Set([
  "-empty",
  "-false",
  "-mount",
  "-print",
  "-print0",
  "-prune",
  "-quit",
  "-readable",
  "-true",
  "-xdev",
]);
const SAFE_FIND_VALUE_FLAGS = new Set([
  "-iname",
  "-ipath",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mtime",
  "-name",
  "-path",
  "-size",
  "-type",
]);
const SAFE_FIND_OPERATORS = new Set([
  "!",
  "(",
  ")",
  ",",
  "-a",
  "-and",
  "-not",
  "-o",
  "-or",
]);

export interface DirectExecCommand {
  argv: string[];
  cwd?: string;
}

export interface DirectExecBatchRequest {
  commands: DirectExecCommand[];
  preferRtk?: boolean;
  stopOnError?: boolean;
  timeoutMs?: number;
}

export interface DirectExecCommandResult {
  argv: string[];
  cwd: string;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  usedRtk: boolean;
}

export interface DirectExecBatchResult {
  results: DirectExecCommandResult[];
  stoppedEarly: boolean;
}

export interface DirectExecOptions {
  repoRoot: string;
  workspaceRoot: string;
  rtkExecutable?: string | false;
  rtkAvailable?: boolean;
  environment?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

export class DirectExecPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectExecPolicyError";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function directFileTargets(argv: readonly string[]): string[] {
  const [program, ...arguments_] = argv;
  if (program === "cat" || program === "wc") {
    const targets: string[] = [];
    let positionalOnly = false;
    for (const argument of arguments_) {
      if (argument === "--" && !positionalOnly) {
        positionalOnly = true;
        continue;
      }
      if (argument === "-") continue;
      if (positionalOnly || !argument.startsWith("-")) targets.push(argument);
    }
    return targets;
  }
  if (program === "find") return findPathTargets(arguments_);
  if (program === "rtk" && arguments_[0] === "find") {
    return findPathTargets(arguments_.slice(1));
  }
  if (program !== "rtk" || !["read", "wc"].includes(arguments_[0] ?? "")) return [];
  const subcommand = arguments_[0];
  const values = subcommand === "read"
    ? new Set(["-l", "--level", "-m", "--max-lines", "--tail-lines"])
    : new Set<string>();
  const targets: string[] = [];
  let positionalOnly = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (argument === "--" && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (values.has(argument)) {
      index += 1;
      continue;
    }
    if (argument !== "-" && (positionalOnly || !argument.startsWith("-"))) {
      targets.push(argument);
    }
  }
  return targets;
}

function findPathTargets(arguments_: readonly string[]): string[] {
  const targets: string[] = [];
  for (const argument of arguments_) {
    if (argument.startsWith("-") || SAFE_FIND_OPERATORS.has(argument)) break;
    targets.push(argument);
  }
  return targets;
}

async function validateDirectFileTargets(
  argv: readonly string[],
  cwd: string,
  repoRoot: string,
): Promise<void> {
  for (const target of directFileTargets(argv)) {
    let resolvedTarget: string;
    try {
      resolvedTarget = await realpath(resolve(cwd, target));
    } catch {
      throw new DirectExecPolicyError(
        `Direct file reads require an existing worktree path: ${target}`,
      );
    }
    if (!isWithin(repoRoot, resolvedTarget)) {
      throw new DirectExecPolicyError(
        `Direct file reads cannot follow a symlink outside the worktree: ${target}`,
      );
    }
  }
}

async function validateExistingArgumentPaths(
  argv: readonly string[],
  cwd: string,
  repoRoot: string,
): Promise<void> {
  for (const argument of argv.slice(1)) {
    const candidates = [argument];
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex > 0 && equalsIndex < argument.length - 1) {
      candidates.push(argument.slice(equalsIndex + 1));
    }
    for (const candidate of candidates) {
      if (!candidate || candidate === "-" || candidate === "--") continue;
      try {
        const resolved = await realpath(resolve(cwd, candidate));
        if (!isWithin(repoRoot, resolved)) {
          throw new DirectExecPolicyError(
            `Command arguments cannot follow a path outside the registered worktree: ${candidate}`,
          );
        }
      } catch (error) {
        if (error instanceof DirectExecPolicyError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EINVAL") throw error;
      }
    }
  }
}

function optionMatches(argument: string, option: string): boolean {
  return (
    argument === option
    || argument.startsWith(`${option}=`)
    || (
      /^-[^-]$/u.test(option)
      && argument.length > option.length
      && argument.startsWith(option)
    )
  );
}

function validateArguments(arguments_: readonly string[]): void {
  if (arguments_.length > MAX_ARGUMENTS) {
    throw new DirectExecPolicyError(`A command may contain at most ${MAX_ARGUMENTS} arguments`);
  }
  for (const argument of arguments_) {
    if (argument.length > MAX_ARGUMENT_LENGTH || argument.includes("\0")) {
      throw new DirectExecPolicyError("Command arguments must be bounded text without NUL bytes");
    }
    if (isAbsolute(argument) || argument.split(/[\\/]/u).includes("..")) {
      throw new DirectExecPolicyError(
        `Command arguments cannot address paths outside the registered worktree: ${argument}`,
      );
    }
  }
}

function validateGit(arguments_: readonly string[]): void {
  if (arguments_.some((argument) =>
    FORBIDDEN_GIT_OPTIONS.some((option) => optionMatches(argument, option)))) {
    throw new DirectExecPolicyError("Git path/config/output overrides are not allowed");
  }
  const subcommand = arguments_.find((argument) => !argument.startsWith("-"));
  if (subcommand === undefined || !READ_ONLY_GIT_COMMANDS.has(subcommand)) {
    throw new DirectExecPolicyError(
      `Only read-only Git commands are allowed (${[...READ_ONLY_GIT_COMMANDS].join(", ")})`,
    );
  }
}

function validateFind(arguments_: readonly string[]): void {
  let index = findPathTargets(arguments_).length;
  while (index < arguments_.length) {
    const argument = arguments_[index] ?? "";
    if (SAFE_FIND_OPERATORS.has(argument) || SAFE_FIND_FLAGS.has(argument)) {
      index += 1;
      continue;
    }
    if (!SAFE_FIND_VALUE_FLAGS.has(argument)) {
      throw new DirectExecPolicyError(
        `find option or action is not allowed in direct inspection mode: ${argument || "<empty>"}`,
      );
    }
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new DirectExecPolicyError(`${argument} requires a value`);
    }
    if (["-maxdepth", "-mindepth"].includes(argument) && !/^\d+$/u.test(value)) {
      throw new DirectExecPolicyError(`${argument} requires a non-negative integer`);
    }
    if (argument === "-type" && !/^[bcdpflsD]$/u.test(value)) {
      throw new DirectExecPolicyError("find -type requires one supported file type");
    }
    index += 2;
  }
}

function validateLs(arguments_: readonly string[]): void {
  if (arguments_.some((argument) =>
    [
      "-H",
      "-L",
      "--dereference",
      "--dereference-command-line",
      "--dereference-command-line-symlink-to-dir",
    ].some((option) => optionMatches(argument, option)))) {
    throw new DirectExecPolicyError("Following ls symlinks is not allowed");
  }
}

function validateRg(arguments_: readonly string[]): void {
  if (arguments_.some((argument) =>
    ["-f", "-L", "--file", "--follow", "--ignore-file", "--pre", "--pre-glob"]
      .some((option) => optionMatches(argument, option)))) {
    throw new DirectExecPolicyError(
      "rg file inputs, preprocessors, and symlink traversal are not allowed",
    );
  }
}

function validateWc(arguments_: readonly string[]): void {
  if (arguments_.some((argument) => optionMatches(argument, "--files0-from"))) {
    throw new DirectExecPolicyError("wc --files0-from is not allowed");
  }
}

function validateRtk(arguments_: readonly string[]): void {
  if (arguments_.length === 1 && ["--version", "-V"].includes(arguments_[0] ?? "")) return;
  const subcommand = arguments_[0];
  if (subcommand === undefined || !SAFE_RTK_COMMANDS.has(subcommand)) {
    throw new DirectExecPolicyError(
      `Only read-only RTK commands are allowed (${[...SAFE_RTK_COMMANDS].join(", ")})`,
    );
  }
  if (subcommand === "git") validateGit(arguments_.slice(1));
  if (subcommand === "find") validateFind(arguments_.slice(1));
  if (subcommand === "ls") validateLs(arguments_.slice(1));
  if (subcommand === "rg") validateRg(arguments_.slice(1));
  if (subcommand === "wc") validateWc(arguments_.slice(1));
  if (subcommand === "deps" && arguments_.length > 1) {
    throw new DirectExecPolicyError("rtk deps does not accept paths in direct inspection mode");
  }
}

export function validateDirectExecArgv(argv: readonly string[]): void {
  const [program, ...arguments_] = argv;
  if (program === undefined || program.length === 0 || program.includes("/") || program.includes("\\")) {
    throw new DirectExecPolicyError("Executable must be a PATH command name");
  }
  validateArguments(arguments_);
  if (program === "rtk") {
    validateRtk(arguments_);
    return;
  }
  if (
    VERSION_PROGRAMS.has(program) &&
    (arguments_.length === 1 && ["--version", "-v", "-V"].includes(arguments_[0] ?? ""))
  ) {
    return;
  }
  if (!SAFE_NATIVE_PROGRAMS.has(program)) {
    throw new DirectExecPolicyError(`${program} is not allowed by the read-only direct executor`);
  }
  if (program === "git") validateGit(arguments_);
  if (program === "find") validateFind(arguments_);
  if (program === "ls") validateLs(arguments_);
  if (program === "rg") validateRg(arguments_);
  if (program === "wc") validateWc(arguments_);
}

export async function directExecExecutableAvailable(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  return await new Promise<boolean>((resolveAvailable) => {
    const child = spawn(executable, ["--version"], {
      env: environment,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      resolveAvailable(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveAvailable(code === 0);
    });
  });
}

function rtkRewrite(argv: readonly string[], rtkExecutable: string): string[] | undefined {
  const [program, ...arguments_] = argv;
  if (program === "git" || program === "rg" || program === "ls" || program === "find" || program === "wc") {
    return [rtkExecutable, program, ...arguments_];
  }
  if (program === "cat" && arguments_.length === 1 && !arguments_[0]?.startsWith("-")) {
    return [rtkExecutable, "read", ...arguments_];
  }
  return undefined;
}

function hardenGitArgv(argv: readonly string[], usedRtk: boolean): string[] {
  const subcommandIndex = usedRtk && argv[1] === "git" ? 2 : argv[0] === "git" ? 1 : -1;
  const subcommand = subcommandIndex < 0 ? undefined : argv[subcommandIndex];
  if (subcommand === undefined || !["diff", "log", "show"].includes(subcommand)) {
    return [...argv];
  }
  return [
    ...argv.slice(0, subcommandIndex + 1),
    "--no-ext-diff",
    "--no-textconv",
    ...argv.slice(subcommandIndex + 1),
  ];
}

function appendBounded(
  current: string,
  chunk: Buffer | string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const remaining = maxBytes - Buffer.byteLength(current);
  if (remaining <= 0) return { text: current, truncated: true };
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buffer.byteLength <= remaining) {
    return { text: current + buffer.toString(), truncated: false };
  }
  return {
    text: current + buffer.subarray(0, remaining).toString(),
    truncated: true,
  };
}

async function runCommand(
  argv: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  usedRtk: boolean,
): Promise<DirectExecCommandResult> {
  const startedAt = Date.now();
  return await new Promise<DirectExecCommandResult>((resolveResult) => {
    const [program, ...arguments_] = argv;
    if (program === undefined) throw new DirectExecPolicyError("Command argv cannot be empty");
    const usesGit = program === "git" || (usedRtk && arguments_[0] === "git");
    const commandEnvironment = usesGit
      ? {
          ...environment,
          GIT_CONFIG_COUNT: "4",
          GIT_CONFIG_KEY_0: "core.fsmonitor",
          GIT_CONFIG_VALUE_0: "false",
          GIT_CONFIG_KEY_1: "core.hooksPath",
          GIT_CONFIG_VALUE_1: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_CONFIG_KEY_2: "diff.external",
          GIT_CONFIG_VALUE_2: "",
          GIT_CONFIG_KEY_3: "interactive.diffFilter",
          GIT_CONFIG_VALUE_3: "",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
        }
      : environment;
    const child = spawn(program, arguments_, {
      cwd,
      env: commandEnvironment,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const removeEmergencyExitHook = installEmergencyChildExitHook(child);
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let termination: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      removeEmergencyExitHook();
      resolveResult({
        argv,
        cwd,
        durationMs: Date.now() - startedAt,
        exitCode,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        timedOut,
        truncated,
        usedRtk,
      });
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      const appended = appendBounded(stdout, chunk, maxOutputBytes);
      stdout = appended.text;
      truncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const appended = appendBounded(stderr, chunk, maxOutputBytes);
      stderr = appended.text;
      truncated ||= appended.truncated;
    });
    child.once("error", (error) => {
      stderr = error.message;
      finish(127);
    });
    child.once("close", (code) => {
      if (termination === undefined) {
        finish(code ?? (timedOut ? 124 : 1));
        return;
      }
      void termination.finally(() => finish(timedOut ? 124 : (code ?? 1)));
    });
    timer = setTimeout(() => {
      timedOut = true;
      termination ??= terminateChildProcessTree(child, KILL_GRACE_MS);
      void termination
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          stderr = stderr ? `${stderr}\n${message}` : message;
        })
        .finally(() => finish(124));
    }, timeoutMs);
    timer.unref();
  });
}

export async function executeReadOnlyBatch(
  request: DirectExecBatchRequest,
  options: DirectExecOptions,
): Promise<DirectExecBatchResult> {
  if (!Array.isArray(request.commands) || request.commands.length === 0) {
    throw new DirectExecPolicyError("At least one command is required");
  }
  if (request.commands.length > MAX_COMMANDS) {
    throw new DirectExecPolicyError(`At most ${MAX_COMMANDS} commands may run in one batch`);
  }
  const repoRoot = await realpath(options.repoRoot);
  const workspaceRoot = await realpath(options.workspaceRoot);
  if (!isWithin(repoRoot, workspaceRoot)) {
    throw new DirectExecPolicyError("Registered workspace must stay inside its Git worktree");
  }
  const environment = options.environment ?? process.env;
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1, request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  const maxOutputBytes = Math.max(1_024, options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES);
  const rtkExecutable = options.rtkExecutable === false
    ? undefined
    : options.rtkExecutable ?? "rtk";
  const rtkAvailable = options.rtkAvailable ?? (rtkExecutable === undefined
    ? false
    : await directExecExecutableAvailable(rtkExecutable, environment));
  const results: DirectExecCommandResult[] = [];
  let stoppedEarly = false;

  for (const command of request.commands) {
    if (!Array.isArray(command.argv)) {
      throw new DirectExecPolicyError("Each command must provide an argv array");
    }
    validateDirectExecArgv(command.argv);
    const requestedCwd = command.cwd === undefined
      ? workspaceRoot
      : isAbsolute(command.cwd)
        ? command.cwd
        : resolve(workspaceRoot, command.cwd);
    const cwd = await realpath(requestedCwd);
    if (!isWithin(repoRoot, cwd)) {
      throw new DirectExecPolicyError("Command cwd must stay inside the registered worktree");
    }
    await validateDirectFileTargets(command.argv, cwd, repoRoot);
    await validateExistingArgumentPaths(command.argv, cwd, repoRoot);

    let effectiveArgv = [...command.argv];
    let usedRtk = effectiveArgv[0] === "rtk";
    if (usedRtk) {
      if (!rtkAvailable || rtkExecutable === undefined) {
        throw new DirectExecPolicyError("RTK was requested but is not available");
      }
      effectiveArgv[0] = rtkExecutable;
    } else if (request.preferRtk !== false && rtkAvailable && rtkExecutable !== undefined) {
      const rewritten = rtkRewrite(effectiveArgv, rtkExecutable);
      if (rewritten !== undefined) {
        effectiveArgv = rewritten;
        usedRtk = true;
      }
    }
    effectiveArgv = hardenGitArgv(effectiveArgv, usedRtk);

    const result = await runCommand(
      effectiveArgv,
      cwd,
      environment,
      timeoutMs,
      maxOutputBytes,
      usedRtk,
    );
    results.push(result);
    if (result.exitCode !== 0 && request.stopOnError !== false) {
      stoppedEarly = results.length < request.commands.length;
      break;
    }
  }

  return { results, stoppedEarly };
}
