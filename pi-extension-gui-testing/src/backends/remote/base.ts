/**
 * The parts `remote-linux` and `remote-linux-docker` share (spec §4.2a,
 * §7a.3): the SSH host, transports, session start up to the helper (connect,
 * remote sweep, session dir, deploy, workspace sync), the remote orphan audit
 * and sweep, and the sweep gate.
 */
import { join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { SessionError, type SessionStartOptions, type SyncSummary } from "../../backend.ts";
import type { CheckResult } from "../../checks/types.ts";
import type { BackendId } from "../../config/types.ts";
import { TextTail } from "../../framing/log-event.ts";
import { PROTOCOL_VERSION, type Leftover, type LogEvent } from "../../protocol.ts";
import { createSpawnRunner } from "../../runner/spawn.ts";
import type { CommandRunner } from "../../runner/types.ts";
import { buildFileSet } from "../../sync/fileset.ts";
import { WorkspaceSync, type SyncMethod, type SyncReport } from "../../sync/transport/workspace-sync.ts";
import { SshError, sshRemediation } from "../../transport/ssh/errors.ts";
import { controlLocation } from "../../transport/ssh/options.ts";
import { assertDestination } from "../../transport/ssh/quote.ts";
import type { DetachedRunner } from "../../transport/ssh/stream.ts";
import { SshTransport, type SshTransportOptions } from "../../transport/ssh/transport.ts";
import type { Spawner } from "../docker/process.ts";
import { packageVersion } from "../docker/package.ts";
import { stopAfterFailedStart } from "../start-failure.ts";
import type { CommonCheckOptions } from "../../checks/common.ts";
import { noHostMessage, sessionHost, type RemoteHostCapability } from "./host.ts";
import { PendingRemoteSession, RemoteResources } from "./resources.ts";
import { auditRemoteOrphans, createRemoteSessionDir, remoteSessionName, sweepRemoteOrphans, type RemoteSessionDir } from "./session-dir.ts";

/** Bound for one `setup` command (spec §7); the heartbeat keeps the helper alive meanwhile. */
export const REMOTE_SETUP_TIMEOUT_MS = 15 * 60_000;
/** Setup output kept for a failed setup command's message (characters). */
export const REMOTE_SETUP_TAIL_CHARS = 4 * 1024;

export interface RemoteBackendOptions {
  /** Owner label of this extension instance, for probe dirs and containers. */
  ownerLabel: () => string;
  /** SSH alias; usually set later through {@link RemoteHostCapability.useHost}. */
  host?: string;
  /** Local runner for `ssh`, `rsync`, `ssh-keygen`; default the spawn runner. */
  runner?: CommandRunner;
  /** Local spawner for `ssh` with open pipes; default the minimal-env spawner. */
  spawner?: Spawner;
  /** Starts the backgrounded ControlMaster; default the real one. */
  detached?: DetachedRunner;
  /** `ssh` executable. */
  ssh?: string;
  version?: string;
  procRoot?: string;
  tmpRoot?: string;
  /** Home directory for `~/.ssh` (tests). */
  home?: string;
  common?: Partial<CommonCheckOptions>;
  setupTimeoutMs?: number;
  /** Test-only: shortened helper heartbeat timeout. */
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** Force one sync method (tests); default `auto`. */
  syncMethod?: "auto" | SyncMethod;
  /** Parent of short ControlMaster dirs when the session dir path is too long; default `/tmp`. */
  shortControlRoot?: string;
  packageRoot?: string;
}

/** What a session start has built when the helper is about to start. */
export interface PreparedRemote {
  destination: string;
  transport: SshTransport;
  resources: RemoteResources;
  remote: RemoteSessionDir;
  /** Mutable: a re-sync updates it in place, so `session.sync` stays current. */
  sync: SyncSummary;
  /** Re-sends the workspace (incremental with rsync). */
  resync(signal?: AbortSignal): Promise<SyncReport>;
}

/** A session that can re-sync its workspace to the remote host. */
export interface WorkspaceResync {
  resync(signal?: AbortSignal): Promise<SyncReport>;
}

export function hasResync(session: object): session is WorkspaceResync {
  return typeof (session as Partial<WorkspaceResync>).resync === "function";
}

/** User-facing start error; connection failures name their remediation. */
export function toStartError(error: unknown, destination: string): unknown {
  if (error instanceof SshError) return new SessionError("START_FAILED", `${error.message}; ${sshRemediation(error.failure, destination)}`);
  return error;
}

export abstract class RemoteBackendBase implements RemoteHostCapability {
  abstract readonly id: BackendId;
  /** Local runner (remediation commands run on the client: `ssh … sudo -n …`, `ssh-keygen`). */
  readonly runner: CommandRunner;
  readonly version: string;
  protected readonly options: RemoteBackendOptions;
  #host?: string;

  constructor(options: RemoteBackendOptions) {
    this.options = options;
    this.runner = options.runner ?? createSpawnRunner();
    this.version = options.version ?? packageVersion();
    if (options.host !== undefined) this.useHost(options.host);
  }

  get remoteHost(): string | undefined {
    return this.#host;
  }

  useHost(host: string | undefined): void {
    this.#host = host === undefined || host === "" ? undefined : assertDestination(host);
  }

  /** Construction options shared by every transport of this backend. */
  protected transportOptions(): Omit<SshTransportOptions, "destination" | "control"> {
    return {
      runner: this.runner,
      ...(this.options.spawner ? { spawner: this.options.spawner } : {}),
      ...(this.options.detached ? { detached: this.options.detached } : {}),
      ...(this.options.ssh ? { ssh: this.options.ssh } : {}),
    };
  }

  /** A transport without ControlMaster to `destination`. */
  oneShot(destination: string): SshTransport {
    return new SshTransport({ destination, ...this.transportOptions() });
  }

  /** The host or a clear error. */
  protected requireHost(): string {
    if (!this.#host) throw new Error(noHostMessage(this.id));
    return this.#host;
  }

  /**
   * Never at Pi startup (no network calls there); for `/gui-cleanup` and
   * `/gui-reset` only when a host is known.
   */
  async sweepAvailable(context: { startup: boolean }): Promise<boolean> {
    return !context.startup && this.#host !== undefined;
  }

  /**
   * Whether `sudo -n` works on the remote host, for setup's remediation plan
   * (`SetupFlowInput.passwordlessSudo`): remote package installs are
   * automated only then. Never handles a password.
   */
  async passwordlessSudo(signal?: AbortSignal): Promise<boolean> {
    if (!this.#host) return false;
    const result = await this.oneShot(this.#host).runner.run(["sudo", "-n", "true"], { timeoutMs: 10_000, ...(signal ? { signal } : {}) }).catch(() => undefined);
    return result?.exitCode === 0;
  }

  /** Doctor audits remote orphans only when SSH authentication worked. */
  orphanAuditReady(results: readonly CheckResult[]): boolean {
    return results.some((r) => r.id === "ssh.auth" && r.status === "pass");
  }

  /**
   * Versions observable without a connection (spec §7 drift): this package,
   * Pi, the protocol, and the configured host.
   */
  async currentVersions(): Promise<Record<string, string>> {
    return {
      "package.version": this.version,
      "pi.version": this.options.common?.piVersion ?? PI_VERSION,
      protocol: String(PROTOCOL_VERSION),
      ...(this.#host ? { "remote.host": this.#host } : {}),
    };
  }

  async auditOrphans(signal: AbortSignal): Promise<Leftover[]> {
    if (!this.#host) return [];
    return auditRemoteOrphans(this.oneShot(this.#host).runner, { destination: this.#host, signal, ...(this.options.procRoot ? { procRoot: this.options.procRoot } : {}) });
  }

  async sweepOrphans(signal: AbortSignal): Promise<Leftover[]> {
    if (!this.#host) return [];
    return sweepRemoteOrphans(this.oneShot(this.#host).runner, { destination: this.#host, signal, ...(this.options.procRoot ? { procRoot: this.options.procRoot } : {}) });
  }

  /** Extra sweep at session start (remote-linux-docker: labelled containers). */
  protected async sweepExtra(_runner: CommandRunner, _destination: string, _signal: AbortSignal): Promise<void> {}

  /**
   * Session start up to the helper: ControlMaster, remote sweep, session dir,
   * `deploy`, and workspace sync. On failure everything is removed again;
   * what cannot be removed stays attached to the thrown error.
   */
  protected async prepare(options: SessionStartOptions, deploy: (transport: SshTransport, remote: RemoteSessionDir, signal: AbortSignal) => Promise<void>): Promise<PreparedRemote> {
    const { signal } = options;
    const host = sessionHost(options.config, this.#host);
    if (!host) throw new SessionError("START_FAILED", noHostMessage(this.id));
    const control = await controlLocation(options.sessionDir, this.options.shortControlRoot);
    const transport = new SshTransport({ destination: host, control, ...this.transportOptions() });
    const resources = new RemoteResources({ transport, auditTransport: this.oneShot(host), name: remoteSessionName(options.sessionId) });
    const pending = new PendingRemoteSession(options.sessionId, this.id, resources);
    const status = (text: string) => options.onStatus?.(text);
    options.onExitCleanup?.(resources.exitArgv());
    try {
      await options.recordResource("ssh-master", `${host} ${control.path}`);
      if (control.shortDir) await options.recordResource("ssh-control-dir", control.shortDir);
      status(`connecting to ${host}`);
      await transport.open(signal);
      status(`removing orphaned GUI sessions on ${host}`);
      await sweepRemoteOrphans(transport.runner, { destination: host, signal, ...(this.options.procRoot ? { procRoot: this.options.procRoot } : {}) }).catch(() => []);
      await this.sweepExtra(transport.runner, host, signal).catch(() => undefined);
      await options.recordResource("remote-dir", `${host}:${resources.name}`);
      status(`creating the session dir on ${host}`);
      const remote = await createRemoteSessionDir(transport.runner, { name: resources.name, ownerLabel: options.ownerLabel, sessionId: options.sessionId, backend: this.id, signal });
      resources.remote = remote;
      await deploy(transport, remote, signal);
      const shared = options.config.shared;
      const sync = new WorkspaceSync({
        transport,
        stagingRoot: join(options.sessionDir, "sync"),
        remoteDir: remote.workspace,
        localRunner: this.runner,
        ...(this.options.syncMethod ? { method: this.options.syncMethod } : {}),
      });
      const summary: SyncSummary = { files: 0, bytes: 0, excluded: 0 };
      const resync = async (s?: AbortSignal): Promise<SyncReport> => {
        const set = await buildFileSet(options.projectRoot, { allow: shared.sync?.allow, deny: shared.sync?.deny, runner: this.runner, ...(s ? { signal: s } : {}) });
        const report = await sync.sync(set, s);
        Object.assign(summary, { files: report.files, bytes: report.bytes, excluded: report.excluded });
        return report;
      };
      status(`syncing the workspace to ${host} (sync rules apply)`);
      const report = await resync(signal);
      status(`synced ${report.files} files to ${host}:${remote.workspace} (${report.bytes} bytes sent via ${report.method}, ${report.excluded} excluded)`);
      return { destination: host, transport, resources, remote, sync: summary, resync };
    } catch (error) {
      const failure = toStartError(error, host);
      await stopAfterFailedStart(pending, failure);
      throw failure;
    }
  }

  /**
   * Runs the project's `setup` commands through the helper's `exec`
   * (spec §4.2a, §4.8) in `cwd`. Throws `SETUP_FAILED` with the output tail.
   */
  protected async runSetup(
    session: { request: (method: "exec", params: { cmd: string; cwd: string; env: Record<string, string>; timeoutMs: number }, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<{ exitCode: number }> },
    options: SessionStartOptions,
    cwd: string,
    tail: TextTail,
  ): Promise<void> {
    const shared = options.config.shared;
    const commands = shared.setup ?? [];
    const timeoutMs = this.options.setupTimeoutMs ?? REMOTE_SETUP_TIMEOUT_MS;
    for (const [index, cmd] of commands.entries()) {
      options.onStatus?.(`setup ${index + 1}/${commands.length} on the remote host: ${cmd}`);
      const result = await session.request("exec", { cmd, cwd, env: { ...(shared.deps?.env ?? {}) }, timeoutMs }, { signal: options.signal, timeoutMs: timeoutMs + 30_000 });
      if (result.exitCode !== 0) {
        const text = tail.text.trim().slice(-2000);
        throw new SessionError("SETUP_FAILED", `setup command ${JSON.stringify(cmd)} exited with ${result.exitCode} on the remote host${text ? `; last output:\n${text}` : ""}`);
      }
    }
  }

  /** `onLog` that also keeps the setup output tail. */
  protected setupLog(options: SessionStartOptions): { tail: TextTail; onLog: (event: LogEvent) => void } {
    const tail = new TextTail(REMOTE_SETUP_TAIL_CHARS);
    return {
      tail,
      onLog: (event) => {
        if (event.source === "setup") tail.push(typeof event.data === "string" ? event.data : String(event.data));
        options.onLog(event);
      },
    };
  }
}
