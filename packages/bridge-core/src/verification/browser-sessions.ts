import { redactText } from "../context/sanitize.js";

export interface BrowserPageState {
  url: string;
  viewport: { width: number; height: number };
  renderRevision: number;
}

export interface BrowserConsoleEvent {
  level: "warning" | "error" | "unhandled";
  message: string;
  createdAt: string;
}

export type BrowserTargetState =
  | "found-and-changed"
  | "found-no-visible-change"
  | "not-found"
  | "page-reloaded"
  | "unverified";

export interface BrowserTargetResult {
  taskId: string;
  state: BrowserTargetState;
  renderRevision: number;
  targetCount: number;
  foundCount: number;
  changedCount: number;
  createdAt: string;
}

export interface BrowserSessionState extends BrowserPageState {
  id: string;
  connectedAt: string;
  lastSeenAt: string;
  consoleEvents: BrowserConsoleEvent[];
  targetResults: BrowserTargetResult[];
}

export interface BrowserVerificationBaseline {
  browserSessionId: string;
  renderRevision: number;
  startedAt: string;
  url: string;
  knownErrorSignatures: string[];
}

export interface BrowserVerificationResult {
  status: "passed" | "partial" | "unverified" | "failed";
  renderChanged: boolean;
  newErrors: BrowserConsoleEvent[];
  targetResult?: BrowserTargetResult;
  summary: string;
}

function errorSignature(event: BrowserConsoleEvent): string {
  return `${event.level}\u0000${event.message}`;
}

function samePage(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin === rightUrl.origin
      && leftUrl.pathname === rightUrl.pathname
      && leftUrl.search === rightUrl.search
    );
  } catch {
    return left === right;
  }
}

export class BrowserSessionManager {
  readonly #sessions = new Map<string, BrowserSessionState>();
  readonly #maxConsoleEvents: number;

  constructor(maxConsoleEvents = 200) {
    this.#maxConsoleEvents = maxConsoleEvents;
  }

  connect(id: string, page: BrowserPageState, now = new Date()): BrowserSessionState {
    const timestamp = now.toISOString();
    const previous = this.#sessions.get(id);
    const session: BrowserSessionState = {
      id,
      ...page,
      connectedAt: previous?.connectedAt ?? timestamp,
      lastSeenAt: timestamp,
      consoleEvents: previous?.consoleEvents ?? [],
      targetResults: previous?.targetResults ?? [],
    };
    this.#sessions.set(id, session);
    return session;
  }

  heartbeat(id: string, now = new Date()): void {
    const session = this.#sessions.get(id);
    if (session !== undefined) {
      session.lastSeenAt = now.toISOString();
    }
  }

  updatePage(id: string, page: BrowserPageState, now = new Date()): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      this.connect(id, page, now);
      return;
    }
    session.url = page.url;
    session.viewport = page.viewport;
    session.renderRevision = page.renderRevision;
    session.lastSeenAt = now.toISOString();
  }

  recordConsole(
    id: string,
    event: Omit<BrowserConsoleEvent, "createdAt"> & { createdAt?: string },
  ): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return;
    }
    session.consoleEvents.push({
      level: event.level,
      message: redactText(event.message, 2_000),
      createdAt: event.createdAt ?? new Date().toISOString(),
    });
    if (session.consoleEvents.length > this.#maxConsoleEvents) {
      session.consoleEvents.splice(0, session.consoleEvents.length - this.#maxConsoleEvents);
    }
  }

  recordTargetResult(
    id: string,
    result: Omit<BrowserTargetResult, "createdAt">,
    now = new Date(),
  ): BrowserTargetResult | undefined {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return undefined;
    }
    const stored = { ...result, createdAt: now.toISOString() };
    session.targetResults.push(stored);
    if (session.targetResults.length > this.#maxConsoleEvents) {
      session.targetResults.splice(
        0,
        session.targetResults.length - this.#maxConsoleEvents,
      );
    }
    session.lastSeenAt = stored.createdAt;
    return stored;
  }

  baseline(id: string, now = new Date()): BrowserVerificationBaseline | undefined {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return undefined;
    }
    return {
      browserSessionId: id,
      renderRevision: session.renderRevision,
      startedAt: now.toISOString(),
      url: session.url,
      knownErrorSignatures: [
        ...new Set(
          session.consoleEvents
            .filter((event) => event.level === "error" || event.level === "unhandled")
            .map(errorSignature),
        ),
      ],
    };
  }

  verify(
    baseline: BrowserVerificationBaseline,
    options: { taskId?: string; targetEvidenceRequired?: boolean } = {},
  ): BrowserVerificationResult {
    const session = this.#sessions.get(baseline.browserSessionId);
    if (session === undefined) {
      return {
        status: "unverified",
        renderChanged: false,
        newErrors: [],
        summary: "Origin browser session is disconnected.",
      };
    }

    const knownErrors = new Set(baseline.knownErrorSignatures);
    const newErrors = [
      ...new Map(
        session.consoleEvents
          .filter(
            (event) =>
              event.createdAt > baseline.startedAt
              && (event.level === "error" || event.level === "unhandled")
              && !knownErrors.has(errorSignature(event)),
          )
          .map((event) => [errorSignature(event), event]),
      ).values(),
    ];
    const renderChanged = session.renderRevision > baseline.renderRevision;
    const pageUnchanged = samePage(baseline.url, session.url);
    const targetResult =
      options.taskId === undefined
        ? undefined
        : session.targetResults
            .filter(
              (result) =>
                result.taskId === options.taskId
                && result.createdAt >= baseline.startedAt,
            )
            .at(-1);

    if (newErrors.length > 0) {
      return {
        status: "failed",
        renderChanged,
        newErrors,
        ...(targetResult ? { targetResult } : {}),
        summary: `${newErrors.length} new browser error${newErrors.length === 1 ? "" : "s"} detected.`,
      };
    }
    if (!pageUnchanged) {
      return {
        status: "partial",
        renderChanged,
        newErrors: [],
        ...(targetResult ? { targetResult } : {}),
        summary: "Origin browser navigated to a different page during verification.",
      };
    }
    if (options.targetEvidenceRequired) {
      const targetChanged =
        targetResult?.state === "found-and-changed"
        && targetResult.targetCount > 0
        && targetResult.foundCount === targetResult.targetCount
        && targetResult.changedCount > 0
        && targetResult.renderRevision > baseline.renderRevision;
      if (targetChanged) {
        return {
          status: "passed",
          renderChanged: true,
          newErrors: [],
          targetResult,
          summary: `Browser re-found and observed a visible change in ${targetResult.changedCount}/${targetResult.targetCount} target(s).`,
        };
      }
      return {
        status: "partial",
        renderChanged,
        newErrors: [],
        ...(targetResult ? { targetResult } : {}),
        summary: targetResult
          ? `Browser target check was ${targetResult.state}; visible target change is uncertain.`
          : renderChanged
            ? "Browser render changed, but target re-location evidence is still unavailable."
            : "Target re-location evidence is still unavailable.",
      };
    }
    if (renderChanged) {
      return {
        status: "passed",
        renderChanged: true,
        newErrors: [],
        summary: "Browser render revision changed with no new errors.",
      };
    }
    return {
      status: "partial",
      renderChanged: false,
      newErrors: [],
      summary: "No new browser errors; render change was not observed.",
    };
  }

  get(id: string): BrowserSessionState | undefined {
    return this.#sessions.get(id);
  }
}
