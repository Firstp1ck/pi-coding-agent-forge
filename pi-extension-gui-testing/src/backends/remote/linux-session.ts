/**
 * One `remote-linux` session: the package's Linux helper in host mode on the
 * remote host, over `ssh -T <host> -- …` stdio through the session's
 * ControlMaster. The helper starts its own private Xvfb, bus, and window
 * manager (never the remote's `:0`) and runs under `env -i`, so nothing of the
 * SSH login environment (a forwarded or inherited `DISPLAY`, the user's bus)
 * reaches it except {@link REMOTE_INHERITED_ENV} and the variables below.
 */
import type { SyncSummary } from "../../backend.ts";
import type { SyncReport } from "../../sync/transport/workspace-sync.ts";
import type { BackendId } from "../../config/types.ts";
import { HEARTBEAT_TIMEOUT_TEST_ENV, type LogEvent } from "../../protocol.ts";
import { HelperSession } from "../../transport/helper-session.ts";
import type { RemoteResources } from "./resources.ts";
import type { RemoteSessionDir } from "./session-dir.ts";

/** Environment contract of the helper's host mode (implemented by the helper). */
export const HELPER_MODE_ENV = "PI_GUI_HELPER_MODE";
export const HELPER_WORKSPACE_ENV = "PI_GUI_WORKSPACE";
export const HELPER_RUNTIME_DIR_ENV = "PI_GUI_RUNTIME_DIR";
export const HELPER_DISPLAY_LOCK_DIR_ENV = "PI_GUI_DISPLAY_LOCK_DIR";
export const HELPER_ALLOW_EXEC_ENV = "PI_GUI_ALLOW_EXEC";

/** Helper environment for a remote session dir (the token is added by {@link HelperSession}). */
export function remoteHelperEnv(remote: RemoteSessionDir, options: { allowExec: boolean; heartbeatTimeoutMs?: number }): Record<string, string> {
  return {
    [HELPER_MODE_ENV]: "host",
    [HELPER_WORKSPACE_ENV]: remote.workspace,
    [HELPER_RUNTIME_DIR_ENV]: remote.run,
    [HELPER_DISPLAY_LOCK_DIR_ENV]: remote.displays,
    ...(options.allowExec ? { [HELPER_ALLOW_EXEC_ENV]: "1" } : {}),
    ...(options.heartbeatTimeoutMs !== undefined ? { [HEARTBEAT_TIMEOUT_TEST_ENV]: String(options.heartbeatTimeoutMs) } : {}),
  };
}

/** Argv of the helper on the remote host: isolated Python (no `PYTHONPATH`, no cwd on `sys.path`). */
export function remoteHelperArgv(remote: RemoteSessionDir): string[] {
  return ["python3", "-I", `${remote.tooling}/helper`];
}

export interface RemoteLinuxSessionOptions {
  id: string;
  backend: BackendId;
  packageVersion: string;
  onLog(event: LogEvent): void;
  sync?: SyncSummary;
  resources: RemoteResources;
  remote: RemoteSessionDir;
  allowExec: boolean;
  /** Re-sends the workspace (incremental with rsync). */
  resync?: (signal?: AbortSignal) => Promise<SyncReport>;
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  exitWaitMs?: number;
  killWaitMs?: number;
}

export class RemoteLinuxSession extends HelperSession {
  readonly #resources: RemoteResources;
  readonly #resync?: (signal?: AbortSignal) => Promise<SyncReport>;
  readonly remote: RemoteSessionDir;

  constructor(options: RemoteLinuxSessionOptions) {
    const { resources, remote } = options;
    const env = remoteHelperEnv(remote, { allowExec: options.allowExec, ...(options.heartbeatTimeoutMs !== undefined ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs } : {}) });
    super({
      id: options.id,
      backend: options.backend,
      packageVersion: options.packageVersion,
      workspacePath: remote.workspace,
      workspaceDescription: `writable copy synced to ${resources.destination} (changes stay there)`,
      onLog: options.onLog,
      ...(options.sync ? { sync: options.sync } : {}),
      ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.exitWaitMs !== undefined ? { exitWaitMs: options.exitWaitMs } : {}),
      ...(options.killWaitMs !== undefined ? { killWaitMs: options.killWaitMs } : {}),
      labels: { launcher: "ssh", target: `the remote session on ${resources.destination}`, inside: `on ${resources.destination}`, stillRunning: "ssh to the remote helper still running" },
      hooks: {
        spawn: (tokenEnv) => resources.transport.spawnHelper(remoteHelperArgv(remote), { ...env, ...tokenEnv }),
        // ssh ignored stdin EOF: end the remote processes first, so SIGTERM to ssh leaves nothing behind.
        onExitTimeout: async () => void (await resources.teardown().catch(() => undefined)),
        teardown: () => resources.teardown(),
        audit: () => resources.audit(),
      },
    });
    this.#resources = resources;
    this.remote = remote;
    if (options.resync) this.#resync = options.resync;
  }

  /** Re-syncs the workspace into the running session (`session.sync` is updated). */
  resync(signal?: AbortSignal): Promise<SyncReport> {
    if (!this.#resync) return Promise.reject(new Error("this session cannot re-sync"));
    return this.#resync(signal);
  }

  /** One bounded `ssh` call that kills the remote processes and removes the remote session dir. */
  forceRemoveArgv(): string[] {
    return this.#resources.exitArgv();
  }
}
