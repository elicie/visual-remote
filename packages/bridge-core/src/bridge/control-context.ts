export type BridgeMode = "attach" | "managed";

export interface BridgeRuntimeState {
  status: "idle" | "working";
  activeTaskId?: string;
}

export interface BridgeControlContext {
  mode: BridgeMode;
  projectId: string;
  repoRoot: string;
  configRoot?: string;
  workspaceRoot: string;
  upstreamUrl: string;
  onRuntimeState?: (state: BridgeRuntimeState) => void;
}
