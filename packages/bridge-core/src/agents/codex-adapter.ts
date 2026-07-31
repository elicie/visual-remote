import { spawn } from "node:child_process";

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
}

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

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly #executable: string;
  readonly #killGraceMs: number;

  constructor(options: CodexAdapterOptions = {}) {
    this.#executable = options.executable ?? "codex";
    this.#killGraceMs = options.killGraceMs ?? 2_000;
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
    const child = spawn(this.#executable, args, {
      cwd: input.repoRoot,
      env: processEnv(input.environment),
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
        for (const event of parseCodexJsonLine(line)) queue.push(event);
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
          for (const event of parseCodexJsonLine(stdoutRemainder)) queue.push(event);
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
    child.stdin.end(input.prompt);

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
