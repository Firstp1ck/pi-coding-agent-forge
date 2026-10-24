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
import { RemoteBackendBase, type RemoteBackendOptions } from "./remote/base.ts";
import { RemoteProbes, remoteBaseChecks } from "./remote/checks.ts";
import { deployFiles } from "./remote/deploy.ts";
import { remoteDockerRuntimeChecks, identityEntries } from "./remote/docker-checks.ts";
import { auditRemoteDockerOrphans, fetchRemotePathProbe, RemoteDockerSession, sweepRemoteDockerOrphans } from "./remote/docker.ts";
import { PendingRemoteSession } from "./remote/resources.ts";

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

  constructor(options: RemoteLinuxDockerOptions) {
    super(options);
    this.#docker = options;
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
    const transport = this.oneShot(this.requireHost());
    const endpoint = await resolveEndpoint(transport.runner, { signal, source: {} });
    return buildBaseImage({ spawner: transport.remoteSpawner(), endpoint, signal, version: this.version, ...(onLine ? { onLine } : {}), ...(this.options.packageRoot ? { packageRoot: this.options.packageRoot } : {}) });
  }

  /** `/gui-reset`: removes every image labelled `pi-gui-testing.base` on the remote host. */
  async removeBaseImages(signal: AbortSignal): Promise<{ removed: string[]; leftovers: Leftover[] }> {
    const runner = this.#remoteRunner();
    const endpoint = await resolveEndpoint(runner, { signal, source: {} });
    const list = await runDocker(runner, endpoint, ["image", "ls", "-q", "--no-trunc", "--filter", `label=${LABEL_BASE}`], { timeoutMs: 20_000, signal });
    if (list.exitCode !== 0) throw new Error(`docker image ls on ${this.remoteHost} failed (${describeFailure(list)})`);
    const ids = [...new Set(list.stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
    const removed: string[] = [];
    const leftovers: Leftover[] = [];
    for (const id of ids) {
      const result = await runDocker(runner, endpoint, ["image", "rm", "-f", id], { timeoutMs: 60_000, signal });
      if (result.exitCode === 0) removed.push(id);
      else leftovers.push({ kind: "image", id, detail: `on ${this.remoteHost}: ${describeFailure(result)}` });
    }
    return { removed, leftovers };
  }

  readonly resetSummary =
    "Stops its sessions and removes its base images on the remote host, orphaned remote session dirs, and its verified state and backend choice. Docker on the remote host stays installed.";
  readonly resetNote = "system packages: setup installs none for remote-linux-docker; Docker on the remote host is yours and stays installed";

  async resetData(signal: AbortSignal): Promise<{ lines: string[]; leftovers: Leftover[] }> {
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
    try {
      const endpoint = await resolveEndpoint(transport.runner, { signal, source: {} });
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
        spawner: transport.remoteSpawner(),
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
      session = new RemoteDockerSession({ docker, resources, sync: prepared.sync, resync: prepared.resync });
      options.onExitCleanup?.(session.forceRemoveArgv());
      await options.recordResource("container", `${prepared.destination}:${name}`);
      options.onStatus?.(`starting the session container on ${prepared.destination}`);
      await docker.start(signal);
      // Fail closed unless /workspace is the synced dir that was created for this session.
      const same = await docker.request("exec", { cmd: workspaceIdentityCommand(remote.workspaceId), cwd: "/", env: {}, timeoutMs: 30_000 }, { signal, timeoutMs: 60_000 });
      if (same.exitCode !== 0) {
        throw new SessionError("ISOLATION", `the directory mounted at /workspace is not the synced session dir (device/inode ${remote.workspaceId} expected; exit ${same.exitCode}); the session was stopped`);
      }
      await this.runSetup(docker, options, "/workspace", tail);
    } catch (error) {
      await stopAfterFailedStart(session ?? new PendingRemoteSession(options.sessionId, this.id, resources), error);
      throw error;
    }
    return session;
  }
}
