import {
  AgentCanceledError,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentRunInput,
  type NormalizedAgentEvent,
} from "./types.js";

export interface FakeAgentRun {
  input: AgentRunInput;
  startedAt: number;
  completedAt?: number;
}

export type FakeAgentHandler = (
  input: AgentRunInput,
  signal: AbortSignal,
) =>
  | AsyncIterable<NormalizedAgentEvent>
  | Promise<Iterable<NormalizedAgentEvent>>
  | Iterable<NormalizedAgentEvent>;

export class FakeAgentAdapter implements AgentAdapter {
  readonly id = "fake";
  readonly runs: FakeAgentRun[] = [];
  readonly #handler: FakeAgentHandler;

  constructor(handler: FakeAgentHandler = () => [{ type: "complete" }]) {
    this.#handler = handler;
  }

  async probe(): Promise<AgentCapabilities> {
    return {
      available: true,
      supportsResume: false,
      structuredOutput: true,
      version: "test",
    };
  }

  async *run(
    input: AgentRunInput,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    const run: FakeAgentRun = { input, startedAt: Date.now() };
    this.runs.push(run);
    try {
      if (signal.aborted) throw new AgentCanceledError();
      const output = await this.#handler(input, signal);
      for await (const event of output) {
        if (signal.aborted) throw new AgentCanceledError();
        yield event;
      }
    } finally {
      run.completedAt = Date.now();
    }
  }
}
