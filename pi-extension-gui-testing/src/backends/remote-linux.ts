/**
 * `remote-linux` backend (spec §4.2a): apps run on a user-owned Linux host
 * reached over SSH, under a private Xvfb display that the package's helper
 * starts in a fresh remote session dir. The workspace is synced there with
 * the §4.7 rules, the project's `setup` commands run there (never on the
 * client), and the session dir is removed on every exit path.
 */
import type { Backend, Session, SessionStartOptions } from "../backend.ts";
import type { DriftCapability, OrphanAuditGate, ResetCapability, RunnerCapability, SmokeCapability, SweepAvailability } from "./capabilities.ts";
import type { Check } from "../checks/types.ts";
import type { BackendId, ResolvedConfig } from "../config/types.ts";
import { stopAfterFailedStart } from "./start-failure.ts";
import { RemoteBackendBase, type RemoteBackendOptions } from "./remote/base.ts";
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

  constructor(options: RemoteLinuxOptions) {
    super(options);
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

  /** The smoke session uses this backend's host. */
  smokeConfig(base: ResolvedConfig): ResolvedConfig {
    return this.remoteHost ? { ...base, remote: { host: this.remoteHost } } : base;
  }

  async startSession(options: SessionStartOptions): Promise<Session> {
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
      ...(heartbeat !== undefined ? { heartbeatTimeoutMs: heartbeat, heartbeatIntervalMs: Math.max(250, Math.floor(heartbeat / 3)) } : {}),
      ...(this.options.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.options.readyTimeoutMs } : {}),
    });
    options.onExitCleanup?.(session.forceRemoveArgv());
    try {
      options.onStatus?.(`starting the helper on ${prepared.destination}`);
      await session.start(options.signal);
      await this.runSetup(session, options, prepared.remote.workspace, tail);
    } catch (error) {
      await stopAfterFailedStart(session, error);
      throw error;
    }
    return session;
  }
}
