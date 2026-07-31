import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitWorktreeNotFoundError extends Error {
  constructor(cwd: string, options: { cause?: unknown } = {}) {
    super(
      `No Git worktree was found from ${cwd}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "GitWorktreeNotFoundError";
  }
}

export async function discoverGitWorktreeRoot(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    const root = stdout.trim();
    if (root.length === 0) {
      throw new Error("git returned an empty worktree path");
    }
    return await realpath(root);
  } catch (error) {
    throw new GitWorktreeNotFoundError(cwd, { cause: error });
  }
}
