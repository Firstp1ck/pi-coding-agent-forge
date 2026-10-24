/**
 * One `docker-linux` session (spec §4.1, §6, §7a): a `docker run -i --rm`
 * container whose entrypoint is the helper. Container lifetime follows the
 * helper: closing stdin or a missed heartbeat ends it without client action.
 * The client still verifies after `stop` and removes anything left.
 */
import { SessionError, type Session, type SyncSummary } from "../../backend.ts";
import type { BackendId } from "../../config/types.ts";
import { ProtocolClient, ProtocolClientError } from "../../framing/client.ts";
import { generateToken } from "../../framing/codec.ts";
import { ownedSlice } from "../../framing/log-event.ts";
import { TOKEN_ENV, type Leftover, type LogEvent, type Method, type Params, type Result } from "../../protocol.ts";
import type { CommandRunner, DockerEndpoint } from "../../runner/types.ts";
import { describeFailure, dockerArgv, runDocker } from "./cli.ts";
import { validateResult } from "../response.ts";
import { stopAfterFailedStart } from "../start-failure.ts";
import { listLabelledObjects, removeObject, toLeftover, type LabelledObject } from "./footprint.ts";
import { formatViolations, hardRuleViolations, workspaceMountProblem, type ContainerInspect, type PathProbe } from "./inspect.ts";
import type { ChildHandle, Spawner } from "./process.ts";
import { TailBuffer } from "./process.ts";
import { containerName, dockerRunArgs, WORKSPACE_PATH, type RunArgsInput } from "./run-args.ts";

export interface DockerSessionOptions {
  id: string;
  backend: BackendId;
  runner: CommandRunner;
  spawner: Spawner;
  endpoint: DockerEndpoint;
  run: RunArgsInput;
  packageVersion: string;
  sync?: SyncSummary;
  onLog(event: LogEvent): void;
  pathProbe?: PathProbe;
  readyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** Time the `docker run` process gets to exit after stdin closes. */
  exitWaitMs?: number;
}

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

export class DockerSession implements Session {
  readonly id: string;
  readonly backend: BackendId;
  readonly containerName: string;
  readonly sync?: SyncSummary;
  #arch = "unknown";
  readonly #options: DockerSessionOptions;
  #child?: ChildHandle;
  #client?: ProtocolClient;
  readonly #stderr = new TailBuffer(16 * 1024);
  /** Set by the first `stop()`; requests are refused from then on, even when a stop attempt fails. */
  #closed = false;
  /** The running stop attempt, shared by concurrent callers. */
  #stopping?: Promise<Leftover[]>;
  /** Set once a stop attempt left nothing behind. */
  #stopped = false;

  constructor(options: DockerSessionOptions) {
    this.#options = options;
    this.id = options.id;
    this.backend = options.backend;
    this.containerName = containerName(options.id);
    if (options.sync) this.sync = options.sync;
  }

  get arch(): string {
    return this.#arch;
  }

  /** PID of the `docker run` CLI process, once started. */
  get cliPid(): number | undefined {
    return this.#child?.pid;
  }

  /** `docker rm -f` argv for the synchronous exit handler. */
  forceRemoveArgv(): string[] {
    return dockerArgv(this.#options.endpoint, ["rm", "-f", this.containerName]);
  }

  /** `true` while the helper connection is open. */
  get isOpen(): boolean {
    return this.#client?.isOpen ?? false;
  }

  /**
   * Starts the container, waits for READY, performs `hello`, and verifies the
   * running container against the hard rules before any app starts.
   *
   * @throws SessionError. The session was stopped; when that left something,
   *   the error carries this session and the leftovers ({@link startLeftovers}).
   */
  async start(signal: AbortSignal): Promise<void> {
    const token = generateToken();
    const argv = dockerArgv(this.#options.endpoint, dockerRunArgs(this.#options.run));
    const child = this.#options.spawner.spawn(argv, { env: { [TOKEN_ENV]: token } });
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
        if (status.error) throw new SessionError("START_FAILED", `cannot start docker: ${status.error.message}`);
      });
      const hello = validateResult("hello", await Promise.race([client.connect(this.#options.packageVersion, signal), spawnFailure.then(() => new Promise<never>(() => {}))]));
      this.#arch = hello.arch;
      const violations = await this.#inspectRunning(signal);
      if (violations) throw new SessionError("ISOLATION", `the session container breaks the isolation rules (${violations}); it was removed`);
    } catch (error) {
      const failure = this.#toSessionError(error, "START_FAILED");
      const stderr = this.#stderr.text().trim();
      // A failed removal stays attached to the error (and retryable through stop()); it is never dropped.
      await stopAfterFailedStart(this, failure);
      if (stderr && failure.code !== "ISOLATION") failure.message += `\ndocker: ${ownedSlice(stderr, Math.max(0, stderr.length - 1500))}`;
      throw failure;
    }
  }

  async #inspectRunning(signal: AbortSignal): Promise<string | undefined> {
    const result = await runDocker(this.#options.runner, this.#options.endpoint, ["container", "inspect", this.containerName], { timeoutMs: 10_000, signal });
    if (result.exitCode !== 0) return `docker inspect failed: ${describeFailure(result)}`;
    const [container] = JSON.parse(result.stdout) as ContainerInspect[];
    const problems = [];
    const violations = hardRuleViolations(container, this.#options.pathProbe);
    if (violations.length > 0) problems.push(formatViolations(violations));
    // The workspace must be the exact directory that was checked, not whatever the path names now.
    const workspace = workspaceMountProblem(container, this.#options.run.workspace.source, WORKSPACE_PATH);
    if (workspace) problems.push(`workspace: ${workspace}`);
    return problems.length > 0 ? problems.join("; ") : undefined;
  }

  #toSessionError(error: unknown, fallback: string): SessionError {
    if (error instanceof SessionError) return error;
    // Helper error texts are untrusted too: keep them bounded.
    // Owned copies: the helper controls both fields, and a slice would keep an oversized original alive.
    if (error instanceof ProtocolClientError) return new SessionError(ownedSlice(error.code, 0, 64), error.message.length > 4_096 ? `${ownedSlice(error.message, 0, 4_096)}…` : ownedSlice(error.message));
    if ((error as Error)?.name === "AbortError") return new SessionError("CANCELLED", (error as Error).message || "cancelled");
    return new SessionError(fallback, (error as Error)?.message ?? String(error));
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
      const failure = this.#toSessionError(error, "INTERNAL");
      if (failure.code === "CLOSED") failure.message = `the session container ended (${failure.message}); start a new session with gui_launch`;
      throw failure;
    }
    // Results are untrusted (any process in the container can forge them): check their shape first.
    return validateResult(method, raw);
  }

  /**
   * Teardown: helper `stop`, close stdin, wait for `docker run` to exit, then
   * remove whatever is left. Concurrent calls share one attempt. Once an
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
    const leftovers: Leftover[] = [];
    const client = this.#client;
    const child = this.#child;
    if (client?.isOpen && child?.running()) {
      try {
        const result = validateResult("stop", await client.request("stop", {}, { timeoutMs: METHOD_TIMEOUTS_MS.stop }));
        if (!result.ok) leftovers.push(...result.leftovers.map((l) => ({ ...l, detail: `inside the container${l.detail ? `: ${l.detail}` : ""}` })));
      } catch {
        // The helper is gone or stuck; the container is removed below either way.
      }
    }
    client?.close();
    if (child?.running()) {
      const waited = await Promise.race([child.exited.then(() => true), delay(this.#options.exitWaitMs ?? 15_000).then(() => false)]);
      if (!waited) {
        await removeObject(this.#options.runner, this.#options.endpoint, { kind: "container", id: this.containerName, name: this.containerName, session: this.id }).catch(() => undefined);
        child.kill("SIGTERM");
        const gone = await Promise.race([child.exited.then(() => true), delay(5_000).then(() => false)]);
        if (!gone) child.kill("SIGKILL");
      }
    }
    // Do not trust the helper alone: remove anything still labelled with this session.
    let own: LabelledObject[];
    try {
      own = await this.#listOwn();
    } catch (error) {
      leftovers.push({ kind: "docker", id: this.containerName, detail: `could not list the session's Docker objects: ${(error as Error).message}` });
      own = [];
    }
    for (const object of own) {
      const failed = await removeObject(this.#options.runner, this.#options.endpoint, object).catch((e: Error) => ({ kind: object.kind, id: object.name, detail: e.message }));
      if (failed) leftovers.push(failed);
    }
    return leftovers;
  }

  #listOwn() {
    return listLabelledObjects(this.#options.runner, this.#options.endpoint, { session: this.id });
  }

  /** Read-only: this session's labelled Docker objects and a still-running `docker run` CLI. */
  async auditFootprint(): Promise<Leftover[]> {
    const leftovers: Leftover[] = [];
    try {
      leftovers.push(...(await this.#listOwn()).map((o) => toLeftover(o)));
    } catch (error) {
      leftovers.push({ kind: "docker", id: this.#options.endpoint.host, detail: `audit failed: ${(error as Error).message}` });
    }
    if (this.#child?.running()) leftovers.push({ kind: "process", id: String(this.#child.pid ?? "?"), detail: "docker run CLI still running" });
    return leftovers;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
