import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DirectExecPolicyError,
  directExecExecutableAvailable,
  executeReadOnlyBatch,
  type DirectExecBatchRequest,
  type DirectExecBatchResult,
} from "../../../packages/bridge-core/src/agents/direct-exec.js";
import { VISUAL_REMOTE_VERSION } from "./version.js";

type JsonRecord = Record<string, unknown>;

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface ServerOptions {
  repoRoot: string;
  workspaceRoot: string;
  rtkExecutable: string | false;
  rtkAvailable: boolean;
}

const TOOL_NAME = "run_readonly";

function recordOf(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

export function parseArguments(
  argv: readonly string[],
): Omit<ServerOptions, "rtkAvailable"> {
  const values = new Map<string, string>();
  let disableRtk = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-rtk") {
      disableRtk = true;
      continue;
    }
    if (!["--repo-root", "--workspace-root", "--rtk"].includes(argument ?? "")) {
      throw new Error(`Unknown direct-exec MCP argument: ${argument ?? "<missing>"}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0) {
      throw new Error(`${argument} requires a value`);
    }
    values.set(argument ?? "", value);
    index += 1;
  }
  const repoRoot = values.get("--repo-root");
  const workspaceRoot = values.get("--workspace-root");
  if (repoRoot === undefined || workspaceRoot === undefined) {
    throw new Error("Direct-exec MCP requires --repo-root and --workspace-root");
  }
  return {
    repoRoot,
    workspaceRoot,
    rtkExecutable: disableRtk ? false : values.get("--rtk") ?? "rtk",
  };
}

export function parseBatchRequest(value: unknown): DirectExecBatchRequest {
  const record = recordOf(value);
  const commands = Array.isArray(record?.commands) ? record.commands : undefined;
  if (commands === undefined) {
    throw new DirectExecPolicyError("commands must be an array");
  }
  return {
    commands: commands.map((candidate) => {
      const command = recordOf(candidate);
      if (!Array.isArray(command?.argv) || !command.argv.every((item) => typeof item === "string")) {
        throw new DirectExecPolicyError("Each command argv must be a string array");
      }
      if (command.cwd !== undefined && typeof command.cwd !== "string") {
        throw new DirectExecPolicyError("Command cwd must be a string when provided");
      }
      return {
        argv: command.argv,
        ...(typeof command.cwd === "string" ? { cwd: command.cwd } : {}),
      };
    }),
    preferRtk: true,
    ...(typeof record?.stopOnError === "boolean" ? { stopOnError: record.stopOnError } : {}),
    ...(typeof record?.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
  };
}

function displayArgument(argument: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/u.test(argument)
    ? argument
    : JSON.stringify(argument);
}

export function formatBatchResult(batch: DirectExecBatchResult): string {
  const sections = batch.results.map((result) => {
    const metadata = [
      `cwd=${result.cwd}`,
      `exit=${result.exitCode}`,
      `duration=${result.durationMs}ms`,
      ...(result.usedRtk ? ["rtk=yes"] : []),
      ...(result.timedOut ? ["timed_out=yes"] : []),
      ...(result.truncated ? ["truncated=yes"] : []),
    ].join(" ");
    const output = [
      result.stdout,
      result.stderr.length > 0 ? `stderr:\n${result.stderr}` : "",
    ].filter(Boolean).join("\n");
    return [
      `$ ${result.argv.map(displayArgument).join(" ")}`,
      metadata,
      output || "(no output)",
    ].join("\n");
  });
  if (batch.stoppedEarly) sections.push("Batch stopped after the first failed command.");
  return sections.join("\n\n");
}

export function structuredBatchResult(batch: DirectExecBatchResult): unknown {
  return {
    stoppedEarly: batch.stoppedEarly,
    results: batch.results.map(({ stdout: _stdout, stderr: _stderr, ...metadata }) => metadata),
  };
}

export function directExecToolResult(batch: DirectExecBatchResult): unknown {
  return {
    content: [{ type: "text", text: formatBatchResult(batch) }],
    structuredContent: structuredBatchResult(batch),
    isError: batch.results.some((command) => command.exitCode !== 0),
  };
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: RpcRequest["id"], value: unknown): void {
  send({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function error(id: RpcRequest["id"], code: number, message: string): void {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function handleRequest(request: RpcRequest, options: ServerOptions): Promise<void> {
  if (request.method === "initialize") {
    const params = recordOf(request.params);
    result(request.id, {
      protocolVersion:
        typeof params?.protocolVersion === "string"
          ? params.protocolVersion
          : "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "visual-remote-direct-exec",
        version: VISUAL_REMOTE_VERSION,
      },
    });
    return;
  }
  if (request.method === "ping") {
    result(request.id, {});
    return;
  }
  if (request.method === "tools/list") {
    result(request.id, {
      tools: [
        {
          name: TOOL_NAME,
          title: "Run read-only repository commands directly",
          description:
            "Runs up to 8 read-only argv commands without a shell in the registered worktree. " +
            "Uses the registered workspace as cwd and applies RTK automatically when supported.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["commands"],
            properties: {
              commands: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["argv"],
                  properties: {
                    argv: {
                      type: "array",
                      minItems: 1,
                      maxItems: 65,
                      items: { type: "string", maxLength: 4_096 },
                    },
                    cwd: {
                      type: "string",
                      description:
                        "Optional absolute worktree path or path relative to the registered workspace.",
                    },
                  },
                },
              },
              stopOnError: { type: "boolean", default: true },
              timeoutMs: { type: "integer", minimum: 1, maximum: 120_000 },
            },
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ],
    });
    return;
  }
  if (request.method === "tools/call") {
    const params = recordOf(request.params);
    if (params?.name !== TOOL_NAME) {
      error(request.id, -32_602, `Unknown tool: ${String(params?.name)}`);
      return;
    }
    try {
      const batch = await executeReadOnlyBatch(
        parseBatchRequest(params.arguments),
        options,
      );
      result(request.id, directExecToolResult(batch));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      result(request.id, {
        content: [{ type: "text", text: message }],
        isError: true,
      });
    }
    return;
  }
  if (request.id !== undefined) error(request.id, -32_601, `Method not found: ${request.method}`);
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const options: ServerOptions = {
    ...parsed,
    rtkAvailable:
      parsed.rtkExecutable === false
        ? false
        : await directExecExecutableAvailable(parsed.rtkExecutable, process.env),
  };
  process.stdin.setEncoding("utf8");
  let remainder = "";
  process.stdin.on("data", (chunk: string) => {
    const lines = (remainder + chunk).split(/\r?\n/u);
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const request = JSON.parse(line) as RpcRequest;
        if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
          error(request.id, -32_600, "Invalid JSON-RPC request");
          continue;
        }
        void handleRequest(request, options).catch((caught: unknown) => {
          error(
            request.id,
            -32_603,
            caught instanceof Error ? caught.message : String(caught),
          );
        });
      } catch {
        error(null, -32_700, "Invalid JSON");
      }
    }
  });
}

if (
  process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((caught: unknown) => {
    process.stderr.write(
      `${caught instanceof Error ? caught.message : String(caught)}\n`,
    );
    process.exitCode = 1;
  });
}
