import { resolve } from "node:path";
import {
  ClaudeAdapter,
  CodexAdapter,
  type AgentAdapter,
} from "../agents/index.js";
import { loadVisualDevConfig } from "../config/index.js";
import type { VisualDevConfig } from "../config/schema.js";
import {
  GitTransactionManager,
  rebaseWorkspacePatterns,
} from "../git/index.js";
import { resolveStoragePaths, SqliteTaskStore } from "../storage/index.js";
import { isWorkingTaskStatus, TaskService } from "../tasks/index.js";
import type { BridgeControlContext } from "./control-context.js";
import type { ControlService } from "./control-service.js";
import { createTaskControlService } from "./task-control-service.js";
import { ComparisonBrowser } from "../comparison/browser.js";
import { EgoComparisonBrowser, findEgoBrowserExecutable } from "../comparison/ego-browser.js";
import { VerificationBrowserRouter, type VerificationBrowserDriver } from "../comparison/router.js";

function createAgentAdapter(agent: VisualDevConfig["agent"]): AgentAdapter {
  if (agent.adapter === "claude") {
    if (agent.reasoningEffort === "minimal") {
      throw new Error("Claude does not support minimal reasoning effort");
    }
    return new ClaudeAdapter({
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: agent.reasoningEffort }),
      ...(agent.permissionMode === undefined
        ? {}
        : { permissionMode: agent.permissionMode }),
    });
  }
  if (agent.adapter === "codex") {
    if (agent.reasoningEffort === "max") {
      throw new Error("Codex does not support max reasoning effort");
    }
    return new CodexAdapter({
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: agent.reasoningEffort }),
      ...(agent.profile === undefined ? {} : { profile: agent.profile }),
    });
  }
  throw new Error(`Agent adapter ${agent.adapter} is not implemented in this build`);
}

function inheritedAgentEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

/**
 * Builds the verification browser set: the Playwright profile is always
 * offered, ego lite whenever its CLI is present, and the configured preference
 * decides which one is used when a request does not choose explicitly.
 */
export async function createVerificationBrowserRouter(
  preference: VisualDevConfig["verification"]["browser"],
  options: { profileDirectory: string; upstreamUrl: string; taskSpaceName: string },
  environment: NodeJS.ProcessEnv = process.env,
): Promise<VerificationBrowserRouter> {
  const drivers: Partial<Record<"playwright" | "ego", VerificationBrowserDriver>> = {
    playwright: new ComparisonBrowser({
      profileDirectory: options.profileDirectory,
      upstreamUrl: options.upstreamUrl,
    }),
  };
  const egoExecutable = await findEgoBrowserExecutable(environment);
  if (egoExecutable) {
    drivers.ego = new EgoComparisonBrowser({
      upstreamUrl: options.upstreamUrl,
      executable: egoExecutable,
      environment,
      taskSpaceName: options.taskSpaceName,
    });
  } else if (preference === "ego") {
    throw new Error(
      "verification.browser is set to ego but the ego-browser command was not found. Install ego lite and finish onboarding, or set verification.browser to auto or playwright.",
    );
  }
  const defaultKind = preference === "auto" ? (egoExecutable ? "ego" : "playwright") : preference;
  return new VerificationBrowserRouter(drivers, defaultKind);
}

export async function createDefaultControlService(
  context: BridgeControlContext,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ControlService> {
  const loaded = await loadVisualDevConfig(context.repoRoot, {
    ...(context.configRoot === undefined ? {} : { configRoot: context.configRoot }),
  });
  const git = await GitTransactionManager.open(context.repoRoot, {
    allowed: rebaseWorkspacePatterns(
      context.repoRoot,
      context.workspaceRoot,
      loaded.config.paths.allowed,
    ),
    denied: rebaseWorkspacePatterns(
      context.repoRoot,
      context.workspaceRoot,
      loaded.config.paths.denied,
    ),
  });
  const storagePaths = await resolveStoragePaths(context.repoRoot, environment);
  const store = new SqliteTaskStore(storagePaths.databasePath);
  const egoExecutable = await findEgoBrowserExecutable(environment);
  const comparisonBrowser = await createVerificationBrowserRouter(
    loaded.config.verification.browser,
    {
      profileDirectory: resolve(storagePaths.logsDirectory, "..", "comparison-browser"),
      upstreamUrl: context.upstreamUrl,
      taskSpaceName: `Visual Remote · ${context.projectId}`,
    },
    environment,
  );
  const taskService = new TaskService({
    projectId: context.projectId,
    workspaceRoot: context.workspaceRoot,
    upstreamUrl: context.upstreamUrl,
    adapter: createAgentAdapter(loaded.config.agent),
    store,
    git,
    comparisonRoot: resolve(storagePaths.logsDirectory, "..", "comparisons"),
    comparisonBrowser,
    ...(egoExecutable ? { egoBrowserExecutable: egoExecutable } : {}),
    maxRunMs: loaded.config.agent.maxRunMs,
    maxPending: loaded.config.queue.maxPending,
    resumeMode: loaded.config.agent.resumeMode,
    environment: inheritedAgentEnvironment(
      loaded.config.agent.inheritEnv,
      environment,
    ),
  });

  const controlService = createTaskControlService({
    taskService,
    openComparisonBrowser: (browserContext) => comparisonBrowser.open(browserContext),
    hmrWaitMs: loaded.config.verification.hmrWaitMs,
    verificationCommands: loaded.config.verification.commands,
    project: {
      id: context.projectId,
      repoRoot: context.repoRoot,
      workspaceRoot: context.workspaceRoot,
      mode: context.mode,
      upstreamUrl: context.upstreamUrl,
      verification: comparisonBrowser.info(),
    },
  });
  const reportRuntimeState = (): void => {
    const activeTask = taskService
      .list()
      .find((task) => isWorkingTaskStatus(task.status));
    context.onRuntimeState?.({
      status: activeTask === undefined ? "idle" : "working",
      ...(activeTask === undefined ? {} : { activeTaskId: activeTask.id }),
    });
  };
  const unsubscribeRuntime = taskService.subscribe(reportRuntimeState);
  reportRuntimeState();

  return {
    ...controlService,
    close: async () => {
      unsubscribeRuntime();
      try {
        await controlService.close?.();
      } finally {
        await comparisonBrowser.close();
      }
    },
  };
}
