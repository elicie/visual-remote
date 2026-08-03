import type { Writable } from "node:stream";
import {
  discoverGitWorktreeRoot,
  isProcessAlive,
  readInstance,
  removeInstance,
  type BridgeInstanceRecord,
} from "@visual-remote/bridge-core";

export interface StatusDependencies {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  stdout?: Writable;
}

export interface BridgeStatus {
  running: boolean;
  instance?: BridgeInstanceRecord;
}

export async function getBridgeStatus(
  dependencies: StatusDependencies = {},
): Promise<BridgeStatus> {
  const repoRoot = await discoverGitWorktreeRoot(dependencies.cwd ?? process.cwd());
  const environment = dependencies.environment ?? process.env;
  const instance = await readInstance(repoRoot, { environment });
  if (instance === undefined) {
    return { running: false };
  }
  if (!isProcessAlive(instance.pid)) {
    await removeInstance(repoRoot, instance.pid, { environment });
    return { running: false };
  }
  return { running: true, instance };
}

export function formatBridgeStatus(status: BridgeStatus): string {
  if (!status.running || status.instance === undefined) {
    return "No Visual Bridge is running for this worktree.";
  }
  const { instance } = status;
  const rows = [
    `Project:  ${instance.projectId}`,
    `Status:   ${instance.status}`,
    `PID:      ${instance.pid}`,
    `Gateway:  ${instance.gatewayUrl}`,
    `Upstream: ${instance.upstreamUrl}`,
  ];
  if (instance.publicUrl !== undefined) rows.push(`Public:   ${instance.publicUrl}`);
  if (instance.activeTaskId !== undefined) {
    rows.push(`Active:   ${instance.activeTaskId}`);
  }
  return rows.join("\n");
}
