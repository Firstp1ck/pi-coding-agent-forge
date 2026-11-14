/**
 * `remote-linux` backend (spec §4.2a): apps run on a user-owned Linux host
 * reached over SSH, under a private Xvfb display that the package's helper
 * starts in a fresh remote session dir. The workspace is synced there with
 * the §4.7 rules, the project's `setup` commands run there (never on the
 * client), and the session dir is removed on every exit path.
 * `network: "none"` cannot be enforced on a shared remote host, so it is
 * refused before anything is created there.
 */
import { SessionError, type Backend, type Session, type SessionStartOptions } from "../backend.ts";
import type { DriftCapability, OrphanAuditGate, ResetCapability, RunnerCapability, SmokeCapability, SweepAvailability } from "./capabilities.ts";
import type { Check } from "../checks/types.ts";
import type { BackendId, ResolvedConfig } from "../config/types.ts";
import { stopAfterFailedStart } from "./start-failure.ts";
import { RemoteBackendBase, type RemoteBackendOptions, type RemoteSharedState } from "./remote/base.ts";
import { RemoteProbes, remoteBaseChecks, REMOTE_LINUX_MIN_FREE_BYTES } from "./remote/checks.ts";
import { deployHelper, REMOTE_SMOKE_APP } from "./remote/deploy.ts";
import { remoteLinuxRuntimeChecks } from "./remote/linux-checks.ts";
import { RemoteLinuxSession } from "./remote/linux-session.ts";

export type RemoteLinuxOptions = RemoteBackendOptions;

export class RemoteLinuxBackend
  extends RemoteBackendBase
  implements Backend, DriftCapability, ResetCapability, SweepAvailability, OrphanAuditGate, RunnerCapability, SmokeCapability
{
  readonly id: BackendId = "remote-linux";

  constructor(options: RemoteLinuxOptions, shared?: RemoteSharedState) {
    super(options, shared);
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
    return [...remoteBaseChecks(probes, { minRemoteFreeBytes: REMOTE_LINUX_MIN_FREE_BYTES }), ...remoteLinuxRuntimeChecks(probes)];
  }

  readonly resetSummary =
    "Stops its sessions, removes orphaned session dirs on the remote host, and removes its verified state and backend choice. Packages installed on the remote host stay.";
  readonly resetNote = "system packages installed on the remote host at setup (Xvfb, xdotool, …) stay installed; remove them there yourself if nothing else needs them";

  /** The GTK 3 smoke app deployed with the helper, relative to the remote workspace. */
  smokeApp(): { cmd: string; args: string[] } {
    return { cmd: "python3", args: [REMOTE_SMOKE_APP] };
  }

  /** The smoke session uses this backend's host and the host's network (`none` cannot be enforced here). */
  smokeConfig(base: ResolvedConfig): ResolvedConfig {
    const config: ResolvedConfig = { ...base, shared: { ...base.shared, network: "default" } };
    return this.remoteHost ? { ...config, remote: { host: this.remoteHost } } : config;
  }

  async startSession(options: SessionStartOptions): Promise<Session> {
    // Refused before any connection: gui_launch must never report a network mode that is not enforced.
    if (options.config.shared.network === "none") {
      throw new SessionError("UNSUPPORTED", 'remote-linux cannot block the app\'s network ("network": "none"); use remote-linux-docker or docker-linux for an offline session, or set "network": "default"');
    }
    const prepared = await this.prepare(options, async (transport, remote, signal) => {
      options.onStatus?.(`copying the helper to ${transport.destination}`);
      await deployHelper(transport, remote.tooling, { signal, ...(this.options.packageRoot ? { packageRoot: this.options.packageRoot } : {}) });
    });
    const { tail, onLog } = this.setupLog(options);
    const heartbeat = this.options.heartbeatTimeoutMs;
    const session = new RemoteLinuxSession({
      id: options.sessionId,
      backend: this.id,
      packageVersion: this.version,
      onLog,
      sync: prepared.sync,
      resources: prepared.resources,
      remote: prepared.remote,
      // Spec §4.2a/§4.8: remote-linux runs the project's setup on the remote host.
      allowExec: true,
      resync: prepared.resync,
      // Spec §4.8: installs go below <session dir>/deps (pip --target, npm prefix), which the cache fills and packs.
      depsDir: `${prepared.remote.dir}/deps`,
      ...(heartbeat !== undefined ? { heartbeatTimeoutMs: heartbeat, heartbeatIntervalMs: Math.max(250, Math.floor(heartbeat / 3)) } : {}),
      ...(this.options.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.options.readyTimeoutMs } : {}),
    });
    options.onExitCleanup?.(session.forceRemoveArgv());
    try {
      options.onStatus?.(`starting the helper on ${prepared.destination}`);
      await session.start(options.signal);
      await this.runSetup(session, options, prepared.remote.workspace, tail, { base: `helper ${this.version}`, writable: true });
    } catch (error) {
      await stopAfterFailedStart(session, error);
      throw error;
    }
    return session;
  }
}
