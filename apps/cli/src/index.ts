import { realpathSync } from "node:fs";
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
import { formatInitResult, initializeVisualDev } from "./init.js";
import { formatBridgeStatus, getBridgeStatus } from "./status.js";
import { VISUAL_REMOTE_VERSION } from "./version.js";
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
    .version(VISUAL_REMOTE_VERSION);

  program
    .command("init")
    .description("Configure Visual Remote for the current Vite or Next.js project")
    .action(async () => {
      const result = await initializeVisualDev(dependencies);
      output(dependencies, formatInitResult(result));
    });

  program
    .command("attach [upstream]", { isDefault: true })
    .description("Attach the Bridge to an existing development server")
    .option("--upstream <url>", "existing development server URL")
    .option("--listen <port>", "gateway port (10001 or above)", parsePort)
    .option("--host <host>", "gateway bind host (default: 127.0.0.1; non-loopback enables pairing)")
    .option("--public-url <url>", "public Gateway URL opened in the browser")
    .action(
      async (
        upstream: string | undefined,
        options: {
          upstream?: string;
          listen?: number;
          host?: string;
          publicUrl?: string;
        },
      ) => {
        const upstreamUrl = options.upstream ?? upstream;
        if (upstreamUrl === undefined) {
          throw new Error(
            "Provide the running app URL, for example: npx visual-remote http://localhost:9011",
          );
        }
        const bridge = await startAttachBridge(
          {
            upstream: upstreamUrl,
            ...(options.listen === undefined ? {} : { listen: options.listen }),
            ...(options.host === undefined ? {} : { host: options.host }),
            ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
          },
          dependencies,
        );
        output(dependencies, formatBridgeSummary(bridge));
        await runBridgeUntilSignal(bridge);
      },
    );

  program
    .command("dev")
    .description("Run the configured development server and Bridge")
    .option("--listen <port>", "gateway port (10001 or above)", parsePort)
    .option("--host <host>", "gateway bind host (default: 127.0.0.1; non-loopback enables pairing)")
    .option("--public-url <url>", "public Gateway URL opened in the browser")
    .action(async (options: { listen?: number; host?: string; publicUrl?: string }) => {
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

function isDirectEntry(entryPath: string): boolean {
  try {
    return pathToFileURL(realpathSync(resolve(entryPath))).href === import.meta.url;
  } catch {
    return false;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && isDirectEntry(entryPath)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unknown Visual Bridge error"}\n`,
    );
    process.exitCode = 1;
  });
}

export * from "./bridge.js";
export * from "./doctor.js";
export * from "./init.js";
export * from "./status.js";
export * from "./version.js";
