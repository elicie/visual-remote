import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  discoverGitWorktreeRoot,
  discoverVisualDevConfigRoot,
  loadVisualDevConfig,
  VisualDevConfigError,
} from "@visual-remote/bridge-core";

const execFileAsync = promisify(execFile);

export type DoctorCheckStatus = "pass" | "warning" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
}

export interface DoctorDependencies {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function isIgnored(repoRoot: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoRoot, "check-ignore", "--quiet", "--", path], {
      windowsHide: true,
    });
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number" &&
      error.code === 1
    ) {
      return false;
    }
    return false;
  }
}

async function executableAvailable(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const candidates =
    executable.includes("/")
      ? [isAbsolute(executable) ? executable : resolve(cwd, executable)]
      : (environment.PATH ?? "")
          .split(delimiter)
          .filter((entry) => entry.length > 0)
          .map((entry) => join(entry, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

export async function runDoctor(
  dependencies: DoctorDependencies = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let repoRoot: string;
  try {
    repoRoot = await discoverGitWorktreeRoot(dependencies.cwd ?? process.cwd());
    checks.push({ name: "git-worktree", status: "pass", message: repoRoot });
  } catch (error) {
    checks.push({
      name: "git-worktree",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
    return checks;
  }

  try {
    const configRoot = await discoverVisualDevConfigRoot(
      dependencies.cwd ?? process.cwd(),
      repoRoot,
    );
    const loaded = await loadVisualDevConfig(repoRoot, { configRoot });
    checks.push({
      name: "config",
      status: loaded.loadedFiles.length === 0 ? "warning" : "pass",
      message:
        loaded.loadedFiles.length === 0
          ? "No .visualdev/config.yaml; attach defaults are available."
          : loaded.loadedFiles.join(", "),
    });

    if (await fileExists(loaded.localConfigPath)) {
      const localConfigRelativePath = relative(repoRoot, loaded.localConfigPath);
      const ignored = await isIgnored(repoRoot, localConfigRelativePath);
      checks.push({
        name: "local-config-ignore",
        status: ignored ? "pass" : "warning",
        message: ignored
          ? ".visualdev/config.local.yaml is ignored by Git."
          : "Add .visualdev/config.local.yaml to .gitignore.",
      });
    }

    const command = loaded.config.upstream.command;
    if (command !== undefined) {
      const executable = command[0];
      const available =
        executable !== undefined &&
        (await executableAvailable(
          executable,
          loaded.workspaceRoot,
          dependencies.environment ?? process.env,
        ));
      checks.push({
        name: "dev-command",
        status: available ? "pass" : "fail",
        message: available
          ? `${executable} is executable.`
          : `${executable ?? "<empty>"} was not found or is not executable.`,
      });
    }
  } catch (error) {
    checks.push({
      name: "config",
      status: "fail",
      message:
        error instanceof VisualDevConfigError || error instanceof Error
          ? error.message
          : String(error),
    });
  }

  return checks;
}

export function formatDoctorChecks(checks: readonly DoctorCheck[]): string {
  return checks
    .map((check) => {
      const marker = check.status === "pass" ? "PASS" : check.status === "warning" ? "WARN" : "FAIL";
      return `[${marker}] ${check.name}: ${check.message}`;
    })
    .join("\n");
}
