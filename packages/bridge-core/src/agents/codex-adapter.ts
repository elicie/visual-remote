import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AsyncQueue } from "./async-queue.js";
import { parseCodexJsonLine } from "./codex-event-parser.js";
import {
  installEmergencyChildExitHook,
  terminateChildProcessTree,
} from "../runtime/managed-process.js";
import {
  AgentCanceledError,
  AgentProcessError,
  AgentTimeoutError,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentResumeInput,
  type AgentRunInput,
  type NormalizedAgentEvent,
} from "./types.js";

export interface CodexAdapterOptions {
  executable?: string;
  killGraceMs?: number;
  rtkExecutable?: string | false;
  directExecMcpScript?: string | false;
}

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
  "CODEX_HOME",
  "OPENAI_API_KEY",
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

function defaultDirectExecMcpScript(): string | undefined {
  const candidates = [
    fileURLToPath(new URL("./direct-exec-mcp.js", import.meta.url)),
    fileURLToPath(
      new URL("../../../../apps/cli/dist/direct-exec-mcp.js", import.meta.url),
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly #executable: string;
  readonly #killGraceMs: number;
  readonly #rtkExecutable: string | false;
  readonly #directExecMcpScript: string | undefined;
  #rtkVersion: Promise<string | undefined> | undefined;

  constructor(options: CodexAdapterOptions = {}) {
    this.#executable = options.executable ?? "codex";
    this.#killGraceMs = options.killGraceMs ?? 2_000;
    this.#rtkExecutable = options.rtkExecutable ?? "rtk";
    this.#directExecMcpScript = options.directExecMcpScript === false
      ? undefined
      : options.directExecMcpScript ?? defaultDirectExecMcpScript();
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
    const commandGuidance = this.#rtkExecutable === false
      ? ""
      : await this.#probeRtk(environment).then((version) => version
        ? `RTK command proxy:\n- ${version} is installed and available in this runtime.\n- Prefix shell commands with RTK by default (for example: rtk git status, rtk rg <pattern>, rtk read <file>, rtk npm test).\n- Use the native command only when RTK has no suitable proxy or RTK execution fails. Do not spend time rediscovering or reinstalling RTK.`
        : `RTK command proxy:\n- RTK was not detected in this runtime. Use native repository commands directly and do not spend time searching for RTK.`);
    const directExecGuidance = this.#directExecMcpScript === undefined
      ? ""
      : `Direct read-only command runner:\n- Use the visual_remote_exec run_readonly MCP tool (mcp__visual_remote_exec__run_readonly) for repository inspection by default: pwd, version checks, file listing/reading/search, and read-only Git status/diff/log/show.\n- Send argv arrays, batch independent reads in one tool call, and keep cwd at the registered workspace unless a known subdirectory is required.\n- The tool executes without a shell and applies RTK automatically when supported.\n- Use command_execution only for edits, tests/builds, or commands that genuinely require shell syntax. Do not retry a policy-rejected command through another shell unless the requested work requires that non-read-only operation.`;
    const guidance = [directExecGuidance, commandGuidance].filter(Boolean).join("\n\n");
    return guidance.length === 0
      ? input.prompt
      : `${input.prompt.trimEnd()}\n\n${guidance}\n`;
  }

  #directExecConfig(input: AgentRunInput): string[] {
    if (this.#directExecMcpScript === undefined) return [];
    const serverArgs = [
      this.#directExecMcpScript,
      "--repo-root",
      input.repoRoot,
      "--workspace-root",
      input.workspaceRoot,
      ...(this.#rtkExecutable === false
        ? ["--no-rtk"]
        : ["--rtk", this.#rtkExecutable]),
    ];
    return [
      "-c",
      `mcp_servers.visual_remote_exec.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.visual_remote_exec.args=${JSON.stringify(serverArgs)}`,
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
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "-s",
      "workspace-write",
      "-C",
      input.repoRoot,
      ...this.#directExecConfig(input),
      "-",
    ];
    yield* this.#execute(input, signal, args);
  }

  async *resume(
    input: AgentResumeInput,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.sessionId)) {
      throw new Error("Refusing to resume an invalid Codex session id");
    }
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "-s",
      "workspace-write",
      "-C",
      input.repoRoot,
      ...this.#directExecConfig(input),
      "resume",
      input.sessionId,
      "-",
    ];
    yield* this.#execute(input, signal, args);
  }

  async *#execute(
    input: AgentRunInput,
    signal: AbortSignal,
    args: string[],
  ): AsyncIterable<NormalizedAgentEvent> {
    const queue = new AsyncQueue<NormalizedAgentEvent>();
    const environment = processEnv(input.environment);
    const prompt = await this.#runtimePrompt(input, environment);
    const child = spawn(this.#executable, args, {
      cwd: input.repoRoot,
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

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutRemainder = splitLines(chunk, stdoutRemainder, (line) => {
        for (const event of parseCodexJsonLine(line, input.repoRoot)) queue.push(event);
      });
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrRemainder = splitLines(chunk, stderrRemainder, (line) => {
        if (line.trim()) queue.push({ type: "warning", text: line });
      });
    });
    child.once("error", (error) => queue.end(error));
    child.once("close", (code, closeSignal) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      void (async () => {
        await requestTermination();
        if (stdoutRemainder.trim()) {
          for (const event of parseCodexJsonLine(stdoutRemainder, input.repoRoot)) {
            queue.push(event);
          }
        }
        if (stderrRemainder.trim()) queue.push({ type: "warning", text: stderrRemainder });
        if (timedOut) queue.end(new AgentTimeoutError());
        else if (aborted) queue.end(new AgentCanceledError());
        else if (code !== 0) {
          queue.end(
            new AgentProcessError(
              `Codex exited with code ${String(code)}`,
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
