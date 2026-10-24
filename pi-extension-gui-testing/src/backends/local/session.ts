/**
 * One `local-linux` session (spec §4.2, §6, §7a): the Linux helper in host
 * mode, spawned directly on the client with an explicit environment. The
 * helper starts its own Xvfb on a free display `:N` (N ≥ 90), a private bus,
 * AT-SPI, and openbox, and tears all of it down when its stdin closes.
 *
 * The client does not trust that alone: before handing the session out it
 * checks the display lock the helper claimed (number, runtime dir,
 * workspace, X socket), and after every stop it removes whatever the lock
 * record still names (tagged processes, X files, the lock).
 */
import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { SessionError, type SyncSummary } from "../../backend.ts";
import { DEFAULT_PROC_ROOT } from "../../cleanup/identity.ts";
import { processResourceId } from "../../cleanup/session-dir.ts";
import type { BackendId } from "../../config/types.ts";
import type { Leftover, LogEvent } from "../../protocol.ts";
import { HelperSession } from "../../transport/helper-session.ts";
import type { LocalSpawner } from "../../transport/local-process.ts";
import { cleanupLock, listDisplayLocks, lockRemnants, xFiles, type DisplayLockRecord, type FootprintOptions } from "./footprint.ts";
import { FIRST_DISPLAY, displayNumber, forbiddenHelperEnv } from "./host.ts";

export interface LocalSessionOptions {
  id: string;
  backend: BackendId;
  packageVersion: string;
  onLog(event: LogEvent): void;
  spawner: LocalSpawner;
  /** Helper argv (`python3 -I -B …/helper`). */
  argv: string[];
  /** Helper environment without the token (`helperEnv`). */
  env: Record<string, string>;
  /** Directory the app runs in (the project, or its copy). */
  workspacePath: string;
  /** `PI_GUI_RUNTIME_DIR`. */
  runtimeDir: string;
  footprint: FootprintOptions;
  /** Records a resource in `owner.json` (`SessionStartOptions.recordResource`). */
  recordResource(kind: string, id: string): Promise<void>;
  /** `SessionStartOptions.onExitCleanup`. */
  onExitCleanup?(argv: string[]): void;
  /** The desktop's display (`process.env.DISPLAY`); the helper's display must differ. */
  hostDisplay?: string;
  sync?: SyncSummary;
  readyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  exitWaitMs?: number;
  killWaitMs?: number;
  /** How long `verifyAfterStart` waits for the lock record (it exists before READY). Default 2 s. */
  lockWaitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export class LocalLinuxSession extends HelperSession {
  readonly #local: LocalSessionOptions;
  /** `<pid>:<starttime>` of the helper, once spawned. */
  #helperId?: string;
  #recorded?: Promise<void>;
  /** The lock record the helper claimed (set by `verifyAfterStart`, or found by teardown). */
  #lock?: { path: string; record: DisplayLockRecord };

  constructor(options: LocalSessionOptions) {
    const forbidden = forbiddenHelperEnv(options.env);
    if (forbidden.length > 0) throw new SessionError("ISOLATION", `refusing to start the helper with ${forbidden.join(", ")} in its environment`);
    super({
      id: options.id,
      backend: options.backend,
      packageVersion: options.packageVersion,
      workspacePath: options.workspacePath,
      onLog: options.onLog,
      ...(options.sync ? { sync: options.sync } : {}),
      ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.exitWaitMs !== undefined ? { exitWaitMs: options.exitWaitMs } : {}),
      ...(options.killWaitMs !== undefined ? { killWaitMs: options.killWaitMs } : {}),
      labels: { launcher: "the GUI helper", target: "the GUI helper", inside: "in the private display session", stillRunning: "GUI helper still running" },
      hooks: {
        spawn: (env) => this.#spawn(env),
        verifyAfterStart: (signal) => this.#verify(signal),
        teardown: () => this.#teardown(),
        audit: () => this.#audit(),
      },
    });
    this.#local = options;
  }

  /** Display the helper runs, e.g. `:90`, once verified. */
  get display(): string | undefined {
    return this.#lock ? `:${this.#lock.record.display}` : undefined;
  }

  /** `kill -TERM` to the helper's process group: the helper then tears down by itself. `[]` once it exited. */
  forceRemoveArgv(): string[] {
    const pid = this.helperPid;
    return pid !== undefined && this.processRunning ? ["kill", "-TERM", "--", `-${pid}`] : [];
  }

  #spawn(tokenEnv: Record<string, string>) {
    const child = this.#local.spawner.spawn(this.#local.argv, { env: { ...this.#local.env, ...tokenEnv }, cwd: "/" });
    const pid = child.pid;
    if (pid !== undefined) {
      // A process id needs the process: record it right after the spawn, before READY can arrive.
      try {
        this.#helperId = processResourceId(pid, this.#local.footprint.procRoot ?? DEFAULT_PROC_ROOT);
        this.#recorded = this.#local.recordResource("process", this.#helperId);
      } catch (error) {
        this.#recorded = Promise.reject(error);
      }
      this.#recorded.catch(() => {});
      this.#local.onExitCleanup?.(["kill", "-TERM", "--", `-${pid}`]);
    }
    return child;
  }

  async #findLock(): Promise<{ path: string; record: DisplayLockRecord } | undefined> {
    if (!this.#helperId) return undefined;
    const entries = await listDisplayLocks(this.#local.footprint.lockDir, this.#local.footprint.uid);
    const own = entries.find((e) => e.record?.helper === this.#helperId);
    return own?.record ? { path: own.path, record: own.record } : undefined;
  }

  async #verify(signal: AbortSignal): Promise<void> {
    if (!this.#recorded) throw new SessionError("START_FAILED", "the GUI helper has no process id");
    try {
      await this.#recorded;
    } catch (error) {
      throw new SessionError("START_FAILED", `could not record the GUI helper process: ${(error as Error).message}`);
    }
    const deadline = Date.now() + (this.#local.lockWaitMs ?? 2_000);
    let lock = await this.#findLock();
    while (!lock && Date.now() < deadline && !signal.aborted) {
      await sleep(50);
      lock = await this.#findLock();
    }
    if (!lock) throw new SessionError("ISOLATION", `the GUI helper claimed no display lock in ${this.#local.footprint.lockDir}; it was stopped`);
    this.#lock = lock;
    const { record } = lock;
    await this.#local.recordResource("display-lock", lock.path);
    const problems: string[] = [];
    if (record.display < FIRST_DISPLAY) problems.push(`display :${record.display} is below :${FIRST_DISPLAY}`);
    const host = displayNumber(this.#local.hostDisplay);
    if (host !== undefined && host === record.display) problems.push(`display :${record.display} is the desktop's display`);
    if (realpathOr(record.runtimeDir) !== realpathOr(this.#local.runtimeDir)) problems.push(`runtime dir ${record.runtimeDir} is not the session's`);
    if (realpathOr(record.workspace) !== realpathOr(this.#local.workspacePath)) problems.push(`workspace ${record.workspace} is not the session's`);
    const socket = xFiles(record.display, this.#local.footprint.x11Dir, this.#local.footprint.xLockDir).socket;
    try {
      const info = await lstat(socket);
      const uid = this.#local.footprint.uid ?? process.getuid?.() ?? 0;
      if (info.uid !== uid) problems.push(`${socket} belongs to uid ${info.uid}`);
    } catch {
      problems.push(`${socket} does not exist`);
    }
    if (problems.length > 0) throw new SessionError("ISOLATION", `the private display breaks the isolation rules (${problems.join("; ")}); the session was stopped`);
  }

  /** After the helper exited: remove whatever its lock record still names. */
  async #teardown(): Promise<Leftover[]> {
    if (this.processRunning) return [{ kind: "process", id: this.#helperId ?? String(this.helperPid ?? "?"), detail: "GUI helper did not exit" }];
    const lock = this.#lock ?? (await this.#findLock());
    if (!lock) return [];
    this.#lock = lock;
    const current = await this.#findLock();
    return cleanupLock(current?.path, lock.record, this.#local.footprint);
  }

  /** Read-only: the lock, tagged processes, and X files of this session. */
  async #audit(): Promise<Leftover[]> {
    const lock = this.#lock ?? (await this.#findLock());
    if (!lock) return [];
    const leftovers: Leftover[] = [];
    const current = await this.#findLock();
    if (current) leftovers.push({ kind: "display-lock", id: current.path, detail: `display :${lock.record.display}` });
    leftovers.push(...(await lockRemnants(lock.record, this.#local.footprint)));
    return leftovers;
  }
}
