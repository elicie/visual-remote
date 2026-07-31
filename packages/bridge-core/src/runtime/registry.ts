import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export type BridgeInstanceStatus =
  | "starting"
  | "idle"
  | "working"
  | "upstream-offline"
  | "stopping";

export interface BridgeInstanceRecord {
  projectId: string;
  repoRoot: string;
  pid: number;
  gatewayUrl: string;
  upstreamUrl: string;
  status: BridgeInstanceStatus;
  startedAt: string;
  publicUrl?: string;
  activeTaskId?: string;
}

interface LockRecord {
  ownerId: string;
  pid: number;
  repoRoot: string;
  acquiredAt: string;
}

export interface WorktreeLock {
  repoKey: string;
  runtimeDirectory: string;
  lockPath: string;
  release(): Promise<void>;
}

export interface RuntimePathOptions {
  environment?: NodeJS.ProcessEnv;
}

export class BridgeAlreadyRunningError extends Error {
  readonly repoRoot: string;
  readonly instance?: BridgeInstanceRecord;

  constructor(repoRoot: string, instance?: BridgeInstanceRecord) {
    const detail =
      instance === undefined
        ? ""
        : ` (pid ${instance.pid}, gateway ${instance.gatewayUrl})`;
    super(`A Visual Bridge is already running for ${repoRoot}${detail}`);
    this.name = "BridgeAlreadyRunningError";
    this.repoRoot = repoRoot;
    if (instance !== undefined) {
      this.instance = instance;
    }
  }
}

function fallbackRuntimeDirectory(): string {
  const userSuffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `visual-bridge-runtime-${userSuffix}`);
}

export function runtimeRoot(options: RuntimePathOptions = {}): string {
  const environment = options.environment ?? process.env;
  const xdgRuntimeDirectory = environment.XDG_RUNTIME_DIR;
  const base =
    xdgRuntimeDirectory !== undefined && isAbsolute(xdgRuntimeDirectory)
      ? xdgRuntimeDirectory
      : fallbackRuntimeDirectory();
  return join(base, "visual-bridge");
}

export async function repositoryKey(repositoryRoot: string): Promise<string> {
  const canonicalRoot = await realpath(repositoryRoot);
  return createHash("sha256").update(canonicalRoot).digest("hex");
}

export async function runtimeDirectoryFor(
  repositoryRoot: string,
  options: RuntimePathOptions = {},
): Promise<string> {
  return join(runtimeRoot(options), await repositoryKey(repositoryRoot));
}

function isBridgeInstanceRecord(value: unknown): value is BridgeInstanceRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.projectId === "string" &&
    typeof record.repoRoot === "string" &&
    typeof record.pid === "number" &&
    typeof record.gatewayUrl === "string" &&
    typeof record.upstreamUrl === "string" &&
    typeof record.status === "string" &&
    typeof record.startedAt === "string"
  );
}

function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.ownerId === "string" &&
    typeof record.pid === "number" &&
    typeof record.repoRoot === "string" &&
    typeof record.acquiredAt === "string"
  );
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    return undefined;
  }
}

export async function readInstance(
  repositoryRoot: string,
  options: RuntimePathOptions = {},
): Promise<BridgeInstanceRecord | undefined> {
  const directory = await runtimeDirectoryFor(repositoryRoot, options);
  const value = await readJson(join(directory, "instance.json"));
  return isBridgeInstanceRecord(value) ? value : undefined;
}

export async function writeInstance(
  repositoryRoot: string,
  instance: BridgeInstanceRecord,
  options: RuntimePathOptions = {},
): Promise<void> {
  const directory = await runtimeDirectoryFor(repositoryRoot, options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "instance.json");
  const temporaryPath = join(directory, `.instance-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(instance, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export async function removeInstance(
  repositoryRoot: string,
  expectedPid?: number,
  options: RuntimePathOptions = {},
): Promise<void> {
  const directory = await runtimeDirectoryFor(repositoryRoot, options);
  const path = join(directory, "instance.json");
  if (expectedPid !== undefined) {
    const current = await readJson(path);
    if (!isBridgeInstanceRecord(current) || current.pid !== expectedPid) {
      return;
    }
  }
  await rm(path, { force: true });
}

export async function listInstances(
  options: RuntimePathOptions & { pruneStale?: boolean } = {},
): Promise<BridgeInstanceRecord[]> {
  const root = runtimeRoot(options);
  let directories: string[];
  try {
    directories = await readdir(root);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const instances: BridgeInstanceRecord[] = [];
  await Promise.all(
    directories.map(async (directoryName) => {
      const path = join(root, directoryName, "instance.json");
      const value = await readJson(path);
      if (!isBridgeInstanceRecord(value)) {
        return;
      }
      if (!isProcessAlive(value.pid)) {
        if (options.pruneStale ?? true) {
          await rm(path, { force: true });
        }
        return;
      }
      instances.push(value);
    }),
  );

  return instances.sort((left, right) => left.repoRoot.localeCompare(right.repoRoot));
}

export async function acquireWorktreeLock(
  repositoryRoot: string,
  options: RuntimePathOptions = {},
): Promise<WorktreeLock> {
  const repoRoot = await realpath(repositoryRoot);
  const repoKey = await repositoryKey(repoRoot);
  const runtimeDirectory = join(runtimeRoot(options), repoKey);
  const lockPath = join(runtimeDirectory, "bridge.lock");
  const ownerId = randomUUID();
  const lockRecord: LockRecord = {
    ownerId,
    pid: process.pid,
    repoRoot,
    acquiredAt: new Date().toISOString(),
  };

  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidatePath = join(
      runtimeDirectory,
      `.bridge-lock-${process.pid}-${ownerId}.tmp`,
    );
    try {
      await writeFile(candidatePath, `${JSON.stringify(lockRecord)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      try {
        await link(candidatePath, lockPath);
      } finally {
        await rm(candidatePath, { force: true });
      }

      let released = false;
      return {
        repoKey,
        runtimeDirectory,
        lockPath,
        async release() {
          if (released) {
            return;
          }
          released = true;
          const current = await readJson(lockPath);
          if (isLockRecord(current) && current.ownerId === ownerId) {
            await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") {
                throw error;
              }
            });
          }
        },
      };
    } catch (error) {
      await rm(candidatePath, { force: true });
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }

      const existingLock = await readJson(lockPath);
      if (isLockRecord(existingLock) && isProcessAlive(existingLock.pid)) {
        throw new BridgeAlreadyRunningError(repoRoot, await readInstance(repoRoot, options));
      }

      await rm(lockPath, { force: true });
      await removeInstance(repoRoot, undefined, options);
    }
  }

  throw new BridgeAlreadyRunningError(repoRoot, await readInstance(repoRoot, options));
}
