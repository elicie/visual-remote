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
  ContextBundle,
  Rect,
  ServerEvent,
  TargetContext,
  TaskStatus,
} from "@visual-remote/protocol";
import {
  BridgeConnection,
  changedFilesFromEvent,
  consumePairingToken,
  createTaskPayload,
  fetchLatestTaskForSession,
  fetchProjectId,
  fetchTaskArtifacts,
  getBrowserSessionId,
  logFromEvent,
  phaseFromEvent,
  postTaskAction,
  routeTaskEvent,
  taskFromEvent,
  type ConnectionSnapshot,
  type ConnectionState,
} from "./bridge.js";
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
  compactText,
  normalizeRect,
  shouldSubmitOnEnter,
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
  changedFiles: string[];
  logs: string[];
  diff: string;
  verification?: string;
  error?: string;
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
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
      ref={panelRef}
      class="strip"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      aria-label="수정 요청 작성"
    >
      <header class="strip-head">
        <span class="strip-title">{sourceLabel(first)}</span>
        <span class="strip-code machine">
          {mode === "element"
            ? "TARGET 1"
            : mode === "multi"
              ? `TARGETS ${selection.length}/8`
              : mode === "region"
                ? `REGION ${selection.length}/20`
                : "PAGE"}
        </span>
      </header>
      <div class="strip-body">
        <div class="selection-readout">
          <strong>
            {mode === "page"
              ? "현재 페이지 컨텍스트"
              : `${selection.length}개 대상 선택`}
          </strong>
          <span>
            {pendingCount > 0
              ? `소스 ${pendingCount}개 확인 중`
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
  task,
  followUpOpen,
  followUpText,
  composingRef,
  busyAction,
  onCancel,
  onAccept,
  onRevert,
  onToggleFollowUp,
  onFollowUpText,
  onFollowUp,
  onNewRequest,
}: {
  panelRef: preact.RefObject<HTMLDivElement>;
  position: PopoverPosition;
  task: TaskView;
  followUpOpen: boolean;
  followUpText: string;
  composingRef: preact.RefObject<boolean>;
  busyAction: boolean;
  onCancel: () => void;
  onAccept: () => void;
  onRevert: () => void;
  onToggleFollowUp: () => void;
  onFollowUpText: (value: string) => void;
  onFollowUp: () => void;
  onNewRequest: () => void;
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
      ref={panelRef}
      class="strip"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      aria-label="작업 진행과 검토"
    >
      <header class="strip-head">
        <span class="strip-title">{compactText(task.requestText, 72)}</span>
        <span class="strip-code machine">
          {task.id ? `TASK ${task.id.slice(0, 8)}` : "DISPATCH"}
        </span>
      </header>
      <div class="strip-body">
        <div class="status-row" role="status" aria-live="polite">
          <span
            class="phase-mark"
            data-state={task.status}
            data-terminal={terminal ? "true" : "false"}
            data-error={errorOutcome ? "true" : "false"}
            aria-hidden="true"
          />
          <span class="phase-copy">
            <strong>{PHASE_LABELS[task.status]}</strong>
            <span>{task.logs.at(-1) ?? "Bridge에서 작업 상태를 기다리는 중입니다."}</span>
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
              <li key={`${index}-${log}`}>{log}</li>
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

        {task.status === "unsafe" ? (
          <div class="error-banner" role="alert">
            저장소 상태가 작업 중 바뀌어 자동 유지·되돌리기를 잠갔습니다. 아래 diff를
            확인한 뒤 Git으로 수동 복구하세요.
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
          {canStartNew ? (
            <button type="button" class="secondary" onClick={onNewRequest}>
              새 요청
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
      </div>
    </section>
  );
}

function Overlay({ host }: { host: HTMLElement }) {
  const token = useMemo(consumePairingToken, []);
  const browserSessionId = useMemo(getBrowserSessionId, []);
  const connectionRef = useRef<BridgeConnection | null>(null);
  const selectedRef = useRef<SelectionItem[]>([]);
  const requestTextRef = useRef("");
  const activeTaskIdRef = useRef<string | undefined>(undefined);
  const lastContextBundleRef = useRef<ContextBundle | null>(null);
  const dragStartRef = useRef<Point | null>(null);
  const compositionRef = useRef(false);
  const renderRevisionRef = useRef(1);
  const lastTargetReportRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SelectionMode>("element");
  const [selected, setSelected] = useState<SelectionItem[]>([]);
  const [hovered, setHovered] = useState<HTMLElement | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestText, setRequestText] = useState("");
  const [scope, setScope] = useState<RequestScope>("instance");
  const [renderRevision, setRenderRevision] = useState(1);
  const [geometryRevision, setGeometryRevision] = useState(0);
  const [connection, setConnection] = useState<ConnectionSnapshot>({
    state: token ? "connecting" : "unpaired",
    lastSequence: 0,
  });
  const [projectId, setProjectId] = useState("current");
  const [task, setTask] = useState<TaskView | null>(null);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUpText, setFollowUpText] = useState("");
  const [busyAction, setBusyAction] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition>({
    left: 12,
    top: 64,
    placement: "below",
  });

  selectedRef.current = selected;
  requestTextRef.current = requestText;
  renderRevisionRef.current = renderRevision;
  activeTaskIdRef.current = task?.id;

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
      if (!token) {
        return;
      }
      const artifacts = await fetchTaskArtifacts(token, taskId);
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
            }
          : current,
      );
    },
    [token],
  );

  const handleServerEvent = useCallback(
    (event: ServerEvent) => {
      const record = taskFromEvent(event);
      const eventTaskId = event.taskId ?? record?.id;
      const phase = phaseFromEvent(event);
      const log = logFromEvent(event);
      const files = changedFilesFromEvent(event);

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
          return {
            ...next,
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
            ...(record?.verificationStatus
              ? { verification: record.verificationStatus }
              : {}),
            ...(typeof error === "string" ? { error } : {}),
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
    if (!token) {
      return;
    }

    const bridge = new BridgeConnection({
      token,
      browserSessionId,
      getPageState: pageState,
      onSnapshot: (snapshot) => {
        setConnection(snapshot);
        if (snapshot.projectId) {
          setProjectId(snapshot.projectId);
        }
      },
      onEvent: handleServerEvent,
    });
    connectionRef.current = bridge;
    bridge.connect();
    void fetchProjectId(token)
      .then((id) => {
        if (id) {
          setProjectId(id);
        }
      })
      .catch(() => undefined);
    void fetchLatestTaskForSession(token, browserSessionId)
      .then((latestTask) => {
        if (!latestTask) {
          return;
        }
        setTask((current) => {
          if (current) {
            return current;
          }
          activeTaskIdRef.current = latestTask.id;
          return {
            id: latestTask.id,
            status: latestTask.status,
            requestText: latestTask.requestText,
            changedFiles: latestTask.changedFiles,
            logs: [],
            diff: "",
            ...(latestTask.verificationStatus
              ? { verification: latestTask.verificationStatus }
              : {}),
            ...(latestTask.error?.message
              ? { error: latestTask.error.message }
              : {}),
          };
        });
        void loadArtifacts(latestTask.id);
      })
      .catch(() => undefined);

    return () => {
      bridge.close();
      connectionRef.current = null;
    };
  }, [browserSessionId, handleServerEvent, loadArtifacts, pageState, token]);

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
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        setRenderRevision((revision) => revision + 1);
      }, 250);
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      observer.disconnect();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, []);

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
      setTask(null);
      setMode(nextMode);
      setScope(nextMode === "page" ? "page" : "instance");
      if (nextMode === "page") {
        captureElements(collectPageElements());
        setRequestOpen(true);
      }
    },
    [captureElements, resetSelection],
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
        if (requestOpen && !task) {
          resetSelection();
        } else {
          setOpen(false);
        }
      } else if (
        event.key === "Enter" &&
        mode === "multi" &&
        selectedRef.current.length > 0 &&
        !requestOpen &&
        !eventIsFromOverlay(event)
      ) {
        event.preventDefault();
        setRequestOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [mode, open, requestOpen, resetSelection, task]);

  useEffect(() => {
    if (!open || requestOpen || task || !token) {
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
  }, [captureElements, mode, open, requestOpen, task, token]);

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
    if (!requestOpen && !task) {
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
  }, [requestOpen, task?.id]);

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
    if (!requestOpen && !task) {
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
  }, [
    anchor,
    followUpOpen,
    requestOpen,
    task?.changedFiles.length,
    task?.diff,
    task?.logs.length,
    task?.status,
  ]);

  const submitRequest = useCallback(async () => {
    const trimmed = requestText.trim();
    if (!trimmed || connection.state !== "connected") {
      return;
    }

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
    lastContextBundleRef.current = bundle;
    const sent = connectionRef.current?.send(
      "task.create",
      createTaskPayload(bundle),
    );
    if (!sent) {
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
    setRequestOpen(false);
  }, [
    browserSessionId,
    connection.state,
    mode,
    projectId,
    region,
    renderRevision,
    requestText,
    scope,
  ]);

  const runTaskAction = useCallback(
    async (action: "accept" | "revert" | "cancel") => {
      if (!token || !task?.id) {
        return;
      }
      setBusyAction(true);
      try {
        await postTaskAction(token, task.id, action);
        setTask((current) =>
          current
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
        setTask((current) =>
          current
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
        setBusyAction(false);
      }
    },
    [task?.id, token],
  );

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
    setFollowUpText("");
    setFollowUpOpen(false);
    lastContextBundleRef.current = contextBundle;
  }, [
    browserSessionId,
    followUpText,
    projectId,
    renderRevision,
    scope,
    task?.id,
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
      <nav ref={toolbarRef} class="toolbar" aria-label="Visual Bridge 선택 모드">
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
              disabled={!token || Boolean(task && ACTIVE_PHASES.has(task.status))}
              onClick={() => chooseMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "multi" && selected.length > 0 && !requestOpen && !task ? (
          <button
            type="button"
            class="primary"
            onClick={() => setRequestOpen(true)}
          >
            요청 작성
          </button>
        ) : null}
        <span class="connection" role="status">
          <span class="state-dot" data-state={connection.state} aria-hidden="true" />
          {CONNECTION_LABELS[connection.state]}
        </span>
      </nav>

      {!requestOpen && !task && hoverRect ? (
        <Reticle rect={hoverRect} kind="hover" />
      ) : null}
      {mode !== "page"
        ? selectedRects.map(({ item, rect }, index) => (
            <Reticle
              key={item.id}
              rect={rect}
              kind="selected"
              {...(mode === "multi" || mode === "region"
                ? { label: String(index + 1) }
                : {})}
            />
          ))
        : null}
      {region ? (
        <div
          class="region-box"
          style={{
            left: `${region.x}px`,
            top: `${region.y}px`,
            width: `${region.width}px`,
            height: `${region.height}px`,
          }}
          aria-hidden="true"
        />
      ) : null}

      {requestOpen && !task ? (
        <RequestStrip
          panelRef={panelRef}
          position={popoverPosition}
          selection={selected}
          mode={mode}
          connectionState={connection.state}
          requestText={requestText}
          scope={scope}
          composingRef={compositionRef}
          onRequestText={setRequestText}
          onScope={setScope}
          onSubmit={() => void submitRequest()}
        />
      ) : null}

      {task ? (
        <TaskStrip
          panelRef={panelRef}
          position={popoverPosition}
          task={task}
          followUpOpen={followUpOpen}
          followUpText={followUpText}
          composingRef={compositionRef}
          busyAction={busyAction}
          onCancel={() => void runTaskAction("cancel")}
          onAccept={() => void runTaskAction("accept")}
          onRevert={() => void runTaskAction("revert")}
          onToggleFollowUp={() => setFollowUpOpen((value) => !value)}
          onFollowUpText={setFollowUpText}
          onFollowUp={() => void submitFollowUp()}
          onNewRequest={() => {
            setTask(null);
            resetSelection();
          }}
        />
      ) : null}

      {!requestOpen && !task ? <div class="selection-hint">{hint}</div> : null}
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
  render(<Overlay host={host} />, mountPoint);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
} else {
  mountOverlay();
}
