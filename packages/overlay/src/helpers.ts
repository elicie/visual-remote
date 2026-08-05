/** Browser-only geometry and input helpers. */
import type { SourceLocation, TargetContext } from "@visual-remote/protocol";

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PopoverPosition {
  left: number;
  top: number;
  placement: "above" | "below" | "left" | "right";
}

export interface PairingFragment {
  token: string | null;
  remainingHash: string;
}

export interface TargetSourceDisplay {
  componentName?: string;
  location: string;
}

export interface TargetDisplayContext {
  elementLabel: string;
  componentPath?: string;
  primarySource?: string;
  sourceCandidates: TargetSourceDisplay[];
  copyText: string;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function escapeMarkup(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sourceLocation(source: SourceLocation, short = false): string {
  const filePath = short
    ? source.filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? source.filePath
    : source.filePath;
  const line = source.lineNumber ? `:${source.lineNumber}` : "";
  const column = source.columnNumber ? `:${source.columnNumber}` : "";
  return `${filePath}${line}${column}`;
}

function sourceCandidates(target: TargetContext): SourceLocation[] {
  const candidates = [
    ...(target.source.primary ? [target.source.primary] : []),
    ...target.source.stack,
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = [
      candidate.filePath,
      candidate.lineNumber ?? 0,
      candidate.columnNumber ?? 0,
      candidate.componentName ?? "",
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function elementSnippet(target: TargetContext): string {
  const { dom } = target;
  const attributes: string[] = [];
  const type = dom.attributes.type;
  if (type) attributes.push(`type="${escapeMarkup(type)}"`);
  if (dom.id) attributes.push(`id="${escapeMarkup(dom.id)}"`);
  if (dom.classNames.length > 0) {
    attributes.push(
      `class="${escapeMarkup(compactText(dom.classNames.join(" "), 120))}"`,
    );
  }
  for (const [name, value] of Object.entries(dom.attributes).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      name === "type"
      || name.startsWith("data-source")
      || name === "data-react-source"
      || name === "data-component"
      || name === "data-component-name"
    ) {
      continue;
    }
    attributes.push(`${name}="${escapeMarkup(value)}"`);
  }

  const tagName = dom.tagName.toLowerCase();
  const opening = `<${tagName}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`;
  if (VOID_ELEMENTS.has(tagName)) return opening;
  const text = compactText(dom.text ?? dom.accessibleName ?? "", 120);
  return `${opening}${escapeMarkup(text)}</${tagName}>`;
}

export function describeTarget(target: TargetContext): TargetDisplayContext {
  const candidates = sourceCandidates(target);
  const closestComponents = candidates
    .map((candidate) => candidate.componentName)
    .filter((name): name is string => Boolean(name))
    .filter((name, index, all) => all.indexOf(name) === index);
  const primary = target.source.primary ?? candidates[0];
  const label = compactText(
    target.dom.accessibleName ?? target.dom.text ?? "",
    80,
  );
  const elementLabel = `<${target.dom.tagName.toLowerCase()}>${label ? ` ${label}` : ""}`;
  const displayCandidates = candidates.map((candidate) => ({
    ...(candidate.componentName ? { componentName: candidate.componentName } : {}),
    location: sourceLocation(candidate),
  }));
  let copyText = elementSnippet(target);
  for (const candidate of displayCandidates) {
    copyText += candidate.componentName
      ? ` in ${candidate.componentName} (at ${candidate.location})`
      : ` at ${candidate.location}`;
  }

  return {
    elementLabel,
    ...(closestComponents.length > 0
      ? { componentPath: [...closestComponents].reverse().join(" › ") }
      : {}),
    ...(primary ? { primarySource: sourceLocation(primary, true) } : {}),
    sourceCandidates: displayCandidates,
    copyText: `[${copyText}]`,
  };
}

export function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) {
    return minimum;
  }

  return Math.min(Math.max(value, minimum), maximum);
}

export function normalizeRect(start: Point, end: Point): Box {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);

  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function intersectionArea(first: Box, second: Box): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) -
      Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) -
      Math.max(first.y, second.y),
  );

  return width * height;
}

export function intersectionRatio(subject: Box, region: Box): number {
  const area = subject.width * subject.height;
  return area > 0 ? intersectionArea(subject, region) / area : 0;
}

export function calculatePopoverPosition(
  anchor: Box,
  popover: Size,
  viewport: Size,
  margin = 12,
  gap = 10,
  topInset = margin,
): PopoverPosition {
  const safeTop = Math.max(margin, topInset);
  const roomBelow = viewport.height - (anchor.y + anchor.height) - margin;
  const roomAbove = anchor.y - safeTop;
  const roomRight = viewport.width - (anchor.x + anchor.width) - margin;
  const roomLeft = anchor.x - margin;

  let placement: PopoverPosition["placement"];
  if (roomBelow >= popover.height + gap) {
    placement = "below";
  } else if (roomAbove >= popover.height + gap) {
    placement = "above";
  } else if (roomRight >= popover.width + gap) {
    placement = "right";
  } else if (roomLeft >= popover.width + gap) {
    placement = "left";
  } else {
    placement = roomBelow >= roomAbove ? "below" : "above";
  }

  const preferredLeft =
    placement === "right"
      ? anchor.x + anchor.width + gap
      : placement === "left"
        ? anchor.x - popover.width - gap
        : anchor.x;
  const preferredTop =
    placement === "below"
      ? anchor.y + anchor.height + gap
      : placement === "above"
        ? anchor.y - popover.height - gap
        : anchor.y;

  return {
    left: clamp(preferredLeft, margin, viewport.width - popover.width - margin),
    top: clamp(preferredTop, safeTop, viewport.height - popover.height - margin),
    placement,
  };
}

function parseTokenFragment(hash: string, key: string): PairingFragment {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.includes(`${key}=`)) {
    return { token: null, remainingHash: hash };
  }

  const params = new URLSearchParams(raw);
  const token = params.get(key);
  params.delete(key);
  const remainder = params.toString();

  return {
    token: token?.trim() || null,
    remainingHash: remainder ? `#${remainder}` : "",
  };
}

export function parsePairingFragment(hash: string): PairingFragment {
  return parseTokenFragment(hash, "visual-pair");
}

export function parseViewerFragment(hash: string): PairingFragment {
  return parseTokenFragment(hash, "visual-view");
}

export function shouldSubmitOnEnter(
  event: { key: string; shiftKey: boolean; isComposing: boolean },
  compositionActive: boolean,
): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    !compositionActive
  );
}

export function compactText(value: string, maximumLength: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maximumLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`;
}
