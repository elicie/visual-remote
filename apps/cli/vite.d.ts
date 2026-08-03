import type { Plugin } from "vite";

export interface VisualRemoteViteOptions {
  cwd?: string;
  bridgeHost?: string;
  bridgePort?: number;
}

export declare function visualRemote(options?: VisualRemoteViteOptions): Plugin;

export default visualRemote;
