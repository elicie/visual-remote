export interface AgentCapabilities {
  available: boolean;
  version?: string;
  supportsResume: boolean;
  structuredOutput: boolean;
}

export interface AgentRunInput {
  taskId: string;
  repoRoot: string;
  workspaceRoot: string;
  prompt: string;
  contextBundlePath: string;
  environment: Record<string, string>;
  maxRunMs: number;
}

export interface AgentResumeInput extends AgentRunInput {
  sessionId: string;
}

export type NormalizedAgentEvent =
  | { type: "message"; text: string }
  | { type: "phase"; name: string }
  | { type: "tool_start"; name: string; summary?: string }
  | { type: "tool_end"; name: string; ok: boolean }
  | {
      type: "command";
      command: string;
      cwd: string;
      exitCode?: number;
      durationMs?: number;
      usedRtk?: boolean;
      timedOut?: boolean;
      truncated?: boolean;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
    }
  | { type: "file_hint"; path: string }
  | { type: "session"; sessionId: string }
  | { type: "warning"; text: string }
  | { type: "error"; text: string }
  | { type: "complete"; summary?: string };

export interface AgentAdapter {
  readonly id: string;
  probe(): Promise<AgentCapabilities>;
  run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent>;
  resume?(
    input: AgentResumeInput,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent>;
}

export class AgentProcessError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(message: string, exitCode: number | null, signal: NodeJS.Signals | null) {
    super(message);
    this.name = "AgentProcessError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export class AgentTimeoutError extends Error {
  constructor(message = "Agent exceeded its configured time limit") {
    super(message);
    this.name = "AgentTimeoutError";
  }
}

export class AgentCanceledError extends Error {
  constructor(message = "Agent run was canceled") {
    super(message);
    this.name = "AgentCanceledError";
  }
}
