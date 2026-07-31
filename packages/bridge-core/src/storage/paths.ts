import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";

export interface StoragePaths {
  repoKey: string;
  databasePath: string;
  logsDirectory: string;
}

export async function resolveStoragePaths(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<StoragePaths> {
  const canonicalRoot = await realpath(repoRoot);
  const repoKey = createHash("sha256").update(canonicalRoot).digest("hex");
  const dataHome = environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const stateHome = environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return {
    repoKey,
    databasePath: join(dataHome, "visual-bridge", repoKey, "state.sqlite"),
    logsDirectory: join(stateHome, "visual-bridge", repoKey, "logs"),
  };
}
