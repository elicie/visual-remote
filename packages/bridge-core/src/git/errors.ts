export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed${exitCode === null ? "" : ` with code ${exitCode}`}: ${stderr.trim()}`);
    this.name = "GitCommandError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class RepositorySafetyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RepositorySafetyError";
    this.code = code;
  }
}

export class PathSafetyError extends RepositorySafetyError {
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(code, message);
    this.name = "PathSafetyError";
    this.path = path;
  }
}

export class CommitConflictError extends RepositorySafetyError {
  readonly paths: string[];

  constructor(paths: string[]) {
    super(
      "COMMIT_CONFLICT",
      `Task files changed after the task completed: ${paths.join(", ")}`,
    );
    this.name = "CommitConflictError";
    this.paths = paths;
  }
}

export class RevertConflictError extends RepositorySafetyError {
  readonly paths: string[];

  constructor(paths: string[]) {
    super(
      "REVERT_CONFLICT",
      `Task files changed after the task completed: ${paths.join(", ")}`,
    );
    this.name = "RevertConflictError";
    this.paths = paths;
  }
}
