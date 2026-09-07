/**
 * THESIS: Project work is inspected as one live operational ledger; it refuses to stretch a popover into a dashboard.
 * OWN-WORLD: Matte graphite framing, warm flight-strip rows, hard rules, tabular machine facts, dispatch orange, and verification cyan.
 * STORY: Scan project health, filter the task stream, select one request, then inspect its exact files, evidence, logs, and diff.
 * FIRST VIEWPORT: A compact instrument header and status rail sit above one split ledger: tasks on the left, selected-task evidence on the right.
 * FORM: Full-page flight operations board, staged as a persistent master-detail workspace within the established Visual Bridge system.
 */

import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { ServerEvent, TaskRecord, TaskStatus } from "@visual-remote/protocol";
import {
  BridgeConnection,
  changedFilesFromEvent,
  consumeViewerToken,
  fetchBootstrap,
  fetchProjectId,
  fetchTaskArtifacts,
  fetchTasks,
  logFromEvent,
  taskFromEvent,
  type BridgeBootstrap,
  type BridgeRequestOptions,
  type ConnectionSnapshot,
  type ConnectionState,
  type TaskArtifacts,
} from "./bridge.js";
import { compactText } from "./helpers.js";
import { viewerStyles } from "./viewer-styles.js";
import { ComparisonPanel } from "./comparison-panel.js";

type TaskFilter = "all" | "active" | "review" | "issue";
const TASK_PAGE_SIZE = 100;
const TASK_FETCH_SIZE = TASK_PAGE_SIZE + 1;
const DIFF_PREVIEW_CHARACTERS = 60_000;
const LOG_PAGE_SIZE = 40;
const LOG_PREVIEW_CHARACTERS = 600;
const LOG_PREVIEW_LINES = 6;

interface DetailState extends TaskArtifacts {
  taskId: string;
  loading: boolean;
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

const REVIEW_PHASES = new Set<TaskStatus>(["review", "unsafe"]);
const ISSUE_PHASES = new Set<TaskStatus>(["failed", "canceled", "unsafe"]);
const STREAM_LABELS: Record<ConnectionState, string> = {
  unpaired: "연결 필요",
  connecting: "연결 중",
  connected: "실시간",
  reconnecting: "재연결 중",
  offline: "오프라인",
  unauthorized: "인증 만료",
};

function isIssue(task: TaskRecord): boolean {
  return ISSUE_PHASES.has(task.status) || task.verificationStatus === "failed";
}

function scopeLabel(scope: TaskRecord["scope"]): string {
  switch (scope) {
    case "instance":
      return "선택한 인스턴스";
    case "component":
      return "공용 컴포넌트";
    case "page":
      return "현재 페이지";
    case "project":
      return "프로젝트 전체";
  }
}

function verificationLabel(value: TaskRecord["verificationStatus"]): string {
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

function taskTimeLabel(task: TaskRecord): string {
  const value = task.completedAt ?? task.startedAt ?? task.createdAt;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시간 미상";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function refreshedTimeLabel(value: Date | null): string {
  if (!value) return "아직 갱신되지 않음";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function matchesFilter(task: TaskRecord, filter: TaskFilter): boolean {
  if (filter === "active") return ACTIVE_PHASES.has(task.status);
  if (filter === "review") return REVIEW_PHASES.has(task.status);
  if (filter === "issue") return isIssue(task);
  return true;
}

function taskTone(task: TaskRecord): "active" | "review" | "issue" | "done" {
  if (isIssue(task)) return "issue";
  if (ACTIVE_PHASES.has(task.status)) return "active";
  if (REVIEW_PHASES.has(task.status)) return "review";
  return "done";
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return compactText(message, 180);
}

function viewerRequestError(error: unknown, fallback: string): string {
  const message = errorText(error);
  if (
    message.includes("unauthorized")
    || message.includes("401")
    || message.includes("Invalid viewer token")
  ) {
    return "읽기 전용 세션이 만료되었습니다. Overlay의 ‘작업 보드’ 버튼에서 다시 열어주세요.";
  }
  return `${fallback} (${message})`;
}

function unavailableLabel(value: TaskArtifacts["unavailable"][number]): string {
  if (value === "files") return "변경 파일";
  if (value === "logs") return "작업 로그";
  return "diff";
}

function orderedTasks(tasks: TaskRecord[]): TaskRecord[] {
  return [...tasks]
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
}

function upsertTask(tasks: TaskRecord[], nextTask: TaskRecord): TaskRecord[] {
  const existing = tasks.findIndex((task) => task.id === nextTask.id);
  if (existing < 0) return orderedTasks([nextTask, ...tasks]);
  const next = [...tasks];
  next[existing] = nextTask;
  return orderedTasks(next);
}

function matchesQuery(task: TaskRecord, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase("ko-KR");
  if (!normalized) return true;
  return [task.id, task.requestText, ...task.changedFiles].some((value) =>
    value.toLocaleLowerCase("ko-KR").includes(normalized),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function LogEntry({ text, index }: { text: string; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.slice(0, LOG_PREVIEW_CHARACTERS).split("\n").slice(0, LOG_PREVIEW_LINES).join("\n");
  const isLong = preview.length < text.length;
  const contentId = `log-content-${index}`;
  return (
    <li>
      <span class="machine">{String(index + 1).padStart(2, "0")}</span>
      <div class="log-entry">
        <pre id={contentId}>{isLong && !expanded ? `${preview}\n…` : text}</pre>
        {isLong ? (
          <button
            type="button"
            class="log-toggle"
            aria-expanded={expanded ? "true" : "false"}
            aria-controls={contentId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "로그 접기" : "전체 로그 펼치기"}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function LogList({ logs }: { logs: string[] }) {
  const [visibleCount, setVisibleCount] = useState(LOG_PAGE_SIZE);
  const start = Math.max(0, logs.length - visibleCount);
  return (
    <>
      {start > 0 ? (
        <button type="button" class="log-older" onClick={() => setVisibleCount((count) => count + LOG_PAGE_SIZE)}>
          이전 로그 {Math.min(start, LOG_PAGE_SIZE)}개 더 보기 · {start}개 남음
        </button>
      ) : null}
      <ol tabIndex={0} aria-label="작업 로그 목록" start={start + 1}>
        {logs.slice(start).map((log, offset) => (
          <LogEntry key={start + offset} text={log} index={start + offset} />
        ))}
      </ol>
    </>
  );
}

function Viewer({ bootstrap }: { bootstrap: BridgeBootstrap }) {
  const { authMode } = bootstrap;
  const token = useMemo(() => authMode === "token" ? consumeViewerToken() ?? "" : "", [authMode]);
  const canConnect = authMode === "local" || Boolean(token);
  const requestOptions = useMemo<BridgeRequestOptions>(() => ({ authMode, mode: "viewer" }), [authMode]);
  const viewerSessionId = useMemo(() => crypto.randomUUID(), []);
  const selectedIdRef = useRef<string | null>(null);
  const tasksRef = useRef<TaskRecord[]>([]);
  const filterRef = useRef<TaskFilter>("all");
  const queryRef = useRef("");
  const detailAbortRef = useRef<AbortController | null>(null);
  const dashboardRequestRef = useRef(0);
  const hydratedRef = useRef(false);
  const pendingEventsRef = useRef<ServerEvent[]>([]);
  const connectionStateRef = useRef<ConnectionState>(canConnect ? "connecting" : "unpaired");
  const [projectId, setProjectId] = useState(bootstrap.projectId);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [loading, setLoading] = useState(canConnect);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [expandedDiffTaskId, setExpandedDiffTaskId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionSnapshot>({
    state: canConnect ? "connecting" : "unpaired",
    lastSequence: 0,
  });

  tasksRef.current = tasks;
  filterRef.current = filter;
  queryRef.current = query;

  const selectTask = useCallback(
    async (task: TaskRecord | null, preserveDetail = false) => {
      const taskId = task?.id ?? null;
      selectedIdRef.current = taskId;
      setSelectedTaskId(taskId);
      detailAbortRef.current?.abort();
      detailAbortRef.current = null;
      if (!task || !canConnect) {
        setDetail(null);
        return;
      }

      const controller = new AbortController();
      detailAbortRef.current = controller;
      setDetail((current) =>
        preserveDetail && current?.taskId === task.id
          ? (() => {
              const next = { ...current };
              delete next.error;
              return next;
            })()
          : {
              taskId: task.id,
              loading: true,
              changedFiles: task.changedFiles,
              diff: "",
              logs: [],
              unavailable: [],
            },
      );
      try {
        const artifacts = await fetchTaskArtifacts(token, task.id, controller.signal, { ...requestOptions, logFormat: "full" });
        setDetail((current) =>
          current?.taskId === task.id && !controller.signal.aborted
            ? { taskId: task.id, loading: false, ...artifacts }
            : current,
        );
      } catch (error) {
        if (isAbortError(error)) return;
        setDetail((current) =>
          current?.taskId === task.id
            ? {
                ...current,
                loading: false,
                error: viewerRequestError(
                  error,
                  "상세 내역을 불러오지 못했습니다.",
                ),
              }
            : current,
        );
      } finally {
        if (detailAbortRef.current === controller) detailAbortRef.current = null;
      }
    },
    [canConnect, requestOptions, token],
  );

  const applyServerEvent = useCallback(
    (event: ServerEvent) => {
      setRefreshedAt(new Date());
      const eventTask = taskFromEvent(event);
      if (eventTask) {
        setTasks((current) => {
          const next = upsertTask(current, eventTask);
          tasksRef.current = next;
          return next;
        });
      }

      const taskId = event.taskId ?? eventTask?.id;
      if (!taskId || selectedIdRef.current !== taskId) return;

      const log = logFromEvent(event, "full");
      const files = changedFilesFromEvent(event);
      if (log || files.length > 0) {
        setDetail((current) =>
          current?.taskId === taskId
            ? {
                ...current,
                changedFiles:
                  files.length > 0 ? files : current.changedFiles,
                logs: log ? [...current.logs, log] : current.logs,
              }
            : current,
        );
      }

      if (
        [
          "task.diff_ready",
          "task.completed",
          "task.failed",
          "task.canceled",
          "task.reverted",
          "task.verification_result",
        ].includes(event.type)
      ) {
        const latestTask =
          eventTask ?? tasksRef.current.find((task) => task.id === taskId);
        if (latestTask) void selectTask(latestTask, true);
      }
    },
    [selectTask],
  );

  const handleServerEvent = useCallback(
    (event: ServerEvent) => {
      if (!hydratedRef.current) {
        pendingEventsRef.current.push(event);
        return;
      }
      applyServerEvent(event);
    },
    [applyServerEvent],
  );

  const loadDashboard = useCallback(async () => {
    if (!canConnect) {
      setLoadError("Overlay의 ‘작업 보드’ 버튼에서 다시 열어주세요.");
      return;
    }

    const requestId = ++dashboardRequestRef.current;
    hydratedRef.current = false;
    setLoading(true);
    setLoadError(null);
    try {
      const [fetchedTasks, nextProjectId] = await Promise.all([
        fetchTasks(token, { ...requestOptions, limit: TASK_FETCH_SIZE }),
        fetchProjectId(token, requestOptions),
      ]);
      if (requestId !== dashboardRequestRef.current) return;
      const nextTasks = fetchedTasks.slice(0, TASK_PAGE_SIZE);
      const ordered = orderedTasks(nextTasks);
      tasksRef.current = ordered;
      setTasks(ordered);
      setHasMore(fetchedTasks.length > TASK_PAGE_SIZE);
      if (nextProjectId) setProjectId(nextProjectId);

      const selected = selectedIdRef.current
        ? ordered.find((task) => task.id === selectedIdRef.current)
        : undefined;
      const nextSelected =
        selected
        && matchesFilter(selected, filterRef.current)
        && matchesQuery(selected, queryRef.current)
          ? selected
          : ordered.find(
              (task) =>
                matchesFilter(task, filterRef.current)
                && matchesQuery(task, queryRef.current),
            ) ?? null;
      await selectTask(nextSelected);
      setRefreshedAt(new Date());
    } catch (error) {
      if (requestId !== dashboardRequestRef.current) return;
      setLoadError(viewerRequestError(
        error,
        "작업 목록을 불러오지 못했습니다. Bridge 연결을 확인해 주세요.",
      ));
    } finally {
      if (requestId === dashboardRequestRef.current) {
        hydratedRef.current = true;
        const pendingEvents = pendingEventsRef.current
          .splice(0)
          .sort((left, right) => left.seq - right.seq);
        for (const event of pendingEvents) applyServerEvent(event);
        setLoading(false);
      }
    }
  }, [applyServerEvent, canConnect, requestOptions, selectTask, token]);

  const loadMoreTasks = useCallback(async () => {
    if (!canConnect || loadingMore) return;
    const cursor = tasksRef.current.at(-1);
    if (!cursor) return;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const fetchedPage = await fetchTasks(token, {
        ...requestOptions,
        limit: TASK_FETCH_SIZE,
        cursor: { id: cursor.id, createdAt: cursor.createdAt },
      });
      const page = fetchedPage.slice(0, TASK_PAGE_SIZE);
      setTasks((current) => {
        const byId = new Map(current.map((task) => [task.id, task]));
        for (const task of page) byId.set(task.id, task);
        const next = orderedTasks([...byId.values()]);
        tasksRef.current = next;
        return next;
      });
      setHasMore(fetchedPage.length > TASK_PAGE_SIZE);
      setRefreshedAt(new Date());
    } catch (error) {
      setLoadError(viewerRequestError(
        error,
        "이전 작업 기록을 불러오지 못했습니다.",
      ));
    } finally {
      setLoadingMore(false);
    }
  }, [canConnect, loadingMore, requestOptions, token]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const filteredTasks = useMemo(
    () =>
      tasks.filter(
        (task) => matchesFilter(task, filter) && matchesQuery(task, query),
      ),
    [filter, query, tasks],
  );

  useEffect(() => {
    const selected = selectedIdRef.current;
    if (selected && filteredTasks.some((task) => task.id === selected)) return;
    void selectTask(filteredTasks[0] ?? null);
  }, [filteredTasks, selectTask]);

  useEffect(() => {
    if (!canConnect) return;
    const bridge = new BridgeConnection({
      token,
      authMode,
      mode: "viewer",
      browserSessionId: viewerSessionId,
      onSequenceGap: () => {
        void loadDashboard();
      },
      onSnapshot: (snapshot) => {
        const previousState = connectionStateRef.current;
        connectionStateRef.current = snapshot.state;
        setConnection(snapshot);
        if (snapshot.projectId) setProjectId(snapshot.projectId);
        if (snapshot.state === "unauthorized") {
          setLoadError(
            "읽기 전용 세션이 만료되었습니다. Overlay의 ‘작업 보드’ 버튼에서 다시 열어주세요.",
          );
        } else if (
          snapshot.state === "connected"
          && (previousState === "offline" || previousState === "reconnecting")
        ) {
          void loadDashboard();
        }
      },
      onEvent: handleServerEvent,
    });
    bridge.connect();
    return () => bridge.close();
  }, [authMode, canConnect, handleServerEvent, loadDashboard, token, viewerSessionId]);

  useEffect(
    () => () => {
      detailAbortRef.current?.abort();
    },
    [],
  );

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedDetail =
    selectedTask && detail?.taskId === selectedTask.id ? detail : null;
  const changedFiles =
    selectedDetail && selectedDetail.changedFiles.length > 0
      ? selectedDetail.changedFiles
      : selectedTask?.changedFiles ?? [];
  const fullDiff = selectedDetail?.diff ?? "";
  const diffIsLarge = fullDiff.length > DIFF_PREVIEW_CHARACTERS;
  const diffExpanded = selectedTask?.id === expandedDiffTaskId;
  const visibleDiff =
    diffIsLarge && !diffExpanded
      ? `${fullDiff.slice(0, DIFF_PREVIEW_CHARACTERS)}\n\n… 성능을 위해 나머지 diff를 접었습니다.`
      : fullDiff;

  const counts = useMemo(
    () => ({
      all: tasks.length,
      active: tasks.filter((task) => ACTIVE_PHASES.has(task.status)).length,
      review: tasks.filter((task) => REVIEW_PHASES.has(task.status)).length,
      issue: tasks.filter(isIssue).length,
    }),
    [tasks],
  );

  const filters: Array<{ value: TaskFilter; label: string; count: number }> = [
    { value: "all", label: "전체", count: counts.all },
    { value: "active", label: "진행 중", count: counts.active },
    { value: "review", label: "검토 필요", count: counts.review },
    { value: "issue", label: "문제", count: counts.issue },
  ];

  return (
    <div class="viewer-app" data-loading={loading ? "true" : "false"}>
      <header class="viewer-header">
        <div class="viewer-brand">
          <span class="brand-signal" aria-hidden="true" />
          <span>
            <strong>Visual Bridge</strong>
            <small>작업 뷰어</small>
          </span>
        </div>
        <div class="header-instruments">
          <span class="project-readout">
            <small>PROJECT</small>
            <strong>{projectId}</strong>
          </span>
          <span class="connection-readout" data-state={connection.state}>
            <small>STREAM</small>
            <strong><span aria-hidden="true" />{STREAM_LABELS[connection.state]}</strong>
          </span>
          <span class="refresh-readout">
            <small>LAST SYNC</small>
            <strong>{refreshedTimeLabel(refreshedAt)}</strong>
          </span>
          <button type="button" class="refresh-button" disabled={loading} onClick={() => void loadDashboard()}>
            {loading ? "갱신 중" : "새로고침"}
          </button>
        </div>
      </header>

      <main class="viewer-main">
        <section class="viewer-intro" aria-labelledby="viewer-title">
          <div>
            <h1 id="viewer-title">프로젝트 작업 흐름</h1>
            <p>요청부터 검증 결과까지, Bridge가 기록한 task를 한 화면에서 검토합니다.</p>
          </div>
          <span class="read-only-mark">READ ONLY</span>
        </section>

        <nav class="status-rail" aria-label="작업 상태 필터">
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value ? "true" : "false"}
              onClick={() => setFilter(item.value)}
            >
              <span>{item.label}</span>
              <strong class="machine">{item.count}</strong>
            </button>
          ))}
        </nav>

        {loadError ? (
          <div class="viewer-error" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => void loadDashboard()}>
              다시 시도
            </button>
          </div>
        ) : null}

        <span class="visually-hidden" role="status" aria-live="polite">
          {loading && tasks.length === 0
            ? "작업 기록 불러오는 중"
            : selectedTask
            ? `${compactText(selectedTask.requestText, 80)} 작업 상세 ${
                selectedDetail?.loading ? "불러오는 중" : "선택됨"
              }, ${STREAM_LABELS[connection.state]}`
            : "선택한 작업 없음"}
        </span>

        <section class="operations-board" aria-label="작업 대시보드">
          <aside class="task-ledger">
            <header class="board-head">
              <div>
                <h2>작업 목록</h2>
                <p>{filter === "all" ? "프로젝트 전체" : filters.find((item) => item.value === filter)?.label}</p>
              </div>
              <div class="board-head-tools">
                <span class="machine">{filteredTasks.length} / {tasks.length}</span>
                <a class="detail-jump" href="#task-detail">상세로 이동</a>
              </div>
            </header>

            <div class="ledger-search">
              <label>
                <span class="visually-hidden">작업 검색</span>
                <input
                  type="search"
                  value={query}
                  placeholder="요청·파일·Task ID 검색"
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
              <span class="machine">불러온 {tasks.length}개 내 검색</span>
            </div>

            {loading && tasks.length === 0 ? (
              <div class="ledger-state" role="status">
                <strong>작업 기록을 불러오는 중입니다.</strong>
                <span>Bridge task store를 확인하고 있습니다.</span>
              </div>
            ) : filteredTasks.length === 0 ? (
              <div class="ledger-state">
                <strong>
                  {tasks.length === 0
                    ? "아직 작업 기록이 없습니다."
                    : query.trim()
                      ? "검색 결과가 없습니다."
                    : "이 상태의 작업이 없습니다."}
                </strong>
                <span>
                  {tasks.length === 0
                    ? "Overlay에서 변경을 요청하면 여기에 기록됩니다."
                    : query.trim()
                      ? "다른 검색어를 입력하거나 검색을 지워보세요."
                    : "다른 상태 필터를 선택해 보세요."}
                </span>
              </div>
            ) : (
              <ol class="task-list">
                {filteredTasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      class="task-row"
                      data-tone={taskTone(task)}
                      aria-current={task.id === selectedTaskId ? "true" : undefined}
                      aria-controls="task-detail"
                      onClick={() => void selectTask(task)}
                    >
                      <span class="task-state" aria-hidden="true" />
                      <span class="task-copy">
                        <strong>{compactText(task.requestText, 110)}</strong>
                        <span>{PHASE_LABELS[task.status]} · {scopeLabel(task.scope)}</span>
                      </span>
                      <span class="task-meta machine">
                        <span>{taskTimeLabel(task)}</span>
                        <span>{task.changedFiles.length} files</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {hasMore ? (
              <div class="ledger-footer">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadMoreTasks()}
                >
                  {loadingMore ? "이전 기록 불러오는 중" : "이전 작업 더 보기"}
                </button>
              </div>
            ) : tasks.length > 0 ? (
              <div class="ledger-footer ledger-end">
                <span>불러온 작업 기록의 끝입니다.</span>
              </div>
            ) : null}
          </aside>

          <section
            id="task-detail"
            class="task-detail"
            aria-label="선택한 작업 상세"
            tabIndex={-1}
          >
            {!selectedTask ? (
              <div class="detail-empty">
                <span class="empty-reticle" aria-hidden="true" />
                <strong>검토할 작업을 선택하세요.</strong>
                <p>왼쪽 작업 목록에서 task를 선택하면 요청, 변경 파일, 로그와 diff가 표시됩니다.</p>
              </div>
            ) : (
              <>
                <header class="detail-head">
                  <div>
                    <span class="detail-kicker machine">TASK {selectedTask.id.slice(0, 12)}</span>
                    <h2>{selectedTask.requestText}</h2>
                  </div>
                  <span class="detail-status" data-tone={taskTone(selectedTask)}>
                    <span aria-hidden="true" />
                    {PHASE_LABELS[selectedTask.status]}
                  </span>
                </header>

                <dl class="fact-strip">
                  <div>
                    <dt>적용 범위</dt>
                    <dd>{scopeLabel(selectedTask.scope)}</dd>
                  </div>
                  <div>
                    <dt>검증</dt>
                    <dd>{verificationLabel(selectedTask.verificationStatus)}</dd>
                  </div>
                  <div>
                    <dt>최근 시각</dt>
                    <dd class="machine">{taskTimeLabel(selectedTask)}</dd>
                  </div>
                  <div>
                    <dt>변경 파일</dt>
                    <dd class="machine">{changedFiles.length}</dd>
                  </div>
                </dl>

                <div
                  class="detail-scroll"
                  role="region"
                  aria-label="선택한 작업의 변경 내역"
                  tabIndex={0}
                >
                  {selectedTask.error?.message
                  || selectedDetail?.error
                  || (selectedDetail && selectedDetail.unavailable.length > 0) ? (
                    <div class="detail-alerts" role="alert">
                      {selectedTask.error?.message ? (
                        <div class="detail-error">
                          <strong>작업 오류</strong>
                          <span>{selectedTask.error.message}</span>
                        </div>
                      ) : null}

                      {selectedDetail?.error ? (
                        <div class="detail-error">
                          <span>{selectedDetail.error}</span>
                          <button type="button" onClick={() => void selectTask(selectedTask)}>다시 시도</button>
                        </div>
                      ) : null}

                      {selectedDetail && selectedDetail.unavailable.length > 0 ? (
                        <div class="detail-error">
                          <span>
                            일부 내역을 불러오지 못했습니다: {selectedDetail.unavailable.map(unavailableLabel).join(", ")}
                          </span>
                          <button type="button" onClick={() => void selectTask(selectedTask)}>다시 시도</button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {selectedTask.comparison ? <ComparisonPanel key={selectedTask.id} state={selectedTask.comparison} token={token} options={requestOptions} /> : null}
                  <section class="files-block" aria-labelledby="files-title">
                    <header>
                      <h3 id="files-title">변경 파일</h3>
                      <span class="machine">{changedFiles.length}</span>
                    </header>
                    {changedFiles.length > 0 ? (
                      <ul>
                        {changedFiles.map((file) => (
                          <li key={file} title={file}><span>Δ</span>{file}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>보고된 변경 파일이 없습니다.</p>
                    )}
                  </section>

                  <div class="evidence-grid">
                    <section class="logs-block" aria-labelledby="logs-title">
                      <header>
                        <h3 id="logs-title">작업 로그</h3>
                        <span class="machine">{selectedDetail?.logs.length ?? 0}</span>
                      </header>
                      {selectedDetail?.loading ? (
                        <p class="block-state">상세 내역을 불러오는 중입니다.</p>
                      ) : selectedDetail && selectedDetail.logs.length > 0 ? (
                        <LogList key={selectedDetail.taskId} logs={selectedDetail.logs} />
                      ) : selectedDetail?.unavailable.includes("logs") ? null : (
                        <p class="block-state">저장된 작업 로그가 없습니다.</p>
                      )}
                    </section>

                    <section class="diff-block" aria-labelledby="diff-title">
                      <header>
                        <h3 id="diff-title">Unified diff</h3>
                        <div class="diff-head-tools">
                          <span class="machine">
                            {diffIsLarge && !diffExpanded ? "PREVIEW" : "DIFF"}
                          </span>
                          {diffIsLarge ? (
                            <button
                              type="button"
                              class="diff-toggle"
                              aria-expanded={diffExpanded ? "true" : "false"}
                              onClick={() => setExpandedDiffTaskId(
                                diffExpanded ? null : selectedTask.id,
                              )}
                            >
                              {diffExpanded ? "미리보기로 접기" : "전체 diff 펼치기"}
                            </button>
                          ) : null}
                        </div>
                      </header>
                      {selectedDetail?.loading ? (
                        <p class="block-state">Diff를 불러오는 중입니다.</p>
                      ) : selectedDetail?.unavailable.includes("diff") ? null : (
                        <pre tabIndex={0} aria-label="Unified diff 내용">
                          {visibleDiff || "저장된 diff가 없습니다."}
                        </pre>
                      )}
                    </section>
                  </div>
                </div>
              </>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}

const style = document.createElement("style");
style.textContent = viewerStyles;
document.head.append(style);

const root = document.getElementById("visual-viewer-root");
if (root) {
  root.replaceChildren();
  void fetchBootstrap().then((bootstrap) => {
    render(<Viewer bootstrap={bootstrap} />, root);
  }).catch(() => {
    render(
      <main class="viewer-main">
        <div class="viewer-error" role="alert">
          <span>Bridge 설정을 불러오지 못했습니다. Bridge 실행과 연결을 확인한 뒤 다시 시도하세요.</span>
          <button type="button" onClick={() => location.reload()}>다시 시도</button>
        </div>
      </main>,
      root,
    );
  });
}
