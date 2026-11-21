/**
 * What one remote session owns besides its helper: the remote session dir
 * (with every process tagged by its path), the ControlMaster, and for
 * `remote-linux-docker` the session container. One object removes them
 * (teardown, retryable), audits them read-only over a fresh connection, and
 * yields the bounded argv for Pi's synchronous exit handler.
 */
import { SessionError, type Session } from "../../backend.ts";
import type { BackendId } from "../../config/types.ts";
import type { Leftover, Method, Params, Result } from "../../protocol.ts";
import { shellJoin } from "../../transport/ssh/quote.ts";
import type { SshTransport } from "../../transport/ssh/transport.ts";
import { auditRemoteSession, REMOVE_SCRIPT, removeRemoteSessions, type RemoteSessionDir } from "./session-dir.ts";

export interface RemoteResourcesOptions {
  /** The session's transport (ControlMaster). */
  transport: SshTransport;
  /** Fresh transport without ControlMaster for audits (spec §7a.3: "a fresh SSH call"). */
  auditTransport: SshTransport;
  /** Remote session dir name, known before the dir exists. */
  name: string;
}

export class RemoteResources {
  readonly transport: SshTransport;
  readonly auditTransport: SshTransport;
  readonly name: string;
  /** Set once the dir exists. */
  remote?: RemoteSessionDir;
  /** `remote-linux-docker`: `docker --host <h> rm -f <name>` runs first in the exit handler. */
  docker?: { host: string; container: string };

  constructor(options: RemoteResourcesOptions) {
    this.transport = options.transport;
    this.auditTransport = options.auditTransport;
    this.name = options.name;
  }

  get destination(): string {
    return this.transport.destination;
  }

  /**
   * Removes the remote session dir and its processes, then ends the
   * ControlMaster. Returns what is left; never throws.
   */
  async teardown(signal?: AbortSignal): Promise<Leftover[]> {
    const leftovers = await removeRemoteSessions(this.transport.runner, [this.name], { destination: this.destination, ...(signal ? { signal } : {}) });
    await this.transport.close().catch(() => undefined);
    return leftovers;
  }

  /** Read-only: the remote dir and its processes (fresh connection), and a ControlMaster still answering. */
  async audit(signal?: AbortSignal): Promise<Leftover[]> {
    const leftovers = await auditRemoteSession(this.auditTransport.runner, this.name, { destination: this.destination, ...(signal ? { signal } : {}) });
    if (await this.transport.masterRunning(signal)) {
      leftovers.push({ kind: "ssh-master", id: this.transport.control?.path ?? this.destination, detail: `ControlMaster to ${this.destination} still running` });
    }
    return leftovers;
  }

  /** One bounded `ssh` call for the exit handler: the container (if any), then the dir and its processes (KILL). */
  exitArgv(): string[] {
    const docker = this.docker ? `docker --host "$1" rm -f "$2" >/dev/null 2>&1; shift 2; ` : "";
    const args = this.docker ? [this.docker.host, this.docker.container] : [];
    return this.transport.exitArgv(shellJoin(["/bin/sh", "-c", `${docker}${REMOVE_SCRIPT}`, "sh", ...args, "fast", this.name]));
  }
}

/**
 * Shared, idempotent, retryable stop: concurrent callers share one attempt;
 * after a clean attempt later calls resolve `[]`; a failed attempt is retried.
 */
export class RetryableStop {
  #stopping?: Promise<Leftover[]>;
  #stopped = false;
  readonly #attempt: () => Promise<Leftover[]>;

  constructor(attempt: () => Promise<Leftover[]>) {
    this.#attempt = attempt;
  }

  run(): Promise<Leftover[]> {
    if (this.#stopped) return Promise.resolve([]);
    if (this.#stopping) return this.#stopping;
    const attempt = this.#attempt();
    this.#stopping = attempt;
    attempt
      .then((leftovers) => void (this.#stopped = leftovers.length === 0), () => {})
      .finally(() => void (this.#stopping = undefined));
    return attempt;
  }
}

/**
 * The session object while only remote resources exist (before the helper
 * starts): requests are refused, `stop()` removes the resources. The runtime
 * keeps it as a `failed` session when that removal leaves something.
 */
export class PendingRemoteSession implements Session {
  readonly id: string;
  readonly backend: BackendId;
  readonly arch = "unknown";
  readonly #resources: RemoteResources;
  readonly #stop: RetryableStop;

  constructor(id: string, backend: BackendId, resources: RemoteResources) {
    this.id = id;
    this.backend = backend;
    this.#resources = resources;
    this.#stop = new RetryableStop(() => resources.teardown());
  }

  request<M extends Method>(_method: M, _params: Params<M>): Promise<Result<M>> {
    return Promise.reject(new SessionError("CLOSED", `session ${this.id} did not start`));
  }

  stop(): Promise<Leftover[]> {
    return this.#stop.run();
  }

  auditFootprint(): Promise<Leftover[]> {
    return this.#resources.audit();
  }

  forceRemoveArgv(): string[] {
    return this.#resources.exitArgv();
  }
}
