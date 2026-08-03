export type BridgeMode = "attach" | "managed";

export interface BridgeControlContext {
  mode: BridgeMode;
  projectId: string;
  repoRoot: string;
  configRoot?: string;
  workspaceRoot: string;
  upstreamUrl: string;
}
