/**
 * `local-linux` backend (spec §4.2): Linux apps run on this machine under a
 * private Xvfb display with a private D-Bus and AT-SPI bus, never on the
 * user's desktop. The Linux helper runs in host mode (`hostmode.py`), started
 * with an explicit environment that holds no desktop variable.
 *
 * Decisions:
 * - `setup` commands never run here (spec §4.2): the app uses the project's
 *   existing environment. A configured `setup` is skipped with a warning.
 * - `workspaceMode: "mount"` runs the app in the project directory itself,
 *   with the user's own permissions (no read-only view exists without a
 *   container). `"copy"` runs it in a filtered copy (spec §4.7) inside the
 *   session temp dir; dependency directories are not copied.
 * - `network: "none"` cannot be enforced on the host, so it is refused.
 */
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { SessionError, type Backend, type Session, type SessionStartOptions, type SyncSummary } from "../backend.ts";
import type { Check } from "../checks/types.ts";
import type { CommonCheckOptions } from "../checks/common.ts";
import { DEFAULT_PROC_ROOT } from "../cleanup/identity.ts";
import type { BackendId, ResolvedConfig } from "../config/types.ts";
import { PROTOCOL_VERSION, type Leftover } from "../protocol.ts";
import { createSpawnRunner } from "../runner/spawn.ts";
import type { CommandRunner } from "../runner/types.ts";
import { copyFileSet } from "../sync/copy.ts";
import { buildFileSet } from "../sync/fileset.ts";
import { createLocalSpawner, type LocalSpawner } from "../transport/local-process.ts";
import type { DriftCapability, ResetCapability, RunnerCapability, SmokeCapability, SweepAvailability } from "./capabilities.ts";
import { packageVersion } from "./docker/package.ts";
import { auditLocalOrphans, sweepLocalOrphans, type FootprintOptions } from "./local/footprint.ts";
import { localLinuxChecks, type LocalCheckOptions } from "./local/checks.ts";
import {
  displayLockDir,
  ensureDisplayLockDir,
  findExecutable,
  helperArgv,
  helperEnv,
  isExecutable,
  DEEPEST_SOCKET,
  MAX_SOCKET_PATH,
  resolvePython,
  SMOKE_APP_PATH,
  type Which,
} from "./local/host.ts";
import { LocalLinuxSession } from "./local/session.ts";

export { LOCAL_LINUX_HOST_SUPPORT } from "./local/host.ts";

export interface LocalLinuxOptions {
  /** Owner label of this extension instance (unused by probes here; kept for the factory shape). */
  ownerLabel?: () => string;
  runner?: CommandRunner;
  spawner?: LocalSpawner;
  version?: string;
  /** Temp root for the display lock dir and probes; default `os.tmpdir()`. */
  tmpRoot?: string;
  procRoot?: string;
  uid?: number;
  /** Pi's environment (only the allow-listed variables are read). */
  env?: NodeJS.ProcessEnv;
  which?: Which;
  executable?: (path: string) => boolean;
  /** Python that runs the helper; default the system `python3`. */
  python?: string;
  /** Test overrides for the X socket and lock dirs, and for signals. */
  x11Dir?: string;
  xLockDir?: string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  common?: Partial<CommonCheckOptions>;
  packageManager?: LocalCheckOptions["packageManager"];
  /** Test-only: shortened helper heartbeat timeout (the client then pings at a third of it). */
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
  exitWaitMs?: number;
  killWaitMs?: number;
  platform?: NodeJS.Platform;
  /** Test-only: longest accepted socket path (fake helpers create no socket). */
  maxSocketPath?: number;
}

/** The warning `gui_launch` shows when `.pi/gui.json` lists setup commands. */
export function setupSkippedWarning(count: number): string {
  return `local-linux never runs setup commands; the ${count} setup command(s) in .pi/gui.json were skipped and the app runs in the project's existing environment (venv, node_modules, system libraries)`;
}

export const COPY_MODE_WARNING =
  'workspaceMode "copy" on local-linux: the app runs in a filtered copy without dependency directories (node_modules, .venv, …); use "mount" to run it in the project with its existing environment';

export class LocalLinuxBackend implements Backend, DriftCapability, ResetCapability, SweepAvailability, RunnerCapability, SmokeCapability {
  readonly id: BackendId = "local-linux";
  readonly runner: CommandRunner;
  readonly spawner: LocalSpawner;
  readonly version: string;
  readonly #options: LocalLinuxOptions;

  constructor(options: LocalLinuxOptions = {}) {
    this.#options = options;
    this.runner = options.runner ?? createSpawnRunner();
    this.spawner = options.spawner ?? createLocalSpawner();
    this.version = options.version ?? packageVersion();
  }

  get #uid(): number {
    return this.#options.uid ?? process.getuid?.() ?? 0;
  }

  get #env(): NodeJS.ProcessEnv {
    return this.#options.env ?? process.env;
  }

  #which: Which = (name) => (this.#options.which ?? ((n: string) => findExecutable(n, this.#env.PATH)))(name);

  get #lockDir(): string {
    return displayLockDir(this.#options.tmpRoot, this.#uid);
  }

  #python(): string | undefined {
    return this.#options.python ?? resolvePython(this.#which, this.#options.executable ?? isExecutable);
  }

  #footprint(): FootprintOptions {
    return {
      lockDir: this.#lockDir,
      uid: this.#uid,
      procRoot: this.#options.procRoot ?? DEFAULT_PROC_ROOT,
      ...(this.#options.x11Dir ? { x11Dir: this.#options.x11Dir } : {}),
      ...(this.#options.xLockDir ? { xLockDir: this.#options.xLockDir } : {}),
      ...(this.#options.kill ? { kill: this.#options.kill } : {}),
    };
  }

  checks(): Check[] {
    return localLinuxChecks({
      runner: this.runner,
      which: this.#which,
      env: this.#env,
      uid: this.#uid,
      ...(this.#options.executable ? { executable: this.#options.executable } : {}),
      ...(this.#options.tmpRoot ? { tmpRoot: this.#options.tmpRoot } : {}),
      ...(this.#options.packageManager !== undefined ? { packageManager: this.#options.packageManager } : {}),
      ...(this.#options.common ? { common: this.#options.common } : {}),
    });
  }

  /** Package, Pi, protocol, and Python versions for the drift check before each launch. */
  async currentVersions(signal?: AbortSignal): Promise<Record<string, string>> {
    const versions: Record<string, string> = {
      "package.version": this.version,
      "pi.version": this.#options.common?.piVersion ?? PI_VERSION,
      protocol: String(PROTOCOL_VERSION),
    };
    const python = this.#python();
    if (!python) throw new Error("python3 not found");
    const result = await this.runner.run([python, "-I", "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { timeoutMs: 10_000, signal });
    if (result.exitCode !== 0) throw new Error(`${python} failed (exit ${result.exitCode ?? result.signal})`);
    versions["python.version"] = result.stdout.trim();
    return versions;
  }

  async startSession(options: SessionStartOptions): Promise<Session> {
    const { signal, config } = options;
    const shared = config.shared;
    if (shared.network === "none") {
      throw new SessionError("UNSUPPORTED", 'local-linux cannot block the app\'s network ("network": "none"); use docker-linux for an offline session, or set "network": "default"');
    }
    const python = this.#python();
    if (!python) throw new SessionError("START_FAILED", "python3 not found; run /gui-doctor local-linux");
    if ((shared.setup ?? []).length > 0) config.warnings.push(setupSkippedWarning(shared.setup!.length));

    let workspace: string;
    let sync: SyncSummary | undefined;
    if (shared.workspaceMode === "copy") {
      options.onStatus?.("copying the workspace (sync rules apply)");
      const set = await buildFileSet(options.projectRoot, { allow: shared.sync?.allow, deny: shared.sync?.deny, runner: this.runner, signal });
      workspace = join(await realpath(options.sessionDir), "workspace");
      sync = await copyFileSet(set, workspace, signal);
      config.warnings.push(COPY_MODE_WARNING);
    } else {
      workspace = await realpath(options.projectRoot);
      if (!(await stat(workspace)).isDirectory()) throw new SessionError("START_FAILED", `${workspace} is not a directory`);
    }

    const runtimeDir = join(await realpath(options.sessionDir), "runtime");
    if (Buffer.byteLength(join(runtimeDir, ...DEEPEST_SOCKET)) > (this.#options.maxSocketPath ?? MAX_SOCKET_PATH)) {
      throw new SessionError("START_FAILED", `the session dir ${options.sessionDir} is too deep for the private bus sockets; set TMPDIR to a shorter path`);
    }
    await mkdir(runtimeDir, { mode: 0o700 });
    let lockDir: string;
    try {
      lockDir = ensureDisplayLockDir(this.#lockDir, this.#uid);
    } catch (error) {
      throw new SessionError("START_FAILED", (error as Error).message);
    }

    const heartbeat = this.#options.heartbeatTimeoutMs;
    const session = new LocalLinuxSession({
      id: options.sessionId,
      backend: this.id,
      packageVersion: this.version,
      onLog: options.onLog,
      spawner: this.spawner,
      argv: helperArgv(python),
      env: helperEnv({ base: this.#env, workspace, runtimeDir, lockDir, ...(heartbeat !== undefined ? { heartbeatTimeoutMs: heartbeat } : {}) }),
      workspacePath: workspace,
      runtimeDir,
      footprint: this.#footprint(),
      recordResource: options.recordResource,
      ...(options.onExitCleanup ? { onExitCleanup: options.onExitCleanup } : {}),
      ...(this.#env.DISPLAY ? { hostDisplay: this.#env.DISPLAY } : {}),
      ...(sync ? { sync } : {}),
      ...(this.#options.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.#options.readyTimeoutMs } : {}),
      ...(heartbeat !== undefined ? { heartbeatIntervalMs: Math.max(250, Math.floor(heartbeat / 3)) } : {}),
      ...(this.#options.exitWaitMs !== undefined ? { exitWaitMs: this.#options.exitWaitMs } : {}),
      ...(this.#options.killWaitMs !== undefined ? { killWaitMs: this.#options.killWaitMs } : {}),
    });
    options.onStatus?.("starting the private display");
    // On failure start() has stopped the session; leftovers stay attached to the error for the runtime.
    await session.start(signal);
    return session;
  }

  /** The bundled GTK 3 app, run with the system Python from the package directory. */
  smokeApp(): { cmd: string; args: string[] } {
    return { cmd: this.#python() ?? "python3", args: [SMOKE_APP_PATH] };
  }

  /** The smoke session needs the host network setting: `none` cannot be enforced here. */
  smokeConfig(base: ResolvedConfig): ResolvedConfig {
    return { ...base, shared: { ...base.shared, network: "default" } };
  }

  /** Swept only on Linux, where the lock dir and `/proc` exist. Runs no command. */
  async sweepAvailable(): Promise<boolean> {
    return (this.#options.platform ?? process.platform) === "linux";
  }

  readonly resetSummary = "Stops its sessions and removes its verified state and backend choice. local-linux installs nothing, so nothing else is removed.";
  readonly resetNote = "system packages: setup installs none for local-linux; Xvfb, xdotool, and the other tools you installed stay installed";

  auditOrphans(): Promise<Leftover[]> {
    return auditLocalOrphans(this.#footprint());
  }

  sweepOrphans(signal: AbortSignal): Promise<Leftover[]> {
    return sweepLocalOrphans({ ...this.#footprint(), signal });
  }
}
