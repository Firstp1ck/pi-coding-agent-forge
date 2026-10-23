/**
 * Usage and loop detector (spec §8.1). A pure state machine fed completed tool
 * calls in order; it returns warnings and never blocks anything.
 */
import { LOOP_THRESHOLDS, type LoopSignal, type SessionUsage, type UsageEvent, type UsageWarning } from "./types.ts";

/** Estimated cost for cost-tracking backends (`cua`, not in M1). */
export interface CostEstimate {
  sessionUsd: number;
  dailyUsd: number;
}

export interface UsageTrackerOptions {
  thresholds?: Partial<typeof LOOP_THRESHOLDS>;
  /** `usageCheck` limits; only used when {@link estimateCost} returns a value. */
  warnSessionCostUsd?: number;
  warnDailyCostUsd?: number;
  /** Hook for backends that bill (M3 `cua`). Return `undefined` when cost is not tracked. */
  estimateCost?: (session: SessionUsage) => CostEstimate | undefined;
  /** Bound on stored warnings per session (all are still returned). */
  maxStoredWarnings?: number;
}

interface LoopState {
  actionKey?: string;
  actionRun: number;
  repeatedReported: boolean;
  /** Hash after the last action whose screen was observed. */
  lastHash?: string;
  /** An action happened since the last observed screenshot. */
  actionPending: boolean;
  unchangedRun: number;
  unchangedReported: boolean;
  sessionCostReported: boolean;
}

/** Plain-language warning text for the model. */
function messageFor(signal: LoopSignal, observed: number, threshold: number): string {
  switch (signal) {
    case "repeated-action":
      return `The same action on the same target ran ${observed} times in a row (limit ${threshold}). Stop and reassess: take a snapshot or screenshot and check whether the action has any effect.`;
    case "unchanged-screen":
      return `The screen did not change across ${observed} consecutive actions (limit ${threshold}). Stop and reassess: the app may be stuck, or the actions miss their target.`;
    case "launch-storm":
      return `gui_launch was called ${observed} times in 10 minutes (limit ${threshold}). Stop and reassess why the app keeps being relaunched.`;
    case "session-cost":
      return `Estimated session cost $${observed.toFixed(2)} passed the warning threshold of $${threshold.toFixed(2)}. Check with the user before continuing.`;
    case "daily-cost":
      return `Estimated cost today $${observed.toFixed(2)} passed the warning threshold of $${threshold.toFixed(2)}. Check with the user before continuing.`;
  }
}

/**
 * Tracks usage per session and detects loops:
 *
 * - `repeated-action`: the same `gui_act` action on the same ref or coordinates
 *   more than `repeatedAction` times in a row. Other tools in between (snapshots,
 *   screenshots) do not break the run; a different action does.
 * - `unchanged-screen`: more than `unchangedScreen` consecutive actions after
 *   which the screenshot hash stayed the same. The hash may come from the act's
 *   auto-screenshot or from the next `gui_screenshot`.
 * - `launch-storm`: more than `launchStorm` `gui_launch` calls within the window,
 *   across all sessions (each launch makes a new session).
 * - `session-cost` / `daily-cost`: through {@link UsageTrackerOptions.estimateCost}.
 *
 * Once a run crosses its threshold, every further call in that run returns the
 * warning again (the model keeps being told); it is stored once per run.
 */
export class UsageTracker {
  readonly #thresholds: typeof LOOP_THRESHOLDS;
  readonly #options: UsageTrackerOptions;
  readonly #sessions = new Map<string, SessionUsage>();
  readonly #loops = new Map<string, LoopState>();
  #launches: number[] = [];
  #launchReported = false;
  #dailyCostReported = false;

  constructor(options: UsageTrackerOptions = {}) {
    this.#thresholds = { ...LOOP_THRESHOLDS, ...options.thresholds };
    this.#options = options;
  }

  /** Registers a session with its backend; events for unknown sessions create one with backend `unknown`. */
  startSession(session: string, backend: string, startedAt: number = Date.now()): SessionUsage {
    const usage: SessionUsage = {
      session,
      backend,
      startedAt,
      toolCalls: {},
      actions: 0,
      screenshots: 0,
      allBlackScreenshots: 0,
      bytesSynced: 0,
      warnings: [],
    };
    this.#sessions.set(session, usage);
    this.#loops.set(session, { actionRun: 0, repeatedReported: false, actionPending: false, unchangedRun: 0, unchangedReported: false, sessionCostReported: false });
    return usage;
  }

  /** Usage of one session (a copy), or `undefined`. */
  session(session: string): SessionUsage | undefined {
    const usage = this.#sessions.get(session);
    return usage && structuredClone(usage);
  }

  /** Usage of every tracked session, oldest first (copies). */
  sessions(): SessionUsage[] {
    return [...this.#sessions.values()].map((u) => structuredClone(u));
  }

  /** Forgets a session (e.g. long after it stopped). */
  forget(session: string): void {
    this.#sessions.delete(session);
    this.#loops.delete(session);
  }

  /** Feeds one completed tool call and returns the warnings it triggers (possibly none). */
  record(event: UsageEvent): UsageWarning[] {
    const usage = this.#sessions.get(event.session) ?? this.startSession(event.session, "unknown", event.at);
    const loop = this.#loops.get(event.session)!;
    const warnings: UsageWarning[] = [];
    const t = this.#thresholds;

    usage.toolCalls[event.tool] = (usage.toolCalls[event.tool] ?? 0) + 1;
    if (event.screenshotSha256 !== undefined) usage.screenshots++;
    if (event.allBlack) usage.allBlackScreenshots++;
    if (event.bytesSynced) usage.bytesSynced += event.bytesSynced;

    if (event.tool === "gui_launch") {
      this.#launches = this.#launches.filter((at) => event.at - at < t.launchStormWindowMs);
      this.#launches.push(event.at);
      if (this.#launches.length > t.launchStorm) {
        warnings.push(this.#warning(usage, "launch-storm", this.#launches.length, t.launchStorm, !this.#launchReported));
        this.#launchReported = true;
      } else {
        this.#launchReported = false;
      }
    }

    if (event.tool === "gui_act") {
      usage.actions++;
      const target = event.ref ?? (event.x !== undefined && event.y !== undefined ? `${event.x},${event.y}` : "");
      const key = `${event.action ?? ""}|${target}`;
      if (key === loop.actionKey) loop.actionRun++;
      else {
        loop.actionKey = key;
        loop.actionRun = 1;
        loop.repeatedReported = false;
      }
      if (loop.actionRun > t.repeatedAction) {
        warnings.push(this.#warning(usage, "repeated-action", loop.actionRun, t.repeatedAction, !loop.repeatedReported));
        loop.repeatedReported = true;
      }
      loop.actionPending = true;
    }

    if (event.screenshotSha256 !== undefined) {
      if (loop.actionPending) {
        if (event.screenshotSha256 === loop.lastHash) loop.unchangedRun++;
        else {
          loop.unchangedRun = 1;
          loop.unchangedReported = false;
        }
        loop.actionPending = false;
        if (loop.unchangedRun > t.unchangedScreen) {
          warnings.push(this.#warning(usage, "unchanged-screen", loop.unchangedRun, t.unchangedScreen, !loop.unchangedReported));
          loop.unchangedReported = true;
        }
      } else if (event.screenshotSha256 !== loop.lastHash) {
        // The screen changed on its own; that breaks an "unchanged" run.
        loop.unchangedRun = 0;
        loop.unchangedReported = false;
      }
      loop.lastHash = event.screenshotSha256;
    }

    warnings.push(...this.#costWarnings(usage, loop));
    return warnings;
  }

  #costWarnings(usage: SessionUsage, loop: LoopState): UsageWarning[] {
    const estimate = this.#options.estimateCost?.(usage);
    if (!estimate) return [];
    const warnings: UsageWarning[] = [];
    const sessionLimit = this.#options.warnSessionCostUsd;
    if (sessionLimit !== undefined && estimate.sessionUsd > sessionLimit && !loop.sessionCostReported) {
      loop.sessionCostReported = true;
      warnings.push(this.#warning(usage, "session-cost", estimate.sessionUsd, sessionLimit, true));
    }
    const dailyLimit = this.#options.warnDailyCostUsd;
    if (dailyLimit !== undefined && estimate.dailyUsd > dailyLimit && !this.#dailyCostReported) {
      this.#dailyCostReported = true;
      warnings.push(this.#warning(usage, "daily-cost", estimate.dailyUsd, dailyLimit, true));
    }
    return warnings;
  }

  #warning(usage: SessionUsage, signal: LoopSignal, observed: number, threshold: number, store: boolean): UsageWarning {
    const warning: UsageWarning = { signal, message: messageFor(signal, observed, threshold), observed, threshold };
    const max = this.#options.maxStoredWarnings ?? 50;
    if (store && usage.warnings.length < max) usage.warnings.push(warning);
    return warning;
  }
}
