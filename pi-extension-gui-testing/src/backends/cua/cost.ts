/**
 * Estimated sandbox cost for the usage check (spec §8.1): sandbox runtime ×
 * hourly rate. The rate comes from Cua (`cua cloud status` lists each cloud's
 * machine price) and otherwise from the rate entered at setup. Runtime counts
 * per sandbox from the start of `sandbox create` until the deletion is
 * confirmed (what the cloud bills), not from the helper's start, and goes on
 * while a kept sandbox waits between sessions. It is an estimate: the cloud's
 * own billing (minimum charges, disks, egress) is authoritative.
 */
import type { CostEstimate } from "../../usage/detector.ts";
import type { SessionUsage } from "../../usage/types.ts";
import type { CloudProvider } from "./api.ts";

/** Billing of one sandbox: from the start of `sandbox create` until its deletion is confirmed. */
interface Billed {
  usdPerHour: number;
  startedAt: number;
  endedAt?: number;
}

/** One session's use of a sandbox (its share for the per-session estimate). */
interface Attached {
  sandbox: string;
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
 * read by `UsageTracker`'s `estimateCost` hook. Billing is tracked per
 * sandbox until its deletion is confirmed, so a sandbox kept by
 * `keepSandbox` keeps counting between sessions, and a reused one is never
 * counted twice. Sessions without a known rate are not estimated.
 */
export class CuaCostLedger {
  readonly #sandboxes = new Map<string, Billed>();
  readonly #sessions = new Map<string, Attached>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * `session` starts using a sandbox: a new one (call before `sandbox create`)
   * or a kept one. A sandbox that is already billing keeps its start time.
   *
   * @param sandbox The sandbox (its ref; default: the session id) and, for a
   *   kept sandbox not yet tracked here, when it began billing.
   */
  start(session: string, usdPerHour: number | undefined, at: number = this.#now(), sandbox: { id: string; since?: number } = { id: session }): void {
    if (usdPerHour === undefined || !Number.isFinite(usdPerHour) || usdPerHour < 0) return;
    const billed = this.#sandboxes.get(sandbox.id);
    if (!billed || billed.endedAt !== undefined) {
      const since = sandbox.since !== undefined && Number.isFinite(sandbox.since) && sandbox.since <= at ? sandbox.since : at;
      this.#sandboxes.set(sandbox.id, { usdPerHour, startedAt: since });
    }
    this.#sessions.set(session, { sandbox: sandbox.id, startedAt: at });
  }

  /** `keepSandbox`: `session` handed its sandbox back; the sandbox keeps billing until it is deleted. */
  release(session: string, at: number = this.#now()): void {
    const attached = this.#sessions.get(session);
    if (attached && attached.endedAt === undefined) attached.endedAt = at;
  }

  /** The sandbox of `session` was deleted (confirmed): the session and the sandbox stop billing. */
  stop(session: string, at: number = this.#now()): void {
    const attached = this.#sessions.get(session);
    if (!attached) return;
    this.release(session, at);
    this.sandboxDeleted(attached.sandbox, at);
  }

  /** A sandbox was deleted outside a session (sweep, `/gui-reset`) or found gone. */
  sandboxDeleted(sandbox: string, at: number = this.#now()): void {
    const billed = this.#sandboxes.get(sandbox);
    if (billed && billed.endedAt === undefined) billed.endedAt = at;
  }

  /** Estimated USD of one session so far: its time on the sandbox at the sandbox's rate. */
  sessionUsd(session: string, at: number = this.#now()): number | undefined {
    const attached = this.#sessions.get(session);
    const billed = attached && this.#sandboxes.get(attached.sandbox);
    if (!attached || !billed) return undefined;
    const end = Math.min(attached.endedAt ?? at, billed.endedAt ?? at);
    return (Math.max(0, end - attached.startedAt) / HOUR_MS) * billed.usdPerHour;
  }

  /** Estimated USD of every sandbox's billed time since local midnight, kept sandboxes between sessions included. */
  dailyUsd(at: number = this.#now()): number {
    const midnight = new Date(at);
    midnight.setHours(0, 0, 0, 0);
    let total = 0;
    for (const billed of this.#sandboxes.values()) {
      total += (overlap(billed.startedAt, billed.endedAt ?? at, midnight.getTime(), at) / HOUR_MS) * billed.usdPerHour;
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

  /** Drops sandboxes deleted before local midnight and their sessions (bounded memory). */
  prune(at: number = this.#now()): void {
    const midnight = new Date(at);
    midnight.setHours(0, 0, 0, 0);
    for (const [sandbox, billed] of this.#sandboxes) if (billed.endedAt !== undefined && billed.endedAt < midnight.getTime()) this.#sandboxes.delete(sandbox);
    for (const [session, attached] of this.#sessions) if (!this.#sandboxes.has(attached.sandbox)) this.#sessions.delete(session);
  }
}
