import { spawn } from "node:child_process";

import { redactSecrets } from "../context/sanitize.js";
import { terminateChildProcessTree } from "../runtime/managed-process.js";

const MAX_OUTPUT_CHARS = 8_000;
const KILL_GRACE_MS = 250;

export interface VerificationCommand {
  name: string;
  command: readonly string[];
  timeoutMs: number;
}

export interface VerificationCommandResult {
  name: string;
  command: string[];
  status: "passed" | "failed" | "timeout";
  exitCode: number | null;
  durationMs: number;
  output: string;
}

function appendOutput(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  return `${current}${chunk.toString()}`.slice(0, MAX_OUTPUT_CHARS);
}

export async function runVerificationCommand(
  configured: VerificationCommand,
  cwd: string,
  signal?: AbortSignal,
): Promise<VerificationCommandResult> {
  const [executable, ...arguments_] = configured.command;
  if (executable === undefined) {
    throw new TypeError(`Verification command ${configured.name} is empty`);
  }
  const startedAt = Date.now();

  return await new Promise<VerificationCommandResult>((resolveResult, rejectResult) => {
    const child = spawn(executable, arguments_, {
      cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    let termination: Promise<void> | undefined;
    const requestTermination = (): Promise<void> => {
      if (termination === undefined) {
        termination = terminateChildProcessTree(child, KILL_GRACE_MS);
        void termination.catch(() => {
          // The result settlement below observes and reports this rejection.
        });
      }
      return termination;
    };
    const abort = (): void => {
      void requestTermination();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      abort();
    }, configured.timeoutMs);
    timeout.unref();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      output = appendOutput(output, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = appendOutput(output, chunk);
    });

    const stopTriggers = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (exitCode: number | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      stopTriggers();
      void (async () => {
        if (child.pid !== undefined) await requestTermination();
        if (spawnError !== undefined) {
          output = appendOutput(output, spawnError.message);
        }
        resolveResult({
          name: configured.name,
          command: [...configured.command],
          status: timedOut ? "timeout" : exitCode === 0 ? "passed" : "failed",
          exitCode,
          durationMs: Date.now() - startedAt,
          output: redactSecrets(output),
        });
      })().catch(rejectResult);
    };

    child.once("error", (error) => finish(null, error));
    child.once("exit", () => {
      stopTriggers();
      void requestTermination();
    });
    child.once("close", (code) => finish(code));
  });
}

export async function runVerificationCommands(
  commands: readonly VerificationCommand[],
  cwd: string,
  signal?: AbortSignal,
): Promise<VerificationCommandResult[]> {
  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    if (signal?.aborted) break;
    results.push(await runVerificationCommand(command, cwd, signal));
  }
  return results;
}
