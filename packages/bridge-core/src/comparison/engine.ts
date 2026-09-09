import { createHash } from "node:crypto";
import { AgentPermissionDeniedError } from "../agents/types.js";
import type {
  CaptureResult,
  ComparisonState,
  ContextBundle,
} from "@visual-remote/protocol";
import {
  assertDimensions,
  comparePixels,
  compareStructure,
  decodePng,
  MAX_PNG_BYTES,
  validateTargets,
} from "./metrics.js";
import {
  readPrivate,
  taskDirectory,
  updateRegistry,
  writePrivate,
} from "./files.js";
import { PNG } from "pngjs";
import { adaptContextToFrame, resamplePng, sameSize, scaleTargets, type Size } from "./fit.js";
import { mimikyuSkill } from "./mimikyu-skill.js";
export { getComparisonArtifact } from "./files.js";
export interface DesignComparisonOptions {
  taskId: string;
  context: ContextBundle;
  root: string;
  signal: AbortSignal;
  runAgent: (prompt: string) => Promise<void>;
  /** Captures `context` (possibly a viewport/region-adapted variant of the task context) at `request` size. */
  capture: (request: Size, context: ContextBundle) => Promise<CaptureResult>;
  /** Measures the selection crop for `context` without capturing, so the Bridge can fit it to the frame. */
  measure?: (context: ContextBundle) => Promise<Size>;
  onState: (state: ComparisonState) => void;
}
function figmaIdentity(value: string): { fileKey: string; nodeId: string } {
  const url = new URL(value),
    match = /^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/u.exec(url.pathname),
    node = url.searchParams.get("node-id");
  if (
    url.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !match ||
    !node ||
    !/^\d+[-:]\d+$/u.test(node)
  )
    throw new Error(
      "An exact HTTPS Figma design/file URL with node-id is required",
    );
  return { fileKey: match[1]!, nodeId: node.replace("-", ":") };
}
export async function runDesignComparison(
  options: DesignComparisonOptions,
): Promise<ComparisonState> {
  const request = options.context.request.comparison;
  let state: ComparisonState = {
    status: "preparing",
    url: request?.url ?? "",
    iteration: 0,
    maxIterations: request?.maxIterations ?? 4,
    iterations: [],
    ...(request
      ? { threshold: request.threshold, targetMatch: request.targetMatch }
      : {}),
  };
  const transition = (
    status: ComparisonState["status"],
    message: string,
  ): void => {
    state = { ...state, status, message, iterations: [...state.iterations] };
    options.onState(structuredClone(state));
  };
  try {
    transition(
      "preparing",
      "Retrieving the exact Figma frame through configured MCP; application edits are not yet permitted",
    );
    options.signal.throwIfAborted();
    if (!request?.enabled || !request.url)
      throw new Error("Figma comparison was not enabled with a reference URL");
    if (
      !Number.isInteger(request.maxIterations) ||
      request.maxIterations < 1 ||
      request.maxIterations > 20 ||
      !Number.isFinite(request.targetMatch) ||
      request.targetMatch < 0 ||
      request.targetMatch > 100 ||
      !Number.isInteger(request.threshold) ||
      request.threshold < 0 ||
      request.threshold > 255
    )
      throw new Error(
        "Invalid comparison iteration cap, threshold or target match",
      );
    const identity = figmaIdentity(request.url),
      directory = await taskDirectory(options.root, options.taskId, true);
    await writePrivate(
      directory,
      "instructions.txt",
      `Reference contract: {width:number,height:number,targets:[{text:string,rect:{x:number,y:number,width:number,height:number},styles:{color?:string,fontSize?:string,fontWeight?:string,fontFamily?:string,lineHeight?:string,letterSpacing?:string}}],sourceUrl:string,nodeId:string}. Dimensions and rectangles are frame-relative CSS pixels at scale 1; include ALL visible text nodes with real rendered bounds, not guessed containers. Empty targets only if no visible text. Export exact genuine PNG; no masks/resizing. Source URL: ${request.url}; normalized node: ${identity.nodeId}.\n${mimikyuSkill}`,
    );
    await options.runAgent(
      `COMPARISON_PHASE=REFERENCE_ONLY\nCOMPARISON_ARTIFACT_DIRECTORY=${directory}\nRetrieve ${request.url} (file ${identity.fileKey}, node ${identity.nodeId}) using ONLY the user's existing configured Figma MCP. Read ${directory}/instructions.txt. TRANSFER RULE: the PNG bytes must reach disk without passing through your own output. Prefer a Figma tool that saves the export directly to a local path (for example a download/export-images tool given the artifact directory) or a shell download of the export URL returned by the Figma images API when a token is already configured; a screenshot tool that returns the image as an attachment is acceptable only if you can save it without retyping it. NEVER transcribe base64 image data into a file or shell command, chunked or not: generating tens of kilobytes of base64 as text takes many minutes and exceeds the task time limit. If every available path would require relaying bytes through text, stop, explain which tool is missing, and leave the reference absent. This phase is read-only for the application: DO NOT implement, edit code, launch servers, install dependencies or execute the implementation request yet. The ONLY write exception outside the normal repository is the designated private artifact directory above. Write actual exported reference.png and reference.json matching instructions.txt there (0600). Include sourceUrl and nodeId provenance and every visible text node's real rendered geometry and CSS-equivalent typography/color. Never fabricate image, metadata or scores. If inaccessible/incomplete, explain the prerequisite and leave reference absent.\n${mimikyuSkill}`,
    );
    options.signal.throwIfAborted();
    const readReference = async (name: string, maxBytes?: number): Promise<Buffer> => {
      try {
        return await readPrivate(directory, name, maxBytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Figma reference retrieval did not produce ${name}. Check the agent output and configured Figma MCP before retrying.`);
        }
        throw error;
      }
    };
    const referenceBytes = await readReference("reference.png"),
      metadataBytes = await readReference("reference.json", 4 * 1024 * 1024);
    const metadata = JSON.parse(metadataBytes.toString("utf8")) as {
      width: number;
      height: number;
      targets: unknown;
      sourceUrl: string;
      nodeId: string;
    };
    assertDimensions(metadata.width, metadata.height);
    const provenance = figmaIdentity(metadata.sourceUrl);
    if (
      provenance.fileKey !== identity.fileKey ||
      provenance.nodeId !== identity.nodeId ||
      typeof metadata.nodeId !== "string" ||
      metadata.nodeId.replace("-", ":") !== identity.nodeId
    )
      throw new Error(
        "Figma reference provenance does not match the requested file and node",
      );
    const expected = validateTargets(metadata.targets),
      reference = decodePng(referenceBytes);
    if (
      reference.width !== metadata.width ||
      reference.height !== metadata.height
    )
      throw new Error(
        "Reference PNG dimensions disagree with structural metadata",
      );
    if (!reference.data.some((byte, index) => index % 4 === 3 && byte !== 0))
      throw new Error("Reference image is entirely transparent");
    const referenceHash = createHash("sha256")
        .update(referenceBytes)
        .digest("hex"),
      metadataHash = createHash("sha256").update(metadataBytes).digest("hex");
    const artifacts = ["reference.png"];
    await updateRegistry(directory, artifacts);
    await writePrivate(
      directory,
      "reference-lock.json",
      JSON.stringify({
        sourceUrl: request.url,
        nodeId: identity.nodeId,
        referenceHash,
        metadataHash,
      }),
    );
    // Fit the selection to the frame before any edit: adapt the verification
    // viewport (or region) so the target renders at the frame size; when the
    // target cannot follow, keep going and scale captures for comparison.
    let working = options.context;
    let scaledCapture: Size | undefined;
    if (options.measure && working.selection.mode !== "page") {
      transition("preparing", "Fitting the selected target to the Figma frame size");
      let current = await options.measure(working);
      options.signal.throwIfAborted();
      for (let attempt = 0; attempt < 2 && !sameSize(current, reference); attempt++) {
        const adapted = adaptContextToFrame(working, current, reference);
        if (!adapted) break;
        const next = await options.measure(adapted);
        options.signal.throwIfAborted();
        working = adapted;
        current = next;
      }
      if (!sameSize(current, reference)) {
        scaledCapture = { width: current.width, height: current.height };
        transition(
          "preparing",
          `Selected target renders at ${current.width}×${current.height}px while the Figma frame is ${reference.width}×${reference.height}px; captures are scaled to the frame size for comparison, so pixel scores are approximate`,
        );
      }
    }
    transition(
      "correcting",
      "Reference validated and locked; implementing in the existing application",
    );
    await options.runAgent(
      `COMPARISON_PHASE=IMPLEMENT\nCOMPARISON_ARTIFACT_DIRECTORY=${directory}\nReference is validated and immutable. Inspect ${directory}/reference.png using your available image tool and read reference.json. Implement the user's requested design in the EXISTING application. If image inspection is unavailable, say so; do not claim visual inspection. Do not modify comparison artifacts, substitute a flat reference image for UI, or start another development server. Host captures the browser after your edits.\n${mimikyuSkill}`,
    );
    let best = -Infinity,
      stagnant = 0;
    for (let iteration = 1; iteration <= request.maxIterations; iteration++) {
      options.signal.throwIfAborted();
      if (
        createHash("sha256")
          .update(await readPrivate(directory, "reference.png"))
          .digest("hex") !== referenceHash ||
        createHash("sha256")
          .update(
            await readPrivate(directory, "reference.json", 4 * 1024 * 1024),
          )
          .digest("hex") !== metadataHash
      )
        throw new Error("Locked Figma reference changed; comparison stopped");
      state = { ...state, iteration };
      let size: Size = { width: reference.width, height: reference.height };
      if (scaledCapture && options.measure) {
        // The target may have changed size after edits; capture whatever it is now.
        const now = await options.measure(working);
        options.signal.throwIfAborted();
        size = { width: now.width, height: now.height };
        scaledCapture = size;
      }
      transition(
        "capturing",
        `Capturing iteration ${iteration} at ${size.width}×${size.height} CSS pixels`,
      );
      const capture = await options.capture(size, working);
      options.signal.throwIfAborted();
      if (capture.error)
        throw new Error(`Browser capture unavailable: ${capture.error}`);
      if (capture.taskId !== options.taskId)
        throw new Error("Capture belongs to another task");
      if (capture.width !== size.width || capture.height !== size.height)
        throw new Error(
          "Browser capture CSS dimensions differ from the requested size; select the exact frame-sized viewport/region",
        );
      const encoded = capture.pngBase64;
      if (
        !encoded ||
        encoded.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 ||
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
      )
        throw new Error("Capture did not provide a valid bounded PNG encoding");
      let currentBytes: Buffer = Buffer.from(encoded, "base64"),
        current = decodePng(currentBytes),
        measured = validateTargets(capture.targets);
      const scaled = !sameSize(current, reference);
      if (scaled) {
        current = resamplePng(current, reference.width, reference.height);
        currentBytes = PNG.sync.write(current);
        measured = scaleTargets(measured, reference.width / size.width, reference.height / size.height);
      }
      transition(
        "comparing",
        `Computing pixel and structural evidence for iteration ${iteration}`,
      );
      const pixels = comparePixels(reference, current, request.threshold),
        structural = compareStructure(expected, measured);
      const names = [
        `capture-${iteration}.png`,
        `heatmap-${iteration}.png`,
        `overlay-${iteration}.png`,
      ];
      for (const [index, bytes] of [
        currentBytes,
        pixels.heatmap,
        pixels.overlay,
      ].entries())
        await writePrivate(directory, names[index]!, bytes);
      artifacts.push(...names);
      await updateRegistry(directory, artifacts);
      const issues = [...structural.issues];
      for (const [region, match] of Object.entries(pixels.regions))
        if (match < request.targetMatch)
          issues.push(
            `${region}: ${match.toFixed(4)}% below ${request.targetMatch}%`,
          );
      const report = {
        iteration,
        overallMatch: pixels.overallMatch,
        regions: pixels.regions,
        ...structural,
        issues,
        referenceArtifactId: `${options.taskId}/reference.png`,
        screenshotArtifactId: `${options.taskId}/${names[0]}`,
        heatmapArtifactId: `${options.taskId}/${names[1]}`,
        overlayArtifactId: `${options.taskId}/${names[2]}`,
        ...(scaled ? { scaled: { width: size.width, height: size.height } } : {}),
      };
      await writePrivate(
        directory,
        `report-${iteration}.json`,
        JSON.stringify({ ...report, expected, measured }, null, 2),
      );
      state = { ...state, iterations: [...state.iterations, report] };
      options.signal.throwIfAborted();
      if (
        report.overallMatch >= request.targetMatch &&
        Object.values(report.regions).every(
          (value) => value >= request.targetMatch,
        ) &&
        report.structuralMismatches === 0 &&
        report.missingTargets === 0
      ) {
        transition(
          "passed",
          "All pixel regions meet the target with zero structural mismatches and missing targets",
        );
        return state;
      }
      const quality =
        Math.min(report.overallMatch, ...Object.values(report.regions)) -
        report.structuralMismatches -
        report.missingTargets;
      if (quality > best + 0.000001) {
        best = quality;
        stagnant = 0;
      } else stagnant++;
      if (iteration === request.maxIterations || stagnant >= 3) {
        transition(
          "unmatched",
          stagnant >= 3
            ? "Stopped after three consecutive iterations without improvement"
            : "Iteration cap reached without satisfying every comparison criterion",
        );
        return state;
      }
      transition(
        "correcting",
        `Correcting measured mismatches after iteration ${iteration}`,
      );
      await options.runAgent(
        `COMPARISON_PHASE=CORRECT\nCOMPARISON_ARTIFACT_DIRECTORY=${directory}\nCorrect existing application from engine report ${directory}/report-${iteration}.json. Inspect ${directory}/capture-${iteration}.png, heatmap-${iteration}.png, overlay-${iteration}.png and immutable reference.png with your available image tool; disclose if unavailable. Read expected-versus-measured issues first, and reference.json. Do not write comparison artifacts, change reference/scoring/capture, launch servers or claim a self-reported score.\n${mimikyuSkill}`,
      );
    }
    throw new Error("Comparison ended without terminal measurement");
  } catch (error) {
    transition(
      options.signal.aborted ? "canceled" : "blocked",
      options.signal.aborted
        ? "Comparison canceled"
        : error instanceof Error
          ? error.message
          : "Comparison failed without usable evidence",
    );
    if (error instanceof AgentPermissionDeniedError) throw error;
    return state;
  }
}
