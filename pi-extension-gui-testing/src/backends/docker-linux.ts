/**
 * `docker-linux` backend (spec §4.1): apps run in a hardened, labelled
 * container with Xvfb, started per session with the helper as entrypoint.
 * Linux hosts with a rootful local Docker daemon only in this version.
 */
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { SessionError, type Backend, type Session, type SessionStartOptions, type SyncSummary } from "../backend.ts";
import type { CommonCheckOptions } from "../checks/common.ts";
import type { Check } from "../checks/types.ts";
import type { BackendId } from "../config/types.ts";
import type { Leftover, LogEvent } from "../protocol.ts";
import { createSpawnRunner } from "../runner/spawn.ts";
import type { CommandRunner, DockerEndpoint, RunResult } from "../runner/types.ts";
import { TextTail } from "../framing/log-event.ts";
import { buildFileSet } from "../sync/fileset.ts";
import { copyFileSet } from "../sync/copy.ts";
import { dockerLinuxChecks, parseDockerCliVersion } from "./docker/checks.ts";
import { PROTOCOL_VERSION } from "../protocol.ts";
import { describeFailure, resolveEndpoint, runDocker, type EndpointSource } from "./docker/cli.ts";
import { auditDockerOrphans, sweepDockerOrphans } from "./docker/footprint.ts";
import { buildBaseImage, inspectImage } from "./docker/image.ts";
import { hostPathProbe, type PathProbe } from "./docker/inspect.ts";
import { baseImageTag, packageVersion } from "./docker/package.ts";
import { createSpawner, type Spawner } from "./docker/process.ts";
import { containerName, shmSizeFor, writeIdentityFiles } from "./docker/run-args.ts";
import { DockerSession } from "./docker/session.ts";
import { stopAfterFailedStart } from "./start-failure.ts";
import { assertMountableRoot, assertNoSockets, WorkspaceRefusedError } from "./docker/workspace.ts";
import { ELECTRON_SHM_SIZE } from "../hardening.ts";
import { LABEL_BASE } from "../labels.ts";

/** Bound for one `setup` command (spec §7); the heartbeat keeps the helper alive meanwhile. */
export const SETUP_COMMAND_TIMEOUT_MS = 15 * 60_000;

/**
 * Start options a caller may add to {@link SessionStartOptions}.
 * `onExitCleanup` receives the argv that force-removes the session's container
 * through the session's own resolved endpoint, before the container is
 * created; the caller's synchronous exit handler runs it while the start is pending.
 */
export interface DockerStartOptions extends SessionStartOptions {
  onExitCleanup?(argv: string[]): void;
}

/** Setup output kept for a failed setup command's error message (characters; the message shows the last 2 000). */
export const SETUP_TAIL_CHARS = 4 * 1024;

/** `<dev> <ino>` of a directory that is not a symlink, in the format of `stat -c '%d %i'`. */
async function directoryIdentity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory()) throw new WorkspaceRefusedError(`${path} is not a directory (it changed while the session started)`);
  return `${info.dev} ${info.ino}`;
}

/**
 * Shell test, run by the helper before any setup command or app, that
 * succeeds only when `/workspace` is the directory with `identity`. Bind
 * mounts keep the host's device and inode numbers.
 */
export function workspaceIdentityCommand(identity: string): string {
  if (!/^\d+ \d+$/.test(identity)) throw new Error(`invalid directory identity ${JSON.stringify(identity)}`);
  return `[ "$(stat -c '%d %i' /workspace)" = '${identity}' ]`;
}

export interface DockerLinuxOptions {
  /** Owner label of this extension instance (`<clientId>:<pid>:<startTime>:<bootId>`), for probe containers. */
  ownerLabel: () => string;
  runner?: CommandRunner;
  spawner?: Spawner;
  version?: string;
  uid?: number;
  gid?: number;
  endpointSource?: EndpointSource;
  pathProbe?: PathProbe;
  procRoot?: string;
  tmpRoot?: string;
  common?: Partial<CommonCheckOptions>;
  setupTimeoutMs?: number;
  socketScanTimeoutMs?: number;
  /** `/dev/shm` policy: `auto` gives Chromium/Electron launches {@link ELECTRON_SHM_SIZE}. Tests use `never`. */
  shm?: "auto" | "never" | "always";
  /** Test-only: shortened helper heartbeat timeout (the client then pings at a third of it). */
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export class DockerLinuxBackend implements Backend {
  readonly id: BackendId = "docker-linux";
  readonly runner: CommandRunner;
  readonly spawner: Spawner;
  readonly version: string;
  readonly #options: DockerLinuxOptions;

  constructor(options: DockerLinuxOptions) {
    this.#options = options;
    this.runner = options.runner ?? createSpawnRunner();
    this.spawner = options.spawner ?? createSpawner();
    this.version = options.version ?? packageVersion();
  }

  get imageTag(): string {
    return baseImageTag(this.version);
  }

  get #uid(): number {
    return this.#options.uid ?? process.getuid?.() ?? 0;
  }

  get #gid(): number {
    return this.#options.gid ?? process.getgid?.() ?? 0;
  }

  checks(): Check[] {
    return dockerLinuxChecks({
      runner: this.runner,
      ownerLabel: this.#options.ownerLabel,
      version: this.version,
      uid: this.#uid,
      gid: this.#gid,
      ...(this.#options.tmpRoot ? { tmpRoot: this.#options.tmpRoot } : {}),
      ...(this.#options.endpointSource ? { endpointSource: this.#options.endpointSource } : {}),
      ...(this.#options.pathProbe ? { pathProbe: this.#options.pathProbe } : {}),
      ...(this.#options.common ? { common: this.#options.common } : {}),
    });
  }

  /** Resolves the local endpoint for one session or command (spec §4.1). */
  endpoint(signal?: AbortSignal): Promise<DockerEndpoint> {
    return resolveEndpoint(this.runner, { signal, source: this.#options.endpointSource });
  }

  /** Builds the base image (the `image.base` remediation). */
  async buildImage(signal: AbortSignal, onLine?: (line: string) => void): Promise<RunResult> {
    return buildBaseImage({ spawner: this.spawner, endpoint: await this.endpoint(signal), signal, onLine, version: this.version });
  }

  /**
   * Every version the verified record holds, as observable now, for the drift
   * check before each launch (spec §7): this package, Pi, the protocol, the
   * Docker CLI and server, and the base image (tag and id). Keys match the
   * check and smoke-test facts setup records. Drift blocks new launches only;
   * running sessions continue.
   */
  async currentVersions(signal?: AbortSignal): Promise<Record<string, string>> {
    const endpoint = await this.endpoint(signal);
    const versions: Record<string, string> = {
      "package.version": this.version,
      "pi.version": this.#options.common?.piVersion ?? PI_VERSION,
      protocol: String(PROTOCOL_VERSION),
      "image.base": this.version,
    };
    const cli = await this.runner.run(["docker", "--version"], { timeoutMs: 10_000, signal });
    if (cli.exitCode !== 0) throw new Error(`docker --version failed (${describeFailure(cli)})`);
    const cliVersion = parseDockerCliVersion(cli.stdout);
    if (cliVersion) versions["docker.cli"] = cliVersion;
    const server = await runDocker(this.runner, endpoint, ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000, signal });
    if (server.exitCode !== 0) throw new Error(`docker version failed (${describeFailure(server)})`);
    versions["docker.server"] = server.stdout.trim();
    const image = await inspectImage(this.runner, endpoint, this.imageTag, signal);
    versions["image.id"] = image?.id ?? "(missing)";
    return versions;
  }

  async startSession(options: DockerStartOptions): Promise<Session> {
    const { signal, config } = options;
    const shared = config.shared;
    const endpoint = await this.endpoint(signal);
    let workspace: { source: string; readOnly: boolean };
    let sync: SyncSummary | undefined;
    // Identity of the checked directory: Docker gets its resolved path, and the
    // running container must show the same device and inode at /workspace.
    let identity: string;
    if (shared.workspaceMode === "copy") {
      options.onStatus?.("copying the workspace (sync rules apply)");
      const set = await buildFileSet(options.projectRoot, { allow: shared.sync?.allow, deny: shared.sync?.deny, runner: this.runner, signal });
      const dest = join(await realpath(options.sessionDir), "workspace");
      sync = await copyFileSet(set, dest, signal);
      identity = await directoryIdentity(dest);
      workspace = { source: dest, readOnly: false };
    } else {
      const probe = this.#options.pathProbe ?? hostPathProbe;
      assertMountableRoot(options.projectRoot, probe);
      // Resolve once; every check below and Docker use this exact path.
      const root = probe.realpath(options.projectRoot);
      assertMountableRoot(root, probe);
      identity = await directoryIdentity(root);
      options.onStatus?.("scanning the workspace for sockets");
      await assertNoSockets(root, { signal, ...(this.#options.socketScanTimeoutMs ? { timeoutMs: this.#options.socketScanTimeoutMs } : {}) });
      if ((await directoryIdentity(root)) !== identity) throw new WorkspaceRefusedError(`${root} was replaced while it was scanned; open the session again`);
      workspace = { source: root, readOnly: true };
    }
    await writeIdentityFiles(options.sessionDir, this.#uid, this.#gid);

    const shm = this.#options.shm ?? "auto";
    const shmSize = shm === "always" ? ELECTRON_SHM_SIZE : shm === "never" ? undefined : shmSizeFor(shared.launch?.cmd, shared.launch?.args);
    // Bounded in characters and held as one owned string, whatever the events carry.
    const setupTail = new TextTail(SETUP_TAIL_CHARS);
    const onLog = (event: LogEvent) => {
      if (event.source === "setup") setupTail.push(typeof event.data === "string" ? event.data : String(event.data));
      options.onLog(event);
    };
    const heartbeat = this.#options.heartbeatTimeoutMs;
    const session = new DockerSession({
      id: options.sessionId,
      backend: this.id,
      runner: this.runner,
      spawner: this.spawner,
      endpoint,
      packageVersion: this.version,
      onLog,
      ...(sync ? { sync } : {}),
      ...(this.#options.pathProbe ? { pathProbe: this.#options.pathProbe } : {}),
      ...(this.#options.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.#options.readyTimeoutMs } : {}),
      ...(heartbeat !== undefined ? { heartbeatIntervalMs: Math.max(250, Math.floor(heartbeat / 3)) } : {}),
      run: {
        sessionId: options.sessionId,
        ownerLabel: options.ownerLabel,
        image: this.imageTag,
        uid: this.#uid,
        gid: this.#gid,
        sessionDir: options.sessionDir,
        workspace,
        network: shared.network,
        ...(shmSize ? { shmSize } : {}),
        ...(heartbeat !== undefined ? { heartbeatTimeoutMs: heartbeat } : {}),
      },
    });
    // The exit handler and owner.json know the container before it exists (spec §7a.2).
    options.onExitCleanup?.(session.forceRemoveArgv());
    await options.recordResource("container", containerName(options.sessionId));
    const commands = shared.setup ?? [];
    const timeoutMs = this.#options.setupTimeoutMs ?? SETUP_COMMAND_TIMEOUT_MS;
    try {
      options.onStatus?.("starting the session container");
      await session.start(signal);
      // Fail closed unless /workspace is the directory that was checked (no swap between check and mount).
      const same = await session.request("exec", { cmd: workspaceIdentityCommand(identity), cwd: "/", env: {}, timeoutMs: 30_000 }, { signal, timeoutMs: 60_000 });
      if (same.exitCode !== 0) {
        throw new SessionError(
          "ISOLATION",
          `the directory mounted at /workspace is not the one that was checked (device/inode ${identity} expected; exit ${same.exitCode}); it changed while the session started, so the session was stopped`,
        );
      }
      for (const [index, cmd] of commands.entries()) {
        options.onStatus?.(`setup ${index + 1}/${commands.length}: ${cmd}`);
        const result = await session.request(
          "exec",
          { cmd, cwd: "/workspace", env: { ...(shared.deps?.env ?? {}) }, timeoutMs },
          { signal, timeoutMs: timeoutMs + 30_000 },
        );
        if (result.exitCode !== 0) {
          const tail = setupTail.text.trim().slice(-2000);
          throw new SessionError(
            "SETUP_FAILED",
            `setup command ${JSON.stringify(cmd)} exited with ${result.exitCode}${tail ? `; last output:\n${tail}` : ""}` +
              (shared.workspaceMode === "mount" ? '\n(the workspace is read-only in mount mode; setup that writes into the project needs "workspaceMode": "copy")' : ""),
          );
        }
      }
    } catch (error) {
      // Stopped here (a retry when start() already tried); anything left stays attached to the error for the runtime.
      await stopAfterFailedStart(session, error);
      throw error;
    }
    return session;
  }

  async auditOrphans(signal: AbortSignal): Promise<Leftover[]> {
    return auditDockerOrphans(this.runner, await this.endpoint(signal), { signal, procRoot: this.#options.procRoot });
  }

  async sweepOrphans(signal: AbortSignal): Promise<Leftover[]> {
    return sweepDockerOrphans(this.runner, await this.endpoint(signal), { signal, procRoot: this.#options.procRoot });
  }

  /** `/gui-reset`: removes every image labelled `pi-gui-testing.base`. Returns what could not be removed. */
  async removeBaseImages(signal: AbortSignal): Promise<{ removed: string[]; leftovers: Leftover[] }> {
    const endpoint = await this.endpoint(signal);
    const list = await runDocker(this.runner, endpoint, ["image", "ls", "-q", "--no-trunc", "--filter", `label=${LABEL_BASE}`], { timeoutMs: 15_000, signal });
    if (list.exitCode !== 0) throw new Error(`docker image ls failed (${describeFailure(list)})`);
    const ids = [...new Set(list.stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
    const removed: string[] = [];
    const leftovers: Leftover[] = [];
    for (const id of ids) {
      const result = await runDocker(this.runner, endpoint, ["image", "rm", "-f", id], { timeoutMs: 60_000, signal });
      if (result.exitCode === 0) removed.push(id);
      else leftovers.push({ kind: "image", id, detail: describeFailure(result) });
    }
    return { removed, leftovers };
  }
}
