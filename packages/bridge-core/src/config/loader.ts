import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import {
  createDefaultConfig,
  type VisualDevConfig,
  visualDevConfigSchema,
} from "./schema.js";

export const CONFIG_PATH = ".visualdev/config.yaml";
export const LOCAL_CONFIG_PATH = ".visualdev/config.local.yaml";

export class VisualDevConfigError extends Error {
  readonly filePath?: string;

  constructor(message: string, options: { cause?: unknown; filePath?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VisualDevConfigError";
    if (options.filePath !== undefined) {
      this.filePath = options.filePath;
    }
  }
}

export interface LoadedVisualDevConfig {
  config: VisualDevConfig;
  repoRoot: string;
  configRoot: string;
  workspaceRoot: string;
  configPath: string;
  localConfigPath: string;
  loadedFiles: string[];
}

export interface LoadVisualDevConfigOptions {
  requireConfig?: boolean;
  configRoot?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merges mappings. Arrays and scalar values replace the base value.
 * This keeps local overrides predictable and avoids accidentally duplicating argv.
 */
export function mergeConfigValues(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] =
      key in merged && isPlainObject(merged[key]) && isPlainObject(value)
        ? mergeConfigValues(merged[key], value)
        : value;
  }
  return merged;
}

async function readYamlMapping(
  filePath: string,
  required: boolean,
): Promise<Record<string, unknown> | undefined> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (
      !required &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw new VisualDevConfigError(`Unable to read config: ${filePath}`, {
      cause: error,
      filePath,
    });
  }

  try {
    const value: unknown = parseYaml(source);
    if (value === null || value === undefined) {
      return {};
    }
    if (!isPlainObject(value)) {
      throw new Error("The YAML document must contain a mapping at its root");
    }
    return value;
  } catch (error) {
    throw new VisualDevConfigError(`Invalid YAML in ${filePath}`, {
      cause: error,
      filePath,
    });
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

async function configExists(root: string): Promise<boolean> {
  try {
    await stat(join(root, CONFIG_PATH));
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export async function discoverVisualDevConfigRoot(
  startDirectory: string,
  repositoryRoot: string,
): Promise<string> {
  const repoRoot = await realpath(repositoryRoot);
  let cursor = await realpath(startDirectory);
  if (!isWithinRoot(repoRoot, cursor)) {
    throw new VisualDevConfigError(`Project directory is outside Git worktree: ${cursor}`);
  }

  while (true) {
    if (await configExists(cursor)) return cursor;
    if (cursor === repoRoot) return repoRoot;
    const parent = dirname(cursor);
    if (parent === cursor || !isWithinRoot(repoRoot, parent)) return repoRoot;
    cursor = parent;
  }
}

export async function loadVisualDevConfig(
  repositoryRoot: string,
  options: LoadVisualDevConfigOptions = {},
): Promise<LoadedVisualDevConfig> {
  const repoRoot = await realpath(repositoryRoot);
  const configRoot = await realpath(options.configRoot ?? repoRoot);
  if (!isWithinRoot(repoRoot, configRoot)) {
    throw new VisualDevConfigError(
      `Config directory is outside Git worktree: ${configRoot}`,
    );
  }
  const configPath = join(configRoot, CONFIG_PATH);
  const localConfigPath = join(configRoot, LOCAL_CONFIG_PATH);
  const projectId = basename(configRoot);

  const baseDocument = await readYamlMapping(configPath, options.requireConfig ?? false);
  const localDocument = await readYamlMapping(localConfigPath, false);
  const loadedFiles: string[] = [];
  if (baseDocument !== undefined) {
    loadedFiles.push(configPath);
  }
  if (localDocument !== undefined) {
    loadedFiles.push(localConfigPath);
  }

  let candidate: unknown = createDefaultConfig(projectId);
  if (baseDocument !== undefined) {
    candidate = mergeConfigValues(candidate, baseDocument);
  }
  if (localDocument !== undefined) {
    candidate = mergeConfigValues(candidate, localDocument);
  }

  let config: VisualDevConfig;
  try {
    config = visualDevConfigSchema.parse(candidate);
  } catch (error) {
    const details =
      error instanceof ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ")
        : String(error);
    throw new VisualDevConfigError(`Invalid visual dev config: ${details}`, {
      cause: error,
      filePath: localDocument === undefined ? configPath : localConfigPath,
    });
  }

  const unresolvedWorkspace = isAbsolute(config.project.workspace)
    ? config.project.workspace
    : resolve(configRoot, config.project.workspace);

  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(unresolvedWorkspace);
  } catch (error) {
    throw new VisualDevConfigError(
      `Configured project workspace does not exist: ${config.project.workspace}`,
      { cause: error, filePath: configPath },
    );
  }

  if (!isWithinRoot(repoRoot, workspaceRoot)) {
    throw new VisualDevConfigError(
      `Configured project workspace escapes the Git worktree: ${config.project.workspace}`,
      { filePath: configPath },
    );
  }

  return {
    config,
    repoRoot,
    configRoot,
    workspaceRoot,
    configPath,
    localConfigPath,
    loadedFiles,
  };
}

export async function loadConfig(
  repositoryRoot: string,
  options?: LoadVisualDevConfigOptions,
): Promise<VisualDevConfig> {
  return (await loadVisualDevConfig(repositoryRoot, options)).config;
}
