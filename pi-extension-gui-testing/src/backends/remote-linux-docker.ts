/**
 * `remote-linux-docker` backend (spec §4.2a): `docker-linux` on a user-owned
 * Linux host reached over SSH. Every `docker` command runs there through the
 * SSH runner, so the client needs no Docker CLI; the base image is built
 * there from a tar build context streamed over SSH; the container's bind
 * mounts refer to the synced remote session dir. The session dir, the
 * container, and the ControlMaster are removed on every exit path; only the
 * tooling base image stays on the remote host.
 */
import { SessionError, type Backend, type Session, type SessionStartOptions } from "../backend.ts";
import type { DriftCapability, ImageCapability, OrphanAuditGate, ResetCapability, RunnerCapability, SmokeCapability, SweepAvailability } from "./capabilities.ts";
import type { Check } from "../checks/types.ts";
import type { BackendId, ResolvedConfig } from "../config/types.ts";
import { ELECTRON_SHM_SIZE } from "../hardening.ts";
import { LABEL_BASE } from "../labels.ts";
import type { Leftover } from "../protocol.ts";
import type { CommandRunner, RunResult } from "../runner/types.ts";
import { describeFailure, resolveEndpoint, runDocker } from "./docker/cli.ts";
import { buildBaseImage } from "./docker/image.ts";
import { baseImageTag } from "./docker/package.ts";
import { containerName, shmSizeFor } from "./docker/run-args.ts";
import { DockerSession } from "./docker/session.ts";
import { workspaceIdentityCommand } from "./docker-linux.ts";
import { stopAfterFailedStart } from "./start-failure.ts";
import { RemoteBackendBase, type RemoteBackendOptions, type RemoteSharedState } from "./remote/base.ts";
import { RemoteProbes, remoteBaseChecks } from "./remote/checks.ts";
import { deployFiles } from "./remote/deploy.ts";
import { remoteDockerRuntimeChecks, identityEntries } from "./remote/docker-checks.ts";
import { auditRemoteDockerOrphans, fetchRemotePathProbe, RemoteDockerSession, sweepRemoteDockerOrphans } from "./remote/docker.ts";
import { PendingRemoteSession } from "./remote/resources.ts";
import { sessionWrappedArgv } from "./remote/session-dir.ts";
import type { SshTransport } from "../transport/ssh/transport.ts";

/** Removes every image labelled `pi-gui-testing.base` on `destination` through `runner` (a runner on that host). */
export async function removeBaseImagesOn(runner: CommandRunner, destination: string, signal?: AbortSignal): Promise<{ removed: string[]; leftovers: Leftover[] }> {
  const endpoint = await resolveEndpoint(runner, { ...(signal ? { signal } : {}), source: {} });
  const list = await runDocker(runner, endpoint, ["image", "ls", "-q", "--no-trunc", "--filter", `label=${LABEL_BASE}`], { timeoutMs: 20_000, ...(signal ? { signal } : {}) });
  if (list.exitCode !== 0) throw new Error(`docker image ls on ${destination} failed (${describeFailure(list)})`);
  const ids = [...new Set(list.stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
  const removed: string[] = [];
  const leftovers: Leftover[] = [];
  for (const id of ids) {
    const result = await runDocker(runner, endpoint, ["image", "rm", "-f", id], { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
    if (result.exitCode === 0) removed.push(id);
    else leftovers.push({ kind: "image", id, detail: `on ${destination}: ${describeFailure(result)}` });
  }
  return { removed, leftovers };
}

/** Bound for removing the base image after a session (`remote.purgeTooling`). */
const PURGE_TIMEOUT_MS = 90_000;

/** The GTK 3 smoke app baked into the base image. */
const IMAGE_SMOKE_APP = { cmd: "python3", args: ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"] };

export interface RemoteLinuxDockerOptions extends RemoteBackendOptions {
  /** `/dev/shm` policy as in docker-linux; tests use `never`. */
  shm?: "auto" | "never" | "always";
}

export class RemoteLinuxDockerBackend
  extends RemoteBackendBase
  implements Backend, ImageCapability, DriftCapability, ResetCapability, SweepAvailability, OrphanAuditGate, RunnerCapability, SmokeCapability
{
  readonly id: BackendId = "remote-linux-docker";
  readonly #docker: RemoteLinuxDockerOptions;

  constructor(options: RemoteLinuxDockerOptions, shared?: RemoteSharedState) {
    super(options, shared);
    this.#docker = options;
  }

  /** Running sessions per host, shared by every host-bound view; `remote.purgeTooling` removes the base image only after the last one. */
  get #running(): Map<string, number> {
    return this.shared.running;
  }

  get imageTag(): string {
    return baseImageTag(this.version);
  }

  checks(): Check[] {
    const probes = new RemoteProbes({
      backend: this.id,
      host: this.remoteHost,
      runner: this.runner,
      transport: this.transportOptions(),
      ownerLabel: this.options.ownerLabel,
      version: this.version,
      ...(this.options.home ? { home: this.options.home } : {}),
      ...(this.options.tmpRoot ? { tmpRoot: this.options.tmpRoot } : {}),
      ...(this.options.ssh ? { ssh: this.options.ssh } : {}),
      ...(this.options.common ? { common: this.options.common } : {}),
      ...(this.options.syncMethod ? { syncMethod: this.options.syncMethod } : {}),
      ...(this.options.shortControlRoot ? { shortControlRoot: this.options.shortControlRoot } : {}),
    });
    return [...remoteBaseChecks(probes), ...remoteDockerRuntimeChecks(probes)];
  }

  /** A runner whose commands run on the configured host (one connection per call). */
  #remoteRunner(): CommandRunner {
    return this.oneShot(this.requireHost()).runner;
  }

  /** Builds the base image on the remote host; the build context (tooling only) streams over SSH. */
  async buildImage(signal: AbortSignal, onLine?: (line: string) => void): Promise<RunResult> {
    return this.#buildImageOn(this.oneShot(this.requireHost()), signal, onLine);
  }

  async #buildImageOn(transport: SshTransport, signal: AbortSignal, onLine?: (line: string) => void): Promise<RunResult> {
    const endpoint = await resolveEndpoint(transport.runner, { signal, source: {} });
    return buildBaseImage({ spawner: transport.remoteSpawner(), endpoint, signal, version: this.version, ...(onLine ? { onLine } : {}), ...(this.options.packageRoot ? { packageRoot: this.options.packageRoot } : {}) });
  }

  /** `/gui-reset`: removes every image labelled `pi-gui-testing.base` on the remote host. */
  async removeBaseImages(signal: AbortSignal): Promise<{ removed: string[]; leftovers: Leftover[] }> {
    return removeBaseImagesOn(this.#remoteRunner(), this.requireHost(), signal);
  }

  readonly resetSummary =
    "Stops its sessions and removes its base images on the remote host, orphaned remote session dirs, and its verified state and backend choice. Docker on the remote host stays installed.";
  readonly resetNote = "system packages: setup installs none for remote-linux-docker; Docker on the remote host is yours and stays installed";

  async resetData(signal: AbortSignal): Promise<{ lines: string[]; leftovers: Leftover[] }> {
    if (!this.remoteHost) return { lines: ["no SSH host is configured, so no remote base image was removed"], leftovers: [] };
    try {
      const images = await this.removeBaseImages(signal);
      return { lines: [`removed ${images.removed.length} base image(s) on ${this.remoteHost}`], leftovers: images.leftovers };
    } catch (error) {
      return { lines: [], leftovers: [{ kind: "image", id: LABEL_BASE, detail: (error as Error).message }] };
    }
  }

  smokeApp(): { cmd: string; args: string[] } {
    return { cmd: IMAGE_SMOKE_APP.cmd, args: [...IMAGE_SMOKE_APP.args] };
  }

  smokeConfig(base: ResolvedConfig): ResolvedConfig {
    return this.remoteHost ? { ...base, remote: { host: this.remoteHost } } : base;
  }

  protected override async sweepExtra(runner: CommandRunner, destination: string, signal: AbortSignal): Promise<void> {
    const endpoint = await resolveEndpoint(runner, { signal, source: {} });
    await sweepRemoteDockerOrphans(runner, endpoint, { signal, destination, ...(this.options.procRoot ? { procRoot: this.options.procRoot } : {}) });
  }

  override async auditOrphans(signal: AbortSignal): Promise<Leftover[]> {
    const leftovers = await super.auditOrphans(signal);
    if (!this.remoteHost) return leftovers;
    try {
      const runner = this.#remoteRunner();
      const endpoint = await resolveEndpoint(runner, { signal, source: {} });
      leftovers.push(...(await auditRemoteDockerOrphans(runner, endpoint, { signal, destination: this.remoteHost, ...(this.options.procRoot ? { procRoot: this.options.procRoot } : {}) })));
    } catch (error) {
      leftovers.push({ kind: "docker", id: this.remoteHost, detail: `remote Docker audit failed: ${(error as Error).message}` });
    }
    return leftovers;
  }

  override async sweepOrphans(signal: AbortSignal): Promise<Leftover[]> {
    if (!this.remoteHost) return [];
    const leftovers: Leftover[] = [];
    try {
      const runner = this.#remoteRunner();
      const endpoint = await resolveEndpoint(runner, { signal, source: {} });
      // Containers first: they hold the bind mounts of the session dirs removed next.
      leftovers.push(...(await sweepRemoteDockerOrphans(runner, endpoint, { signal, destination: this.remoteHost, ...(this.options.procRoot ? { procRoot: this.options.procRoot } : {}) })));
    } catch (error) {
      leftovers.push({ kind: "docker", id: this.remoteHost, detail: `remote Docker sweep failed: ${(error as Error).message}` });
    }
    leftovers.push(...(await super.sweepOrphans(signal)));
    return leftovers;
  }

  async startSession(options: SessionStartOptions): Promise<Session> {
    const prepared = await this.prepare(options, async (transport, remote, signal) => {
      // The container's /etc/passwd and /etc/group map the SSH user's UID/GID (read-only binds).
      await deployFiles(transport, remote.dir, identityEntries(remote.uid, remote.gid), { signal, umask: "022" });
    });
    const { signal, config } = options;
    const shared = config.shared;
    const { remote, resources, transport } = prepared;
    const { tail, onLog } = this.setupLog(options);
    let session: RemoteDockerSession | undefined;
    const purge = config.remote?.purgeTooling === true;
    try {
      const endpoint = await resolveEndpoint(transport.runner, { signal, source: {} });
      if (purge) await this.#ensureImage(transport, endpoint, prepared.destination, options);
      const name = containerName(options.sessionId);
      resources.docker = { host: endpoint.host, container: name };
      options.onExitCleanup?.(resources.exitArgv());
      const readOnly = shared.workspaceMode !== "copy";
      const pathProbe = await fetchRemotePathProbe(transport.runner, [`${remote.dir}/passwd`, `${remote.dir}/group`, remote.workspace], signal);
      const shm = this.#docker.shm ?? "auto";
      const shmSize = shm === "always" ? ELECTRON_SHM_SIZE : shm === "never" ? undefined : shmSizeFor(shared.launch?.cmd, shared.launch?.args);
      const heartbeat = this.options.heartbeatTimeoutMs;
      const docker = new DockerSession({
        id: options.sessionId,
        backend: this.id,
        runner: transport.runner,
        // `docker run` runs under the session wrapper: when it ends (container exited, --rm, or the client
        // died), the remote host removes the container and then the synced session dir itself, also after a
        // dropped connection.
        spawner: { spawn: (argv, o) => transport.spawnHelper(sessionWrappedArgv(remote, argv, { host: endpoint.host, container: name }), o?.env ?? {}) },
        endpoint,
        packageVersion: this.version,
        onLog,
        sync: prepared.sync,
        pathProbe,
        ...(this.options.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.options.readyTimeoutMs } : {}),
        ...(heartbeat !== undefined ? { heartbeatIntervalMs: Math.max(250, Math.floor(heartbeat / 3)) } : {}),
        run: {
          sessionId: options.sessionId,
          ownerLabel: options.ownerLabel,
          image: this.imageTag,
          uid: remote.uid,
          gid: remote.gid,
          sessionDir: remote.dir,
          workspace: { source: remote.workspace, readOnly },
          network: shared.network,
          ...(shmSize ? { shmSize } : {}),
          ...(heartbeat !== undefined ? { heartbeatTimeoutMs: heartbeat } : {}),
        },
      });
      const destination = prepared.destination;
      let counted = false;
      session = new RemoteDockerSession({
        docker,
        resources,
        sync: prepared.sync,
        resync: prepared.resync,
        workspaceDescription: readOnly ? `read-only mount of the copy synced to ${destination}` : `writable copy synced to ${destination} (changes stay there)`,
        ...(purge
          ? {
              afterStop: async () => {
                if (counted) {
                  counted = false;
                  this.#count(destination, -1);
                }
                if ((this.#running.get(destination) ?? 0) > 0) return [];
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), PURGE_TIMEOUT_MS);
                try {
                  return (await removeBaseImagesOn(this.oneShot(destination).runner, destination, controller.signal)).leftovers;
                } finally {
                  clearTimeout(timer);
                }
              },
            }
          : {}),
      });
      options.onExitCleanup?.(session.forceRemoveArgv());
      await options.recordResource("container", `${prepared.destination}:${name}`);
      options.onStatus?.(`starting the session container on ${prepared.destination}`);
      await docker.start(signal);
      // Fail closed unless /workspace is the synced dir that was created for this session.
      const same = await docker.request("exec", { cmd: workspaceIdentityCommand(remote.workspaceId), cwd: "/", env: {}, timeoutMs: 30_000 }, { signal, timeoutMs: 60_000 });
      if (same.exitCode !== 0) {
        throw new SessionError("ISOLATION", `the directory mounted at /workspace is not the synced session dir (device/inode ${remote.workspaceId} expected; exit ${same.exitCode}); the session was stopped`);
      }
      await this.runSetup(docker, options, "/workspace", tail, { base: `image ${this.version}`, writable: !readOnly });
      if (purge) {
        counted = true;
        this.#count(destination, 1);
      }
    } catch (error) {
      await stopAfterFailedStart(session ?? new PendingRemoteSession(options.sessionId, this.id, resources), error);
      throw error;
    }
    return session;
  }

  #count(destination: string, delta: number): void {
    const next = (this.#running.get(destination) ?? 0) + delta;
    if (next > 0) this.#running.set(destination, next);
    else this.#running.delete(destination);
  }

  /** `remote.purgeTooling`: an earlier session removed the base image, so build it again when it is missing. */
  async #ensureImage(transport: SshTransport, endpoint: Awaited<ReturnType<typeof resolveEndpoint>>, destination: string, options: SessionStartOptions): Promise<void> {
    const { signal } = options;
    const present = await runDocker(transport.runner, endpoint, ["image", "inspect", "--format", "{{.Id}}", this.imageTag], { timeoutMs: 20_000, signal });
    if (present.exitCode === 0) return;
    options.onStatus?.(`building the base image on ${destination} (purgeTooling removed it after the last session; this takes several minutes)`);
    const built = await this.#buildImageOn(transport, signal, (line) => {
      const trimmed = line.trim();
      if (trimmed) options.onStatus?.(`building the base image on ${destination}: ${trimmed.slice(0, 100)}`);
    });
    if (built.exitCode !== 0 || built.timedOut) {
      throw new SessionError("START_FAILED", `building the base image on ${destination} failed (${describeFailure(built)}); run /gui-doctor remote-linux-docker`);
    }
  }
}
