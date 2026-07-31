import { spawn, type ChildProcess } from "node:child_process";

export interface ManagedProcessOptions {
  command: readonly string[];
  cwd: string;
  upstreamPort: number;
  killGraceMs?: number;
  environment?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface ManagedProcess {
  readonly child: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

function replacePortPlaceholder(value: string, port: number): string {
  return value.replaceAll("{upstreamPort}", String(port));
}

function safeChildProcessId(child: ChildProcess): number | undefined {
  const pid = child.pid;
  if (
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid === process.pid
  ) {
    return undefined;
  }
  return pid;
}

function safeDetachedProcessGroupId(child: ChildProcess): number | undefined {
  return process.platform === "win32"
    ? undefined
    : safeChildProcessId(child);
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function processGroupIsAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      return true;
    }
    throw error;
  }
}

function childIsAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Synchronously signals the validated process tree created for a detached
 * child. This is safe to call from a Node `exit` listener.
 */
export function signalChildProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  const pid = safeChildProcessId(child);
  if (pid === undefined) return false;
  try {
    if (process.platform === "win32") {
      if (!childIsAlive(child)) return false;
      return child.kill(signal);
    }
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
}

export function installEmergencyChildExitHook(
  child: ChildProcess,
  processLike: Pick<NodeJS.Process, "once" | "off"> = process,
): () => void {
  let removed = false;
  const emergencyExit = (): void => {
    removed = true;
    try {
      signalChildProcessTree(child, "SIGKILL");
    } catch {
      // Exit hooks cannot recover from signaling failures and must not throw.
    }
  };
  processLike.once("exit", emergencyExit);
  return (): void => {
    if (removed) return;
    removed = true;
    processLike.off("exit", emergencyExit);
  };
}

async function waitForProcessTreeExit(
  child: ChildProcess,
  processGroupId: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (
    processGroupId === undefined
      ? childIsAlive(child)
      : processGroupIsAlive(processGroupId)
  ) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(25, remaining));
    });
  }
  return true;
}

/**
 * Terminates the detached POSIX process group created for a child. The group is
 * addressed only when its leader PID is a validated child PID, never the
 * Bridge's own PID. On Windows this falls back to terminating the child.
 */
export async function terminateChildProcessTree(
  child: ChildProcess,
  killGraceMs = 3_000,
): Promise<void> {
  const processGroupId = safeDetachedProcessGroupId(child);
  if (processGroupId === undefined && !childIsAlive(child)) return;

  const sendSignal = (signal: NodeJS.Signals): void => {
    signalChildProcessTree(child, signal);
  };

  sendSignal("SIGTERM");
  if (
    await waitForProcessTreeExit(
      child,
      processGroupId,
      Math.max(0, killGraceMs),
    )
  ) {
    return;
  }

  sendSignal("SIGKILL");
  await waitForProcessTreeExit(
    child,
    processGroupId,
    Math.min(Math.max(0, killGraceMs), 1_000),
  );
}

export async function startManagedProcess(
  options: ManagedProcessOptions,
): Promise<ManagedProcess> {
  const [executable, ...rawArguments] = options.command;
  if (executable === undefined) {
    throw new Error("Managed dev command is empty");
  }

  const detached = process.platform !== "win32";
  const child = spawn(
    replacePortPlaceholder(executable, options.upstreamPort),
    rawArguments.map((argument) => replacePortPlaceholder(argument, options.upstreamPort)),
    {
      cwd: options.cwd,
      env: {
        ...(options.environment ?? process.env),
        HOST: "0.0.0.0",
        PORT: String(options.upstreamPort),
      },
      detached,
      stdio: [
        "inherit",
        options.stdout === undefined ? "inherit" : "pipe",
        options.stderr === undefined ? "inherit" : "pipe",
      ],
      windowsHide: true,
    },
  );
  const removeEmergencyExitHook = installEmergencyChildExitHook(child);

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    },
  );

  if (child.stdout !== null && options.stdout !== undefined) {
    child.stdout.pipe(options.stdout, { end: false });
  }
  if (child.stderr !== null && options.stderr !== undefined) {
    child.stderr.pipe(options.stderr, { end: false });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    removeEmergencyExitHook();
    throw error;
  }

  let stopPromise: Promise<void> | undefined;
  return {
    child,
    exit,
    stop() {
      stopPromise ??= terminateChildProcessTree(
        child,
        options.killGraceMs,
      ).finally(removeEmergencyExitHook);
      return stopPromise;
    },
  };
}
