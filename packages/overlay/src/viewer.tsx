/**
 * THESIS: Project work is inspected as one live operational ledger; it refuses to stretch a popover into a dashboard.
 * OWN-WORLD: Matte graphite framing, warm flight-strip rows, hard rules, tabular machine facts, dispatch orange, and verification cyan.
 * STORY: Scan project health, filter the task stream, select one request, then inspect its exact files, evidence, logs, and diff.
 * FIRST VIEWPORT: A compact instrument header and status rail sit above one split ledger: tasks on the left, selected-task evidence on the right.
 * FORM: Full-page flight operations board, staged as a persistent master-detail workspace within the established Visual Bridge system.
 */

import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { TaskRecord, TaskStatus } from "@visual-remote/protocol";
import {
  consumePairingToken,
  fetchProjectId,
  fetchTaskArtifacts,
  fetchTasks,
  type TaskArtifacts,
} from "./bridge.js";
import { compactText } from "./helpers.js";
import { viewerStyles } from "./viewer-styles.js";

type TaskFilter = "all" | "active" | "review" | "issue";

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

function unavailableLabel(value: TaskArtifacts["unavailable"][number]): string {
  if (value === "files") return "변경 파일";
  if (value === "logs") return "작업 로그";
  return "diff";
}

function Viewer() {
  const token = useMemo(consumePairingToken, []);
  const selectedIdRef = useRef<string | null>(null);
  const [projectId, setProjectId] = useState("current");
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const selectTask = useCallback(
    async (task: TaskRecord | null) => {
      const taskId = task?.id ?? null;
      selectedIdRef.current = taskId;
      setSelectedTaskId(taskId);
      if (!task || !token) {
        setDetail(null);
        return;
      }

      setDetail({
        taskId: task.id,
        loading: true,
        changedFiles: task.changedFiles,
        diff: "",
        logs: [],
        unavailable: [],
      });
      try {
        const artifacts = await fetchTaskArtifacts(token, task.id);
        setDetail((current) =>
          current?.taskId === task.id
            ? { taskId: task.id, loading: false, ...artifacts }
            : current,
        );
      } catch (error) {
        setDetail((current) =>
          current?.taskId === task.id
            ? {
                ...current,
                loading: false,
                error: `상세 내역을 불러오지 못했습니다. (${errorText(error)})`,
              }
            : current,
        );
      }
    },
    [token],
  );

  const loadDashboard = useCallback(async () => {
    if (!token) {
      setLoadError("페어링된 Overlay에서 뷰어를 다시 열어주세요.");
      return;
    }

    setLoading(true);
    setLoadError(null);
    try {
      const [nextTasks, nextProjectId] = await Promise.all([
        fetchTasks(token),
        fetchProjectId(token),
      ]);
      setTasks(nextTasks);
      if (nextProjectId) setProjectId(nextProjectId);

      const selected = selectedIdRef.current
        ? nextTasks.find((task) => task.id === selectedIdRef.current)
        : undefined;
      const nextSelected =
        selected && matchesFilter(selected, filter)
          ? selected
          : nextTasks.find((task) => matchesFilter(task, filter)) ?? null;
      await selectTask(nextSelected);
      setRefreshedAt(new Date());
    } catch (error) {
      setLoadError(
        `작업 목록을 불러오지 못했습니다. Bridge 연결을 확인해 주세요. (${errorText(
          error,
        )})`,
      );
    } finally {
      setLoading(false);
    }
  }, [filter, selectTask, token]);

  useEffect(() => {
    void loadDashboard();
    // The initial load should not repeat when the local filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const filteredTasks = useMemo(
    () => tasks.filter((task) => matchesFilter(task, filter)),
    [filter, tasks],
  );

  useEffect(() => {
    const selected = selectedIdRef.current;
    if (selected && filteredTasks.some((task) => task.id === selected)) return;
    void selectTask(filteredTasks[0] ?? null);
  }, [filteredTasks, selectTask]);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedDetail =
    selectedTask && detail?.taskId === selectedTask.id ? detail : null;
  const changedFiles =
    selectedDetail && selectedDetail.changedFiles.length > 0
      ? selectedDetail.changedFiles
      : selectedTask?.changedFiles ?? [];

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
              }`
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
                    : "이 상태의 작업이 없습니다."}
                </strong>
                <span>
                  {tasks.length === 0
                    ? "Overlay에서 변경을 요청하면 여기에 기록됩니다."
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

                <div class="detail-scroll">
                  {selectedTask.error?.message ? (
                    <div class="detail-error" role="alert">
                      <strong>작업 오류</strong>
                      <span>{selectedTask.error.message}</span>
                    </div>
                  ) : null}

                  {selectedDetail?.error ? (
                    <div class="detail-error" role="alert">
                      <span>{selectedDetail.error}</span>
                      <button type="button" onClick={() => void selectTask(selectedTask)}>다시 시도</button>
                    </div>
                  ) : null}

                  {selectedDetail && selectedDetail.unavailable.length > 0 ? (
                    <div class="detail-error" role="alert">
                      <span>
                        일부 내역을 불러오지 못했습니다: {selectedDetail.unavailable.map(unavailableLabel).join(", ")}
                      </span>
                      <button type="button" onClick={() => void selectTask(selectedTask)}>다시 시도</button>
                    </div>
                  ) : null}

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
                        <ol>
                          {selectedDetail.logs.map((log, index) => (
                            <li key={`${index}-${log}`}><span class="machine">{String(index + 1).padStart(2, "0")}</span>{log}</li>
                          ))}
                        </ol>
                      ) : selectedDetail?.unavailable.includes("logs") ? null : (
                        <p class="block-state">저장된 작업 로그가 없습니다.</p>
                      )}
                    </section>

                    <section class="diff-block" aria-labelledby="diff-title">
                      <header>
                        <h3 id="diff-title">Unified diff</h3>
                        <span class="machine">DIFF</span>
                      </header>
                      {selectedDetail?.loading ? (
                        <p class="block-state">Diff를 불러오는 중입니다.</p>
                      ) : selectedDetail?.unavailable.includes("diff") ? null : (
                        <pre>{selectedDetail?.diff || "저장된 diff가 없습니다."}</pre>
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
if (root) render(<Viewer />, root);
