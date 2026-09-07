import { spawn } from "node:child_process";
import { readFile, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  CONFIG_PATH,
  discoverGitWorktreeRoot,
} from "@visual-remote/bridge-core";
import { stringify as stringifyYaml } from "yaml";

type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

interface PackageManifest {
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

export interface PackageInstallRequest {
  cwd: string;
  packageManager: PackageManager;
  packageSpec: string;
}

export interface InitDependencies {
  cwd?: string;
  installPackage?: (request: PackageInstallRequest) => Promise<void>;
}

export interface InitResult {
  framework: "vite" | "next";
  created: boolean;
  configPath: string;
  devScript: string;
  packageManager: PackageManager;
  integrationPath: string;
  integrationChanged: boolean;
  clientPath?: string;
  clientChanged?: boolean;
  packageInstalled: boolean;
}

const VITE_CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
] as const;
const VITE_IMPORT = 'import { visualRemote } from "visual-remote/vite";';
const NEXT_CONFIG_FILES = [
  "next.config.ts",
  "next.config.mjs",
  "next.config.js",
] as const;
const NEXT_ESM_IMPORT = 'import { withVisualRemote } from "visual-remote/next";';
const NEXT_CJS_IMPORT = 'const { withVisualRemote } = require("visual-remote/next");';
const NEXT_CLIENT_MODULE = "visual-remote/next/client";
const NEXT_CLIENT_BOOTSTRAP = [
  'if (process.env.NODE_ENV === "development") {',
  `  void import("${NEXT_CLIENT_MODULE}");`,
  "}",
  "",
].join("\n");

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function packageManagerFromField(value: unknown): PackageManager | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.split("@", 1)[0];
  return name === "bun" || name === "npm" || name === "pnpm" || name === "yarn"
    ? name
    : undefined;
}

async function detectPackageManager(
  projectRoot: string,
  repoRoot: string,
  manifest: PackageManifest,
): Promise<PackageManager> {
  const declared = packageManagerFromField(manifest.packageManager);
  if (declared !== undefined) return declared;

  const lockfiles: readonly [PackageManager, string][] = [
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
    ["npm", "package-lock.json"],
  ];
  for (const root of projectRoot === repoRoot ? [projectRoot] : [projectRoot, repoRoot]) {
    for (const [manager, filename] of lockfiles) {
      if (await fileExists(join(root, filename))) return manager;
    }
  }
  return "npm";
}

function readDevScript(manifest: PackageManifest): string {
  if (
    typeof manifest.scripts !== "object" ||
    manifest.scripts === null ||
    !("dev" in manifest.scripts) ||
    typeof manifest.scripts.dev !== "string" ||
    manifest.scripts.dev.trim().length === 0
  ) {
    throw new Error('visual init requires a non-empty "dev" script in package.json');
  }
  return manifest.scripts.dev.trim();
}

function packageRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isViteProject(manifest: PackageManifest, devScript: string): boolean {
  const packages = {
    ...packageRecord(manifest.dependencies),
    ...packageRecord(manifest.devDependencies),
  };
  return "vite" in packages || /(^|[\s;&|])vite(?:\s|$)/.test(devScript);
}

function isNextProject(manifest: PackageManifest, devScript: string): boolean {
  const packages = {
    ...packageRecord(manifest.dependencies),
    ...packageRecord(manifest.devDependencies),
  };
  return "next" in packages || /(^|[\s;&|])next(?:\s|$)/.test(devScript);
}

function hasVisualRemote(manifest: PackageManifest): boolean {
  return (
    "visual-remote" in packageRecord(manifest.dependencies) ||
    "visual-remote" in packageRecord(manifest.devDependencies)
  );
}

function devCommand(manager: PackageManager, script: string): string[] {
  const command =
    manager === "pnpm"
      ? ["corepack", "pnpm", "run", "dev"]
      : manager === "yarn"
        ? ["corepack", "yarn", "run", "dev"]
        : manager === "bun"
          ? ["bun", "run", "dev"]
          : ["npm", "run", "dev"];
  const next = /(^|[\s;&|])next(?:\s|$)/.test(script);
  return [
    ...command,
    "--",
    next ? "--hostname" : "--host",
    "0.0.0.0",
    "--port",
    "{upstreamPort}",
  ];
}

async function readManifest(projectRoot: string): Promise<PackageManifest> {
  const manifestPath = join(projectRoot, "package.json");
  let source: string;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error("visual init requires package.json in the current directory");
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse ${manifestPath}`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  return value as PackageManifest;
}

async function findViteConfig(projectRoot: string): Promise<string> {
  for (const filename of VITE_CONFIG_FILES) {
    const candidate = join(projectRoot, filename);
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(
    "visual init found Vite but could not find vite.config.ts, .mts, .js, or .mjs",
  );
}

async function findNextConfig(projectRoot: string): Promise<string> {
  for (const filename of NEXT_CONFIG_FILES) {
    const candidate = join(projectRoot, filename);
    if (await fileExists(candidate)) return candidate;
  }
  return join(projectRoot, "next.config.mjs");
}

function insertViteImport(source: string): string {
  const lines = source.split("\n");
  let index = 0;
  while (lines[index]?.startsWith("///")) index += 1;
  lines.splice(index, 0, VITE_IMPORT);
  return lines.join("\n");
}

export function transformViteConfig(source: string): string {
  if (source.includes("visual-remote/vite") && /\bvisualRemote\s*\(/.test(source)) {
    return source;
  }

  let transformed = source.includes("visual-remote/vite")
    ? source
    : insertViteImport(source);
  const pluginsPattern = /(\bplugins\s*:\s*\[)/;
  if (pluginsPattern.test(transformed)) {
    return transformed.replace(
      pluginsPattern,
      (match: string, _prefix: string, offset: number, fullSource: string) =>
        `${match}visualRemote(),${
          fullSource[offset + match.length] === "\n" ? "" : " "
        }`,
    );
  }

  const objectConfigPattern = /(defineConfig\s*\(\s*\{)/;
  if (objectConfigPattern.test(transformed)) {
    return transformed.replace(
      objectConfigPattern,
      "$1\n  plugins: [visualRemote()],",
    );
  }

  throw new Error(
    "visual init could not add visualRemote() to the Vite plugins array",
  );
}

async function configureVite(configPath: string): Promise<boolean> {
  const source = await readFile(configPath, "utf8");
  const transformed = transformViteConfig(source);
  if (transformed === source) return false;
  await writeFile(configPath, transformed, "utf8");
  return true;
}

function expressionEnd(source: string, expressionStart: number): number {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = expressionStart; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") roundDepth += 1;
    if (character === ")") roundDepth -= 1;
    if (character === "[") squareDepth += 1;
    if (character === "]") squareDepth -= 1;
    if (character === "{") curlyDepth += 1;
    if (character === "}") curlyDepth -= 1;
    if (
      character === ";"
      && roundDepth === 0
      && squareDepth === 0
      && curlyDepth === 0
    ) {
      return index;
    }
  }
  return source.length;
}

function wrapConfigExpression(source: string, assignmentPattern: RegExp): string {
  const assignment = assignmentPattern.exec(source);
  if (assignment?.index === undefined) {
    throw new Error("visual init could not find the default Next.js config export");
  }
  let start = assignment.index + assignment[0].length;
  while (/\s/.test(source[start] ?? "")) start += 1;
  const end = expressionEnd(source, start);
  const rawExpression = source.slice(start, end);
  const trailingWhitespace = rawExpression.match(/\s*$/)?.[0] ?? "";
  const expression = rawExpression.slice(0, rawExpression.length - trailingWhitespace.length);
  if (expression.length === 0) {
    throw new Error("visual init found an empty Next.js config export");
  }
  return `${source.slice(0, start)}withVisualRemote(${expression})${trailingWhitespace}${source.slice(end)}`;
}

export function transformNextConfig(source: string): string {
  if (source.includes("visual-remote/next") && /\bwithVisualRemote\s*\(/.test(source)) {
    return source;
  }

  if (/\bmodule\.exports\s*=/.test(source)) {
    const wrapped = wrapConfigExpression(source, /\bmodule\.exports\s*=/);
    return wrapped.includes(NEXT_CJS_IMPORT)
      ? wrapped
      : `${NEXT_CJS_IMPORT}\n${wrapped}`;
  }

  const wrapped = wrapConfigExpression(source, /\bexport\s+default\b/);
  return wrapped.includes(NEXT_ESM_IMPORT)
    ? wrapped
    : `${NEXT_ESM_IMPORT}\n${wrapped}`;
}

async function configureNext(configPath: string): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    source = "export default {};\n";
  }
  const transformed = transformNextConfig(source);
  if (transformed === source) return false;
  await writeFile(configPath, transformed, "utf8");
  return true;
}

async function findNextClientPath(projectRoot: string): Promise<string> {
  const candidates = [
    join(projectRoot, "instrumentation-client.ts"),
    join(projectRoot, "instrumentation-client.js"),
    join(projectRoot, "src", "instrumentation-client.ts"),
    join(projectRoot, "src", "instrumentation-client.js"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  const sourceRoot = (await fileExists(join(projectRoot, "src")))
    ? join(projectRoot, "src")
    : projectRoot;
  const extension = (await fileExists(join(projectRoot, "tsconfig.json")))
    ? "ts"
    : "js";
  return join(sourceRoot, `instrumentation-client.${extension}`);
}

async function configureNextClient(clientPath: string): Promise<boolean> {
  let source = "";
  try {
    source = await readFile(clientPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (source.includes(NEXT_CLIENT_MODULE)) return false;
  const separator = source.length === 0 || source.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(clientPath), { recursive: true });
  await writeFile(clientPath, `${source}${separator}${NEXT_CLIENT_BOOTSTRAP}`, "utf8");
  return true;
}

function installCommand(
  request: PackageInstallRequest,
): { command: string; args: string[] } {
  if (request.packageManager === "pnpm") {
    return {
      command: "corepack",
      args: ["pnpm", "add", "--save-dev", request.packageSpec],
    };
  }
  if (request.packageManager === "yarn") {
    return {
      command: "corepack",
      args: ["yarn", "add", "--dev", request.packageSpec],
    };
  }
  if (request.packageManager === "bun") {
    return { command: "bun", args: ["add", "--dev", request.packageSpec] };
  }
  return {
    command: "npm",
    args: ["install", "--save-dev", request.packageSpec],
  };
}

async function installPackage(request: PackageInstallRequest): Promise<void> {
  const { command, args } = installCommand(request);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: request.cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed${
            signal === null ? ` with exit code ${code ?? "unknown"}` : ` with ${signal}`
          }`,
        ),
      );
    });
  });
}

export async function initializeVisualDev(
  dependencies: InitDependencies = {},
): Promise<InitResult> {
  const projectRoot = await realpath(dependencies.cwd ?? process.cwd());
  const repoRoot = await discoverGitWorktreeRoot(projectRoot);
  const manifest = await readManifest(projectRoot);
  const devScript = readDevScript(manifest);
  const framework = isViteProject(manifest, devScript)
    ? "vite"
    : isNextProject(manifest, devScript)
      ? "next"
      : undefined;
  if (framework === undefined) {
    throw new Error("visual init currently supports Vite and Next.js projects");
  }

  const packageManager = await detectPackageManager(projectRoot, repoRoot, manifest);
  const integrationPath = framework === "vite"
    ? await findViteConfig(projectRoot)
    : await findNextConfig(projectRoot);
  const packageInstalled = !hasVisualRemote(manifest);
  if (packageInstalled) {
    await (dependencies.installPackage ?? installPackage)({
      cwd: projectRoot,
      packageManager,
      packageSpec: "visual-remote@latest",
    });
  }
  const integrationChanged = framework === "vite"
    ? await configureVite(integrationPath)
    : await configureNext(integrationPath);
  const clientPath = framework === "next"
    ? await findNextClientPath(projectRoot)
    : undefined;
  const clientChanged = clientPath === undefined
    ? undefined
    : await configureNextClient(clientPath);

  const configPath = join(projectRoot, CONFIG_PATH);
  const created = !(await fileExists(configPath));
  if (created) {
    const document = {
      version: 1,
      project: {
        id: basename(projectRoot),
        workspace: ".",
      },
      gateway: {
        host: "127.0.0.1",
        port: "auto",
      },
      upstream: {
        port: "auto",
        command: devCommand(packageManager, devScript),
      },
    };
    await mkdir(dirname(configPath), { recursive: true });
    try {
      await writeFile(configPath, stringifyYaml(document), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (!isMissingFile(error) && (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )) {
        throw error;
      }
    }
  }

  return {
    framework,
    created,
    configPath,
    devScript,
    packageManager,
    integrationPath,
    integrationChanged,
    ...(clientPath === undefined || clientChanged === undefined
      ? {}
      : { clientPath, clientChanged }),
    packageInstalled,
  };
}

export function formatInitResult(result: InitResult): string {
  const configLabel = result.created ? "Created" : "Existing";
  const integrationLabel = result.integrationChanged ? "Configured" : "Existing";
  const rows = [
    `Framework: ${result.framework === "next" ? "Next.js" : "Vite"}`,
    `${configLabel}:   ${relative(process.cwd(), result.configPath) || CONFIG_PATH}`,
    `${integrationLabel}: ${relative(process.cwd(), result.integrationPath)}`,
  ];
  if (result.clientPath !== undefined) {
    rows.push(
      `${result.clientChanged ? "Configured" : "Existing"}: ${relative(process.cwd(), result.clientPath)}`,
    );
  }
  rows.push(
    result.packageInstalled
      ? "Installed: visual-remote@latest"
      : "Installed: visual-remote",
    "Next:      Start the app normally and open its original URL.",
  );
  return rows.join("\n");
}
