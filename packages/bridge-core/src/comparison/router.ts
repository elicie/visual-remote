import type { CaptureResult, ContextBundle, Rect, VerificationBrowserKind } from "@visual-remote/protocol";

export type { VerificationBrowserKind };

export const VERIFICATION_BROWSER_KINDS: readonly VerificationBrowserKind[] = ["playwright", "ego"];

/** Contract every verification browser driver implements. */
export interface VerificationBrowserDriver {
  open(context?: ContextBundle): Promise<{ status: "ready"; message: string }>;
  begin(taskId: string, context: ContextBundle, signal: AbortSignal): Promise<void>;
  capture(taskId: string, context: ContextBundle, size: { width: number; height: number }, signal: AbortSignal): Promise<CaptureResult>;
  /** Measures the current crop rectangle without capturing, for early size checks. */
  measure?(taskId: string, context: ContextBundle, signal: AbortSignal): Promise<Rect>;
  finish(taskId: string): Promise<void>;
  close(): Promise<void>;
}

export interface VerificationBrowserInfo {
  browsers: VerificationBrowserKind[];
  defaultBrowser: VerificationBrowserKind;
}

/**
 * Routes each task to the driver its request asked for (or the configured
 * default) and remembers the choice until the task finishes, so capture and
 * finish always reach the driver that opened the page.
 */
export class VerificationBrowserRouter implements VerificationBrowserDriver {
  readonly #drivers: Partial<Record<VerificationBrowserKind, VerificationBrowserDriver>>;
  readonly #defaultKind: VerificationBrowserKind;
  readonly #active = new Map<string, VerificationBrowserDriver>();

  constructor(
    drivers: Partial<Record<VerificationBrowserKind, VerificationBrowserDriver>>,
    defaultKind: VerificationBrowserKind,
  ) {
    if (!drivers[defaultKind]) throw new Error(`Default verification browser ${defaultKind} is not available`);
    this.#drivers = { ...drivers };
    this.#defaultKind = defaultKind;
  }

  info(): VerificationBrowserInfo {
    return {
      browsers: VERIFICATION_BROWSER_KINDS.filter((kind) => Boolean(this.#drivers[kind])),
      defaultBrowser: this.#defaultKind,
    };
  }

  kindFor(context?: ContextBundle): VerificationBrowserKind {
    const requested = context?.request.comparison?.browser;
    return requested ?? this.#defaultKind;
  }

  #select(context?: ContextBundle): VerificationBrowserDriver {
    const kind = this.kindFor(context);
    const driver = this.#drivers[kind];
    if (!driver) {
      throw new Error(
        kind === "ego"
          ? "ego lite verification was requested but the ego-browser command is not available on this Bridge. Install ego lite or choose the separate verification browser."
          : `Verification browser ${kind} is not available on this Bridge.`,
      );
    }
    return driver;
  }

  open(context?: ContextBundle): Promise<{ status: "ready"; message: string }> {
    return this.#select(context).open(context);
  }

  async begin(taskId: string, context: ContextBundle, signal: AbortSignal): Promise<void> {
    const driver = this.#select(context);
    this.#active.set(taskId, driver);
    try {
      await driver.begin(taskId, context, signal);
    } catch (error) {
      this.#active.delete(taskId);
      throw error;
    }
  }

  async capture(taskId: string, context: ContextBundle, size: { width: number; height: number }, signal: AbortSignal): Promise<CaptureResult> {
    const driver = this.#active.get(taskId);
    if (!driver) throw new Error("No active verification page for this task.");
    return await driver.capture(taskId, context, size, signal);
  }

  async measure(taskId: string, context: ContextBundle, signal: AbortSignal): Promise<Rect> {
    const driver = this.#active.get(taskId);
    if (!driver) throw new Error("No active verification page for this task.");
    if (!driver.measure) throw new Error("Verification browser cannot measure without capturing.");
    return await driver.measure(taskId, context, signal);
  }

  async finish(taskId: string): Promise<void> {
    const driver = this.#active.get(taskId);
    this.#active.delete(taskId);
    await driver?.finish(taskId);
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const driver of Object.values(this.#drivers)) {
      try {
        await driver?.close();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#active.clear();
    if (failures.length > 0) throw failures[0];
  }
}
