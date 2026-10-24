/**
 * The backend-independent half of a session (spec §6, §7a): one helper
 * process reached over stdio, whatever starts it (`docker run -i`, a local
 * spawn, `ssh`). It owns the READY handshake and `hello`, response validation,
 * error mapping with owned copies, the request queue (via
 * {@link ProtocolClient}), and the retryable, shared, idempotent stop. The
 * backend supplies the process and the parts that differ: verification after
 * start, removal of its own resources, and the read-only audit.
 */
import { SessionError, type Session, type SyncSummary } from "../backend.ts";
import type { BackendId } from "../config/types.ts";
import { ProtocolClient, ProtocolClientError } from "../framing/client.ts";
import { generateToken } from "../framing/codec.ts";
import { ownedSlice } from "../framing/log-event.ts";
import { TOKEN_ENV, type Leftover, type LogEvent, type Method, type Params, type Result } from "../protocol.ts";
import { validateResult } from "../backends/response.ts";
import { stopAfterFailedStart } from "../backends/start-failure.ts";
import { TailBuffer, type HelperProcess } from "./process.ts";

/** Default bound per method when the caller passes no timeout. */
export const METHOD_TIMEOUTS_MS: Partial<Record<Method, number>> = {
  hello: 15_000,
  launch: 60_000,
  wait: 15_000,
  snapshot: 30_000,
  snapshotFull: 30_000,
  screenshot: 30_000,
  act: 30_000,
  windows: 10_000,
  stop: 20_000,
};

/** Wording of user-visible messages, so each backend names what the user knows. */
export interface HelperSessionLabels {
  /** What starts the helper, e.g. `docker`: "cannot start docker: …" and "\ndocker: <stderr tail>". */
  launcher: string;
  /** What ends with the helper connection, e.g. "the session container". */
  target: string;
  /** Where helper-reported leftovers live, e.g. "inside the container". */
  inside: string;
  /** Audit detail while the launcher process still runs, e.g. "docker run CLI still running". */
  stillRunning: string;
}

/** The backend-specific parts of a {@link HelperSession}. */
export interface HelperSessionHooks {
  /**
   * Starts the helper with `env` (holding the protocol token, {@link TOKEN_ENV}) and returns its
   * process. Throwing here propagates as is; nothing has started yet.
   */
  spawn(env: Record<string, string>): HelperProcess;
  /**
   * Runs after `hello` and before the session is handed out. Throws (e.g. a
   * `SessionError("ISOLATION", …)`) to fail closed; the session is then stopped.
   */
  verifyAfterStart?(signal: AbortSignal): Promise<void>;
  /**
   * The helper did not exit within `exitWaitMs` after its stdin closed; runs
   * before SIGTERM goes to the launcher's process group (e.g. `docker rm -f`).
   */
  onExitTimeout?(): Promise<void>;
  /**
   * Last step of every stop attempt: removes whatever the backend created for
   * this session, without trusting the helper. Returns what could not be
   * removed; a throw fails the stop attempt (the runtime keeps the session and retries).
   */
  teardown(): Promise<Leftover[]>;
  /** Read-only audit of this session's backend resources (spec §7a.4). */
  audit(): Promise<Leftover[]>;
}

export interface HelperSessionOptions {
  id: string;
  backend: BackendId;
  packageVersion: string;
  sync?: SyncSummary;
  /** Absolute path of the workspace as the helper sees it. */
  workspacePath?: string;
  /** `Session.workspaceDescription`. */
  workspaceDescription?: string;
  /** `Session.warnings`. */
  warnings?: readonly string[];
  onLog(event: LogEvent): void;
  readyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** Time the launcher gets to exit after stdin closes. Default 15 s. */
  exitWaitMs?: number;
  /** Time after SIGTERM before SIGKILL. Default 5 s. */
  killWaitMs?: number;
  /** Error codes whose start failure gets no launcher stderr appended. Default `ISOLATION`. */
  quietCodes?: readonly string[];
  labels: HelperSessionLabels;
  hooks: HelperSessionHooks;
}

/** Launcher stderr kept for start errors (bytes). */
const STDERR_TAIL_BYTES = 16 * 1024;

export class HelperSession implements Session {
  readonly id: string;
  readonly backend: BackendId;
  readonly sync?: SyncSummary;
  readonly workspacePath?: string;
  readonly workspaceDescription?: string;
  readonly warnings?: readonly string[];
  #arch = "unknown";
  readonly #options: HelperSessionOptions;
  #child?: HelperProcess;
  #client?: ProtocolClient;
  readonly #stderr = new TailBuffer(STDERR_TAIL_BYTES);
  /** Set by the first `stop()`; requests are refused from then on, even when a stop attempt fails. */
  #closed = false;
  /** The running stop attempt, shared by concurrent callers. */
  #stopping?: Promise<Leftover[]>;
  /** Set once a stop attempt left nothing behind. */
  #stopped = false;

  constructor(options: HelperSessionOptions) {
    this.#options = options;
    this.id = options.id;
    this.backend = options.backend;
    if (options.sync) this.sync = options.sync;
    if (options.workspacePath) this.workspacePath = options.workspacePath;
    if (options.workspaceDescription) this.workspaceDescription = options.workspaceDescription;
    if (options.warnings?.length) this.warnings = [...options.warnings];
  }

  get arch(): string {
    return this.#arch;
  }

  /** PID of the launcher process, once started. */
  get helperPid(): number | undefined {
    return this.#child?.pid;
  }

  /** `true` while the helper connection is open. */
  get isOpen(): boolean {
    return this.#client?.isOpen ?? false;
  }

  /** `true` while the launcher process runs. */
  get processRunning(): boolean {
    return this.#child?.running() ?? false;
  }

  /**
   * Starts the helper, waits for READY, performs `hello`, and runs the
   * backend's verification before any app starts.
   *
   * @throws SessionError. The session was stopped; when that left something,
   *   the error carries this session and the leftovers ({@link startLeftovers}).
   */
  async start(signal: AbortSignal): Promise<void> {
    const token = generateToken();
    const { labels, hooks } = this.#options;
    const child = hooks.spawn({ [TOKEN_ENV]: token });
    this.#child = child;
    child.stderr.on("data", (chunk: Buffer) => this.#stderr.add(chunk));
    const client = new ProtocolClient({
      stdin: child.stdin,
      stdout: child.stdout,
      token,
      onLog: (event) => this.#options.onLog(event),
      ...(this.#options.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.#options.readyTimeoutMs } : {}),
      ...(this.#options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: this.#options.heartbeatIntervalMs } : {}),
    });
    this.#client = client;
    try {
      const spawnFailure = child.exited.then((status) => {
        if (status.error) throw new SessionError("START_FAILED", `cannot start ${labels.launcher}: ${status.error.message}`);
      });
      const hello = validateResult("hello", await Promise.race([client.connect(this.#options.packageVersion, signal), spawnFailure.then(() => new Promise<never>(() => {}))]));
      this.#arch = hello.arch;
      await hooks.verifyAfterStart?.(signal);
    } catch (error) {
      const failure = toSessionError(error, "START_FAILED");
      const stderr = this.#stderr.text().trim();
      // A failed removal stays attached to the error (and retryable through stop()); it is never dropped.
      await stopAfterFailedStart(this, failure);
      const quiet = this.#options.quietCodes ?? ["ISOLATION"];
      if (stderr && !quiet.includes(failure.code)) failure.message += `\n${labels.launcher}: ${ownedSlice(stderr, Math.max(0, stderr.length - 1500))}`;
      throw failure;
    }
  }

  async request<M extends Method>(method: M, params: Params<M>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Result<M>> {
    if (!this.#client || this.#closed) throw new SessionError("CLOSED", `session ${this.id} is stopped`);
    let raw: unknown;
    try {
      raw = await this.#client.request(method, params, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? METHOD_TIMEOUTS_MS[method],
      });
    } catch (error) {
      const failure = toSessionError(error, "INTERNAL");
      if (failure.code === "CLOSED") failure.message = `${this.#options.labels.target} ended (${failure.message}); start a new session with gui_launch`;
      throw failure;
    }
    // Results are untrusted (any process next to the helper can forge them): check their shape first.
    return validateResult(method, raw);
  }

  /**
   * Teardown: helper `stop`, close stdin, wait for the launcher to exit, then
   * the backend's teardown. Concurrent calls share one attempt. Once an
   * attempt removed everything, later calls resolve `[]` at once; after a
   * failed attempt (leftovers or an error) the next call tries again.
   */
  stop(): Promise<Leftover[]> {
    this.#closed = true;
    if (this.#stopped) return Promise.resolve([]);
    if (this.#stopping) return this.#stopping;
    const attempt = this.#stop();
    this.#stopping = attempt;
    attempt
      .then((leftovers) => void (this.#stopped = leftovers.length === 0), () => {})
      .finally(() => void (this.#stopping = undefined));
    return attempt;
  }

  async #stop(): Promise<Leftover[]> {
    const { labels, hooks } = this.#options;
    const leftovers: Leftover[] = [];
    const client = this.#client;
    const child = this.#child;
    if (client?.isOpen && child?.running()) {
      try {
        const result = validateResult("stop", await client.request("stop", {}, { timeoutMs: METHOD_TIMEOUTS_MS.stop }));
        if (!result.ok) leftovers.push(...result.leftovers.map((l) => ({ ...l, detail: `${labels.inside}${l.detail ? `: ${l.detail}` : ""}` })));
      } catch {
        // The helper is gone or stuck; the backend teardown below runs either way.
      }
    }
    client?.close();
    if (child?.running()) {
      const waited = await Promise.race([child.exited.then(() => true), delay(this.#options.exitWaitMs ?? 15_000).then(() => false)]);
      if (!waited) {
        await hooks.onExitTimeout?.().catch(() => undefined);
        child.kill("SIGTERM");
        const gone = await Promise.race([child.exited.then(() => true), delay(this.#options.killWaitMs ?? 5_000).then(() => false)]);
        if (!gone) child.kill("SIGKILL");
      }
    }
    // Do not trust the helper alone: the backend removes whatever it created for this session.
    leftovers.push(...(await hooks.teardown()));
    return leftovers;
  }

  /** Read-only: the backend's audit of this session plus a launcher process that still runs. */
  async auditFootprint(): Promise<Leftover[]> {
    const leftovers = [...(await this.#options.hooks.audit())];
    if (this.#child?.running()) leftovers.push({ kind: "process", id: String(this.#child.pid ?? "?"), detail: this.#options.labels.stillRunning });
    return leftovers;
  }
}

/**
 * Maps any failure to a {@link SessionError}. Helper error texts are untrusted:
 * code and message become bounded, owned copies, so a slice never keeps an
 * oversized original alive.
 */
export function toSessionError(error: unknown, fallback: string): SessionError {
  if (error instanceof SessionError) return error;
  if (error instanceof ProtocolClientError) return new SessionError(ownedSlice(error.code, 0, 64), error.message.length > 4_096 ? `${ownedSlice(error.message, 0, 4_096)}…` : ownedSlice(error.message));
  if ((error as Error)?.name === "AbortError") return new SessionError("CANCELLED", (error as Error).message || "cancelled");
  return new SessionError(fallback, (error as Error)?.message ?? String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
