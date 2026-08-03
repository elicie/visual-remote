import { CodexAdapter } from "../agents/index.js";
import { loadVisualDevConfig } from "../config/index.js";
import {
  GitTransactionManager,
  rebaseWorkspacePatterns,
} from "../git/index.js";
import { resolveStoragePaths, SqliteTaskStore } from "../storage/index.js";
import { isWorkingTaskStatus, TaskService } from "../tasks/index.js";
import type { BridgeControlContext } from "./control-context.js";
import type { ControlService } from "./control-service.js";
import { createTaskControlService } from "./task-control-service.js";

export async function createDefaultControlService(
  context: BridgeControlContext,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ControlService> {
  const loaded = await loadVisualDevConfig(context.repoRoot, {
    ...(context.configRoot === undefined ? {} : { configRoot: context.configRoot }),
  });
  if (loaded.config.agent.adapter !== "codex") {
    throw new Error(
      `Agent adapter ${loaded.config.agent.adapter} is not implemented in this MVP build`,
    );
  }

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
  const taskService = new TaskService({
    projectId: context.projectId,
    workspaceRoot: context.workspaceRoot,
    upstreamUrl: context.upstreamUrl,
    adapter: new CodexAdapter(),
    store,
    git,
    maxRunMs: loaded.config.agent.maxRunMs,
    maxPending: loaded.config.queue.maxPending,
    resumeMode: loaded.config.agent.resumeMode,
    environment: {},
  });

  const controlService = createTaskControlService({
    taskService,
    hmrWaitMs: loaded.config.verification.hmrWaitMs,
    verificationCommands: loaded.config.verification.commands,
    project: {
      id: context.projectId,
      repoRoot: context.repoRoot,
      workspaceRoot: context.workspaceRoot,
      mode: context.mode,
      upstreamUrl: context.upstreamUrl,
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
      await controlService.close?.();
    },
  };
}
