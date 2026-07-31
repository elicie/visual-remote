import { spawn } from "node:child_process";

import { GitCommandError } from "./errors.js";

export interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface RunGitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  allowFailure?: boolean;
  maxOutputBytes?: number;
}

export async function runGit(
  args: readonly string[],
  options: RunGitOptions,
): Promise<GitResult> {
  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const maxOutputBytes = options.maxOutputBytes ?? 128 * 1024 * 1024;

    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxOutputBytes) {
        child.kill("SIGKILL");
        reject(new Error(`git output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      target.push(buffer);
    };
    child.stdout.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => collect(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result: GitResult = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? -1,
      };
      if (code !== 0 && !options.allowFailure) {
        reject(new GitCommandError(args, code, result.stderr.toString("utf8")));
      } else {
        resolve(result);
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function gitText(
  args: readonly string[],
  options: RunGitOptions,
): Promise<string> {
  const result = await runGit(args, options);
  return result.stdout.toString("utf8").trim();
}

export function literalPathspec(path: string): string {
  return `:(top,literal)${path}`;
}
