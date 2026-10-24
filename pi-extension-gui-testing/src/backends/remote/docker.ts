/**
 * `remote-linux-docker` pieces on top of the docker-linux code (spec §4.2a):
 * every `docker` command runs on the remote host through the SSH runner, so
 * `docker-linux`'s run arguments, inspect rules, and footprint listing are
 * reused unchanged. What differs is judged here: bind sources are remote
 * paths (resolved on the remote host), and labelled objects of other client
 * machines are never swept while they run.
 */
import { SessionError, type Session, type SyncSummary } from "../../backend.ts";
import type { BackendId } from "../../config/types.ts";
import { FORBIDDEN_MOUNT_PATHS } from "../../hardening.ts";
import { LABEL_SESSION } from "../../labels.ts";
import type { Leftover, Method, Params, Result } from "../../protocol.ts";
import type { CommandRunner, DockerEndpoint } from "../../runner/types.ts";
import type { SyncReport } from "../../sync/transport/workspace-sync.ts";
import { describeFailure, runDocker } from "../docker/cli.ts";
import { listLabelledObjects, removeObject, toLeftover, type LabelledObject } from "../docker/footprint.ts";
import type { PathProbe } from "../docker/inspect.ts";
import type { DockerSession } from "../docker/session.ts";
import { RetryableStop, type RemoteResources } from "./resources.ts";
import { remoteFailure, remoteOwnerState } from "./session-dir.ts";

/** Prints `<path>\t<resolved>\t<is socket>` for each argument. */
export const PATH_PROBE_SCRIPT =
  'for p in "$@"; do r=$(readlink -f -- "$p" 2>/dev/null); [ -n "$r" ] || r=$p; if [ -S "$p" ]; then s=1; else s=0; fi; printf "%s\\t%s\\t%s\\n" "$p" "$r" "$s"; done; exit 0';

/**
 * A {@link PathProbe} for remote paths: `paths` (plus the §4.1 forbidden
 * paths) resolved and socket-tested on the remote host in one call. Unknown
 * paths resolve to themselves and are not sockets.
 *
 * @throws Error when the remote call fails.
 */
export async function fetchRemotePathProbe(runner: CommandRunner, paths: readonly string[], signal?: AbortSignal): Promise<PathProbe> {
  const all = [...new Set([...FORBIDDEN_MOUNT_PATHS, ...paths])];
  const result = await runner.run(["/bin/sh", "-c", PATH_PROBE_SCRIPT, "sh", ...all], { timeoutMs: 20_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) throw new Error(`resolving paths on the remote host failed (${remoteFailure(result)})`);
  const resolved = new Map<string, string>();
  const sockets = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const [path, real, socket] = line.split("\t");
    if (!path || !real) continue;
    resolved.set(path, real);
    if (socket === "1") {
      sockets.add(path);
      sockets.add(real);
    }
  }
  return {
    realpath: (path) => resolved.get(path) ?? path,
    isSocket: (path) => sockets.has(path),
  };
}

export interface DockerOrphanDecision {
  object: LabelledObject;
  action: "remove" | "report" | "keep";
  reason: string;
}

/** Names of running labelled containers. @throws Error when docker fails. */
async function runningContainers(runner: CommandRunner, endpoint: DockerEndpoint, signal?: AbortSignal): Promise<Set<string>> {
  const result = await runDocker(runner, endpoint, ["ps", "--no-trunc", "--filter", `label=${LABEL_SESSION}`, "--filter", "status=running", "--format", "{{.ID}}\t{{.Names}}"], {
    timeoutMs: 15_000,
    ...(signal ? { signal } : {}),
  });
  if (result.exitCode !== 0) throw new Error(`docker ps failed (${describeFailure(result)})`);
  const names = new Set<string>();
  for (const line of result.stdout.split("\n")) for (const part of line.split("\t")) if (part.trim()) names.add(part.trim());
  return names;
}

/**
 * Orphan decisions for labelled Docker objects on the remote host: owners of
 * this client are judged by PID and start time; objects of another client
 * machine are kept while their container runs and otherwise reported, never
 * removed; unparseable owners are reported.
 */
export async function decideDockerOrphans(runner: CommandRunner, endpoint: DockerEndpoint, options: { signal?: AbortSignal; procRoot?: string } = {}): Promise<DockerOrphanDecision[]> {
  const objects = await listLabelledObjects(runner, endpoint, { ...(options.signal ? { signal: options.signal } : {}) });
  if (objects.length === 0) return [];
  const running = await runningContainers(runner, endpoint, options.signal);
  return objects.map((object) => {
    const state = remoteOwnerState(object.owner, options.procRoot);
    if (state === "alive") return { object, action: "keep", reason: "owner alive" };
    if (state === "dead") return { object, action: "remove", reason: "owner gone" };
    if (state === "foreign") {
      const live = running.has(object.id) || running.has(object.name);
      return live
        ? { object, action: "keep", reason: "owned by another client; still running" }
        : { object, action: "report", reason: "owned by another client or an earlier boot; not removed automatically" };
    }
    return { object, action: "report", reason: `owner label "${object.owner.slice(0, 80)}" cannot be judged; not removed automatically` };
  });
}

/** Read-only orphan audit of remote Docker objects. */
export async function auditRemoteDockerOrphans(runner: CommandRunner, endpoint: DockerEndpoint, options: { signal?: AbortSignal; procRoot?: string; destination: string }): Promise<Leftover[]> {
  return (await decideDockerOrphans(runner, endpoint, options))
    .filter((d) => d.action !== "keep")
    .map((d) => ({ ...toLeftover(d.object, d.reason), detail: `on ${options.destination}, ${toLeftover(d.object, d.reason).detail}` }));
}

/** Removes remote Docker objects of dead owners; reports the rest that is not kept and failed removals. */
export async function sweepRemoteDockerOrphans(runner: CommandRunner, endpoint: DockerEndpoint, options: { signal?: AbortSignal; procRoot?: string; destination: string }): Promise<Leftover[]> {
  const leftovers: Leftover[] = [];
  // listLabelledObjects lists containers first, so volumes and networks are free when their turn comes.
  for (const decision of await decideDockerOrphans(runner, endpoint, options)) {
    if (decision.action === "report") leftovers.push({ ...toLeftover(decision.object, decision.reason), detail: `on ${options.destination}, ${toLeftover(decision.object, decision.reason).detail}` });
    if (decision.action !== "remove") continue;
    const failed = await removeObject(runner, endpoint, decision.object, options.signal);
    if (failed) leftovers.push(failed);
  }
  return leftovers;
}

/**
 * A `remote-linux-docker` session: the docker-linux {@link DockerSession}
 * (container lifetime, inspect, labelled removal) running its `docker`
 * commands on the remote host, plus the remote session dir and ControlMaster.
 * `stop()` stops the container first, then removes the remote resources;
 * the audit covers both.
 */
export class RemoteDockerSession implements Session {
  readonly id: string;
  readonly backend: BackendId;
  readonly sync?: SyncSummary;
  readonly workspacePath: string;
  readonly workspaceDescription?: string;
  readonly docker: DockerSession;
  readonly #resources: RemoteResources;
  readonly #stop: RetryableStop;
  readonly #resync?: (signal?: AbortSignal) => Promise<SyncReport>;
  #closed = false;

  readonly #afterStop?: () => Promise<Leftover[]>;

  constructor(options: {
    docker: DockerSession;
    resources: RemoteResources;
    sync?: SyncSummary;
    resync?: (signal?: AbortSignal) => Promise<SyncReport>;
    workspaceDescription?: string;
    /** Runs after the container and the remote resources are gone (`remote.purgeTooling`: remove the base image). */
    afterStop?: () => Promise<Leftover[]>;
  }) {
    this.docker = options.docker;
    this.#resources = options.resources;
    this.id = options.docker.id;
    this.backend = options.docker.backend;
    this.workspacePath = options.docker.workspacePath ?? "/workspace";
    if (options.sync) this.sync = options.sync;
    if (options.resync) this.#resync = options.resync;
    if (options.workspaceDescription) this.workspaceDescription = options.workspaceDescription;
    if (options.afterStop) this.#afterStop = options.afterStop;
    this.#stop = new RetryableStop(async () => {
      const leftovers = await this.docker.stop().catch((e: Error): Leftover[] => [{ kind: "session", id: this.id, detail: `container stop failed: ${e.message}` }]);
      leftovers.push(...(await this.#resources.teardown()));
      if (leftovers.length === 0 && this.#afterStop) leftovers.push(...(await this.#afterStop().catch((e: Error): Leftover[] => [{ kind: "image", id: this.id, detail: e.message }])));
      return leftovers;
    });
  }

  get arch(): string {
    return this.docker.arch;
  }

  request<M extends Method>(method: M, params: Params<M>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Result<M>> {
    if (this.#closed) return Promise.reject(new SessionError("CLOSED", `session ${this.id} is stopped`));
    return this.docker.request(method, params, options);
  }

  /** Re-syncs the workspace into the running session; the container sees the change through its bind mount. */
  resync(signal?: AbortSignal): Promise<SyncReport> {
    if (!this.#resync) return Promise.reject(new Error("this session cannot re-sync"));
    if (this.#closed) return Promise.reject(new SessionError("CLOSED", `session ${this.id} is stopped`));
    return this.#resync(signal);
  }

  stop(): Promise<Leftover[]> {
    this.#closed = true;
    return this.#stop.run();
  }

  async auditFootprint(): Promise<Leftover[]> {
    return [...(await this.docker.auditFootprint()), ...(await this.#resources.audit())];
  }

  /** One bounded `ssh` call: `docker rm -f` of the container, then the remote dir and its processes. */
  forceRemoveArgv(): string[] {
    return this.#resources.exitArgv();
  }
}
