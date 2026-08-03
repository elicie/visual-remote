import type { NextConfig } from "next";

export interface VisualRemoteNextOptions {
  cwd?: string;
  bridgeHost?: string;
  bridgePort?: number;
  appPort?: number;
}

export type NextConfigFactory = (
  phase: string,
  context: { defaultConfig: NextConfig },
) => NextConfig | Promise<NextConfig>;

export declare function withVisualRemote(
  nextConfig?: NextConfig | NextConfigFactory,
  options?: VisualRemoteNextOptions,
): NextConfigFactory;

export declare function closeVisualRemoteNext(cwd?: string): Promise<void>;

export default withVisualRemote;
