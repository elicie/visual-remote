import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import type { SourceLocation } from "@visual-remote/protocol";

export interface NormalizedSourceLocation {
  input: SourceLocation;
  filePath?: string;
  absolutePath?: string;
  lineNumber?: number;
  columnNumber?: number;
  componentName?: string;
  confidence: "exact" | "probable" | "ambiguous" | "unknown";
  candidates: string[];
}

function toPosix(value: string): string {
  return value.split(sep).join("/").replaceAll("\\", "/");
}

function stripVirtualPrefix(input: string): string {
  let value = input.trim();

  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original string when a bundler emitted malformed escaping.
  }

  value = value.split(/[?#]/u, 1)[0] ?? value;
  value = value.replace(/^file:\/\//u, "");
  value = value.replace(/^(?:webpack|vite):\/\//u, "");
  value = value.replace(/^\/?_N_E\/(?:\.\/)?/u, "");
  value = value.replace(/^\/?@fs\//u, "/");

  const explicitRelative = value.lastIndexOf("/./");
  if (explicitRelative >= 0) {
    value = value.slice(explicitRelative + 3);
  }

  return value.replace(/^\.\/+/u, "").replaceAll("\\", "/");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function gitFiles(repoRoot: string): Promise<string[]> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    const error: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => error.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(error).toString("utf8").trim() || "git ls-files failed"));
        return;
      }
      resolvePromise(
        Buffer.concat(output)
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .map(toPosix),
      );
    });
  });
}

async function boundedLine(
  absolutePath: string,
  requestedLine: number | undefined,
): Promise<number | undefined> {
  if (requestedLine === undefined) {
    return undefined;
  }

  const content = await readFile(absolutePath, "utf8");
  const count = content === "" ? 1 : content.split(/\r?\n/u).length;
  return requestedLine <= count ? requestedLine : undefined;
}

export async function normalizeSourceLocation(
  input: SourceLocation,
  repoRootInput: string,
): Promise<NormalizedSourceLocation> {
  const repoRoot = await realpath(repoRootInput);
  const stripped = stripVirtualPrefix(input.filePath);
  const direct = isAbsolute(stripped) ? resolve(stripped) : resolve(repoRoot, stripped);

  if (isWithin(repoRoot, direct) && (await exists(direct))) {
    const canonical = await realpath(direct);
    if (isWithin(repoRoot, canonical)) {
      const lineNumber = await boundedLine(canonical, input.lineNumber);
      return {
        input,
        filePath: toPosix(relative(repoRoot, canonical)),
        absolutePath: canonical,
        ...(lineNumber === undefined ? {} : { lineNumber }),
        ...(input.columnNumber === undefined ? {} : { columnNumber: input.columnNumber }),
        ...(input.componentName === undefined ? {} : { componentName: input.componentName }),
        confidence: "exact",
        candidates: [],
      };
    }
  }

  let files: string[];
  try {
    files = await gitFiles(repoRoot);
  } catch {
    return { input, confidence: "unknown", candidates: [] };
  }

  const normalizedNeedle = stripped.replace(/^\/+/u, "");
  const segments = normalizedNeedle.split("/").filter(Boolean);
  const suffixes = segments.map((_, index) => segments.slice(index).join("/"));
  const bestSuffix = suffixes.find((suffix) => files.some((file) => file.endsWith(suffix)));
  const matches = bestSuffix === undefined
    ? []
    : files.filter((file) => file === bestSuffix || file.endsWith(`/${bestSuffix}`));

  if (matches.length !== 1) {
    return {
      input,
      confidence: matches.length > 1 ? "ambiguous" : "unknown",
      candidates: matches.slice(0, 20),
    };
  }

  const filePath = matches[0]!;
  const absolutePath = resolve(repoRoot, filePath);
  const canonical = await realpath(absolutePath);
  if (!isWithin(repoRoot, canonical)) {
    return { input, confidence: "unknown", candidates: [] };
  }

  const lineNumber = await boundedLine(canonical, input.lineNumber);
  return {
    input,
    filePath,
    absolutePath: canonical,
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(input.columnNumber === undefined ? {} : { columnNumber: input.columnNumber }),
    ...(input.componentName === undefined ? {} : { componentName: input.componentName }),
    confidence: "probable",
    candidates: [],
  };
}
