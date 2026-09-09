/**
 * THESIS: The selected page stays primary while one flight strip routes a safe code change; it refuses the detached developer dashboard.
 * OWN-WORLD: Matte graphite instruments, warm paper strips, hard rules, tabular machine facts, dispatch orange, and verification cyan.
 * STORY: Identify a live target, state intent and scope, watch its route, then keep or reverse the exact change.
 * FIRST VIEWPORT: A compact mode rail sits top-center; reticles mark page geometry; one clamped strip opens beside the target with dispatch at its lower edge.
 * FORM: Flight-strip console, ranked first, staged as a target-anchored operational strip; seed key 0f89a551.
 */

import { render } from "preact";
import type { JSX } from "preact";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import type {
  ComparisonState,
  ContextBundle,
  Rect,
  ServerEvent,
  TargetContext,
  TaskRecord,
  TaskStatus,
  VerificationBrowserKind,
} from "@visual-remote/protocol";
import { normalizeComparisonRequest, type ComparisonRequest } from "@visual-remote/protocol";
import {
  BridgeConnection,
  approveTaskTools,
  changedFilesFromEvent,
  commitTask,
  consumePairingToken,
  createTaskPayload,
  fetchBootstrap,
  fetchLatestTaskForSession,
  fetchTasks,
  fetchProjectId,
  fetchVerificationInfo,
  fetchTaskArtifacts,
  fetchViewerUrl,
  getBrowserSessionId,
  logFromEvent,
  phaseFromEvent,
  openComparisonBrowser,
  postTaskAction,
  routeTaskEvent,
  taskFromEvent,
  type BridgeBootstrap,
  type ConnectionSnapshot,
  type ConnectionState,
  type VerificationBrowserInfo,
} from "./bridge.js";
import { LogText } from "./log-text.js";
import {
  collectPageElements,
  collectRegionElements,
  collectTargetContext,
  createContextBundle,
  getEligibleElementAtPoint,
  OVERLAY_HOST_ID,
  rectForElement,
  relocateTargets,
} from "./context.js";
import {
  calculatePopoverPosition,
  clampDragPosition,
  compactText,
  normalizeRect,
  orderTasks,
  parsePairingFragment,
  shouldSubmitOnEnter,
  upsertTask,
  type DragPosition,
  type Point,
  type PopoverPosition,
} from "./helpers.js";
import { overlayStyles } from "./styles.js";

type SelectionMode = ContextBundle["selection"]["mode"];
type RequestScope = ContextBundle["request"]["scope"];

interface SelectionItem {
  id: string;
  element: HTMLElement;
  context: TargetContext | null;
}

interface TaskView {
  id?: string;
  status: TaskStatus;
  requestText: string;
  comparison?: ComparisonState;
  changedFiles: string[];
  logs: string[];
  diff: string;
  verification?: string;
  error?: string;
  errorCode?: string;
  permissionDeniedTools?: string[];
  commit?: TaskRecord["commit"];
  unavailableArtifacts?: Array<"files" | "diff" | "logs">;
}

const PHASE_LABELS: Record<TaskStatus, string> = {
  queued: "대기 중",
  preparing: "작업 준비",
  snapshotting_before: "변경 전 스냅샷",
  resolving_context: "소스 확인",
  running_agent: "에이전트 수정 중",
  snapshotting_after: "변경 후 스냅샷",
  diffing: "변경 범위 계산",
  waiting_hmr: "화면 반영 대기",
  verifying: "검증 중",
  review: "검토 대기",
  accepted: "변경 유지",
  reverted: "되돌리기 완료",
  failed: "작업 실패",
  canceled: "작업 취소",
  unsafe: "안전 확인 필요",
};

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  unpaired: "페어링 필요",
  connecting: "연결 중",
  connected: "Bridge 연결됨",
  reconnecting: "재연결 중",
  offline: "Bridge 응답 없음",
  unauthorized: "페어링 거부됨",
};

const CONNECTION_COMPACT_LABELS: Record<ConnectionState, string> = {
  unpaired: "페어링",
  connecting: "연결 중",
  connected: "연결됨",
  reconnecting: "재연결",
  offline: "응답 없음",
  unauthorized: "거부됨",
};

const ACTIVE_PHASES = new Set<TaskStatus>([
  "queued",
  "preparing",
  "snapshotting_before",
  "resolving_context",
  "running_agent",
  "snapshotting_after",
  "diffing",
  "waiting_hmr",
  "verifying",
]);

const ERROR_PHASES = new Set<TaskStatus>(["failed", "unsafe"]);

const TASK_HYDRATION_TIMEOUT_MS = 3_000;

function eligibleDeniedTools(task: TaskView): string[] {
  if (task.status !== "failed" || task.errorCode !== "AGENT_PERMISSION_DENIED") return [];
  return [...new Set(task.permissionDeniedTools?.filter((tool) => tool.trim() === tool && /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(tool)) ?? [])];
}

function isTaskRecord(value: unknown): value is TaskRecord {
  const record = value as Partial<TaskRecord> | null | undefined;
  return (
    typeof record?.id === "string"
    && typeof record.createdAt === "string"
    && typeof record.requestText === "string"
    && typeof record.status === "string"
    && Array.isArray(record.changedFiles)
  );
}

function taskTone(record: TaskRecord): "active" | "review" | "issue" | "done" {
  if (ERROR_PHASES.has(record.status) || record.verificationStatus === "failed") return "issue";
  if (ACTIVE_PHASES.has(record.status)) return "active";
  if (record.status === "review") return "review";
  return "done";
}

function taskTimeLabel(record: TaskRecord): string {
  const date = new Date(record.completedAt ?? record.startedAt ?? record.createdAt);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function viewFromRecord(record: TaskRecord): TaskView {
  return {
    id: record.id,
    status: record.status,
    requestText: record.requestText,
    changedFiles: record.changedFiles,
    logs: [],
    diff: "",
    ...(record.comparison ? { comparison: record.comparison } : {}),
    ...(record.error?.code ? { errorCode: record.error.code } : {}),
    ...(record.permissionDeniedTools ? { permissionDeniedTools: record.permissionDeniedTools } : {}),
    ...(record.verificationStatus ? { verification: record.verificationStatus } : {}),
    ...(record.error?.message ? { error: record.error.message } : {}),
    ...(record.commit ? { commit: record.commit } : {}),
  };
}

/** Same subject/body shape the Bridge uses when no message is given. */
function suggestedCommitMessage(task: TaskView): string {
  const flattened = task.requestText.replace(/\s+/g, " ").trim() || "Visual Remote change";
  const subject = flattened.length > 72 ? `${flattened.slice(0, 71).trimEnd()}…` : flattened;
  return task.id ? `${subject}\n\nVisual Remote task ${task.id}` : subject;
}

function eventIsFromOverlay(event: Event): boolean {
  return event.composedPath().some(
    (node) => node instanceof HTMLElement && node.id === OVERLAY_HOST_ID,
  );
}

function sourceLabel(item: SelectionItem | undefined): string {
  if (!item) {
    return "현재 페이지";
  }

  if (!item.context) {
    return "소스 위치 확인 중…";
  }

  const source = item.context.source.primary;
  if (source) {
    const line = source.lineNumber ? `:${source.lineNumber}` : "";
    return `${source.componentName ? `${source.componentName} · ` : ""}${
      source.filePath
    }${line}`;
  }

  const dom = item.context.dom;
  const detail = dom.id
    ? `#${dom.id}`
    : dom.classNames[0]
      ? `.${dom.classNames[0]}`
      : "";
  return `${dom.tagName}${detail} · source unknown`;
}

function verificationLabel(value: string | undefined): string {
  switch (value) {
    case "passed":
      return "검증 통과";
    case "partial":
      return "부분 검증";
    case "failed":
      return "검증 실패";
    default:
      return "미검증";
  }
}

function consoleText(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function Reticle({
  rect,
  kind,
  label,
}: {
  rect: Rect;
  kind: "hover" | "selected";
  label?: string;
}) {
  return (
    <div
      class="reticle"
      data-kind={kind}
      style={{
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
      aria-hidden="true"
    >
      {label ? <span class="reticle-label">{label}</span> : null}
    </div>
  );
}

function RequestStrip({
  panelRef,
  position,
  selection,
  mode,
  connectionState,
  requestText,
  scope,
  composingRef,
  onRequestText,
  onScope,
  onSubmit,
  comparisonEnabled, comparisonUrl, comparisonError, browserMessage, browserError, browserBusy,
  browserKinds, browserKind, comparisonTarget, comparisonRounds,
  onComparisonEnabled, onComparisonUrl, onOpenBrowser, onBrowserKind, onComparisonTarget, onComparisonRounds,
}: {
  panelRef: preact.RefObject<HTMLDivElement>;
  position: PopoverPosition;
  selection: SelectionItem[];
  mode: SelectionMode;
  connectionState: ConnectionState;
  requestText: string;
  scope: RequestScope;
  composingRef: preact.RefObject<boolean>;
  onRequestText: (value: string) => void;
  onScope: (scope: RequestScope) => void;
  onSubmit: () => void;
  comparisonEnabled: boolean;
  comparisonUrl: string;
  comparisonError: string;
  browserMessage: string;
  browserError: string;
  browserBusy: boolean;
  browserKinds: VerificationBrowserKind[];
  browserKind: VerificationBrowserKind | undefined;
  comparisonTarget: number;
  comparisonRounds: number;
  onComparisonEnabled: (enabled: boolean) => void;
  onComparisonUrl: (url: string) => void;
  onOpenBrowser: () => void;
  onBrowserKind: (kind: VerificationBrowserKind) => void;
  onComparisonTarget: (value: number) => void;
  onComparisonRounds: (value: number) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const drag = useDraggable();
  const first = selection[0];
  const pendingCount = selection.filter((item) => !item.context).length;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (
      shouldSubmitOnEnter(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
        },
        Boolean(composingRef.current),
      )
    ) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <section
      ref={(node: HTMLElement | null) => {
        panelRef.current = node as HTMLDivElement | null;
        drag.elementRef.current = node;
      }}
      class="strip"
      data-dragging={drag.dragging ? "true" : "false"}
      style={
        drag.position
          ? { left: `${drag.position.left}px`, top: `${drag.position.top}px` }
          : { left: `${position.left}px`, top: `${position.top}px` }
      }
      aria-label={mode === "region" ? "영역 수정 요청 작성" : "수정 요청 작성"}
    >
      <header
        class="strip-head"
        data-drag-handle="true"
        title="드래그해서 패널을 옮길 수 있습니다"
        {...drag.handlers}
      >
        <span class="strip-grip" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span class="strip-title">
          {mode === "region" ? "드래그한 화면 영역" : sourceLabel(first)}
        </span>
        <span class="strip-code machine">
          {mode === "element"
            ? "TARGET 1"
            : mode === "multi"
              ? `TARGETS ${selection.length}/8`
              : mode === "region"
                ? "REGION"
                : "PAGE"}
        </span>
      </header>
      <div class="strip-body">
        <div class="selection-readout">
          <strong>
            {mode === "page"
              ? "현재 페이지 컨텍스트"
              : mode === "region"
                ? "영역 선택됨"
                : `${selection.length}개 대상 선택`}
          </strong>
          <span>
            {pendingCount > 0
              ? mode === "region"
                ? `범위 안 요소 ${pendingCount}개 확인 중`
                : `소스 ${pendingCount}개 확인 중`
              : mode === "region"
                ? `범위 안 요소 ${selection.length}개 포함`
                : "컨텍스트 준비됨"}
          </span>
        </div>
        <label class="visually-hidden" for="visual-request">
          수정 요청
        </label>
        <textarea
          ref={textareaRef}
          id="visual-request"
          class="request-field"
          value={requestText}
          maxLength={10_000}
          placeholder="선택한 화면을 어떻게 바꿀까요?"
          onInput={(event) => onRequestText(event.currentTarget.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={handleKeyDown}
        />
        <p class="input-note">Enter로 보내기 · Shift+Enter로 줄바꿈</p>
        <div class="comparison-request">
          <label class="comparison-toggle"><input type="checkbox" checked={comparisonEnabled} onChange={(event) => onComparisonEnabled(event.currentTarget.checked)} /> Figma 디자인과 자동 비교</label>
          {comparisonEnabled ? <>
            <label class="field-label">Figma 프레임 링크
              <input class="comparison-url" type="url" value={comparisonUrl} placeholder="https://www.figma.com/design/…?node-id=1-2" onInput={(event) => onComparisonUrl(event.currentTarget.value)} />
            </label>
            <div class="comparison-limits">
              <label class="field-label">
                픽셀 일치 목표 (%)
                <input class="comparison-url" type="number" min={50} max={100} step={1} value={comparisonTarget} onInput={(event) => onComparisonTarget(Number(event.currentTarget.value))} />
              </label>
              <label class="field-label">
                최대 수정 회차
                <input class="comparison-url" type="number" min={1} max={20} step={1} value={comparisonRounds} onInput={(event) => onComparisonRounds(Number(event.currentTarget.value))} />
              </label>
            </div>
            <p class="input-note">전체와 3×3 각 영역이 목표 이상이고 텍스트 위치·크기 불일치가 0이면 통과입니다. 회차 안에 못 미치면 실패가 아니라 가장 근접한 결과가 검토 대기로 남습니다.</p>
            {browserKinds.includes("ego") ? (
              <fieldset class="browser-choice">
                <legend class="field-label">검증 브라우저</legend>
                <label class="comparison-toggle">
                  <input type="radio" name="visual-verification-browser" value="ego" checked={browserKind === "ego"} onChange={() => onBrowserKind("ego")} />
                  ego lite · 현재 로그인 상태를 그대로 사용
                </label>
                {browserKinds.includes("playwright") ? (
                  <label class="comparison-toggle">
                    <input type="radio" name="visual-verification-browser" value="playwright" checked={browserKind === "playwright"} onChange={() => onBrowserKind("playwright")} />
                    별도 검증 브라우저 · 전용 Chrome 프로필
                  </label>
                ) : null}
              </fieldset>
            ) : null}
            {browserKind === "ego" ? (
              <p class="input-note">ego lite의 격리된 작업 공간에서 현재 프로필의 로그인 상태로 검증합니다. 별도 로그인이 필요 없습니다.</p>
            ) : (
              <>
                <button type="button" disabled={browserBusy} aria-busy={browserBusy} onClick={onOpenBrowser}>{browserBusy ? "검증 브라우저 여는 중…" : "검증 브라우저 열기"}</button>
                <p class="input-note">별도 검증 브라우저에서 한 번 로그인하세요. 현재 탭은 그대로 유지되며, 비교 요청은 순서대로 처리됩니다.</p>
              </>
            )}
            {browserMessage ? <p class="input-note" role="status">{browserMessage}</p> : null}
            {browserError ? <p class="error-banner" role="alert">{browserError}</p> : null}
            {comparisonError ? <p class="error-banner" role="alert">{comparisonError}</p> : null}
          </> : null}
        </div>
        <div class="request-meta">
          <label class="field-label">
            적용 범위
            <select
              value={scope}
              onChange={(event) =>
                onScope(event.currentTarget.value as RequestScope)
              }
            >
              <option value="instance">선택한 인스턴스</option>
              <option value="component">공용 컴포넌트</option>
              <option value="page">현재 페이지</option>
              <option value="project">프로젝트 전체</option>
            </select>
          </label>
          <button
            type="button"
            class="primary"
            disabled={
              !requestText.trim() ||
              pendingCount > 0 ||
              connectionState !== "connected"
              || (comparisonEnabled && Boolean(comparisonError))
            }
            onClick={onSubmit}
          >
            요청 보내기
          </button>
        </div>
        {connectionState !== "connected" ? (
          <div class="error-banner" role="status">
            연결 상태: {CONNECTION_LABELS[connectionState]}. Bridge 연결 후 요청할 수
            있습니다.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TaskStrip({
  panelRef,
  position,
  docked = false,
  task,
  followUpOpen,
  followUpText,
  commitOpen,
  commitText,
  composingRef,
  busyAction,
  onCancel,
  onAccept,
  onRevert,
  onApproveTools,
  onToggleFollowUp,
  onFollowUpText,
  onFollowUp,
  onToggleCommit,
  onCommitText,
  onCommit,
  onNewRequest,
  onDismiss,
}: {
  panelRef?: preact.RefObject<HTMLDivElement>;
  position?: PopoverPosition;
  docked?: boolean;
  task: TaskView;
  followUpOpen: boolean;
  followUpText: string;
  commitOpen: boolean;
  commitText: string;
  composingRef: preact.RefObject<boolean>;
  busyAction: boolean;
  onCancel: () => void;
  onAccept: () => void;
  onRevert: () => void;
  onApproveTools: () => void;
  onToggleFollowUp: () => void;
  onFollowUpText: (value: string) => void;
  onFollowUp: () => void;
  onToggleCommit: () => void;
  onCommitText: (value: string) => void;
  onCommit: () => void;
  onNewRequest: () => void;
  onDismiss: () => void;
}) {
  const active = ACTIVE_PHASES.has(task.status);
  const hasChanges = task.changedFiles.length > 0 || Boolean(task.diff);
  const reviewable =
    task.status === "review" ||
    ((task.status === "failed" || task.status === "canceled") && hasChanges);
  const terminal =
    task.status === "review" ||
    task.status === "accepted" ||
    task.status === "reverted";
  const canStartNew =
    task.status === "accepted" ||
    task.status === "reverted" ||
    ((task.status === "failed" || task.status === "canceled") && !hasChanges);
  const committable =
    !task.commit
    && hasChanges
    && (task.status === "review" || task.status === "accepted");
  const errorOutcome =
    ERROR_PHASES.has(task.status) || task.verification === "failed";
  const progressOutcome = errorOutcome
    ? "error"
    : task.status === "canceled"
      ? "canceled"
      : terminal
        ? "complete"
        : "active";
  const summaryLogs = task.logs.slice(-4);
  const deniedTools = eligibleDeniedTools(task);
  const permissionDenied = task.status === "failed" && task.errorCode === "AGENT_PERMISSION_DENIED";

  const handleFollowUpKey = (
    event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      shouldSubmitOnEnter(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
        },
        Boolean(composingRef.current),
      )
    ) {
      event.preventDefault();
      onFollowUp();
    }
  };

  return (
    <section
      id="visual-task-strip"
      {...(panelRef ? { ref: panelRef } : {})}
      class={docked ? "strip strip-docked" : "strip"}
      {...(docked || !position
        ? {}
        : { style: { left: `${position.left}px`, top: `${position.top}px` } })}
      aria-label="작업 진행과 검토"
    >
      <header class="strip-head">
        <span class="strip-title">{compactText(task.requestText, 72)}</span>
        <span class="strip-code machine">
          {task.id ? `TASK ${task.id.slice(0, 8)}` : "DISPATCH"}
        </span>
      </header>
      <div class="strip-body">
        <div class="status-row" role="status">
          <span
            class="phase-mark"
            data-state={task.status}
            data-terminal={terminal ? "true" : "false"}
            data-error={errorOutcome ? "true" : "false"}
            aria-hidden="true"
          />
          <span class="phase-copy">
            <strong>{PHASE_LABELS[task.status]}</strong>
            <span>{compactText(task.logs.at(-1) ?? "Bridge에서 작업 상태를 기다리는 중입니다.", 180)}</span>
          </span>
          <span class="phase-count machine">{task.changedFiles.length} files</span>
        </div>
        <div
          class="progress-track"
          data-active={active ? "true" : "false"}
          data-outcome={progressOutcome}
        >
          <span />
        </div>

        {summaryLogs.length > 0 ? (
          <ul class="log-summary" aria-label="최근 작업 로그">
            {summaryLogs.map((log, index) => (
              <li key={`${task.id}-${index}-${log}`}><LogText text={log} compact /></li>
            ))}
          </ul>
        ) : (
          <p class="empty-line">아직 표시할 작업 로그가 없습니다.</p>
        )}

        {task.error ? (
          <div class="error-banner" role="alert">
            오류: {task.error}
          </div>
        ) : null}

        {permissionDenied ? (
          <div class="review-summary">
            <strong>도구 사용 권한이 거부되었습니다.</strong>
            {task.permissionDeniedTools?.length ? (
              <ul class="file-list" aria-label="거부된 도구">
                {task.permissionDeniedTools.map((tool) => <li key={tool}>{tool}</li>)}
              </ul>
            ) : null}
            {deniedTools.length > 0 ? (
              <>
                <p class="empty-line">아래 MCP 도구만 이 재시도 작업 동안 모든 인수의 호출을 허용합니다. 전역 설정은 바꾸지 않으며, 기존 명시적 거부·관리자 정책은 계속 차단할 수 있습니다.</p>
                <ul class="file-list" aria-label="재시도에서 허용할 MCP 도구">
                  {deniedTools.map((tool) => <li key={tool}>{tool}</li>)}
                </ul>
                <button type="button" class="primary" disabled={!task.id || busyAction} onClick={onApproveTools}>
                  해당 MCP 도구 허용 후 재시도
                </button>
              </>
            ) : null}
            {deniedTools.length === 0 || deniedTools.length !== task.permissionDeniedTools?.length ? (
              <p class="empty-line">기본 도구·알 수 없는 도구는 여기서 허용할 수 없습니다. 로컬 Claude CLI의 권한 설정을 확인한 뒤 새 요청을 보내세요.</p>
            ) : null}
          </div>
        ) : null}

        {task.unavailableArtifacts && task.unavailableArtifacts.length > 0 ? (
          <div class="error-banner" role="status">
            일부 작업 정보를 불러오지 못했습니다: {task.unavailableArtifacts.join(", ")}.
            작업 보드에서 다시 확인해 주세요.
          </div>
        ) : null}

        {task.status === "unsafe" ? (
          <div class="error-banner" role="alert">
            허용 범위 밖의 파일 또는 Git 상태가 작업 중 바뀌어 자동 유지·되돌리기를
            잠갔습니다. 아래 diff에는 허용된 경로만 표시됩니다. 작업 오류와 Git 상태를
            확인한 뒤 Git에서 변경을 직접 유지하거나 되돌리세요.
          </div>
        ) : null}

        {task.changedFiles.length > 0 ||
        reviewable ||
        terminal ||
        task.status === "unsafe" ? (
          <>
            <div class="review-summary">
              {task.changedFiles.length > 0 ? (
                <ul class="file-list" aria-label="변경 파일">
                  {task.changedFiles.map((file) => (
                    <li key={file}>Δ&nbsp; {file}</li>
                  ))}
                </ul>
              ) : (
                <p class="empty-line">변경 파일이 보고되지 않았습니다.</p>
              )}
              <div
                class="verification"
                data-status={task.verification ?? "unverified"}
              >
                <strong>검증</strong>
                <span>{verificationLabel(task.verification)}</span>
              </div>
              {task.commit ? (
                <div class="commit-note" role="status">
                  <strong>커밋됨</strong>
                  <span class="machine">{task.commit.sha.slice(0, 7)}</span>
                  <span>{compactText(task.commit.message.split("\n")[0] ?? "", 80)}</span>
                </div>
              ) : null}
            </div>
            <details class="diff">
              <summary>Unified diff 보기</summary>
              <pre class="diff-code">
                {task.diff || "Diff를 아직 받지 못했습니다."}
              </pre>
            </details>
          </>
        ) : null}

        <div class="actions">
          {active ? (
            <button
              type="button"
              class="quiet"
              disabled={!task.id || busyAction}
              onClick={onCancel}
            >
              작업 취소
            </button>
          ) : null}
          {reviewable ? (
            <>
              <button
                type="button"
                class="primary"
                disabled={!task.id || busyAction}
                onClick={onAccept}
              >
                변경 유지
              </button>
              <button
                type="button"
                class="secondary"
                disabled={!task.id || busyAction}
                onClick={onToggleFollowUp}
              >
                후속 수정
              </button>
              <button
                type="button"
                class="danger"
                disabled={!task.id || busyAction}
                onClick={onRevert}
              >
                되돌리기
              </button>
            </>
          ) : null}
          {committable ? (
            <button
              type="button"
              class="secondary"
              aria-expanded={commitOpen ? "true" : "false"}
              disabled={!task.id || busyAction}
              onClick={onToggleCommit}
            >
              커밋
            </button>
          ) : null}
          {canStartNew ? (
            <button type="button" class="secondary" onClick={onNewRequest}>
              새 요청
            </button>
          ) : null}
          {!active ? (
            <button
              type="button"
              class="quiet"
              title="작업 내역은 작업 보드에 남기고 이 패널만 닫기"
              onClick={onDismiss}
            >
              닫기
            </button>
          ) : null}
        </div>

        {followUpOpen && reviewable ? (
          <div class="follow-up">
            <label class="field-label" for="visual-follow-up">
              후속 수정 내용
            </label>
            <textarea
              id="visual-follow-up"
              class="request-field"
              value={followUpText}
              maxLength={10_000}
              placeholder="현재 변경을 기준으로 추가할 내용을 입력하세요."
              onInput={(event) => onFollowUpText(event.currentTarget.value)}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onKeyDown={handleFollowUpKey}
            />
            <button
              type="button"
              class="primary"
              disabled={!followUpText.trim() || busyAction}
              onClick={onFollowUp}
            >
              후속 요청 보내기
            </button>
          </div>
        ) : null}

        {commitOpen && committable ? (
          <div class="follow-up commit-form">
            <label class="field-label" for="visual-commit-message">
              커밋 메시지
            </label>
            <textarea
              id="visual-commit-message"
              class="request-field"
              value={commitText}
              maxLength={4_000}
              placeholder="첫 줄이 제목이 됩니다."
              onInput={(event) => onCommitText(event.currentTarget.value)}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
            />
            <p class="input-note">
              이 작업이 바꾼 파일 {task.changedFiles.length}개만 스테이징해서 로컬 Git 사용자 이름으로
              커밋합니다. 푸시는 하지 않습니다.
            </p>
            <button
              type="button"
              class="primary"
              disabled={!task.id || !commitText.trim() || busyAction}
              onClick={onCommit}
            >
              커밋하기
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const COMPACT_POSITION_KEY = "visual-remote:compact-strip-position";
const DRAG_THRESHOLD_PX = 5;
const DRAG_MARGIN_PX = 8;

function readStoredPosition(key: string): DragPosition | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DragPosition> | null;
    if (typeof value?.left === "number" && typeof value.top === "number") {
      return { left: value.left, top: value.top };
    }
  } catch {
    /* storage may be unavailable in the host page */
  }
  return null;
}

function writeStoredPosition(key: string, position: DragPosition | null): void {
  try {
    if (position) localStorage.setItem(key, JSON.stringify(position));
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

interface DragHandlers {
  onPointerDown: (event: JSX.TargetedPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: JSX.TargetedPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: JSX.TargetedPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: JSX.TargetedPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: JSX.TargetedMouseEvent<HTMLElement>) => void;
}

interface Draggable {
  elementRef: preact.RefObject<HTMLElement>;
  position: DragPosition | null;
  dragging: boolean;
  handlers: DragHandlers;
}

/**
 * Pointer-driven dragging for a fixed surface. Plain clicks on children keep
 * working: pointer capture only starts after the pointer travels past the
 * threshold, and the click that ends a drag is swallowed.
 */
function useDraggable(storageKey?: string): Draggable {
  const [position, setPosition] = useState<DragPosition | null>(() =>
    storageKey ? readStoredPosition(storageKey) : null,
  );
  const [dragging, setDragging] = useState(false);
  const elementRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const clampToViewport = useCallback((candidate: DragPosition): DragPosition => {
    const element = elementRef.current;
    return clampDragPosition(
      candidate,
      { width: element?.offsetWidth ?? 0, height: element?.offsetHeight ?? 0 },
      { width: innerWidth, height: innerHeight },
      DRAG_MARGIN_PX,
    );
  }, []);

  const positioned = position !== null;
  useEffect(() => {
    if (!positioned) return;
    const keepInside = () =>
      setPosition((current) => (current ? clampToViewport(current) : current));
    keepInside();
    window.addEventListener("resize", keepInside);
    return () => window.removeEventListener("resize", keepInside);
  }, [positioned, clampToViewport]);

  const finish = useCallback(
    (event: JSX.TargetedPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (!drag.moved) return;
      try {
        elementRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        /* capture may already be gone */
      }
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      setDragging(false);
      if (storageKey) {
        setPosition((current) => {
          writeStoredPosition(storageKey, current);
          return current;
        });
      }
    },
    [storageKey],
  );

  const handlers = useMemo<DragHandlers>(
    () => ({
      onPointerDown: (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        const element = elementRef.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originLeft: rect.left,
          originTop: rect.top,
          moved: false,
        };
      },
      onPointerMove: (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          drag.moved = true;
          setDragging(true);
          try {
            elementRef.current?.setPointerCapture(event.pointerId);
          } catch {
            /* capture is best-effort */
          }
        }
        event.preventDefault();
        setPosition(clampToViewport({ left: drag.originLeft + dx, top: drag.originTop + dy }));
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onClickCapture: (event) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [clampToViewport, finish],
  );

  return { elementRef, position, dragging, handlers };
}

function TaskCompactStrip({
  task,
  busyAction,
  drag,
  onExpand,
  onCancel,
}: {
  task: TaskView;
  busyAction: boolean;
  drag: Draggable;
  onExpand: () => void;
  onCancel: () => void;
}) {
  const active = ACTIVE_PHASES.has(task.status);
  const terminal = ["review", "accepted", "reverted"].includes(task.status);
  const error = ERROR_PHASES.has(task.status) || task.verification === "failed";
  const phaseId = "visual-task-compact-phase";
  const requestId = "visual-task-compact-request";
  const actionId = "visual-task-compact-action";
  return (
    <section
      ref={drag.elementRef as preact.RefObject<HTMLElement>}
      class="task-compact"
      data-active={active ? "true" : "false"}
      data-error={error ? "true" : "false"}
      data-dragging={drag.dragging ? "true" : "false"}
      {...(drag.position
        ? { style: { left: `${drag.position.left}px`, top: `${drag.position.top}px`, right: "auto" } }
        : {})}
      aria-label="최소화된 작업 상태"
      title="드래그해서 위치를 옮길 수 있습니다"
      {...drag.handlers}
    >
      <span class="task-compact-grip" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <button
        type="button"
        class="task-compact-main"
        aria-labelledby={`${phaseId} ${requestId} ${actionId}`}
        onClick={onExpand}
      >
        <span
          class="phase-mark"
          data-state={task.status}
          data-terminal={terminal ? "true" : "false"}
          data-error={error ? "true" : "false"}
          aria-hidden="true"
        />
        <span class="task-compact-copy">
          <strong id={phaseId}>{PHASE_LABELS[task.status]}</strong>
          <span id={requestId} class="task-compact-request">
            {task.requestText}
          </span>
          <span id={actionId} class="visually-hidden">
            작업 상세 펼치기
          </span>
        </span>
      </button>
      {active ? (
        <button
          type="button"
          class="task-compact-cancel"
          disabled={!task.id || busyAction}
          onClick={onCancel}
        >
          취소
        </button>
      ) : null}
    </section>
  );
}

function TaskDock({
  task,
  tasks,
  tasksError,
  onSelectTask,
  onRefresh,
  onClose,
  children,
}: {
  task: TaskView | null;
  tasks: TaskRecord[];
  tasksError: string | null;
  onSelectTask: (record: TaskRecord) => void;
  onRefresh: () => void;
  onClose: () => void;
  children?: preact.ComponentChildren;
}) {
  return (
    <aside id="visual-task-dock" class="task-dock" aria-label="작업 패널">
      <header class="dock-head">
        <span class="strip-title">작업 패널</span>
        <span class="strip-code machine">{tasks.length} TASKS</span>
        <button
          type="button"
          class="dock-close"
          title={task ? "작업 상태를 남기고 패널 접기" : "작업 패널 닫기"}
          onClick={onClose}
        >
          {task ? "접기" : "닫기"}
        </button>
      </header>
      <div class="dock-body">
        {children}
        {!task ? (
          <p class="dock-empty">
            진행 중인 작업이 없습니다. 페이지에서 요소를 선택해 변경을 요청하거나
            아래 목록에서 작업을 선택하세요.
          </p>
        ) : null}
        <div class="dock-section-head">
          <span>전체 작업</span>
          <button type="button" class="dock-refresh" onClick={onRefresh}>
            새로고침
          </button>
        </div>
        {tasksError ? (
          <div class="error-banner dock-error" role="status">{tasksError}</div>
        ) : null}
        {tasks.length === 0 ? (
          <p class="dock-empty">아직 작업 기록이 없습니다.</p>
        ) : (
          <ol class="dock-list" aria-label="전체 작업 목록">
            {tasks.map((record) => (
              <li key={record.id}>
                <button
                  type="button"
                  class="dock-row"
                  data-tone={taskTone(record)}
                  aria-current={record.id === task?.id ? "true" : undefined}
                  onClick={() => onSelectTask(record)}
                >
                  <span class="dock-state" aria-hidden="true" />
                  <span class="dock-copy">
                    <strong>{compactText(record.requestText, 90)}</strong>
                    <span>
                      {PHASE_LABELS[record.status]} · {record.changedFiles.length} files
                    </span>
                  </span>
                  <span class="dock-meta machine">{taskTimeLabel(record)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

function Overlay({ host, bootstrap }: { host: HTMLElement; bootstrap: BridgeBootstrap }) {
  const { authMode } = bootstrap;
  const pairedFromFragment = useMemo(
    () => authMode === "token" && parsePairingFragment(location.hash).token !== null,
    [authMode],
  );
  const token = useMemo(() => authMode === "token" ? consumePairingToken() : "", [authMode]);
  const browserSessionId = useMemo(getBrowserSessionId, []);
  const connectionRef = useRef<BridgeConnection | null>(null);
  const selectedRef = useRef<SelectionItem[]>([]);
  const requestTextRef = useRef("");
  const activeTaskIdRef = useRef<string | undefined>(undefined);
  const pendingActionRef = useRef<{ taskId: string } | null>(null);
  const mountedRef = useRef(true);
  const lastContextBundleRef = useRef<ContextBundle | null>(null);
  const dragStartRef = useRef<Point | null>(null);
  const compositionRef = useRef(false);
  const renderRevisionRef = useRef(1);
  const lastTargetReportRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);

  const [open, setOpen] = useState(authMode === "local" || pairedFromFragment);
  const [mode, setMode] = useState<SelectionMode>("element");
  const [selected, setSelected] = useState<SelectionItem[]>([]);
  const [hovered, setHovered] = useState<HTMLElement | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestText, setRequestText] = useState("");
  const [scope, setScope] = useState<RequestScope>("instance");
  const [comparisonChoice, setComparisonChoice] = useState<boolean | undefined>(undefined);
  const [verificationInfo, setVerificationInfo] = useState<VerificationBrowserInfo | null>(null);
  const [browserChoice, setBrowserChoice] = useState<VerificationBrowserKind | undefined>(undefined);
  const [comparisonUrl, setComparisonUrl] = useState("");
  const [comparisonTarget, setComparisonTarget] = useState(99);
  const [comparisonRounds, setComparisonRounds] = useState(4);
  const [browserMessage, setBrowserMessage] = useState("");
  const [browserError, setBrowserError] = useState("");
  const [browserBusy, setBrowserBusy] = useState(false);
  const detectedComparisonUrl = requestText.match(/https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/[^\s<>"']+/i)?.[0]?.replace(/[),.;]+$/, "") ?? "";
  const comparisonEnabled = comparisonChoice ?? Boolean(detectedComparisonUrl);
  const browserKinds = verificationInfo?.browsers ?? [];
  const browserKind: VerificationBrowserKind | undefined =
    browserChoice && browserKinds.includes(browserChoice) ? browserChoice : verificationInfo?.defaultBrowser;
  let comparisonRequest: ComparisonRequest | undefined;
  let comparisonError = "";
  const targetMatch = Number.isFinite(comparisonTarget) ? Math.min(100, Math.max(50, comparisonTarget)) : 99;
  const maxIterations = Number.isFinite(comparisonRounds) ? Math.min(20, Math.max(1, Math.round(comparisonRounds))) : 4;
  try { comparisonRequest = normalizeComparisonRequest(requestText, comparisonChoice === false ? { enabled: false } : comparisonEnabled ? { enabled: true, url: comparisonUrl || detectedComparisonUrl, targetMatch, maxIterations, ...(browserKind ? { browser: browserKind } : {}) } : undefined); }
  catch (error) { comparisonError = error instanceof Error ? error.message : "Figma 프레임 링크를 확인하세요."; }

  const openBrowser = async () => {
    if (browserBusy) return;
    setBrowserBusy(true);
    setBrowserMessage("");
    setBrowserError("");
    try {
      let targets = await Promise.all(selectedRef.current.map((item, index) => item.context ?? collectTargetContext(item.element, index)));
      if (mode === "page" && targets.length === 0) {
        targets = await Promise.all(collectPageElements().map((element, index) => collectTargetContext(element, index)));
      }
      const context = createContextBundle({
        projectId,
        browserSessionId,
        mode,
        targets,
        ...(region ? { region } : {}),
        requestText: "검증 브라우저 설정",
        scope,
        renderRevision,
      });
      const result = await openComparisonBrowser(token, context, { authMode });
      if (mountedRef.current) setBrowserMessage(result.message);
    } catch (error) {
      if (mountedRef.current) setBrowserError(error instanceof Error ? error.message : "검증 브라우저를 열지 못했습니다. 다시 시도하세요.");
    } finally {
      if (mountedRef.current) setBrowserBusy(false);
    }
  };
  const [renderRevision, setRenderRevision] = useState(1);
  const [geometryRevision, setGeometryRevision] = useState(0);
  const [connection, setConnection] = useState<ConnectionSnapshot>({
    state: "connecting",
    lastSequence: 0,
  });
  const [projectId, setProjectId] = useState(bootstrap.projectId);
  const [viewerUrl, setViewerUrl] = useState<string | null>(authMode === "local" ? "/_visual/viewer" : null);
  const [viewerUrlFailed, setViewerUrlFailed] = useState(false);
  const [task, setTask] = useState<TaskView | null>(null);
  const [taskPanelHidden, setTaskPanelHidden] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const dockVisible = task ? !taskPanelHidden : listOpen;
  const compactDrag = useDraggable(COMPACT_POSITION_KEY);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUpText, setFollowUpText] = useState("");
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitText, setCommitText] = useState("");
  const [pendingAction, setPendingAction] = useState<{ taskId: string } | null>(null);
  const busyAction = pendingAction !== null && pendingAction.taskId === task?.id;
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition>({
    left: 12,
    top: 64,
    placement: "below",
  });

  selectedRef.current = selected;
  requestTextRef.current = requestText;
  renderRevisionRef.current = renderRevision;
  activeTaskIdRef.current = task?.id;

  const trackRenderMutations = Boolean(
    task
    && (
      ACTIVE_PHASES.has(task.status)
      || (
        task.status === "review"
        && !["passed", "partial", "failed"].includes(task.verification ?? "")
      )
    ),
  );

  const pageState = useCallback(
    () => ({
      url: location.href,
      pathname: location.pathname,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      renderRevision: renderRevisionRef.current,
    }),
    [],
  );

  const loadArtifacts = useCallback(
    async (taskId: string) => {
      const artifacts = await fetchTaskArtifacts(token, taskId);
      if (!mountedRef.current) return;
      setTask((current) =>
        current?.id === taskId
          ? {
              ...current,
              changedFiles:
                artifacts.changedFiles.length > 0
                  ? artifacts.changedFiles
                  : current.changedFiles,
              diff: artifacts.diff || current.diff,
              logs: artifacts.logs.length > 0 ? artifacts.logs : current.logs,
              unavailableArtifacts: artifacts.unavailable,
            }
          : current,
      );
    },
    [token],
  );

  const refreshTasks = useCallback(async () => {
    try {
      const records = await fetchTasks(token, { limit: 40 });
      if (!mountedRef.current) return;
      setTasks(orderTasks(records));
      setTasksError(null);
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setTasksError(`작업 목록을 불러오지 못했습니다 (${compactText(message, 120)})`);
    }
  }, [token]);

  const selectTaskFromList = useCallback(
    (record: TaskRecord) => {
      activeTaskIdRef.current = record.id;
      setFollowUpOpen(false);
      setFollowUpText("");
      setCommitOpen(false);
      setTaskPanelHidden(false);
      setListOpen(false);
      setTask(viewFromRecord(record));
      void loadArtifacts(record.id);
    },
    [loadArtifacts],
  );

  const handleServerEvent = useCallback(
    (event: ServerEvent) => {
      const record = taskFromEvent(event);
      const eventTaskId = event.taskId ?? record?.id;
      const phase = phaseFromEvent(event);
      const log = logFromEvent(event);
      const files = changedFilesFromEvent(event);

      if (isTaskRecord(record)) {
        setTasks((current) => upsertTask(current, record));
      }

      if (event.type === "project.state") {
        const payload = event.payload as { projectId?: unknown };
        if (typeof payload?.projectId === "string") {
          setProjectId(payload.projectId);
        }
      }

      if (event.type === "command.error") {
        const payload = event.payload as { message?: unknown };
        if (typeof payload?.message === "string") {
          setTask((current) =>
            current
              ? {
                  ...current,
                  status:
                    current.status === "queued" && !current.id
                      ? "failed"
                      : current.status,
                  error: payload.message as string,
                }
              : current,
          );
        }
        return;
      }

      const route = routeTaskEvent(
        event,
        browserSessionId,
        activeTaskIdRef.current,
      );
      if (!route.accept || !route.taskId) {
        return;
      }
      if (route.bind) {
        activeTaskIdRef.current = route.taskId;
      }

      if (record?.scope) {
        setScope(record.scope);
      }

      if (event.type === "task.verification_result") {
        const payload = event.payload as {
          status?: unknown;
          verificationStatus?: unknown;
        };
        const verification = payload.verificationStatus ?? payload.status;
        if (typeof verification === "string") {
          setTask((current) => (current ? { ...current, verification } : current));
        }
      }

      if (eventTaskId || phase || log || files.length > 0 || record) {
        setTask((current) => {
          const next: TaskView =
            current && (!current.id || current.id === eventTaskId)
              ? current
              : {
                  status: phase ?? record?.status ?? "queued",
                  requestText: record?.requestText ?? requestTextRef.current,
                  changedFiles: [],
                  logs: [],
                  diff: "",
                };
          const error =
            record?.error?.message ??
            ((event.payload as { error?: { message?: unknown } })?.error?.message);
          const { error: priorError, errorCode: priorErrorCode, permissionDeniedTools: priorDeniedTools, ...base } = next;
          return {
            ...base,
            ...(!record && priorError !== undefined ? { error: priorError } : {}),
            ...(!record && priorErrorCode !== undefined ? { errorCode: priorErrorCode } : {}),
            ...(!record && priorDeniedTools !== undefined ? { permissionDeniedTools: priorDeniedTools } : {}),
            ...(eventTaskId ? { id: eventTaskId } : {}),
            status: phase ?? record?.status ?? next.status,
            requestText: record?.requestText ?? next.requestText,
            changedFiles:
              files.length > 0
                ? files
                : record?.changedFiles?.length
                  ? record.changedFiles
                  : next.changedFiles,
            logs: log ? [...next.logs, log].slice(-40) : next.logs,
            ...(record?.comparison ? { comparison: record.comparison } : {}),
            ...(record?.verificationStatus
              ? { verification: record.verificationStatus }
              : {}),
            ...(typeof error === "string" ? { error } : {}),
            ...(record?.error?.code ? { errorCode: record.error.code } : {}),
            ...(record?.permissionDeniedTools ? { permissionDeniedTools: record.permissionDeniedTools } : {}),
            ...(record?.commit ? { commit: record.commit } : {}),
          };
        });
      }

      if (
        eventTaskId &&
        (event.type === "task.diff_ready" ||
          event.type === "task.completed" ||
          event.type === "task.failed")
      ) {
        void loadArtifacts(eventTaskId);
      }
    },
    [browserSessionId, loadArtifacts],
  );

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    let hydrating = true;
    const bufferedEvents: ServerEvent[] = [];
    const hydrationController = new AbortController();
    const finishHydration = () => {
      if (!hydrating) return;
      hydrating = false;
      window.clearTimeout(hydrationTimer);
      if (active) {
        if (!activeTaskIdRef.current) {
          for (const event of bufferedEvents) {
            const record = taskFromEvent(event);
            if (record?.originBrowserSessionId === browserSessionId) {
              activeTaskIdRef.current = record.id;
              break;
            }
          }
        }
        for (const event of bufferedEvents) {
          handleServerEvent(event);
        }
      }
      bufferedEvents.length = 0;
    };
    // A stalled snapshot must not hold a healthy live connection hostage.
    const hydrationTimer = window.setTimeout(() => {
      finishHydration();
      hydrationController.abort();
    }, TASK_HYDRATION_TIMEOUT_MS);
    const bridge = new BridgeConnection({
      token,
      authMode,
      browserSessionId,
      getPageState: pageState,
      onSnapshot: (snapshot) => {
        if (!active) return;
        setConnection(snapshot);
        if (snapshot.projectId) {
          setProjectId(snapshot.projectId);
        }
      },
      onEvent: (event) => {
        if (!active) return;
        if (hydrating) {
          bufferedEvents.push(event);
        } else {
          handleServerEvent(event);
        }
      },
    });
    connectionRef.current = bridge;
    bridge.connect();
    void refreshTasks();
    void fetchProjectId(token)
      .then((id) => {
        if (active && id) {
          setProjectId(id);
        }
      })
      .catch(() => undefined);
    void fetchVerificationInfo(token)
      .then((info) => {
        if (active && info) setVerificationInfo(info);
      })
      .catch(() => undefined);
    void fetchLatestTaskForSession(token, browserSessionId, hydrationController.signal)
      .then((latestTask) => {
        if (!active || !hydrating || !latestTask) {
          return;
        }
        setTask((current) => {
          if (current) {
            return current;
          }
          activeTaskIdRef.current = latestTask.id;
          return viewFromRecord(latestTask);
        });
        void loadArtifacts(latestTask.id);
      })
      .catch(() => undefined)
      .finally(finishHydration);

    return () => {
      active = false;
      hydrating = false;
      window.clearTimeout(hydrationTimer);
      hydrationController.abort();
      mountedRef.current = false;
      bufferedEvents.length = 0;
      pendingActionRef.current = null;
      bridge.close();
      connectionRef.current = null;
    };
  }, [authMode, browserSessionId, handleServerEvent, loadArtifacts, pageState, refreshTasks, token]);

  useEffect(() => {
    if (dockVisible) void refreshTasks();
  }, [dockVisible, refreshTasks]);

  useEffect(() => {
    if (authMode === "local") return;
    let active = true;
    setViewerUrlFailed(false);
    void fetchViewerUrl(token)
      .then((url) => {
        if (active) setViewerUrl(url);
      })
      .catch(() => {
        if (active) {
          setViewerUrl(null);
          setViewerUrlFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [authMode, token]);

  useEffect(() => {
    host.dataset.active = open ? "true" : "false";
    if (open) {
      requestAnimationFrame(() => {
        toolbarRef.current
          ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
          ?.focus();
      });
    }
  }, [host, open]);

  useEffect(() => {
    if (!trackRenderMutations) return;
    let quietTimer: number | undefined;
    let maxTimer: number | undefined;
    const flushRevision = () => {
      if (quietTimer !== undefined) {
        clearTimeout(quietTimer);
        quietTimer = undefined;
      }
      if (maxTimer !== undefined) {
        clearTimeout(maxTimer);
        maxTimer = undefined;
      }
      setRenderRevision((revision) => revision + 1);
    };
    const observer = new MutationObserver((records) => {
      const hasPageMutation = records.some(
        ({ target }) => target !== host && !host.contains(target),
      );
      if (!hasPageMutation) {
        return;
      }
      if (quietTimer !== undefined) {
        clearTimeout(quietTimer);
      }
      quietTimer = window.setTimeout(flushRevision, 150);
      if (maxTimer === undefined) {
        maxTimer = window.setTimeout(flushRevision, 1_000);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      if (quietTimer !== undefined) {
        clearTimeout(quietTimer);
      }
      if (maxTimer !== undefined) {
        clearTimeout(maxTimer);
      }
    };
  }, [host, trackRenderMutations]);

  useEffect(() => {
    connectionRef.current?.send("browser.page_state", pageState());
  }, [pageState, renderRevision]);

  useEffect(() => {
    if (
      connection.state !== "connected"
      || !task?.id
      || task.verification === "passed"
      || task.verification === "partial"
      || task.verification === "failed"
      || (!ACTIVE_PHASES.has(task.status) && task.status !== "review")
    ) {
      return;
    }

    const context = lastContextBundleRef.current;
    if (!context) {
      const reportKey = `${task.id}:page-reloaded`;
      if (lastTargetReportRef.current === reportKey) {
        return;
      }
      const sent = connectionRef.current?.send("verification.target_state", {
        taskId: task.id,
        state: "page-reloaded",
        renderRevision,
        targetCount: 0,
        foundCount: 0,
        changedCount: 0,
      });
      if (sent) {
        lastTargetReportRef.current = reportKey;
      }
      return;
    }

    const targets = context.selection.targets;
    if (
      context.selection.mode === "page"
      || targets.length === 0
      || renderRevision <= context.page.renderRevision
    ) {
      return;
    }
    const reportKey = `${task.id}:${renderRevision}`;
    if (lastTargetReportRef.current === reportKey) {
      return;
    }

    let report: ReturnType<typeof relocateTargets>;
    try {
      report = relocateTargets(targets);
    } catch {
      report = {
        state: "unverified",
        targetCount: targets.length,
        foundCount: 0,
        changedCount: 0,
      };
    }
    const sent = connectionRef.current?.send("verification.target_state", {
      taskId: task.id,
      renderRevision,
      ...report,
    });
    if (sent) {
      lastTargetReportRef.current = reportKey;
    }
  }, [
    connection.state,
    renderRevision,
    task?.id,
    task?.status,
    task?.verification,
  ]);

  useEffect(() => {
    const publish = (
      level: "warning" | "error" | "unhandled",
      values: unknown[],
    ) => {
      const message = compactText(values.map(consoleText).join(" "), 2_000);
      if (!message) {
        return;
      }
      connectionRef.current?.send("verification.console_events", {
        events: [{ level, message, createdAt: new Date().toISOString() }],
      });
    };
    const originalError = console.error;
    const originalWarn = console.warn;
    const wrappedError = (...values: unknown[]) => {
      originalError.apply(console, values);
      publish("error", values);
    };
    const wrappedWarn = (...values: unknown[]) => {
      originalWarn.apply(console, values);
      publish("warning", values);
    };
    const onError = (event: ErrorEvent) => {
      publish("error", [
        event.error instanceof Error ? event.error : event.message,
      ]);
    };
    const onUnhandled = (event: PromiseRejectionEvent) => {
      publish("unhandled", [event.reason]);
    };

    console.error = wrappedError;
    console.warn = wrappedWarn;
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => {
      if (console.error === wrappedError) {
        console.error = originalError;
      }
      if (console.warn === wrappedWarn) {
        console.warn = originalWarn;
      }
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandled);
    };
  }, []);

  const resetSelection = useCallback(() => {
    setSelected([]);
    setHovered(null);
    setRegion(null);
    setRequestOpen(false);
    setRequestText("");
    setFollowUpOpen(false);
    dragStartRef.current = null;
  }, []);

  const captureElements = useCallback((elements: HTMLElement[]) => {
    const items = elements.map((element) => ({
      id: crypto.randomUUID(),
      element,
      context: null,
    }));
    setSelected(items);
    for (const [index, item] of items.entries()) {
      void collectTargetContext(item.element, index).then((context) => {
        setSelected((current) =>
          current.map((candidate) =>
            candidate.id === item.id ? { ...candidate, context } : candidate,
          ),
        );
      });
    }
  }, []);

  const chooseMode = useCallback(
    (nextMode: SelectionMode) => {
      resetSelection();
      setTaskPanelHidden(Boolean(task));
      setMode(nextMode);
      setScope(nextMode === "page" ? "page" : "instance");
      if (nextMode === "page") {
        captureElements(collectPageElements());
        setRequestOpen(true);
      }
    },
    [captureElements, resetSelection, task],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "g" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        setOpen((value) => !value);
        return;
      }

      if (!open) {
        return;
      }

      if (event.key === "Escape") {
        if (requestOpen) {
          resetSelection();
        } else {
          setOpen(false);
        }
      } else if (
        event.key === "Enter" &&
        mode === "multi" &&
        selectedRef.current.length > 0 &&
        !requestOpen &&
        (!task || taskPanelHidden) &&
        !eventIsFromOverlay(event)
      ) {
        event.preventDefault();
        setRequestOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [mode, open, requestOpen, resetSelection, task, taskPanelHidden]);

  useEffect(() => {
    if (
      !open
      || requestOpen
      || Boolean(
        task && ACTIVE_PHASES.has(task.status) && !taskPanelHidden,
      )
    ) {
      setHovered(null);
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      if (mode === "region" && dragStartRef.current) {
        setRegion(
          normalizeRect(dragStartRef.current, { x: event.clientX, y: event.clientY }),
        );
        return;
      }
      if (mode === "page" || eventIsFromOverlay(event)) {
        return;
      }
      const target = getEligibleElementAtPoint(event.clientX, event.clientY);
      setHovered((current) => (current === target ? current : target));
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || eventIsFromOverlay(event) || mode === "page") {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (mode !== "region") {
        return;
      }
      dragStartRef.current = { x: event.clientX, y: event.clientY };
      setRegion({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
      setSelected([]);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        eventIsFromOverlay(event) ||
        mode === "page"
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (mode !== "region" || !dragStartRef.current) {
        return;
      }
      const finalRegion = normalizeRect(dragStartRef.current, {
        x: event.clientX,
        y: event.clientY,
      });
      dragStartRef.current = null;
      if (finalRegion.width < 5 || finalRegion.height < 5) {
        setRegion(null);
        return;
      }
      setRegion(finalRegion);
      captureElements(collectRegionElements(finalRegion));
      setRequestOpen(true);
    };

    const onClick = (event: MouseEvent) => {
      if (
        mode === "region" ||
        mode === "page" ||
        event.button !== 0 ||
        eventIsFromOverlay(event)
      ) {
        return;
      }
      const target = getEligibleElementAtPoint(event.clientX, event.clientY);
      if (!target) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();

      setTaskPanelHidden(Boolean(task));

      const multi = mode === "multi" || event.shiftKey;
      if (!multi) {
        captureElements([target]);
        setRequestOpen(true);
        return;
      }

      if (mode !== "multi") {
        setMode("multi");
      }
      const existing = selectedRef.current;
      const matched = existing.find((item) => item.element === target);
      if (matched) {
        setSelected(existing.filter((item) => item.id !== matched.id));
        return;
      }
      if (existing.length >= 8) {
        return;
      }
      const item: SelectionItem = {
        id: crypto.randomUUID(),
        element: target,
        context: null,
      };
      setSelected([...existing, item]);
      void collectTargetContext(target, existing.length).then((context) => {
        setSelected((current) =>
          current.map((candidate) =>
            candidate.id === item.id ? { ...candidate, context } : candidate,
          ),
        );
      });
    };

    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [captureElements, mode, open, requestOpen, task, taskPanelHidden]);

  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setGeometryRevision((revision) => revision + 1),
      );
    };
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, []);

  useEffect(() => {
    if (!requestOpen) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setGeometryRevision((revision) => revision + 1),
      );
    });
    observer.observe(panel);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [requestOpen]);

  const anchor = useMemo<Rect>(() => {
    if (region) {
      return region;
    }
    const last = selected.at(-1);
    if (last?.element.isConnected) {
      return rectForElement(last.element);
    }
    return { x: 12, y: 52, width: 1, height: 1 };
  }, [geometryRevision, region, selected]);

  useLayoutEffect(() => {
    if (!requestOpen) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const toolbarBottom =
      toolbarRef.current?.getBoundingClientRect().bottom ?? 52;
    setPopoverPosition(
      calculatePopoverPosition(
        anchor,
        {
          width: panel.offsetWidth || 408,
          height: panel.offsetHeight || 300,
        },
        { width: innerWidth, height: innerHeight },
        12,
        10,
        toolbarBottom + 10,
      ),
    );
  }, [anchor, requestOpen]);

  const submitRequest = useCallback(async () => {
    const trimmed = requestText.trim();
    if (!trimmed || connection.state !== "connected") {
      return;
    }
    if (comparisonError) return;

    let contexts = await Promise.all(
      selectedRef.current.map(async (item, index) =>
        item.context ?? collectTargetContext(item.element, index),
      ),
    );
    if (mode === "element" && contexts.length === 0) {
      return;
    }
    if (mode === "page" && contexts.length === 0) {
      const elements = collectPageElements();
      contexts = await Promise.all(
        elements.map((element, index) => collectTargetContext(element, index)),
      );
    }

    const bundle = createContextBundle({
      projectId,
      browserSessionId,
      mode,
      targets: contexts,
      ...(region ? { region } : {}),
      requestText: trimmed,
      scope,
      renderRevision,
    });
    if (comparisonRequest) bundle.request.comparison = comparisonRequest;
    lastContextBundleRef.current = bundle;
    const sent = connectionRef.current?.send(
      "task.create",
      createTaskPayload(bundle),
    );
    if (!sent) {
      setTaskPanelHidden(false);
      setTask({
        status: "failed",
        requestText: trimmed,
        changedFiles: [],
        logs: [],
        diff: "",
        error: "Bridge 연결이 끊어져 요청을 보내지 못했습니다. 재연결 후 다시 시도하세요.",
      });
      return;
    }

    setTask({
      status: "queued",
      requestText: trimmed,
      changedFiles: [],
      logs: ["요청을 Bridge writer queue에 전달했습니다."],
      diff: "",
    });
    setTaskPanelHidden(false);
    setRequestOpen(false);
  }, [
    comparisonError,
    comparisonRequest,
    browserSessionId,
    connection.state,
    mode,
    projectId,
    region,
    renderRevision,
    requestText,
    scope,
  ]);

  const toggleCommitForm = useCallback(() => {
    setCommitOpen((open) => {
      if (!open) {
        setFollowUpOpen(false);
        setCommitText((text) => (text.trim() ? text : task ? suggestedCommitMessage(task) : ""));
      }
      return !open;
    });
  }, [task]);

  const submitCommit = useCallback(async () => {
    if (!task?.id || pendingActionRef.current?.taskId === task.id) return;
    const message = commitText.trim();
    if (!message) return;
    const request = { taskId: task.id };
    pendingActionRef.current = request;
    setPendingAction(request);
    try {
      const committed = await commitTask(token, request.taskId, message);
      if (pendingActionRef.current !== request) return;
      setCommitOpen(false);
      setCommitText("");
      setTask((current) =>
        current?.id === request.taskId
          ? {
              ...current,
              status: committed.status,
              ...(committed.commit ? { commit: committed.commit } : {}),
              logs: [
                ...current.logs,
                committed.commit
                  ? `변경을 커밋했습니다 (${committed.commit.sha.slice(0, 7)}).`
                  : "커밋 요청을 보냈습니다.",
              ],
            }
          : current,
      );
      setTasks((current) => upsertTask(current, committed));
    } catch (error) {
      if (pendingActionRef.current !== request) return;
      setTask((current) =>
        current?.id === request.taskId
          ? {
              ...current,
              error: error instanceof Error ? error.message : "커밋을 완료하지 못했습니다.",
            }
          : current,
      );
    } finally {
      if (pendingActionRef.current === request) {
        pendingActionRef.current = null;
        setPendingAction(null);
      }
    }
  }, [commitText, task, token]);

  const runTaskAction = useCallback(
    async (action: "accept" | "revert" | "cancel") => {
      if (!task?.id || pendingActionRef.current?.taskId === task.id) {
        return;
      }
      const request = { taskId: task.id };
      pendingActionRef.current = request;
      setPendingAction(request);
      try {
        await postTaskAction(token, request.taskId, action);
        if (pendingActionRef.current !== request) return;
        setTask((current) =>
          current?.id === request.taskId
            ? {
                ...current,
                status:
                  action === "accept"
                    ? "accepted"
                    : action === "revert"
                      ? "reverted"
                      : "canceled",
                logs: [
                  ...current.logs,
                  action === "accept"
                    ? "현재 working tree 변경을 유지했습니다."
                    : action === "revert"
                      ? "최신 task 변경을 되돌렸습니다."
                      : "작업 취소를 요청했습니다.",
                ],
              }
            : current,
        );
      } catch (error) {
        if (pendingActionRef.current !== request) return;
        setTask((current) =>
          current?.id === request.taskId
            ? {
                ...current,
                error:
                  error instanceof Error
                    ? error.message
                    : "작업 명령을 완료하지 못했습니다.",
              }
            : current,
        );
      } finally {
        if (pendingActionRef.current === request) {
          pendingActionRef.current = null;
          setPendingAction((current) => current === request ? null : current);
        }
      }
    },
    [task?.id, token],
  );

  const approveToolsAndRetry = useCallback(async () => {
    if (!task?.id || pendingActionRef.current?.taskId === task.id) return;
    const tools = eligibleDeniedTools(task);
    if (tools.length === 0) return;
    const request = { taskId: task.id };
    pendingActionRef.current = request;
    setPendingAction(request);
    try {
      const retry = await approveTaskTools(token, request.taskId, tools, { authMode });
      if (!mountedRef.current || pendingActionRef.current !== request) return;
      // The socket may already have bound and advanced the retry or a newer task.
      // Only replace the denied task; never replay a stale HTTP snapshot over it.
      setTask((current) => {
        if (current?.id !== request.taskId) return current;
        activeTaskIdRef.current = retry.id;
        return {
          id: retry.id,
          status: retry.status,
          requestText: retry.requestText,
          changedFiles: retry.changedFiles,
          logs: [],
          diff: "",
          ...(retry.comparison ? { comparison: retry.comparison } : {}),
          ...(retry.verificationStatus ? { verification: retry.verificationStatus } : {}),
          ...(retry.error?.message ? { error: retry.error.message } : {}),
          ...(retry.error?.code ? { errorCode: retry.error.code } : {}),
          ...(retry.permissionDeniedTools ? { permissionDeniedTools: retry.permissionDeniedTools } : {}),
        };
      });
    } catch (error) {
      if (!mountedRef.current || pendingActionRef.current !== request) return;
      setTask((current) => current?.id === request.taskId
        ? { ...current, error: error instanceof Error ? error.message : "도구 허용 후 재시도를 시작하지 못했습니다." }
        : current);
    } finally {
      if (pendingActionRef.current === request) {
        pendingActionRef.current = null;
        if (mountedRef.current) setPendingAction((current) => current === request ? null : current);
      }
    }
  }, [task, token, authMode]);

  const submitFollowUp = useCallback(async () => {
    if (!task?.id || !followUpText.trim()) {
      return;
    }
    let previousBundle = lastContextBundleRef.current;
    if (!previousBundle) {
      const elements = collectPageElements();
      const contexts = await Promise.all(
        elements.map((element, index) => collectTargetContext(element, index)),
      );
      previousBundle = createContextBundle({
        projectId,
        browserSessionId,
        mode: "page",
        targets: contexts,
        requestText: task.requestText,
        scope: "page",
        renderRevision,
      });
    }
    const contextBundle: ContextBundle = {
      ...previousBundle,
      page: {
        ...previousBundle.page,
        url: location.href,
        pathname: location.pathname,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio: devicePixelRatio || 1,
        scroll: { x: scrollX, y: scrollY },
        renderRevision,
      },
      request: { text: followUpText.trim(), scope },
    };
    try {
      const detected = normalizeComparisonRequest(followUpText, comparisonChoice === false ? { enabled: false } : undefined);
      const inherited = previousBundle.request.comparison ?? (task.comparison ? {
        enabled: true, url: task.comparison.url, maxIterations: task.comparison.maxIterations,
        ...(task.comparison.targetMatch !== undefined ? { targetMatch: task.comparison.targetMatch } : {}),
        ...(task.comparison.threshold !== undefined ? { threshold: task.comparison.threshold } : {}),
      } : undefined);
      const comparison = detected ?? (inherited ? normalizeComparisonRequest(followUpText, inherited) : undefined);
      if (comparison) contextBundle.request.comparison = comparison;
    } catch (error) {
      setTask((current) => current ? { ...current, error: error instanceof Error ? error.message : "Figma 링크를 확인하세요." } : current);
      return;
    }
    const sent = connectionRef.current?.send("task.follow_up", {
      taskId: task.id,
      parentTaskId: task.id,
      contextBundle,
    });
    if (!sent) {
      setTask((current) =>
        current
          ? {
              ...current,
              error: "Bridge가 연결되지 않아 후속 요청을 보내지 못했습니다.",
            }
          : current,
      );
      return;
    }
    setTask({
      status: "queued",
      requestText: followUpText.trim(),
      changedFiles: [],
      logs: [`${task.id.slice(0, 8)} task를 기준으로 후속 요청을 보냈습니다.`],
      diff: "",
    });
    setTaskPanelHidden(false);
    setFollowUpText("");
    setFollowUpOpen(false);
    lastContextBundleRef.current = contextBundle;
  }, [
    comparisonChoice,
    browserSessionId,
    followUpText,
    projectId,
    renderRevision,
    scope,
    task?.id,
    task?.comparison,
    task?.requestText,
  ]);

  const selectedRects = selected
    .filter((item) => item.element.isConnected)
    .map((item) => ({ item, rect: rectForElement(item.element) }));
  const hoverRect =
    hovered?.isConnected && !selected.some((item) => item.element === hovered)
      ? rectForElement(hovered)
      : null;
  void geometryRevision;

  const hint =
    mode === "element"
      ? "요소를 클릭하세요 · Shift+Click은 여러 요소"
      : mode === "multi"
        ? `요소를 선택하세요 (${selected.length}/8) · Enter로 요청 작성`
        : mode === "region"
          ? "요청할 영역을 드래그하세요"
          : "현재 페이지의 주요 컨텍스트를 수집했습니다";

  return (
    <div class="visual-shell" data-open={open ? "true" : "false"}>
      <nav ref={toolbarRef} class="toolbar" aria-label="Visual Bridge 도구">
        <span class="brand-mark">Visual Bridge</span>
        <div class="mode-tabs">
          {(
            [
              ["element", "요소"],
              ["multi", "여러 요소"],
              ["region", "영역"],
              ["page", "페이지"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value ? "true" : "false"}
              disabled={Boolean(
                task && ACTIVE_PHASES.has(task.status) && !taskPanelHidden,
              )}
              onClick={() => chooseMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "multi"
        && selected.length > 0
        && !requestOpen
        && (!task || taskPanelHidden) ? (
          <button
            type="button"
            class="primary"
            onClick={() => setRequestOpen(true)}
          >
            요청 작성
          </button>
        ) : null}
        {!task && !requestOpen ? (
          <button
            type="button"
            class="task-toggle"
            aria-controls="visual-task-dock"
            aria-expanded={listOpen ? "true" : "false"}
            title={listOpen ? "작업 패널 닫기" : "전체 작업 목록 열기"}
            onClick={() => setListOpen((value) => !value)}
          >
            {listOpen ? "작업 닫기" : "작업 목록"}
          </button>
        ) : null}
        {task && !requestOpen ? (
          <button
            type="button"
            class="task-toggle"
            aria-controls="visual-task-dock"
            aria-expanded={taskPanelHidden ? "false" : "true"}
            title={
              taskPanelHidden
                ? "최소화된 작업 상세 펼치기"
                : "작업 상태를 남기고 패널 최소화"
            }
            onClick={() => {
              if (taskPanelHidden) {
                setTaskPanelHidden(false);
                return;
              }
              resetSelection();
              setTaskPanelHidden(true);
            }}
          >
            {taskPanelHidden ? "작업 펼치기" : "작업 최소화"}
          </button>
        ) : null}
        {viewerUrl ? (
          <a
            class="viewer-link"
            href={viewerUrl}
            target="_blank"
            rel="noopener"
            aria-label="전체화면 작업 보드를 새 탭에서 열기"
            title="전체화면 작업 보드 열기"
          >
            작업 보드 ↗
          </a>
        ) : (
          <button
            type="button"
            class="viewer-link"
            disabled
            title={viewerUrlFailed ? "작업 보드 연결을 준비하지 못했습니다" : "작업 보드 준비 중"}
          >
            작업 보드
          </button>
        )}
        <span class="connection" role="status">
          <span class="state-dot" data-state={connection.state} aria-hidden="true" />
          <span class="connection-label connection-label-full">
            {CONNECTION_LABELS[connection.state]}
          </span>
          <span class="connection-label connection-label-compact">
            {CONNECTION_COMPACT_LABELS[connection.state]}
          </span>
        </span>
      </nav>

      {task && taskPanelHidden ? (
        <TaskCompactStrip
          task={task}
          busyAction={busyAction}
          drag={compactDrag}
          onExpand={() => setTaskPanelHidden(false)}
          onCancel={() => void runTaskAction("cancel")}
        />
      ) : null}

      {!requestOpen
      && (!task || taskPanelHidden || !ACTIVE_PHASES.has(task.status))
      && hoverRect ? (
        <Reticle rect={hoverRect} kind="hover" />
      ) : null}
      {mode !== "page"
      && mode !== "region"
      && (!task || !taskPanelHidden || requestOpen)
        ? selectedRects.map(({ item, rect }, index) => (
            <Reticle
              key={item.id}
              rect={rect}
              kind="selected"
              {...(mode === "multi" ? { label: String(index + 1) } : {})}
            />
          ))
        : null}
      {region && (!task || !taskPanelHidden || requestOpen) ? (
        <div
          class="region-box"
          style={{
            left: `${region.x}px`,
            top: `${region.y}px`,
            width: `${region.width}px`,
            height: `${region.height}px`,
          }}
          aria-hidden="true"
        >
          <span class="region-box-label machine">영역</span>
        </div>
      ) : null}

      {requestOpen && (!task || taskPanelHidden) ? (
        <RequestStrip
          panelRef={panelRef}
          position={popoverPosition}
          selection={selected}
          mode={mode}
          connectionState={connection.state}
          requestText={requestText}
          scope={scope}
          comparisonEnabled={comparisonEnabled}
          comparisonUrl={comparisonUrl || detectedComparisonUrl}
          comparisonError={comparisonError}
          browserMessage={browserMessage}
          browserError={browserError}
          browserBusy={browserBusy}
          browserKinds={browserKinds}
          browserKind={browserKind}
          comparisonTarget={comparisonTarget}
          comparisonRounds={comparisonRounds}
          onComparisonTarget={setComparisonTarget}
          onComparisonRounds={setComparisonRounds}
          onComparisonEnabled={setComparisonChoice}
          onComparisonUrl={setComparisonUrl}
          onOpenBrowser={() => void openBrowser()}
          onBrowserKind={setBrowserChoice}
          composingRef={compositionRef}
          onRequestText={setRequestText}
          onScope={setScope}
          onSubmit={() => void submitRequest()}
        />
      ) : null}

      {dockVisible ? (
        <TaskDock
          task={task}
          tasks={tasks}
          tasksError={tasksError}
          onSelectTask={selectTaskFromList}
          onRefresh={() => void refreshTasks()}
          onClose={() => {
            if (task) {
              resetSelection();
              setTaskPanelHidden(true);
              return;
            }
            setListOpen(false);
          }}
        >
          {task ? (
        <TaskStrip
          docked
          task={task}
          followUpOpen={followUpOpen}
          followUpText={followUpText}
          commitOpen={commitOpen}
          commitText={commitText}
          composingRef={compositionRef}
          busyAction={busyAction}
          onCancel={() => void runTaskAction("cancel")}
          onAccept={() => void runTaskAction("accept")}
          onRevert={() => void runTaskAction("revert")}
          onApproveTools={() => void approveToolsAndRetry()}
          onToggleFollowUp={() => {
            setCommitOpen(false);
            setFollowUpOpen((value) => !value);
          }}
          onFollowUpText={setFollowUpText}
          onFollowUp={() => void submitFollowUp()}
          onToggleCommit={toggleCommitForm}
          onCommitText={setCommitText}
          onCommit={() => void submitCommit()}
          onNewRequest={() => {
            setTask(null);
            setTaskPanelHidden(false);
            resetSelection();
          }}
          onDismiss={() => {
            activeTaskIdRef.current = undefined;
            setTask(null);
            setTaskPanelHidden(false);
            resetSelection();
          }}
        />
          ) : null}
        </TaskDock>
      ) : null}

      {!requestOpen
      && (!task || taskPanelHidden) ? (
        <div class="selection-hint">{hint}</div>
      ) : null}
      <div class="visually-hidden" aria-live="polite">
        {task ? `${PHASE_LABELS[task.status]}. ${task.logs.at(-1) ?? ""}` : hint}
      </div>
      <span class="visually-hidden">
        Overlay 열기 또는 닫기: Command 또는 Control + Shift + G
      </span>
    </div>
  );
}

function mountOverlay(): void {
  if (document.getElementById(OVERLAY_HOST_ID) || !document.body) {
    return;
  }

  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  host.dataset.visualBridgeIgnore = "true";
  host.dataset.active = "false";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = overlayStyles;
  const mountPoint = document.createElement("div");
  mountPoint.dataset.visualBridgeIgnore = "true";
  shadow.append(style, mountPoint);
  document.body.append(host);
  void fetchBootstrap().then((bootstrap) => {
    render(<Overlay host={host} bootstrap={bootstrap} />, mountPoint);
  }).catch(() => {
    host.dataset.active = "true";
    render(
      <div class="visual-shell" data-open="true">
        <div class="toolbar" role="alert">
          <span>Bridge 설정을 불러오지 못했습니다. Bridge 실행과 연결을 확인한 뒤 다시 시도하세요.</span>
          <button type="button" onClick={() => location.reload()}>다시 시도</button>
        </div>
      </div>,
      mountPoint,
    );
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
} else {
  mountOverlay();
}
