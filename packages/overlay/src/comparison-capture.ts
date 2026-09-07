import type {
  CaptureResult,
  ComparisonCaptureRequest,
  ComparisonMeasuredTarget,
  ContextBundle,
  Rect,
} from "@visual-remote/protocol";
import { OVERLAY_HOST_ID } from "./context.js";

type CaptureTrack = MediaStreamTrack & {
  getCaptureHandle?: () => { handle?: string; origin?: string } | null;
};
type CaptureDevices = MediaDevices & {
  setCaptureHandleConfig?: (config: {
    handle: string;
    exposeOrigin: boolean;
    permittedOrigins: string[];
  }) => void;
};
const MAX_PIXELS = 16_000_000;
const MAX_BASE64 = 22_369_624;
let stream: MediaStream | null = null;
let nonce = "";
let generation = 0;
let busy = false;
let statusListener: ((ready: boolean, message: string) => void) | undefined;

export function observeComparisonSharing(
  listener: typeof statusListener,
): void {
  statusListener = listener;
}
export function stopComparisonSharing(): void {
  generation++;
  const previous = stream;
  stream = null;
  previous?.getTracks().forEach((track) => track.stop());
  statusListener?.(
    false,
    "탭 공유가 중지되었습니다. 비교하려면 현재 탭을 다시 공유하세요.",
  );
}
export function comparisonSharingReady(): boolean {
  const track = stream?.getVideoTracks()[0] as CaptureTrack | undefined;
  const handle = track?.getCaptureHandle?.();
  return Boolean(
    track?.readyState === "live" &&
      track.getSettings().displaySurface === "browser" &&
      handle?.handle === nonce &&
      handle.origin === location.origin,
  );
}
export async function startComparisonSharing(): Promise<void> {
  stopComparisonSharing();
  const version = generation;
  const devices = navigator.mediaDevices as CaptureDevices | undefined;
  if (!devices?.setCaptureHandleConfig || !devices.getDisplayMedia)
    throw new Error(
      "현재 탭 확인을 지원하는 Chrome에서 열어 주세요. 일반 요청은 탭 공유 없이 사용할 수 있습니다.",
    );
  nonce = crypto.randomUUID();
  devices.setCaptureHandleConfig({
    handle: nonce,
    exposeOrigin: true,
    permittedOrigins: [location.origin],
  });
  const acquired = await devices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  } as DisplayMediaStreamOptions);
  if (version !== generation) {
    acquired.getTracks().forEach((track) => track.stop());
    return;
  }
  stream = acquired;
  if (!comparisonSharingReady()) {
    stopComparisonSharing();
    throw new Error(
      "공유한 화면이 현재 탭인지 확인할 수 없습니다. Chrome 공유 창에서 이 탭을 선택하세요 (창·전체 화면 불가).",
    );
  }
  const track = acquired.getVideoTracks()[0]!;
  track.addEventListener(
    "ended",
    () => {
      if (stream === acquired) stopComparisonSharing();
    },
    { once: true },
  );
  track.addEventListener("capturehandlechange", () => {
    if (stream === acquired && !comparisonSharingReady())
      stopComparisonSharing();
  });
  statusListener?.(true, "현재 탭 공유 중 · 비교할 때만 화면을 캡처합니다.");
}
function bounded<T>(
  pending: Promise<T>,
  message: string,
  ms = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
export function comparisonCrop(context: ContextBundle): Rect {
  if (
    location.href !== context.page.url ||
    innerWidth !== context.page.viewport.width ||
    innerHeight !== context.page.viewport.height ||
    scrollX !== context.page.scroll.x ||
    scrollY !== context.page.scroll.y
  )
    throw new Error(
      "페이지 위치 또는 뷰포트가 변경되었습니다. 원래 화면으로 돌아와 새 비교를 요청하세요.",
    );
  if (context.selection.mode === "page")
    return { x: 0, y: 0, width: innerWidth, height: innerHeight };
  if (context.selection.mode === "region") return context.selection.region;
  const rects = context.selection.targets.map((target) => {
    let element: Element | undefined;
    for (const locator of target.dom.locatorCandidates) {
      let selector: string;
      if (locator.type === "id") selector = `#${CSS.escape(locator.value)}`;
      else if (locator.type === "testid")
        selector = `[data-testid="${CSS.escape(locator.value)}"],[data-test-id="${CSS.escape(locator.value)}"]`;
      else if (locator.type === "css" || locator.type === "dom-path")
        selector = locator.value;
      else continue;
      try {
        const matches = document.querySelectorAll(selector);
        if (
          matches.length === 1 &&
          matches[0]?.tagName.toLowerCase() === target.dom.tagName
        ) {
          element = matches[0];
          break;
        }
      } catch {
        /* Invalid or stale locator cannot establish identity. */
      }
    }
    if (!element)
      throw new Error(
        "선택한 요소가 없거나 모호합니다. 대상을 다시 선택하세요.",
      );
    const rect = element.getBoundingClientRect();
    return rect;
  });
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  };
}
export function measureComparisonText(crop: Rect): ComparisonMeasuredTarget[] {
  const targets: ComparisonMeasuredTarget[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    const text = node.textContent?.replace(/\s+/g, " ").trim();
    if (
      !element ||
      !text ||
      element.closest(
        `#${OVERLAY_HOST_ID},script,style,noscript,textarea,input,select,[hidden],[aria-hidden="true"]`,
      )
    )
      continue;
    const style = getComputedStyle(element);
    if (
      style.visibility !== "visible" ||
      style.display === "none" ||
      Number(style.opacity) === 0
    )
      continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      rect.right <= crop.x ||
      rect.bottom <= crop.y ||
      rect.x >= crop.x + crop.width ||
      rect.y >= crop.y + crop.height
    )
      continue;
    if (targets.length >= 2000 || text.length > 10_000)
      throw new Error(
        "비교 텍스트가 너무 많습니다. 더 작은 영역을 선택하세요.",
      );
    targets.push({
      text,
      rect: {
        x: rect.x - crop.x,
        y: rect.y - crop.y,
        width: rect.width,
        height: rect.height,
      },
      styles: {
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontFamily: style.fontFamily,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
      },
    });
  }
  return targets;
}
export async function captureComparison(
  request: ComparisonCaptureRequest,
  context: ContextBundle,
  host: HTMLElement,
): Promise<CaptureResult> {
  const identity = { requestId: request.requestId, taskId: request.taskId };
  if (busy)
    return { ...identity, error: "이미 다른 비교 화면을 캡처하고 있습니다." };
  busy = true;
  const visibility = host.style.getPropertyValue("visibility");
  const priority = host.style.getPropertyPriority("visibility");
  const animations = document
    .getAnimations()
    .filter((animation) => animation.playState === "running");
  const video = document.createElement("video");
  try {
    if (!comparisonSharingReady())
      throw new Error(
        "현재 탭 공유가 중지되었습니다. 현재 탭을 다시 공유하고 비교를 요청하세요.",
      );
    if (
      !Number.isInteger(request.width) ||
      !Number.isInteger(request.height) ||
      request.width < 1 ||
      request.height < 1 ||
      request.width > 8192 ||
      request.height > 8192 ||
      request.width * request.height > MAX_PIXELS
    )
      throw new Error("지원하는 비교 이미지 크기를 초과했습니다.");
    host.style.setProperty("visibility", "hidden", "important");
    animations.forEach((animation) => animation.pause());
    await bounded(document.fonts.ready, "폰트가 준비되지 않았습니다.");
    const crop = comparisonCrop(context);
    await bounded(
      Promise.all([
        document.fonts.ready,
        ...Array.from(document.images)
          .filter((image) => {
            if (image.closest(`#${OVERLAY_HOST_ID}`)) return false;
            const rect = image.getBoundingClientRect();
            if (!rect.width || !rect.height || rect.right <= crop.x || rect.bottom <= crop.y || rect.x >= crop.x + crop.width || rect.y >= crop.y + crop.height) return false;
            for (let element: Element | null = image; element; element = element.parentElement) {
              const style = getComputedStyle(element);
              if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
            }
            return true;
          })
          .map((image) => image.decode()),
      ]),
      "폰트 또는 이미지가 준비되지 않았습니다.",
    );
    if (
      crop.width !== request.width ||
      crop.height !== request.height ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.x + crop.width > innerWidth ||
      crop.y + crop.height > innerHeight
    )
      throw new Error(
        `선택 영역 ${crop.width}×${crop.height}px와 Figma ${request.width}×${request.height}px가 다릅니다. 뷰포트 또는 선택 영역을 정확히 맞춰 주세요.`,
      );
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await bounded(video.play(), "공유 화면을 재생하지 못했습니다.");
    if (!video.requestVideoFrameCallback)
      throw new Error(
        "실제 미디어 프레임 캡처를 지원하는 Chrome이 필요합니다.",
      );
    // Wait for two freshly presented frames after hiding the overlay and settling the page.
    for (let index = 0; index < 2; index++) {
      let callback = 0;
      const frame = new Promise<void>((resolve) => {
        callback = video.requestVideoFrameCallback(() => resolve());
      });
      try {
        await bounded(frame, "새 공유 프레임을 받지 못했습니다.");
      } finally {
        video.cancelVideoFrameCallback(callback);
      }
    }
    if (!comparisonSharingReady())
      throw new Error("캡처 중 현재 탭 공유가 중지되거나 변경되었습니다.");
    const finalCrop = comparisonCrop(context);
    if (
      ["x", "y", "width", "height"].some(
        (key) => finalCrop[key as keyof Rect] !== crop[key as keyof Rect],
      )
    )
      throw new Error(
        "캡처 중 선택 영역이 움직였습니다. 화면이 안정된 뒤 새 비교를 요청하세요.",
      );
    const scaleX = video.videoWidth / innerWidth,
      scaleY = video.videoHeight / innerHeight;
    if (!scaleX || !scaleY || Math.abs(scaleX - scaleY) > 0.01)
      throw new Error(
        "공유 프레임의 비율이 현재 탭과 다릅니다. 현재 탭을 다시 공유하세요.",
      );
    const canvas = document.createElement("canvas");
    canvas.width = request.width;
    canvas.height = request.height;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new Error("PNG 캡처용 Canvas를 만들 수 없습니다.");
    drawing.drawImage(
      video,
      crop.x * scaleX,
      crop.y * scaleY,
      crop.width * scaleX,
      crop.height * scaleY,
      0,
      0,
      request.width,
      request.height,
    );
    const targets = measureComparisonText(crop);
    const pngBase64 = canvas.toDataURL("image/png").split(",")[1]!;
    if (
      pngBase64.length > MAX_BASE64 ||
      JSON.stringify(targets).length > 2_000_000
    )
      throw new Error("캡처 결과가 너무 큽니다. 더 작은 영역을 선택하세요.");
    return {
      ...identity,
      pngBase64,
      width: request.width,
      height: request.height,
      targets,
    };
  } catch (error) {
    return {
      ...identity,
      error:
        error instanceof Error ? error.message : "화면 캡처에 실패했습니다.",
    };
  } finally {
    video.pause();
    video.srcObject = null;
    host.style.setProperty("visibility", visibility, priority);
    animations.forEach((animation) => {
      if (animation.playState === "paused") animation.play();
    });
    busy = false;
  }
}
