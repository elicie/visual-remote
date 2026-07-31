import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import {
  formatBridgeSummary,
  runBridgeUntilSignal,
  startAttachBridge,
  startManagedBridge,
  type BridgeDependencies,
} from "./bridge.js";
import { formatDoctorChecks, runDoctor } from "./doctor.js";
import { formatBridgeStatus, getBridgeStatus } from "./status.js";
import { assertServicePort } from "@visual-remote/bridge-core";

export interface CliDependencies extends BridgeDependencies {
  setExitCode?: (code: number) => void;
}

function parsePort(value: string): number {
  const port = Number(value);
  try {
    assertServicePort(port);
    return port;
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function output(dependencies: CliDependencies, message: string): void {
  (dependencies.stdout ?? process.stdout).write(`${message}\n`);
}

function setExitCode(dependencies: CliDependencies, code: number): void {
  if (dependencies.setExitCode !== undefined) {
    dependencies.setExitCode(code);
  } else {
    process.exitCode = code;
  }
}

export function createCli(dependencies: CliDependencies = {}): Command {
  const program = new Command()
    .name("visual")
    .description("Visual Remote Dev Bridge")
    .version("0.1.0");

  program
    .command("attach")
    .description("Attach the Bridge to an existing development server")
    .requiredOption("--upstream <url>", "existing development server URL")
    .option("--listen <port>", "gateway port (10001 or above)", parsePort)
    .option("--host <host>", "gateway bind host (default: 0.0.0.0)")
    .action(
      async (options: { upstream: string; listen?: number; host?: string }) => {
        const bridge = await startAttachBridge(options, dependencies);
        output(dependencies, formatBridgeSummary(bridge));
        await runBridgeUntilSignal(bridge);
      },
    );

  program
    .command("dev")
    .description("Run the configured development server and Bridge")
    .option("--listen <port>", "gateway port (10001 or above)", parsePort)
    .option("--host <host>", "gateway bind host (default: 0.0.0.0)")
    .action(async (options: { listen?: number; host?: string }) => {
      const bridge = await startManagedBridge(options, dependencies);
      output(dependencies, formatBridgeSummary(bridge));
      await runBridgeUntilSignal(bridge);
    });

  program
    .command("status")
    .description("Show the Bridge for the current Git worktree")
    .action(async () => {
      const status = await getBridgeStatus(dependencies);
      output(dependencies, formatBridgeStatus(status));
      if (!status.running) {
        setExitCode(dependencies, 1);
      }
    });

  program
    .command("doctor")
    .description("Check the current worktree and Visual Bridge configuration")
    .action(async () => {
      const checks = await runDoctor(dependencies);
      output(dependencies, formatDoctorChecks(checks));
      if (checks.some((check) => check.status === "fail")) {
        setExitCode(dependencies, 1);
      }
    });

  return program;
}

export async function main(
  argv: readonly string[] = process.argv,
  dependencies: CliDependencies = {},
): Promise<void> {
  await createCli(dependencies).parseAsync(argv);
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  pathToFileURL(resolve(entryPath)).href === import.meta.url
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unknown Visual Bridge error"}\n`,
    );
    process.exitCode = 1;
  });
}

export * from "./bridge.js";
export * from "./doctor.js";
export * from "./status.js";
