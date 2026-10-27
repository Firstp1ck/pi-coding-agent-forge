/**
 * Session limits (spec §8 "Limits", §3a D5): at most `maxConcurrentSessions`
 * per client, and sessions idle for `idleTimeoutMinutes` are torn down. No
 * maximum session duration.
 */

/** A new session would exceed `maxConcurrentSessions`. The message is user- and model-facing. */
export class SessionLimitError extends Error {
  readonly limit: number;
  constructor(limit: number, active: readonly string[]) {
    super(
      `at most ${limit} GUI session${limit === 1 ? "" : "s"} can run at once (limits.maxConcurrentSessions); ` +
        `stop one with gui_stop first. Active: ${active.join(", ")}`,
    );
    this.name = "SessionLimitError";
    this.limit = limit;
  }
}

export interface RegisteredSession {
  id: string;
  backend: string;
  startedAt: number;
  lastActivity: number;
}

export interface SessionRegistryOptions {
  maxConcurrentSessions: number;
  idleTimeoutMinutes: number;
  now?: () => number;
}

/**
 * Bookkeeping for live sessions. Register a session before starting it (the
 * slot is reserved even while the backend is still starting, so two parallel
 * launches cannot both pass the limit), and unregister it once stopped or
 * when the start failed.
 */
export class SessionRegistry {
  readonly #sessions = new Map<string, RegisteredSession>();
  readonly #max: number;
  readonly #idleMs: number;
  readonly #now: () => number;

  constructor(options: SessionRegistryOptions) {
    this.#max = options.maxConcurrentSessions;
    this.#idleMs = options.idleTimeoutMinutes * 60_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Reserves a slot for `id`.
   *
   * @throws SessionLimitError when the limit is reached.
   * @throws Error when `id` is already registered.
   */
  register(id: string, backend: string): RegisteredSession {
    if (this.#sessions.has(id)) throw new Error(`session "${id}" is already registered`);
    if (this.#sessions.size >= this.#max) throw new SessionLimitError(this.#max, [...this.#sessions.keys()]);
    const now = this.#now();
    const session = { id, backend, startedAt: now, lastActivity: now };
    this.#sessions.set(id, session);
    return { ...session };
  }

  /** Records activity (a tool call) on `id`; ignored for unknown ids. */
  touch(id: string): void {
    const session = this.#sessions.get(id);
    if (session) session.lastActivity = this.#now();
  }

  /** Frees the slot of `id`. Idempotent. */
  unregister(id: string): void {
    this.#sessions.delete(id);
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** Registered sessions (copies), in registration order. */
  list(): RegisteredSession[] {
    return [...this.#sessions.values()].map((s) => ({ ...s }));
  }

  /** Ids of sessions with no activity for at least `idleTimeoutMinutes`. */
  idleSessions(): string[] {
    const now = this.#now();
    return [...this.#sessions.values()].filter((s) => now - s.lastActivity >= this.#idleMs).map((s) => s.id);
  }

  /** Milliseconds until the next session becomes idle, or `undefined` when none is registered (for scheduling one timer). */
  nextIdleInMs(): number | undefined {
    const now = this.#now();
    let next: number | undefined;
    for (const s of this.#sessions.values()) {
      const remaining = Math.max(0, s.lastActivity + this.#idleMs - now);
      next = next === undefined ? remaining : Math.min(next, remaining);
    }
    return next;
  }
}
