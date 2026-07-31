import type {
  ContextBundle,
  SourceLocation,
  TargetContext,
} from "@visual-remote/protocol";
import {
  normalizeSourceLocation,
  type NormalizedSourceLocation,
} from "../source/path-normalizer.js";

function toSourceLocation(result: NormalizedSourceLocation): SourceLocation | undefined {
  if (result.filePath === undefined) {
    return undefined;
  }

  return {
    filePath: result.filePath,
    ...(result.lineNumber === undefined ? {} : { lineNumber: result.lineNumber }),
    ...(result.columnNumber === undefined ? {} : { columnNumber: result.columnNumber }),
    ...(result.componentName === undefined ? {} : { componentName: result.componentName }),
  };
}

async function resolveTarget(
  target: TargetContext,
  repoRoot: string,
): Promise<TargetContext> {
  const primaryResult =
    target.source.primary === undefined
      ? undefined
      : await normalizeSourceLocation(target.source.primary, repoRoot);
  const stackResults = await Promise.all(
    target.source.stack.map((location) => normalizeSourceLocation(location, repoRoot)),
  );
  const stack = stackResults
    .map(toSourceLocation)
    .filter((location): location is SourceLocation => location !== undefined);
  const primary = primaryResult === undefined ? undefined : toSourceLocation(primaryResult);

  const confidence = primaryResult?.confidence
    ?? stackResults.find((result) => result.confidence !== "unknown")?.confidence
    ?? "unknown";

  return {
    ...target,
    source: {
      ...(primary === undefined ? {} : { primary }),
      stack,
      confidence,
    },
  };
}

export async function resolveContextSources(
  bundle: ContextBundle,
  repoRoot: string,
): Promise<ContextBundle> {
  const targets = await Promise.all(
    bundle.selection.targets.map((target) => resolveTarget(target, repoRoot)),
  );

  return {
    ...bundle,
    selection: {
      ...bundle.selection,
      targets,
    } as ContextBundle["selection"],
  };
}
