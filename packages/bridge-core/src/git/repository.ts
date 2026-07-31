import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { RepositorySafetyError } from "./errors.js";
import { gitText } from "./git-command.js";

export interface GitRepository {
  root: string;
  gitDir: string;
}

export async function discoverGitRepository(startPath: string): Promise<GitRepository> {
  const cwd = await realpath(resolve(startPath));
  const rootText = await gitText(["rev-parse", "--show-toplevel"], { cwd });
  const root = await realpath(rootText);
  const verifiedRoot = await gitText(["rev-parse", "--show-toplevel"], { cwd: root });
  if ((await realpath(verifiedRoot)) !== root) {
    throw new RepositorySafetyError("REPOSITORY_ROOT_CHANGED", "Git repository root was unstable");
  }
  const gitDirText = await gitText(["rev-parse", "--absolute-git-dir"], { cwd: root });
  const gitDir = await realpath(gitDirText);
  return { root, gitDir };
}
