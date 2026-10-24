/**
 * Per-extension-instance state shared by tools, commands, and the smoke test:
 * live sessions and their temp dirs, session limits and idle timeout (spec §8),
 * the usage tracker (§8.1), setup cancellation (§5.2), and every cleanup path
 * (§7a.2). Creating it starts nothing; resources appear only when a command or
 * tool asks for them.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Backend, Session, SessionStartOptions } from "../backend.ts";
import { hasCost, sweepAllowed, type RuntimeBackend, type SweepContext } from "../backends/capabilities.ts";
import { DEFAULT_REGISTRY, type BackendOptions, type BackendRegistry } from "../backends/registry.ts";
import { startLeftovers } from "../backends/start-failure.ts";
import { DEFAULT_PROC_ROOT, createOwnerIdentity } from "../cleanup/identity.ts";
import { installExitCleanup } from "../cleanup/exit.ts";
import { createSessionDir, type SessionDir } from "../cleanup/session-dir.ts";
import { auditClientOrphans, auditSession, sweepClientOrphans, type SweepReport } from "../cleanup/sweep.ts";
import { loadConfigSources, resolveConfig } from "../config/load.ts";
import { DEFAULTS, globalConfigPath, type BackendId, type GlobalConfig, type ResolvedConfig, type UsageCheckConfig } from "../config/types.ts";
import { notSetUpMessage, verificationState } from "../config/verified.ts";
import { formatOwnerLabel, type OwnerLabel } from "../owner.ts";
import type { Leftover, LogEvent } from "../protocol.ts";
import type { pickHost } from "../setup/hosts.ts";
import { UsageTracker } from "../usage/detector.ts";
import { SessionRegistry } from "../usage/registry.ts";
import type { UsageEvent, UsageWarning } from "../usage/types.ts";
import { LogBuffer } from "./logs.ts";

/** The most recent screenshot of a session; coordinates in `gui_act` refer to it. */
export interface CaptureRef {
  captureId: string;
  target: string;
  scale: number;
  width: number;
  height: number;
}

/**
 * `running`: usable. `closing`: a teardown runs. `failed`: a teardown left
 * something behind; the session stays listed (with its temp dir, `owner.json`,
 * and the exit handler) until `/gui-cleanup`, `gui_stop`, or shutdown retries.
 */
export type LiveState = "running" | "closing" | "failed";

export interface LiveSession {
  id: string;
  backend: BackendId;
  session: Session;
  dir: SessionDir;
  /** Screenshots, dumps, and logs; exported by `gui_export`. Temporary. */
  artifactsDir: string;
  logs: LogBuffer;
  startedAt: number;
  /** Smoke-test sessions do not count against the session limit. */
  transient: boolean;
  lastCapture?: CaptureRef;
  counter: number;
  queue: Promise<unknown>;
  state: LiveState;
  /** Tool calls admitted and not finished (queued or running); idle reaping skips the session meanwhile. */
  inFlight: number;
  /** The running teardown, shared by concurrent `closeSession` calls. */
  closing?: Promise<StopOutcome>;
}

export interface StopOutcome {
  /** What `stop` could not remove. */
  stopLeftovers: Leftover[];
  /** Session-scoped footprint audit after stop (spec §7a.4); must be empty. */
  audit: Leftover[];
}

export interface OpenSessionOptions {
  backend: BackendId;
  projectRoot: string;
  config: ResolvedConfig;
  piSessionId: string;
  signal?: AbortSignal;
  onStatus?: (text: string | undefined) => void;
  transient?: boolean;
  /**
   * The runtime generation ({@link GuiRuntime.signal}) the caller captured
   * before its first await; a start for a generation that has shut down is refused.
   */
  generation?: AbortSignal;
}

/**
 * Backend construction options (`backendOptions`, and the M1 names `docker`
 * and `dockerOnPath`) come from {@link BackendOptions}; tests inject runners
 * and fakes there.
 */
export interface RuntimeOptions extends BackendOptions {
  /** The backends this runtime offers; default: the registry of this build. */
  registry?: BackendRegistry;
  /** Replaces backend construction entirely (unit tests). Ids still come from the registry. */
  createBackend?: (id: BackendId, runtime: GuiRuntime) => Backend;
  procRoot?: string;
  tmpRoot?: string;
  globalConfigPath?: string;
  now?: () => number;
  /** Bound for `shutdown()` to wait for session starts and setup runs in flight. */
  shutdownWaitMs?: number;
  /** Replaces the `/gui-setup` SSH host picker (`pickHost` of `src/setup/hosts.ts`; unit tests). */
  hostPicker?: typeof pickHost;
}

/** Default bound for `shutdown()` to wait for pending starts and setup runs. */
export const SHUTDOWN_WAIT_MS = 20_000;

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}

/** For work that began before a shutdown and would continue after it. */
function retiredError(): Error {
  return abortError("Pi is shutting down (or restarted this extension); run the command again");
}

/**
 * Throws when the runtime generation captured at a command's entry has shut
 * down: Pi stopped (or reloaded) the extension while the command awaited.
 */
export function assertCurrent(generation: AbortSignal): void {
  if (generation.aborted) throw retiredError();
}

/** Placeholder for a failed start whose backend resources are gone but whose temp dir is not. */
function cleanedSession(id: string, backend: BackendId): Session {
  return {
    id,
    backend,
    arch: "unknown",
    request: () => Promise.reject(new Error(`GUI session ${id} never started`)),
    stop: async () => [],
    auditFootprint: async () => [],
  };
}

/** A backend with its optional capabilities (`src/backends/capabilities.ts`). */
export type { RuntimeBackend } from "../backends/capabilities.ts";

export class GuiRuntime {
  readonly options: RuntimeOptions;
  /** `usageCheck` thresholds of the latest session start (read by the tracker on every call). */
  #usageCheck: Required<UsageCheckConfig> = { ...DEFAULTS.usageCheck };
  /**
   * Usage and loop check (spec §8.1). Billing backends ({@link CostCapability},
   * e.g. `cua`) feed the cost estimate; the cost thresholds are the
   * `usageCheck` of the latest session start.
   */
  readonly tracker: UsageTracker;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #backends = new Map<BackendId, RuntimeBackend>();
  /** Removal argv of sessions that are still starting (bound to their endpoint, from the backend), for the exit handler. */
  readonly #starting = new Map<string, string[]>();
  #identity?: OwnerLabel;
  #registry?: SessionRegistry;
  #idleTimer?: NodeJS.Timeout;
  #uninstallExit?: () => void;
  #shutdown = new AbortController();
  #setup?: { controller: AbortController; label: string; done: Promise<void>; finish: () => void };
  #notify?: (message: string, type: "info" | "warning" | "error") => void;
  #sweep?: Promise<SweepReport | undefined>;
  /** Session starts in flight, awaited by `shutdown()`. */
  readonly #pending = new Set<Promise<unknown>>();
  /** Config warnings already shown in a tool result. */
  readonly #reportedWarnings = new Set<string>();

  constructor(options: RuntimeOptions = {}) {
    this.options = options;
    const runtime = this;
    this.tracker = new UsageTracker({
      estimateCost: (usage) => {
        const backend = this.#backends.get(usage.backend as BackendId);
        return backend && hasCost(backend) ? backend.estimateCost(usage) : undefined;
      },
      get warnSessionCostUsd() {
        return runtime.#usageCheck.warnSessionCostUsd;
      },
      get warnDailyCostUsd() {
        return runtime.#usageCheck.warnDailyCostUsd;
      },
    });
  }

  /** Directory of the global config; backends keep their state files there. */
  get configDir(): string {
    return dirname(this.options.globalConfigPath ?? globalConfigPath());
  }

  get procRoot(): string {
    return this.options.procRoot ?? DEFAULT_PROC_ROOT;
  }

  /** Owner identity of this extension instance; read lazily from `/proc`. */
  identity(): OwnerLabel {
    this.#identity ??= createOwnerIdentity(this.procRoot);
    return this.#identity;
  }

  ownerLabel(): string {
    return formatOwnerLabel(this.identity());
  }

  /** The backends this runtime offers, in picker order. */
  get registry(): BackendRegistry {
    return this.options.registry ?? DEFAULT_REGISTRY;
  }

  /** Whether `id` is a backend of this runtime. */
  implemented(id: string): id is BackendId {
    return this.registry.has(id);
  }

  /** "not available yet" text for `id`, listing this runtime's backends. */
  notAvailableMessage(id: string): string {
    return this.registry.notAvailableMessage(id);
  }

  /**
   * The backend for `id`, created on first use (creating one runs nothing).
   *
   * @throws Error with the "not available yet" text for backends this build lacks.
   */
  backend(id: BackendId): RuntimeBackend {
    if (!this.implemented(id)) throw new Error(this.notAvailableMessage(id));
    let backend = this.#backends.get(id);
    if (!backend) {
      backend = this.options.createBackend
        ? this.options.createBackend(id, this)
        : this.registry.create(id, {
            ownerLabel: () => this.ownerLabel(),
            ...(this.options.tmpRoot ? { tmpRoot: this.options.tmpRoot } : {}),
            ...(this.options.procRoot ? { procRoot: this.options.procRoot } : {}),
            configDir: this.configDir,
            runtimeOptions: this.options,
          });
      this.#backends.set(id, backend);
    }
    return backend;
  }

  /** Remembers how to notify the user (from the latest context with a UI). */
  setNotifier(notify: ((message: string, type: "info" | "warning" | "error") => void) | undefined): void {
    this.#notify = notify;
  }

  notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    this.#notify?.(message, type);
  }

  /**
   * Aborted while Pi shuts down this extension instance; long commands pass it on.
   * It also identifies the runtime generation: `shutdown()` ends with a fresh
   * signal, so a signal captured before an await that is aborted afterwards
   * means the caller belongs to a retired generation and must not continue.
   */
  get signal(): AbortSignal {
    return this.#shutdown.signal;
  }

  /**
   * The backends among `ids` that may be swept and audited now, per their
   * {@link SweepAvailability} gate (no command runs to decide; e.g. Docker
   * only when a `docker` executable is on PATH).
   */
  async sweepableBackends(ids: readonly BackendId[], context: SweepContext): Promise<BackendId[]> {
    const allowed: BackendId[] = [];
    for (const id of ids) {
      let backend: RuntimeBackend;
      try {
        backend = this.backend(id);
      } catch {
        continue;
      }
      if (await sweepAllowed(backend, context)) allowed.push(id);
    }
    return allowed;
  }

  /** The config warnings not yet shown in a tool result, marking them shown. */
  takeConfigWarnings(warnings: readonly string[]): string[] {
    const fresh = warnings.filter((w) => !this.#reportedWarnings.has(w));
    for (const w of fresh) this.#reportedWarnings.add(w);
    return fresh;
  }
  /** Loads and resolves the config for a project. */
  async config(projectRoot: string): Promise<{ resolved: ResolvedConfig; global: GlobalConfig }> {
    const sources = await loadConfigSources(projectRoot, this.options.globalConfigPath);
    return { resolved: resolveConfig(sources), global: sources.global };
  }

  /**
   * The backend tools must use, refusing unless it is verified (spec §5.1, R8).
   * The only implemented backend is used when none is chosen; no other backend
   * is ever substituted (R6).
   *
   * @throws Error with the spec's "not set up" text.
   */
  async verifiedBackend(projectRoot: string): Promise<{ id: BackendId; backend: RuntimeBackend; config: ResolvedConfig; global: GlobalConfig }> {
    const { resolved, global } = await this.config(projectRoot);
    const id = resolved.backend ?? this.registry.defaultId;
    if (!this.implemented(id)) throw new Error(this.notAvailableMessage(id));
    const state = verificationState(global, id);
    if (state.state !== "verified") throw new Error(notSetUpMessage(id));
    return { id, backend: this.backend(id), config: resolved, global };
  }

  // ---------------------------------------------------------------- setup

  /**
   * Starts a setup or doctor run with its own abort controller (spec §5.2).
   *
   * @param generation The {@link signal} the command captured at entry, before any await.
   * @throws Error when another run is active, or when Pi shut down since `generation` was captured.
   */
  beginSetup(label: string, generation?: AbortSignal): AbortController {
    if (generation?.aborted || this.#shutdown.signal.aborted) throw retiredError();
    if (this.#setup) throw new Error(`${this.#setup.label} is already running; wait for it or cancel it with /gui-cleanup`);
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    this.#setup = { controller, label, done, finish };
    return controller;
  }

  endSetup(controller: AbortController): void {
    if (this.#setup?.controller !== controller) return;
    this.#setup.finish();
    this.#setup = undefined;
  }

  /** Aborts a running setup or doctor run; returns its label, or `undefined` when none ran. */
  cancelSetup(reason: string): string | undefined {
    const setup = this.#setup;
    if (!setup) return undefined;
    setup.controller.abort(Object.assign(new Error(reason), { name: "AbortError" }));
    return setup.label;
  }

  // ---------------------------------------------------------------- sessions

  #registryFor(config: ResolvedConfig): SessionRegistry {
    // Limits come from the config of the first launch; they are re-read whenever no session runs.
    if (!this.#registry || this.#registry.size === 0) {
      this.#registry = new SessionRegistry({ ...config.limits, ...(this.options.now ? { now: this.options.now } : {}) });
    }
    return this.#registry;
  }

  /** Sessions in start order, including those whose teardown is running or failed. */
  list(): LiveSession[] {
    return [...this.#sessions.values()];
  }

  /** A session by id in any state, or `undefined`. */
  find(id: string): LiveSession | undefined {
    return this.#sessions.get(id);
  }

  /**
   * A running session by id.
   *
   * @throws Error naming the active sessions when `id` is unknown, or saying why it is not usable.
   */
  get(id: string): LiveSession {
    const live = this.#sessions.get(id);
    if (!live) {
      const active = this.list().filter((s) => !s.transient && s.state === "running").map((s) => s.id);
      throw new Error(`unknown GUI session "${id}"; ${active.length ? `active: ${active.join(", ")}` : "no session is running; start one with gui_launch"}`);
    }
    if (live.state === "closing") throw new Error(`GUI session ${id} is stopping`);
    if (live.state === "failed") throw new Error(`GUI session ${id} was stopped, but its cleanup did not finish; run gui_stop or /gui-cleanup to retry`);
    return live;
  }

  /**
   * Runs `fn` after the session's previous operation finished (sequential per
   * session, spec §8). The call counts as activity from admission to its end,
   * so idle reaping never stops a session with a queued or running call.
   */
  withSession<T>(id: string, fn: (live: LiveSession) => Promise<T>): Promise<T> {
    const live = this.get(id);
    const release = this.admit(id);
    const run = live.queue.then(() => fn(live));
    live.queue = run.catch(() => {});
    return run.finally(release);
  }

  /**
   * Marks a call on session `id` as admitted: activity now, and in flight
   * (never idle-reaped) until the returned release function runs, which is
   * activity too. Tools call it before any await, so a reap cannot slip in
   * between the call's arrival and its turn in the queue. Unknown ids are ignored.
   */
  admit(id: string): () => void {
    const live = this.#sessions.get(id);
    if (!live) return () => {};
    live.inFlight++;
    this.touch(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      live.inFlight--;
      this.touch(id);
    };
  }

  /** Records activity for the idle timeout. */
  touch(id: string): void {
    this.#registry?.touch(id);
    this.#scheduleIdle();
  }

  /** Feeds the usage tracker; returns warnings and notifies the user about them (never blocks). */
  recordUsage(event: Omit<UsageEvent, "at">): UsageWarning[] {
    const warnings = this.tracker.record({ ...event, at: this.options.now?.() ?? Date.now() });
    for (const warning of warnings) this.notify(`GUI testing (${event.session}): ${warning.message}`, "warning");
    return warnings;
  }

  /** Counts a `gui_launch` that failed (no session to attribute it to) for launch-storm detection. */
  recordFailedLaunch(): UsageWarning[] {
    const warnings = this.tracker.recordFailedLaunch(this.options.now?.() ?? Date.now());
    for (const warning of warnings) this.notify(`GUI testing: ${warning.message}`, "warning");
    return warnings;
  }

  /**
   * Opens a session: reserves a slot, creates the temp dir with `owner.json`,
   * and starts the backend session. On failure nothing is left behind, or what
   * is left stays listed as a `failed` session until a retry removes it. A start
   * that finishes after shutdown began is torn down instead of registered.
   *
   * @throws SessionLimitError, WorkspaceRefusedError, SessionError, …
   */
  openSession(options: OpenSessionOptions): Promise<LiveSession> {
    if (this.#shutdown.signal.aborted || options.generation?.aborted) return Promise.reject(abortError("Pi is shutting down; no new GUI session starts"));
    // A caller cancelled before the start (e.g. a setup run aborted by a shutdown that has finished).
    if (options.signal?.aborted) return Promise.reject(abortError("the GUI session start was cancelled"));
    const run = this.#openSession(options, this.#shutdown);
    this.#pending.add(run);
    void run.then(
      () => this.#pending.delete(run),
      () => this.#pending.delete(run),
    );
    return run;
  }

  async #openSession(options: OpenSessionOptions, generation: AbortController): Promise<LiveSession> {
    const id = `gui-${randomBytes(4).toString("hex")}`;
    const backend = this.backend(options.backend);
    const transient = options.transient ?? false;
    const registry = transient ? undefined : this.#registryFor(options.config);
    registry?.register(id, options.backend);
    let dir: SessionDir | undefined;
    let logs: LogBuffer | undefined;
    const signal = options.signal ? AbortSignal.any([options.signal, generation.signal]) : generation.signal;
    let live: LiveSession;
    try {
      dir = await createSessionDir({
        identity: this.identity(),
        piSessionId: options.piSessionId,
        backend: options.backend,
        ...(this.options.tmpRoot ? { tmpRoot: this.options.tmpRoot } : {}),
      });
      const artifactsDir = join(dir.path, "artifacts");
      await mkdir(artifactsDir, { mode: 0o700 });
      logs = new LogBuffer(join(artifactsDir, "app.log"));
      const sessionLogs = logs;
      this.#installExitCleanup();
      const start: SessionStartOptions = {
        sessionId: id,
        projectRoot: options.projectRoot,
        sessionDir: dir.path,
        config: options.config,
        ownerLabel: dir.ownerLabel,
        recordResource: (kind, resourceId) => dir!.recordResource(kind, resourceId),
        onLog: (event: LogEvent) => sessionLogs.add(event),
        ...(options.onStatus ? { onStatus: options.onStatus } : {}),
        signal,
        // The backend registers the endpoint-bound removal before it creates the container.
        onExitCleanup: (argv) => void this.#starting.set(id, argv),
      };
      const session = await backend.startSession(start);
      live = { id, backend: options.backend, session, dir, artifactsDir, logs, startedAt: Date.now(), transient, counter: 0, queue: Promise.resolve(), state: "running", inFlight: 0 };
      this.#sessions.set(id, live);
    } catch (error) {
      registry?.unregister(id);
      if (dir) await this.#settleFailedStart(id, options.backend, transient, dir, logs, error);
      throw error;
    } finally {
      this.#starting.delete(id);
    }
    if (generation.signal.aborted) {
      // Shutdown began while this session started: never hand it out; tear it down (kept listed if that fails).
      await this.closeSession(id);
      throw abortError("Pi is shutting down; the GUI session that was starting was stopped");
    }
    if (!transient) {
      this.#usageCheck = { ...options.config.usageCheck };
      this.tracker.startSession(id, options.backend);
    }
    this.touch(id);
    return live;
  }

  /**
   * After a failed start: removes the temp dir when nothing is left. When the
   * backend reports leftovers ({@link startLeftovers}) or the dir cannot be
   * removed, the start stays listed as a `failed` session instead (temp dir,
   * `owner.json`, and exit cleanup kept), so `gui_stop`, `/gui-cleanup`,
   * `stopAll`, and shutdown retry it; the error message says so.
   */
  async #settleFailedStart(id: string, backend: BackendId, transient: boolean, dir: SessionDir, logs: LogBuffer | undefined, error: unknown): Promise<void> {
    const remnant = startLeftovers(error);
    if (!remnant && (await dir.remove().then(() => true, () => false))) return;
    const artifactsDir = join(dir.path, "artifacts");
    const session = remnant?.session ?? cleanedSession(id, backend);
    this.#sessions.set(id, {
      id,
      backend,
      session,
      dir,
      artifactsDir,
      logs: logs ?? new LogBuffer(),
      startedAt: Date.now(),
      transient,
      counter: 0,
      queue: Promise.resolve(),
      state: "failed",
      inFlight: 0,
    });
    this.#installExitCleanup();
    const what = remnant ? remnant.leftovers.map((l) => `${l.kind} ${l.id}${l.detail ? ` (${l.detail})` : ""}`).join(", ") : `temp dir ${dir.path}`;
    const note = `\nCleanup after the failed start of ${id} did not finish (${what}); it stays tracked and is retried by gui_stop {"session":"${id}"}, /gui-cleanup, or when Pi exits.`;
    if (error instanceof Error) error.message += note;
  }

  /**
   * Stops one session, removes its temp dir, and audits its footprint.
   * Concurrent calls share one teardown. The session is forgotten only when
   * the audit is empty; otherwise it stays listed as `failed` (with its temp
   * dir, `owner.json`, and the exit handler) and the next call retries.
   */
  closeSession(id: string): Promise<StopOutcome> {
    const live = this.#sessions.get(id);
    if (!live) return Promise.resolve({ stopLeftovers: [], audit: [] });
    if (!live.closing) {
      const closing = this.#teardown(live);
      live.closing = closing;
      void closing.finally(() => {
        if (live.closing === closing) live.closing = undefined;
      });
    }
    return live.closing;
  }

  async #teardown(live: LiveSession): Promise<StopOutcome> {
    live.state = "closing";
    this.#registry?.unregister(live.id);
    this.#scheduleIdle();
    let stopFailed = false;
    const stopLeftovers = await live.session.stop().catch((e: Error): Leftover[] => {
      stopFailed = true;
      return [{ kind: "session", id: live.id, detail: `stop failed: ${e.message}` }];
    });
    await live.logs.flush();
    let audit = await live.session.auditFootprint().catch((e: Error): Leftover[] => [{ kind: "audit", id: live.id, detail: `audit failed: ${e.message}` }]);
    if (audit.length === 0 && !stopFailed) {
      // Only now is it safe to drop owner.json: nothing it lists is left.
      const resources = live.dir.resources;
      await live.dir.remove().catch(() => {});
      audit = await auditSession({ path: live.dir.path, resources }, this.procRoot);
    }
    if (audit.length === 0 && !stopFailed) {
      this.#sessions.delete(live.id);
      if (this.#sessions.size === 0) this.#uninstallExitCleanup();
    } else {
      live.state = "failed";
    }
    return { stopLeftovers, audit };
  }

  #scheduleIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    const next = this.#registry?.nextIdleInMs();
    if (next === undefined) return;
    this.#idleTimer = setTimeout(() => void this.reapIdle(), next + 50);
    this.#idleTimer.unref?.();
  }

  /** Tears down sessions idle for `idleTimeoutMinutes` (spec §8 Limits). Returns the stopped ids. */
  async reapIdle(): Promise<string[]> {
    const idle: string[] = [];
    for (const id of this.#registry?.idleSessions() ?? []) {
      // A queued or running call is activity: never stop a session under it.
      if ((this.#sessions.get(id)?.inFlight ?? 0) > 0) this.#registry?.touch(id);
      else idle.push(id);
    }
    for (const id of idle) {
      const outcome = await this.closeSession(id);
      const leftovers = [...outcome.stopLeftovers, ...outcome.audit];
      this.notify(
        `GUI session ${id} was idle too long and was stopped${leftovers.length ? `; leftovers: ${leftovers.map((l) => `${l.kind} ${l.id}`).join(", ")}` : ""}`,
        leftovers.length ? "warning" : "info",
      );
    }
    this.#scheduleIdle();
    return idle;
  }

  /** The commands the synchronous exit handler runs now: removal of every listed session and of starts in flight. */
  exitCleanupCommands(): string[][] {
    return [
      ...this.list().map((live) => live.session.forceRemoveArgv?.() ?? []),
      ...this.#starting.values(),
    ];
  }

  #installExitCleanup(): void {
    if (this.#uninstallExit) return;
    this.#uninstallExit = installExitCleanup({
      commands: () => this.exitCleanupCommands(),
      dirs: () => this.list().map((live) => live.dir.path),
    });
  }

  #uninstallExitCleanup(): void {
    if (this.#starting.size > 0 || this.#sessions.size > 0) return;
    this.#uninstallExit?.();
    this.#uninstallExit = undefined;
  }

  /** Stops every session of `backend` (or all), retrying failed teardowns. Returns the combined leftovers. */
  async stopAll(backend?: BackendId): Promise<Leftover[]> {
    const leftovers: Leftover[] = [];
    for (const live of this.list()) {
      if (backend && live.backend !== backend) continue;
      const outcome = await this.closeSession(live.id);
      leftovers.push(...outcome.stopLeftovers, ...outcome.audit);
    }
    return leftovers;
  }

  // ---------------------------------------------------------------- sweep and audit

  /**
   * Startup sweep (spec §7a.2): removes temp dirs and processes of dead
   * owners, then runs the sweeper of every registered backend whose gate
   * allows it, whatever the verified state (a session may have outlived a
   * reset or a failed doctor). Gates run no command (Docker: a `docker`
   * executable on PATH). Errors end up in the report; the sweep never throws.
   */
  sweep(_projectRoot?: string, signal: AbortSignal = this.#shutdown.signal): Promise<SweepReport | undefined> {
    const run = async (): Promise<SweepReport | undefined> => {
      const ids = await this.sweepableBackends(this.registry.ids, { startup: true });
      const sweepers = ids.map((id) => this.backend(id));
      return sweepClientOrphans({ signal, sweepers, procRoot: this.procRoot, ...(this.options.tmpRoot ? { tmpRoot: this.options.tmpRoot } : {}) });
    };
    this.#sweep = run().catch(() => undefined);
    return this.#sweep;
  }

  /** Orphan audit for doctor and cleanup: client scope plus the scope of each given backend. */
  async auditOrphans(backends: BackendId | readonly BackendId[] | undefined, signal: AbortSignal): Promise<Leftover[]> {
    const leftovers = await auditClientOrphans({ procRoot: this.procRoot, ...(this.options.tmpRoot ? { tmpRoot: this.options.tmpRoot } : {}) });
    const ids: readonly BackendId[] = backends === undefined ? [] : typeof backends === "string" ? [backends] : backends;
    for (const backend of ids) {
      try {
        leftovers.push(...(await this.backend(backend).auditOrphans(signal)));
      } catch (error) {
        leftovers.push({ kind: "audit", id: backend, detail: `audit failed: ${(error as Error).message}` });
      }
    }
    return leftovers;
  }

  /** Runs the sweep now (`/gui-cleanup`), for the client scope and the given backends. */
  sweepNow(backends: readonly BackendId[], signal: AbortSignal): Promise<SweepReport> {
    return sweepClientOrphans({
      signal,
      sweepers: backends.map((b) => this.backend(b)),
      procRoot: this.procRoot,
      ...(this.options.tmpRoot ? { tmpRoot: this.options.tmpRoot } : {}),
    });
  }

  // ---------------------------------------------------------------- shutdown

  /**
   * Idempotent `session_shutdown` path: refuses new sessions, cancels setup
   * and launches, waits (bounded) for starts and setup runs in flight, stops
   * every session, removes temp dirs. Sessions whose teardown fails stay
   * covered by the synchronous exit handler.
   */
  async shutdown(): Promise<void> {
    this.cancelSetup("Pi is shutting down");
    this.#shutdown.abort(abortError("Pi is shutting down"));
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    const inFlight = [...this.#pending, ...(this.#setup ? [this.#setup.done] : [])];
    if (inFlight.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, this.options.shutdownWaitMs ?? SHUTDOWN_WAIT_MS)));
      await Promise.race([Promise.allSettled(inFlight), bound]);
      clearTimeout(timer);
    }
    await this.stopAll();
    await this.#sweep;
    this.#uninstallExitCleanup();
    this.#shutdown = new AbortController();
  }
}
