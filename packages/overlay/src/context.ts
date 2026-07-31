import type {
  ContextBundle,
  Rect,
  SourceLocation,
  TargetContext,
} from "@visual-remote/protocol";

import { compactText, intersectionRatio } from "./helpers.js";

export const OVERLAY_HOST_ID = "__visual_bridge_root";

const IGNORED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "META",
  "LINK",
  "NOSCRIPT",
  "TEMPLATE",
]);

const SAFE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "role",
  "title",
  "type",
  "placeholder",
  "data-testid",
  "data-test-id",
  "data-component",
  "data-component-name",
  "data-source",
  "data-source-file",
  "data-source-line",
  "data-source-column",
  "data-react-source",
]);

const SENSITIVE_ATTRIBUTE_PATTERN =
  /(?:auth|cookie|credential|csrf|jwt|key|password|secret|session|token|value)/i;

const STYLE_PROPERTIES = [
  ["display", "display"],
  ["position", "position"],
  ["width", "width"],
  ["height", "height"],
  ["margin", "margin"],
  ["padding", "padding"],
  ["gap", "gap"],
  ["borderRadius", "border-radius"],
  ["fontSize", "font-size"],
  ["fontWeight", "font-weight"],
  ["lineHeight", "line-height"],
  ["color", "color"],
  ["backgroundColor", "background-color"],
  ["flexDirection", "flex-direction"],
  ["alignItems", "align-items"],
  ["justifyContent", "justify-content"],
  ["gridTemplateColumns", "grid-template-columns"],
  ["zIndex", "z-index"],
] as const;

const IMPLICIT_ROLES: Partial<Record<keyof HTMLElementTagNameMap, string>> = {
  a: "link",
  button: "button",
  footer: "contentinfo",
  form: "form",
  header: "banner",
  img: "img",
  main: "main",
  nav: "navigation",
  select: "combobox",
  textarea: "textbox",
};

type SourceConfidence = TargetContext["source"]["confidence"];
type LocatorCandidate = TargetContext["dom"]["locatorCandidates"][number];

export type TargetRelocationState =
  | "found-and-changed"
  | "found-no-visible-change"
  | "not-found"
  | "page-reloaded"
  | "unverified";

export interface TargetRelocationReport {
  state: TargetRelocationState;
  targetCount: number;
  foundCount: number;
  changedCount: number;
}

export interface ContextBundleInput {
  projectId: string;
  browserSessionId: string;
  mode: ContextBundle["selection"]["mode"];
  targets: TargetContext[];
  region?: Rect;
  requestText: string;
  scope: ContextBundle["request"]["scope"];
  renderRevision: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: string | null | undefined): string | undefined {
  const compacted = value?.trim();
  return compacted ? compacted : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sourceFromRecord(
  source: Record<string, unknown>,
  componentFallback?: string,
): SourceLocation | undefined {
  const filePath = optionalString(
    typeof source.fileName === "string"
      ? source.fileName
      : typeof source.filePath === "string"
        ? source.filePath
        : typeof source.file === "string"
          ? source.file
          : undefined,
  );

  if (!filePath) {
    return undefined;
  }

  const lineNumber = finitePositiveInteger(source.lineNumber ?? source.line);
  const columnNumber = finitePositiveInteger(source.columnNumber ?? source.column);
  const componentName = optionalString(
    typeof source.componentName === "string"
      ? source.componentName
      : componentFallback,
  );

  return {
    filePath,
    ...(lineNumber ? { lineNumber } : {}),
    ...(columnNumber ? { columnNumber } : {}),
    ...(componentName ? { componentName } : {}),
  };
}

function sourceFromString(
  rawValue: string,
  componentName?: string,
): SourceLocation | undefined {
  const value = rawValue.trim();
  if (!value) {
    return undefined;
  }

  if (value.startsWith("{")) {
    try {
      const parsed = asRecord(JSON.parse(value));
      return parsed ? sourceFromRecord(parsed, componentName) : undefined;
    } catch {
      return undefined;
    }
  }

  const match = /^(.*):(\d+)(?::(\d+))?$/.exec(value);
  const filePath = optionalString(match?.[1] ?? value);
  if (!filePath) {
    return undefined;
  }

  const lineNumber = finitePositiveInteger(match?.[2]);
  const columnNumber = finitePositiveInteger(match?.[3]);
  return {
    filePath,
    ...(lineNumber ? { lineNumber } : {}),
    ...(columnNumber ? { columnNumber } : {}),
    ...(componentName ? { componentName } : {}),
  };
}

function sourceFromAttributes(element: Element): SourceLocation | undefined {
  const componentName =
    optionalString(element.getAttribute("data-component-name")) ??
    optionalString(element.getAttribute("data-component"));
  const combined =
    element.getAttribute("data-react-source") ?? element.getAttribute("data-source");
  if (combined) {
    const parsed = sourceFromString(combined, componentName);
    if (parsed) {
      return parsed;
    }
  }

  const filePath = optionalString(
    element.getAttribute("data-source-file") ??
      element.getAttribute("data-file") ??
      undefined,
  );
  if (!filePath) {
    return undefined;
  }

  const lineNumber = finitePositiveInteger(element.getAttribute("data-source-line"));
  const columnNumber = finitePositiveInteger(
    element.getAttribute("data-source-column"),
  );

  return {
    filePath,
    ...(lineNumber ? { lineNumber } : {}),
    ...(columnNumber ? { columnNumber } : {}),
    ...(componentName ? { componentName } : {}),
  };
}

function componentNameFromFiber(fiber: Record<string, unknown>): string | undefined {
  const type = fiber.type;
  if (typeof type === "function") {
    const candidate = type as { displayName?: unknown; name?: unknown };
    return optionalString(
      typeof candidate.displayName === "string"
        ? candidate.displayName
        : typeof candidate.name === "string"
          ? candidate.name
          : undefined,
    );
  }

  const typeRecord = asRecord(type);
  return optionalString(
    typeof typeRecord?.displayName === "string"
      ? typeRecord.displayName
      : typeof typeRecord?.name === "string"
        ? typeRecord.name
        : undefined,
  );
}

function parseSourcesFromStack(
  stackValue: unknown,
  componentName?: string,
): SourceLocation[] {
  const stack =
    typeof stackValue === "string"
      ? stackValue
      : stackValue instanceof Error
        ? stackValue.stack
        : undefined;
  if (!stack) {
    return [];
  }

  const sources: SourceLocation[] = [];
  for (const line of stack.split("\n")) {
    const match = /(?:\(|\s)([^()\s]+):(\d+):(\d+)\)?$/.exec(line.trim());
    if (!match?.[1] || match[1].includes("node_modules")) {
      continue;
    }

    sources.push({
      filePath: match[1],
      lineNumber: Number(match[2]),
      columnNumber: Number(match[3]),
      ...(componentName ? { componentName } : {}),
    });
    if (sources.length === 8) {
      break;
    }
  }

  return sources;
}

function sourcesFromReactFiber(element: Element): SourceLocation[] {
  const elementRecord = element as unknown as Record<string, unknown>;
  const fiberKey = Object.keys(elementRecord).find(
    (key) =>
      key.startsWith("__reactFiber$") ||
      key.startsWith("__reactInternalInstance$"),
  );
  let fiber = fiberKey ? asRecord(elementRecord[fiberKey]) : null;
  const sources: SourceLocation[] = [];
  const seen = new Set<string>();

  for (let depth = 0; fiber && depth < 20 && sources.length < 8; depth += 1) {
    const componentName = componentNameFromFiber(fiber);
    const debugSource = asRecord(fiber._debugSource);
    const directSource = debugSource
      ? sourceFromRecord(debugSource, componentName)
      : undefined;
    const candidates = directSource
      ? [directSource]
      : parseSourcesFromStack(fiber._debugStack, componentName);

    for (const candidate of candidates) {
      const key = `${candidate.filePath}:${candidate.lineNumber ?? 0}:${
        candidate.columnNumber ?? 0
      }`;
      if (!seen.has(key)) {
        sources.push(candidate);
        seen.add(key);
      }
      if (sources.length === 8) {
        break;
      }
    }

    fiber = asRecord(fiber.return);
  }

  return sources;
}

function resolveSource(element: Element): {
  primary?: SourceLocation;
  stack: SourceLocation[];
  confidence: SourceConfidence;
} {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const source = sourceFromAttributes(current);
    if (source) {
      const fiberSources = sourcesFromReactFiber(element);
      return {
        primary: source,
        stack: [source, ...fiberSources]
          .filter(
            (candidate, index, all) =>
              all.findIndex(
                (other) =>
                  other.filePath === candidate.filePath &&
                  other.lineNumber === candidate.lineNumber &&
                  other.columnNumber === candidate.columnNumber,
              ) === index,
          )
          .slice(0, 8),
        confidence: depth === 0 ? "exact" : "probable",
      };
    }
    current = current.parentElement;
  }

  const stack = sourcesFromReactFiber(element);
  return stack.length > 0
    ? { primary: stack[0]!, stack, confidence: "probable" }
    : { stack: [], confidence: "unknown" };
}

function isOverlayElement(element: Element): boolean {
  if (element.id === OVERLAY_HOST_ID || element.closest(`#${OVERLAY_HOST_ID}`)) {
    return true;
  }

  const root = element.getRootNode();
  return root instanceof ShadowRoot && (root.host as HTMLElement).id === OVERLAY_HOST_ID;
}

export function isElementEligible(element: Element): element is HTMLElement {
  if (
    !(element instanceof HTMLElement) ||
    IGNORED_TAGS.has(element.tagName) ||
    isOverlayElement(element)
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return false;
  }

  const style = getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number.parseFloat(style.opacity || "1") > 0
  );
}

export function getEligibleElementAtPoint(
  x: number,
  y: number,
): HTMLElement | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (isElementEligible(element)) {
      return element;
    }
  }

  return null;
}

function safeAttributes(element: HTMLElement): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attribute of element.attributes) {
    const name = attribute.name.toLowerCase();
    const isSafeDataAttribute =
      name.startsWith("data-") &&
      !SENSITIVE_ATTRIBUTE_PATTERN.test(name) &&
      /(?:component|source|test|qa|variant)/i.test(name);
    if (
      (SAFE_ATTRIBUTES.has(name) || isSafeDataAttribute) &&
      !SENSITIVE_ATTRIBUTE_PATTERN.test(name)
    ) {
      attributes[name] = compactText(attribute.value, 200);
    }
  }

  return attributes;
}

function roleFor(element: HTMLElement): string | undefined {
  return (
    optionalString(element.getAttribute("role")) ??
    IMPLICIT_ROLES[element.tagName.toLowerCase() as keyof HTMLElementTagNameMap] ??
    (element instanceof HTMLInputElement ? "textbox" : undefined)
  );
}

function accessibleNameFor(element: HTMLElement): string | undefined {
  const ariaLabel = optionalString(element.getAttribute("aria-label"));
  if (ariaLabel) {
    return compactText(ariaLabel, 200);
  }

  if (element instanceof HTMLImageElement) {
    return optionalString(element.alt);
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const label = element.labels?.[0];
    const labelText = optionalString(label?.innerText);
    if (labelText) {
      return compactText(labelText, 200);
    }
    return optionalString(element.getAttribute("placeholder"));
  }

  const text = optionalString(element.innerText);
  return text ? compactText(text, 200) : optionalString(element.title);
}

function escapeCss(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function cssSelectorFor(element: HTMLElement): string {
  const testId =
    element.getAttribute("data-testid") ?? element.getAttribute("data-test-id");
  if (testId) {
    return `[data-testid="${escapeCss(testId)}"]`;
  }

  if (element.id) {
    return `#${escapeCss(element.id)}`;
  }

  const segments: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body && segments.length < 5) {
    const parent: HTMLElement | null = current.parentElement;
    const tagName = current.tagName.toLowerCase();
    const currentTagName = current.tagName;
    if (!parent) {
      segments.unshift(tagName);
      break;
    }
    const sameTagSiblings = Array.from(parent.children).filter(
      (sibling: Element) => sibling.tagName === currentTagName,
    );
    const suffix =
      sameTagSiblings.length > 1
        ? `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`
        : "";
    segments.unshift(`${tagName}${suffix}`);
    current = parent;
  }

  return segments.join(" > ");
}

function locatorCandidatesFor(element: HTMLElement): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];
  const testId =
    element.getAttribute("data-testid") ?? element.getAttribute("data-test-id");
  if (testId) {
    candidates.push({ type: "testid", value: testId, confidence: 1 });
  }
  if (element.id) {
    candidates.push({ type: "id", value: element.id, confidence: 0.98 });
  }

  const role = roleFor(element);
  const accessibleName = accessibleNameFor(element);
  if (role) {
    candidates.push({
      type: "role",
      value: accessibleName ? `${role}:${accessibleName}` : role,
      confidence: accessibleName ? 0.9 : 0.72,
    });
  }

  const css = cssSelectorFor(element);
  if (css) {
    candidates.push({ type: "css", value: css, confidence: 0.68 });
    candidates.push({ type: "dom-path", value: css, confidence: 0.5 });
  }

  const text = optionalString(element.innerText);
  if (text && !(element instanceof HTMLInputElement)) {
    candidates.push({
      type: "text",
      value: compactText(text, 100),
      confidence: 0.45,
    });
  }

  return candidates;
}

const LOCATOR_PRIORITY: Record<LocatorCandidate["type"], number> = {
  testid: 0,
  id: 1,
  role: 2,
  css: 3,
  "dom-path": 4,
  text: 5,
};

const STYLE_PROPERTY_BY_KEY = new Map<string, string>(STYLE_PROPERTIES);

function firstEligible(
  elements: Iterable<Element>,
  predicate: (element: HTMLElement) => boolean,
): HTMLElement | null {
  let inspected = 0;
  for (const element of elements) {
    inspected += 1;
    if (inspected > 2_500) {
      break;
    }
    if (isElementEligible(element) && predicate(element)) {
      return element;
    }
  }
  return null;
}

function querySelectorSafely(root: Document, selector: string): HTMLElement | null {
  try {
    const element = root.querySelector(selector);
    return element && isElementEligible(element) ? element : null;
  } catch {
    return null;
  }
}

function findByLocator(
  root: Document,
  target: TargetContext,
  locator: LocatorCandidate,
): HTMLElement | null {
  if (locator.type === "testid") {
    return firstEligible(
      root.querySelectorAll("[data-testid], [data-test-id]"),
      (element) =>
        element.getAttribute("data-testid") === locator.value
        || element.getAttribute("data-test-id") === locator.value,
    );
  }
  if (locator.type === "id") {
    const element = root.getElementById(locator.value);
    return element && isElementEligible(element) ? element : null;
  }
  if (locator.type === "role") {
    const separator = locator.value.indexOf(":");
    const expectedRole =
      target.dom.role ?? (separator < 0 ? locator.value : locator.value.slice(0, separator));
    const expectedName =
      target.dom.accessibleName
      ?? (separator < 0 ? undefined : locator.value.slice(separator + 1));
    return firstEligible(
      root.querySelectorAll(
        "[role], a[href], button, footer, form, header, img, input, main, nav, select, textarea",
      ),
      (element) =>
        roleFor(element) === expectedRole
        && (expectedName === undefined
          || accessibleNameFor(element) === expectedName),
    );
  }
  if (locator.type === "css" || locator.type === "dom-path") {
    return querySelectorSafely(root, locator.value);
  }

  const expectedText = compactText(locator.value, 100);
  return firstEligible(root.querySelectorAll("*"), (element) => {
    if (element.tagName.toLowerCase() !== target.dom.tagName) {
      return false;
    }
    return compactText(element.innerText ?? "", 100) === expectedText;
  });
}

function relocateTarget(
  target: TargetContext,
  root: Document,
): HTMLElement | null {
  const locators = [...target.dom.locatorCandidates].sort(
    (left, right) =>
      LOCATOR_PRIORITY[left.type] - LOCATOR_PRIORITY[right.type]
      || right.confidence - left.confidence,
  );
  for (const locator of locators) {
    const element = findByLocator(root, target, locator);
    if (element) {
      return element;
    }
  }
  return null;
}

function targetSignalChanged(
  target: TargetContext,
  element: HTMLElement,
): boolean {
  const currentRect = rectForElement(element);
  const originalRect = target.dom.rect;
  if (
    Math.abs(currentRect.x - originalRect.x) > 1
    || Math.abs(currentRect.y - originalRect.y) > 1
    || Math.abs(currentRect.width - originalRect.width) > 1
    || Math.abs(currentRect.height - originalRect.height) > 1
  ) {
    return true;
  }

  if (
    target.dom.text !== undefined
    && compactText(element.innerText ?? "", 500) !== target.dom.text
  ) {
    return true;
  }

  const style = getComputedStyle(element);
  return Object.entries(target.styles).some(([key, originalValue]) => {
    const property = STYLE_PROPERTY_BY_KEY.get(key);
    return property !== undefined && style.getPropertyValue(property) !== originalValue;
  });
}

export function relocateTargets(
  targets: readonly TargetContext[],
  root: Document = document,
): TargetRelocationReport {
  if (targets.length === 0) {
    return {
      state: "unverified",
      targetCount: 0,
      foundCount: 0,
      changedCount: 0,
    };
  }

  let foundCount = 0;
  let changedCount = 0;
  for (const target of targets) {
    const element = relocateTarget(target, root);
    if (!element) {
      continue;
    }
    foundCount += 1;
    if (targetSignalChanged(target, element)) {
      changedCount += 1;
    }
  }

  return {
    state:
      foundCount !== targets.length
        ? "not-found"
        : changedCount > 0
          ? "found-and-changed"
          : "found-no-visible-change",
    targetCount: targets.length,
    foundCount,
    changedCount,
  };
}

function parentPathFor(element: HTMLElement): TargetContext["dom"]["parentPath"] {
  const path: TargetContext["dom"]["parentPath"] = [];
  let current = element.parentElement;
  while (current && current !== document.body && path.length < 8) {
    const siblingIndex = current.parentElement
      ? Array.from(current.parentElement.children).indexOf(current)
      : undefined;
    const id = optionalString(current.id);
    path.unshift({
      tagName: current.tagName.toLowerCase(),
      ...(id ? { id } : {}),
      classNames: Array.from(current.classList).slice(0, 20),
      ...(siblingIndex !== undefined && siblingIndex >= 0 ? { siblingIndex } : {}),
    });
    current = current.parentElement;
  }
  return path;
}

export function rectForElement(element: Element): Rect {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

export async function collectTargetContext(
  element: HTMLElement,
  order: number,
): Promise<TargetContext> {
  await Promise.resolve();
  const style = getComputedStyle(element);
  const classNames = Array.from(element.classList).slice(0, 100);
  while (classNames.join(" ").length > 2_000) {
    classNames.pop();
  }

  const styles: Record<string, string> = {};
  for (const [key, property] of STYLE_PROPERTIES) {
    const value = style.getPropertyValue(property);
    if (value) {
      styles[key] = compactText(value, 160);
    }
  }

  const id = optionalString(element.id);
  const text =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
      ? undefined
      : optionalString(element.innerText);
  const role = roleFor(element);
  const accessibleName = accessibleNameFor(element);
  const source = resolveSource(element);

  return {
    targetId: crypto.randomUUID(),
    order,
    dom: {
      tagName: element.tagName.toLowerCase(),
      ...(id ? { id } : {}),
      classNames,
      ...(text ? { text: compactText(text, 500) } : {}),
      ...(role ? { role } : {}),
      ...(accessibleName
        ? { accessibleName: compactText(accessibleName, 200) }
        : {}),
      attributes: safeAttributes(element),
      rect: rectForElement(element),
      locatorCandidates: locatorCandidatesFor(element),
      parentPath: parentPathFor(element),
    },
    styles,
    source,
  };
}

export function collectRegionElements(region: Rect): HTMLElement[] {
  const candidates: Array<{ element: HTMLElement; score: number; index: number }> = [];
  const regionArea = Math.max(region.width * region.height, 1);
  const all = document.body?.querySelectorAll("*") ?? [];
  let scanned = 0;

  for (const element of all) {
    scanned += 1;
    if (scanned > 4_000) {
      break;
    }
    if (!isElementEligible(element)) {
      continue;
    }

    const rect = rectForElement(element);
    const ratio = intersectionRatio(rect, region);
    if (ratio <= 0) {
      continue;
    }

    const role = roleFor(element);
    const interactive =
      Boolean(role) ||
      /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(element.tagName);
    const areaRatio = (rect.width * rect.height) / regionArea;
    const leafLike = element.children.length <= 2;
    if (!interactive && !leafLike && areaRatio > 0.88) {
      continue;
    }
    if (!interactive && ratio < 0.12) {
      continue;
    }

    candidates.push({
      element,
      score: ratio + (interactive ? 1.5 : 0) + (leafLike ? 0.35 : 0),
      index: scanned,
    });
  }

  return candidates
    .sort((first, second) => second.score - first.score || first.index - second.index)
    .slice(0, 20)
    .sort((first, second) => first.index - second.index)
    .map(({ element }) => element);
}

export function collectPageElements(): HTMLElement[] {
  const selectors = [
    "main",
    "header",
    "nav",
    "aside",
    "footer",
    "[role='main']",
    "[role='navigation']",
    "h1",
    "h2",
    "button",
    "a[href]",
    "input",
    "select",
    "textarea",
    "[role='button']",
  ];
  const elements: HTMLElement[] = [];
  const seen = new Set<Element>();
  for (const element of document.querySelectorAll(selectors.join(","))) {
    if (
      seen.has(element) ||
      !isElementEligible(element) ||
      intersectionRatio(rectForElement(element), {
        x: 0,
        y: 0,
        width: innerWidth,
        height: innerHeight,
      }) <= 0
    ) {
      continue;
    }
    elements.push(element);
    seen.add(element);
    if (elements.length === 20) {
      break;
    }
  }

  return elements;
}

export function createContextBundle(input: ContextBundleInput): ContextBundle {
  const baseTargets = input.targets.map((target, order) => ({ ...target, order }));
  const selection: ContextBundle["selection"] =
    input.mode === "element"
      ? { mode: "element", targets: baseTargets.slice(0, 1) }
      : input.mode === "multi"
        ? { mode: "multi", targets: baseTargets.slice(0, 8) }
        : input.mode === "region"
          ? {
              mode: "region",
              region: input.region ?? { x: 0, y: 0, width: 0, height: 0 },
              targets: baseTargets.slice(0, 20),
            }
          : { mode: "page", targets: baseTargets.slice(0, 20) };

  return {
    version: 1,
    projectId: input.projectId || "current",
    browserSessionId: input.browserSessionId,
    page: {
      url: location.href,
      pathname: location.pathname,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio: devicePixelRatio || 1,
      scroll: { x: scrollX, y: scrollY },
      renderRevision: input.renderRevision,
    },
    selection,
    request: {
      text: input.requestText.trim(),
      scope: input.scope,
    },
  };
}
