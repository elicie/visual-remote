import { PNG } from "pngjs";
import type { ComparisonMeasuredTarget } from "@visual-remote/protocol";
export const MAX_PNG_BYTES = 16 * 1024 * 1024;
const labels = [
  "top-left",
  "top-center",
  "top-right",
  "mid-left",
  "mid-center",
  "mid-right",
  "bot-left",
  "bot-center",
  "bot-right",
];
const weights = [0.299, 0.587, 0.114];
export function assertDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 3 ||
    height < 3 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16_000_000
  )
    throw new Error(
      "Dimensions must be 3–8192 CSS pixels per edge and at most 16 million pixels",
    );
}
export function decodePng(bytes: Buffer): PNG {
  if (
    bytes.length < 33 ||
    bytes.length > MAX_PNG_BYTES ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(8) !== 13
  )
    throw new Error("Expected a bounded genuine PNG");
  assertDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  const png = PNG.sync.read(bytes, { checkCRC: true });
  if (png.data.length !== png.width * png.height * 4)
    throw new Error("Invalid decoded PNG length");
  return png;
}
// Adapted from Mimikyu scripts/compare.py (MIT, accompanying license).
// Composite alpha over white consistently; never resize, mask, or round scores.
export function comparePixels(reference: PNG, current: PNG, threshold: number) {
  if (reference.width !== current.width || reference.height !== current.height)
    throw new Error(
      "Reference and capture dimensions differ; recapture exact CSS dimensions, never resize",
    );
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255)
    throw new Error("Invalid RGB threshold");
  const { width, height } = reference;
  const heatmap = new PNG({ width, height });
  const overlay = new PNG({ width, height });
  const totals = new Uint32Array(9),
    matches = new Uint32Array(9);
  let matching = 0;
  for (let y = 0; y < height; y++) {
    const row =
      y < Math.floor(height / 3) ? 0 : y < Math.floor((2 * height) / 3) ? 1 : 2;
    for (let x = 0; x < width; x++) {
      const col =
        x < Math.floor(width / 3) ? 0 : x < Math.floor((2 * width) / 3) ? 1 : 2;
      const region = row * 3 + col,
        offset = (y * width + x) * 4;
      const a = reference.data[offset + 3]! / 255,
        b = current.data[offset + 3]! / 255;
      let maximum = 0,
        luminance = 0;
      for (let channel = 0; channel < 3; channel++) {
        const original = Math.round(
          reference.data[offset + channel]! * a + 255 * (1 - a),
        );
        const actual = Math.round(
          current.data[offset + channel]! * b + 255 * (1 - b),
        );
        const delta = Math.abs(original - actual);
        maximum = Math.max(maximum, delta);
        luminance += delta * weights[channel]!;
        overlay.data[offset + channel] = original;
      }
      totals[region] = totals[region]! + 1;
      if (maximum <= threshold) {
        matching++;
        matches[region] = matches[region]! + 1;
      }
      const intensity = Math.min(Math.round(luminance) * 4, 255);
      heatmap.data[offset] = intensity;
      heatmap.data[offset + 3] = 255;
      for (let channel = 0; channel < 3; channel++)
        overlay.data[offset + channel] = Math.round(
          overlay.data[offset + channel]! * 0.6 +
            (channel === 0 ? intensity : 0) * 0.4,
        );
      overlay.data[offset + 3] = 255;
    }
  }
  return {
    overallMatch: (matching / (width * height)) * 100,
    regions: Object.fromEntries(
      labels.map((label, i) => [label, (matches[i]! / totals[i]!) * 100]),
    ),
    heatmap: PNG.sync.write(heatmap),
    overlay: PNG.sync.write(overlay),
  };
}
export const normalizeText = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();
const styleKeys = [
  "color",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
] as const;
function normalizeStyle(key: string, value: string): string {
  const text = value.trim().toLowerCase();
  if (key === "fontWeight")
    return text === "normal" ? "400" : text === "bold" ? "700" : text;
  if (key === "fontFamily")
    return text.replace(/["']/gu, "").replace(/\s*,\s*/gu, ",");
  if (key === "color") {
    const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/u.exec(text);
    if (hex) {
      let digits = hex[1]!;
      if (digits.length <= 4) digits = [...digits].map((c) => c + c).join("");
      return `${parseInt(digits.slice(0, 2), 16)},${parseInt(digits.slice(2, 4), 16)},${parseInt(digits.slice(4, 6), 16)},${Number((digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1).toFixed(3))}`;
    }
    const rgb = /^rgba?\(([^)]+)\)$/u.exec(text);
    if (rgb) {
      const parts = rgb[1]!.split(/[\s,/]+/u).filter(Boolean);
      if (parts.length === 3 || parts.length === 4) {
        const values = parts.map((part, i) =>
          part.endsWith("%")
            ? Number(part.slice(0, -1)) * (i < 3 ? 2.55 : 0.01)
            : Number(part),
        );
        if (values.every(Number.isFinite))
          return `${Math.round(values[0]!)},${Math.round(values[1]!)},${Math.round(values[2]!)},${Number((values[3] ?? 1).toFixed(3))}`;
      }
    }
  }
  if (["fontSize", "lineHeight", "letterSpacing"].includes(key)) {
    if (key === "letterSpacing" && text === "normal") return "0px";
    const n = /^(-?\d+(?:\.\d+)?)(?:px)?$/u.exec(text);
    if (n) return `${Number(n[1])}px`;
  }
  return text;
}
export function validateTargets(value: unknown): ComparisonMeasuredTarget[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error("Expected bounded structural targets array");
  for (const item of value) {
    if (
      !item ||
      typeof item.text !== "string" ||
      item.text.length > 20000 ||
      !normalizeText(item.text) ||
      !item.rect ||
      !item.styles ||
      typeof item.styles !== "object" ||
      Array.isArray(item.styles)
    )
      throw new Error("Malformed structural target");
    for (const key of ["x", "y", "width", "height"])
      if (
        typeof item.rect[key] !== "number" ||
        !Number.isFinite(item.rect[key]) ||
        Math.abs(item.rect[key]) > 1000000 ||
        ((key === "width" || key === "height") && item.rect[key] < 0)
      )
        throw new Error("Malformed target rectangle");
    for (const v of Object.values(item.styles))
      if (typeof v !== "string" || v.length > 2000)
        throw new Error("Malformed target style");
  }
  return value as ComparisonMeasuredTarget[];
}
export function compareStructure(
  expected: ComparisonMeasuredTarget[],
  measured: ComparisonMeasuredTarget[],
) {
  const issues: string[] = [];
  let structuralMismatches = 0,
    missingTargets = 0;
  const used = new Set<number>();
  for (const target of expected) {
    const candidates = measured
      .flatMap((actual, index) =>
        !used.has(index) &&
        normalizeText(actual.text) === normalizeText(target.text)
          ? [
              {
                actual,
                index,
                distance:
                  Math.abs(target.rect.x - actual.rect.x) +
                  Math.abs(target.rect.y - actual.rect.y),
              },
            ]
          : [],
      )
      .sort((a, b) => a.distance - b.distance);
    const candidate = candidates[0];
    if (
      !candidate ||
      (candidates[1] &&
        Math.abs(candidate.distance - candidates[1].distance) < 0.000001)
    ) {
      missingTargets++;
      issues.push(
        `${candidate ? "Ambiguous" : "Missing"} target ${JSON.stringify(target.text)}`,
      );
      continue;
    }
    used.add(candidate.index);
    const actual = candidate.actual;
    for (const key of ["x", "y", "width", "height"] as const)
      if (Math.abs(target.rect[key] - actual.rect[key]) > 2) {
        structuralMismatches++;
        issues.push(
          `${JSON.stringify(target.text)} ${key}: expected ${target.rect[key]}, measured ${actual.rect[key]}`,
        );
      }
    for (const key of styleKeys) {
      const wanted = target.styles[key];
      if (
        wanted !== undefined &&
        (actual.styles[key] === undefined ||
          normalizeStyle(key, wanted) !==
            normalizeStyle(key, actual.styles[key]!))
      ) {
        structuralMismatches++;
        issues.push(
          `${JSON.stringify(target.text)} ${key}: expected ${wanted}, measured ${actual.styles[key] ?? "missing"}`,
        );
      }
    }
  }
  return { structuralMismatches, missingTargets, issues };
}
