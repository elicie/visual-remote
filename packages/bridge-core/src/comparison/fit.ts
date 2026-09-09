import { PNG } from "pngjs";
import type { ComparisonMeasuredTarget, ContextBundle, Rect } from "@visual-remote/protocol";

export interface Size {
  width: number;
  height: number;
}

const MAX_EDGE = 8192;

export function sameSize(left: Size, right: Size): boolean {
  return left.width === right.width && left.height === right.height;
}

function clampEdge(value: number): number {
  return Math.min(MAX_EDGE, Math.max(1, Math.round(value)));
}

/**
 * Proposes a verification context whose selected target should render at the
 * Figma frame size. Full-bleed elements follow the viewport, so the viewport
 * grows or shrinks by the measured difference; a region simply takes the frame
 * size at its anchor; page mode maps the viewport onto the frame. Returns
 * undefined when nothing can change (fixed-size elements, edge limits).
 */
export function adaptContextToFrame(context: ContextBundle, measured: Size, frame: Size): ContextBundle | undefined {
  const viewport = context.page.viewport;
  const selection = context.selection;
  if (selection.mode === "page") {
    if (sameSize(viewport, frame)) return undefined;
    return { ...context, page: { ...context.page, viewport: { width: frame.width, height: frame.height } } };
  }
  if (selection.mode === "region") {
    const region = selection.region;
    const nextViewport = {
      width: clampEdge(Math.max(viewport.width, region.x + frame.width)),
      height: clampEdge(Math.max(viewport.height, region.y + frame.height)),
    };
    const nextRegion: Rect = { x: region.x, y: region.y, width: frame.width, height: frame.height };
    if (sameSize(region, nextRegion) && sameSize(viewport, nextViewport)) return undefined;
    return {
      ...context,
      page: { ...context.page, viewport: nextViewport },
      selection: { ...selection, region: nextRegion },
    };
  }
  const nextViewport = {
    width: clampEdge(viewport.width + (frame.width - measured.width)),
    height: clampEdge(viewport.height + (frame.height - measured.height)),
  };
  if (sameSize(viewport, nextViewport)) return undefined;
  return { ...context, page: { ...context.page, viewport: nextViewport } };
}

/** Bilinear resample of an RGBA image; used only when sizes cannot be matched in the browser. */
export function resamplePng(source: PNG, width: number, height: number): PNG {
  if (source.width === width && source.height === height) return source;
  const target = new PNG({ width, height });
  const scaleX = source.width / width;
  const scaleY = source.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(source.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(source.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = sx - x0;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const top = source.data[(y0 * source.width + x0) * 4 + channel]! * (1 - fx) + source.data[(y0 * source.width + x1) * 4 + channel]! * fx;
        const bottom = source.data[(y1 * source.width + x0) * 4 + channel]! * (1 - fx) + source.data[(y1 * source.width + x1) * 4 + channel]! * fx;
        target.data[offset + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return target;
}

export function scaleTargets(targets: ComparisonMeasuredTarget[], scaleX: number, scaleY: number): ComparisonMeasuredTarget[] {
  if (scaleX === 1 && scaleY === 1) return targets;
  return targets.map((target) => ({
    ...target,
    rect: {
      x: target.rect.x * scaleX,
      y: target.rect.y * scaleY,
      width: target.rect.width * scaleX,
      height: target.rect.height * scaleY,
    },
  }));
}
