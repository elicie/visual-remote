import type {
  ContextBundle,
  SourceLocation,
  TargetContext,
} from "@visual-remote/protocol";

export interface AgentPromptOptions {
  repoRoot: string;
  workspaceRoot: string;
  upstreamUrl?: string;
  contextBundlePath: string;
  context: ContextBundle;
  parent?: {
    taskId: string;
    requestText: string;
    diffSummary: string;
  };
  allowedPatterns: readonly string[];
  deniedPatterns: readonly string[];
}

function sourceLabel(source: SourceLocation): string {
  const position = source.lineNumber
    ? `:${source.lineNumber}${source.columnNumber ? `:${source.columnNumber}` : ""}`
    : "";
  const component = source.componentName ? ` (${source.componentName})` : "";
  return `${source.filePath}${position}${component}`;
}

function targetSummary(target: TargetContext): string {
  const dom = target.dom;
  const identity = [
    dom.tagName.toLowerCase(),
    dom.id ? `#${dom.id}` : "",
    ...dom.classNames.slice(0, 6).map((name) => `.${name}`),
  ].join("");
  const text = dom.accessibleName ?? dom.text ?? "";
  const sources = [
    ...(target.source.primary ? [target.source.primary] : []),
    ...target.source.stack,
  ];
  return [
    `- target ${target.order + 1}: ${identity}`,
    text ? `  label/text: ${JSON.stringify(text.slice(0, 240))}` : "",
    sources.length > 0
      ? `  source candidates: ${[...new Set(sources.map(sourceLabel))].join(", ")}`
      : "  source candidates: unavailable; search the repository from DOM context",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildAgentPrompt(options: AgentPromptOptions): string {
  const targets = options.context.selection.targets.map(targetSummary).join("\n");
  const parent = options.parent
    ? `
Follow-up context:
- Parent task: ${options.parent.taskId}
- Previous request: ${options.parent.requestText}
- Previous diff summary: ${options.parent.diffSummary || "No file changes"}
`
    : "";
  return `Target service context (authoritative):
- Repository worktree: ${options.repoRoot}
- Workspace: ${options.workspaceRoot}
- Browser URL: ${options.context.page.url}
${options.upstreamUrl ? `- Local upstream URL: ${options.upstreamUrl}\n` : ""}
Treat the workspace above as the already-resolved service directory and the repository worktree as its safety boundary. Run project commands from the workspace; do not search parent directories or run directory-discovery commands to locate the project again.

User request:
${options.context.request.text}

Selected UI context:
- Route: ${options.context.page.pathname}
- Selection mode: ${options.context.selection.mode}
${targets || "- No concrete target; use the page context and repository search."}

Scope requested by user:
${options.context.request.scope}
${parent}
The complete sanitized context bundle is available at:
${options.contextBundlePath}

Runtime capabilities:
- Repository inspection, file editing, and short-lived repository checks are available.
- Browser, MCP, and external-reference access depend on the selected CLI's configured tools and permissions; use only tools actually available in this run.
- When a browser session is connected, the Bridge performs its configured HMR and browser checks after editing.

Rules:
- Inspect the relevant source before editing.
- Preserve unrelated existing changes.
- Do not edit outside the repository root.
- Only modify paths matching these allowed patterns: ${options.allowedPatterns.join(", ")}.
- Do not access or modify denied paths: ${options.deniedPatterns.join(", ")}.
- Do not run git commit, push, reset, clean, checkout, stash, or rebase.
- Keep the change focused on the request.
- Do not start another long-running development server solely for visual verification.
- Run only useful checks for the files changed.
- Before claiming a match to an external design reference (including Figma), actually access and inspect it with an available tool and report the evidence used. A URL in the request is not access evidence.
- If the reference cannot be accessed, explicitly disclose that limitation and do not claim design verification. Repository documentation may guide implementation but is not evidence of a verified match to the external reference.
- When finished, summarize changed files and any unresolved uncertainty.
`;
}
