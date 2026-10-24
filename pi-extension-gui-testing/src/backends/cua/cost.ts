/**
 * Estimated sandbox cost for the usage check (spec §8.1): sandbox runtime ×
 * hourly rate. The rate comes from Cua (`cua cloud status` lists each cloud's
 * machine price) and otherwise from the rate entered at setup. Runtime counts
 * from the start of `sandbox create` until the deletion is confirmed (what the
 * cloud bills), not from the helper's start. It is an estimate: the cloud's
 * own billing (minimum charges, disks, egress) is authoritative.
 */
import type { CostEstimate } from "../../usage/detector.ts";
import type { SessionUsage } from "../../usage/types.ts";
import type { CloudProvider } from "./api.ts";

interface Billed {
  usdPerHour: number;
  startedAt: number;
  endedAt?: number;
}

/** The hourly price Cua reports for `image` in `location`, if any. */
export function reportedRate(providers: readonly CloudProvider[], location: string, image: string): number | undefined {
  const provider = providers.find((p) => p.name === location);
  if (!provider) return undefined;
  const kinds = provider.kinds.filter((k) => k.supported && k.usdPerHour !== undefined);
  const exact = kinds.find((k) => k.image === image);
  const linux = kinds.find((k) => k.image === "linux");
  return (exact ?? linux ?? kinds[0])?.usdPerHour;
}

/** Overlap of `[start, end)` with `[from, to)` in milliseconds. */
function overlap(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

const HOUR_MS = 3_600_000;

/**
 * Per-process record of billed sandbox time, fed by the `cua` sessions and
 * read by `UsageTracker`'s `estimateCost` hook. Sessions without a known
 * rate are not estimated.
 */
export class CuaCostLedger {
  readonly #sessions = new Map<string, Billed>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A sandbox for `session` started billing (call before `sandbox create`). */
  start(session: string, usdPerHour: number | undefined, at: number = this.#now()): void {
    if (usdPerHour === undefined || !Number.isFinite(usdPerHour) || usdPerHour < 0) return;
    this.#sessions.set(session, { usdPerHour, startedAt: at });
  }

  /** The sandbox of `session` was deleted or handed to `keepSandbox` (no longer this session's cost). */
  stop(session: string, at: number = this.#now()): void {
    const billed = this.#sessions.get(session);
    if (billed && billed.endedAt === undefined) billed.endedAt = at;
  }

  /** Estimated USD of one session so far. */
  sessionUsd(session: string, at: number = this.#now()): number | undefined {
    const billed = this.#sessions.get(session);
    if (!billed) return undefined;
    return ((billed.endedAt ?? at) - billed.startedAt) / HOUR_MS * billed.usdPerHour;
  }

  /** Estimated USD of every session's sandbox time since local midnight. */
  dailyUsd(at: number = this.#now()): number {
    const midnight = new Date(at);
    midnight.setHours(0, 0, 0, 0);
    let total = 0;
    for (const billed of this.#sessions.values()) {
      total += overlap(billed.startedAt, billed.endedAt ?? at, midnight.getTime(), at) / HOUR_MS * billed.usdPerHour;
    }
    return total;
  }

  /** `UsageTrackerOptions.estimateCost`: an estimate for `cua` sessions with a known rate, else `undefined`. */
  estimate(usage: SessionUsage): CostEstimate | undefined {
    if (usage.backend !== "cua") return undefined;
    const at = this.#now();
    const sessionUsd = this.sessionUsd(usage.session, at);
    if (sessionUsd === undefined) return undefined;
    return { sessionUsd, dailyUsd: this.dailyUsd(at) };
  }

  /** Drops sessions that ended before local midnight (bounded memory). */
  prune(at: number = this.#now()): void {
    const midnight = new Date(at);
    midnight.setHours(0, 0, 0, 0);
    for (const [session, billed] of this.#sessions) if (billed.endedAt !== undefined && billed.endedAt < midnight.getTime()) this.#sessions.delete(session);
  }
}
