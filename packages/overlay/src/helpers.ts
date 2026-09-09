/** Browser-only geometry and input helpers. */
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

export interface TaskOrderKey {
  id: string;
  createdAt: string;
}

/** Newest first, with the id as a stable tie-breaker for equal timestamps. */
export function orderTasks<T extends TaskOrderKey>(tasks: readonly T[]): T[] {
  return [...tasks].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );
}

export function upsertTask<T extends TaskOrderKey>(tasks: readonly T[], nextTask: T): T[] {
  const existing = tasks.findIndex((task) => task.id === nextTask.id);
  if (existing < 0) return orderTasks([nextTask, ...tasks]);
  const next = [...tasks];
  next[existing] = nextTask;
  return orderTasks(next);
}

export interface DragPosition {
  left: number;
  top: number;
}

/** Keeps a dragged fixed-position surface fully inside the viewport with a margin. */
export function clampDragPosition(
  position: DragPosition,
  size: Size,
  viewport: Size,
  margin: number,
): DragPosition {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  return {
    left: clamp(Math.round(position.left), margin, maxLeft),
    top: clamp(Math.round(position.top), margin, maxTop),
  };
}
