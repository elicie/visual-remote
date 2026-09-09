import { execFile, spawn } from "node:child_process";
import { isAbsolute, parse, resolve } from "node:path";
import { promisify } from "node:util";

import {
  installEmergencyChildExitHook,
  terminateChildProcessTree,
} from "../runtime/managed-process.js";
import { AsyncQueue } from "./async-queue.js";
import { ClaudeEventParser } from "./claude-event-parser.js";
import {
  AgentCanceledError,
  AgentPermissionDeniedError,
  AgentProcessError,
  AgentTimeoutError,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentResumeInput,
  type AgentRunInput,
  type NormalizedAgentEvent,
} from "./types.js";

export interface ClaudeAdapterOptions {
  executable?: string;
  killGraceMs?: number;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: ClaudePermissionMode;
  rtkExecutable?: string | false;
}

/**
 * Claude CLI `--permission-mode` values that make sense for a headless run.
 * `default` denies every tool that local Claude permission rules do not
 * already allow, `acceptEdits` additionally auto-approves file edits in the
 * workspace, and `bypassPermissions` approves every tool call including Bash.
 */
export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions";

/**
 * A headless `claude -p` run cannot prompt, so anything short of
 * `bypassPermissions` silently denies Bash unless local rules allow it.
 */
export const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = "bypassPermissions";

const execFileAsync = promisify(execFile);

const INHERITED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
] as const;

function processEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...overrides };
}

function splitLines(
  chunk: Buffer | string,
  previous: string,
  onLine: (line: string) => void,
): string {
  const combined = previous + chunk.toString();
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) onLine(line);
  return remainder;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude";
  readonly #executable: string;
  readonly #killGraceMs: number;
  readonly #model: string | undefined;
  readonly #reasoningEffort: ClaudeAdapterOptions["reasoningEffort"];
  readonly #permissionMode: ClaudePermissionMode;
  readonly #rtkExecutable: string | false;
  #rtkVersion: Promise<string | undefined> | undefined;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.#executable = options.executable ?? "claude";
    this.#killGraceMs = options.killGraceMs ?? 2_000;
    this.#model = options.model;
    this.#reasoningEffort = options.reasoningEffort;
    this.#permissionMode = options.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE;
    this.#rtkExecutable = options.rtkExecutable ?? "rtk";
  }

  #probeRtk(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
    if (this.#rtkExecutable === false) return Promise.resolve(undefined);
    this.#rtkVersion ??= execFileAsync(this.#rtkExecutable, ["--version"], {
      encoding: "utf8",
      env: environment,
      timeout: 1_000,
      windowsHide: true,
      maxBuffer: 16 * 1_024,
    })
      .then(({ stdout }) => stdout.trim().split(/\r?\n/, 1)[0] || undefined)
      .catch(() => undefined);
    return this.#rtkVersion;
  }

  async #runtimePrompt(
    input: AgentRunInput,
    environment: NodeJS.ProcessEnv,
  ): Promise<string> {
    if (this.#rtkExecutable === false) return input.prompt;
    const guidance = await this.#probeRtk(environment).then((version) =>
      version
        ? `RTK command proxy:\n- ${version} is installed and available in this runtime.\n- Prefix shell commands with RTK by default (for example: rtk git status, rtk rg <pattern>, rtk read <file>, rtk npm test).\n- Use the native command only when RTK has no suitable proxy or RTK execution fails. Do not spend time rediscovering or reinstalling RTK.`
        : `RTK command proxy:\n- RTK was not detected in this runtime. Use native repository commands directly and do not spend time searching for RTK.`,
    );
    return `${input.prompt.trimEnd()}\n\n${guidance}\n`;
  }

  #baseArgs(input: AgentRunInput): string[] {
    const directory = input.artifactDirectory;
    if (directory !== undefined
      && (!isAbsolute(directory) || resolve(directory) === parse(directory).root)) {
      throw new Error("Artifact directory must be an absolute non-root path");
    }
    if (input.allowedTools !== undefined && (!Array.isArray(input.allowedTools)
      || input.allowedTools.some((name) => typeof name !== "string" || name.trim() !== name
        || !/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(name)))) {
      throw new Error("Allowed tools must be exact MCP tool names");
    }
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(directory === undefined ? [] : ["--add-dir", directory]),
      ...(input.allowedTools?.length ? ["--allowedTools", input.allowedTools.join(",")] : []),
      ...(this.#model === undefined ? [] : ["--model", this.#model]),
      ...(this.#reasoningEffort === undefined
        ? []
        : ["--effort", this.#reasoningEffort]),
      "--permission-mode", this.#permissionMode,
    ];
  }

  async probe(): Promise<AgentCapabilities> {
    return await new Promise<AgentCapabilities>((resolve) => {
      const child = spawn(this.#executable, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
      });
      child.once("error", () => {
        resolve({ available: false, supportsResume: true, structuredOutput: true });
      });
      child.once("close", (code) => {
        const match = output.match(/(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/);
        const capabilities: AgentCapabilities = {
          available: code === 0,
          supportsResume: true,
          structuredOutput: true,
        };
        if (match?.[1]) capabilities.version = match[1];
        resolve(capabilities);
      });
    });
  }

  async *run(
    input: AgentRunInput,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    yield* this.#execute(input, signal, this.#baseArgs(input));
  }

  async *resume(
    input: AgentResumeInput,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.sessionId)) {
      throw new Error("Refusing to resume an invalid Claude session id");
    }
    yield* this.#execute(
      input,
      signal,
      [...this.#baseArgs(input), "--resume", input.sessionId],
    );
  }

  async *#execute(
    input: AgentRunInput,
    signal: AbortSignal,
    args: string[],
  ): AsyncIterable<NormalizedAgentEvent> {
    const queue = new AsyncQueue<NormalizedAgentEvent>();
    const environment = processEnv(input.environment);
    const prompt = await this.#runtimePrompt(input, environment);
    const parser = new ClaudeEventParser(input.workspaceRoot);
    const child = spawn(this.#executable, args, {
      cwd: input.workspaceRoot,
      env: environment,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const removeEmergencyExitHook = installEmergencyChildExitHook(child);

    let stdoutRemainder = "";
    let stderrRemainder = "";
    let timedOut = false;
    let aborted = signal.aborted;
    let termination: Promise<void> | undefined;
    let permissionDenied = false;
    const deniedTools = new Set<string>();
    const requestTermination = (): Promise<void> => {
      termination ??= terminateChildProcessTree(
        child,
        this.#killGraceMs,
      ).finally(removeEmergencyExitHook);
      return termination;
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      void requestTermination();
    }, Math.max(1, input.maxRunMs));
    timeout.unref();

    const abort = (): void => {
      aborted = true;
      void requestTermination();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    const parseLine = (line: string): void => {
      for (const event of parser.parse(line)) {
        if (event.type === "permission_denied") {
          permissionDenied = true;
          if (event.toolName) deniedTools.add(event.toolName);
          queue.push(event);
          clearTimeout(timeout);
          void requestTermination();
        } else if (!permissionDenied) queue.push(event);
      }
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutRemainder = splitLines(chunk, stdoutRemainder, parseLine);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrRemainder = splitLines(chunk, stderrRemainder, (line) => {
        if (!permissionDenied && line.trim()) queue.push({ type: "warning", text: line });
      });
    });
    child.once("error", (error) => queue.end(error));
    child.once("close", (code, closeSignal) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      void (async () => {
        await requestTermination();
        if (stdoutRemainder.trim()) {
          parseLine(stdoutRemainder);
        }
        if (!permissionDenied && stderrRemainder.trim()) queue.push({ type: "warning", text: stderrRemainder });
        if (timedOut) queue.end(new AgentTimeoutError());
        else if (aborted) queue.end(new AgentCanceledError());
        else if (permissionDenied) queue.end(new AgentPermissionDeniedError([...deniedTools]));
        else if (code !== 0) {
          queue.end(
            new AgentProcessError(
              `Claude exited with code ${String(code)}`,
              code,
              closeSignal,
            ),
          );
        } else {
          queue.end();
        }
      })().catch((error: unknown) => queue.end(error));
    });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") queue.end(error);
    });
    child.stdin.end(prompt);

    try {
      for await (const event of queue) yield event;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      try {
        if (child.exitCode === null && child.signalCode === null) {
          await requestTermination();
        } else if (termination) {
          await termination;
        }
      } finally {
        removeEmergencyExitHook();
      }
    }
  }
}
