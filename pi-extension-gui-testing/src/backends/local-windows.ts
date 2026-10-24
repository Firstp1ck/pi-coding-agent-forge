/**
 * `local-windows` backend (spec §4.5): Windows apps run on this machine on a
 * private desktop the Windows helper creates, inside kill-on-close Job
 * Objects, non-elevated, never on the user's desktop. The helper is Windows
 * PowerShell 5.1 compiling C# with `Add-Type` (spec Q4 option c), started in
 * `local` mode with an explicit environment built from an allow-list.
 *
 * Decisions:
 * - `setup` commands never run here (like `local-linux`): the helper gets no
 *   `PI_GUI_ALLOW_EXEC`, and a configured `setup` is skipped with a warning.
 * - `workspaceMode: "mount"` runs the app in the project directory itself,
 *   with the user's own permissions. `"copy"` runs it in a filtered copy
 *   (spec §4.7) inside the owner-only runtime dir; dependency directories are
 *   not copied.
 * - `network: "none"` cannot be enforced on the host, so it is refused.
 * - The runtime dir is `%LOCALAPPDATA%\Temp\pi-gui-testing-win-<16 hex>`,
 *   recorded in `owner.json` before it exists, with an ACL that grants only
 *   the user. Its 16 hex digits are the session tag the helper must use
 *   (`PI_GUI_WIN_TAG`). It holds a copy of the owner record (so this
 *   backend's orphan sweep can judge it; the generic session-dir scan skips
 *   these dirs) and the helper's `session.json`.
 * - Isolation is verified before the session is handed out: `hello` must
 *   report a private desktop and no `exec`, the session record must name a
 *   private desktop of this session, and the user's foreground window
 *   (`-Probe foreground`) must be the same before and after the helper start.
 */
import { join, win32 } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { SessionError, type Backend, type Session, type SessionStartOptions, type SyncSummary } from "../backend.ts";
import type { Check } from "../checks/types.ts";
import type { CommonCheckOptions } from "../checks/common.ts";
import { defaultProbe, DEFAULT_PROC_ROOT, type ProcessProbe } from "../cleanup/identity.ts";
import type { BackendId, ResolvedConfig } from "../config/types.ts";
import { OWNER_FILE } from "../owner.ts";
import { PROTOCOL_VERSION, type Leftover } from "../protocol.ts";
import { createSpawnRunner } from "../runner/spawn.ts";
import type { CommandRunner } from "../runner/types.ts";
import { copyFileSet } from "../sync/copy.ts";
import { buildFileSet } from "../sync/fileset.ts";
import { createLocalSpawner, type LocalSpawner } from "../transport/local-process.ts";
import type { DriftCapability, ResetCapability, RunnerCapability, SmokeCapability, SweepAvailability } from "./capabilities.ts";
import { packageVersion, PACKAGE_ROOT } from "./docker/package.ts";
import { stopAfterFailedStart } from "./start-failure.ts";
import { localHelperEnv, passedWindowsEnv } from "./windows/env.ts";
import { auditWindowsOrphans, sweepWindowsOrphans, type WinFootprintOptions } from "./windows/footprint.ts";
import { localWindowsChecks, LOCAL_WINDOWS_HOST_SUPPORT } from "./windows/local-checks.ts";
import { foregroundOf, LocalWindowsSession, type ForegroundWindow } from "./windows/local-session.ts";
import { boundedText, clientTempRoot, HELPER_DIR, helperArgv, localTempRoot, POWERSHELL_FILE_ARGS, powershellPath, systemRoot } from "./windows/paths.ts";
import { reportBoolean, runHelperProbe, type ProbeOutcome } from "./windows/probe.ts";
import { createRuntimeDir, nodeWinFs, ownerRecordFrom, runtimeDirTag, writeRuntimeOwner, type WinFs } from "./windows/runtime-dir.ts";

export { LOCAL_WINDOWS_HOST_SUPPORT } from "./windows/local-checks.ts";

/** The WinForms smoke app (spec §5.5), run in place from the installed package. */
export const WINDOWS_SMOKE_APP_PATH = join(PACKAGE_ROOT, "src", "backends", "windows", "smoke-app.ps1");

/** Copies the filtered project into `dest` (spec §4.7); injected in tests. */
export type CopyWorkspace = (projectRoot: string, dest: string, rules: { allow?: string[]; deny?: string[] }, signal: AbortSignal) => Promise<SyncSummary>;

export interface LocalWindowsOptions {
  /** Owner label of this extension instance (unused here; kept for the factory shape). */
  ownerLabel?: () => string;
  runner?: CommandRunner;
  spawner?: LocalSpawner;
  version?: string;
  /** Host platform; default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Pi's environment (only allow-listed system variables are read). */
  env?: Readonly<Record<string, string | undefined>>;
  /** File system; default `node:fs`. Tests pass a simulated Windows file system. */
  fs?: WinFs;
  /** Directory holding `helper.ps1`; default the package's `helpers\windows`. */
  helperDir?: string;
  /** Smoke app script; default {@link WINDOWS_SMOKE_APP_PATH}. */
  smokeAppPath?: string;
  /** Where the client's session dirs live; default {@link clientTempRoot} (`os.tmpdir()` on Windows). */
  clientTmpRoot?: string;
  /** Start times of PIDs as `owner.json` records them; default the platform probe. */
  processProbe?: ProcessProbe;
  copyWorkspace?: CopyWorkspace;
  /** `false` turns off the foreground-window comparison around the helper start (tests only). */
  foregroundCheck?: boolean;
  common?: Partial<CommonCheckOptions>;
  probeTimeoutMs?: number;
  /** Test-only: shortened helper heartbeat timeout (the client then pings at a third of it). */
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
  exitWaitMs?: number;
  killWaitMs?: number;
  recordWaitMs?: number;
}

/** The warning `gui_launch` shows when `.pi/gui.json` lists setup commands. */
export function windowsSetupSkippedWarning(count: number): string {
  return `local-windows never runs setup commands; the ${count} setup command(s) in .pi/gui.json were skipped and the app runs in the project's existing environment`;
}

export const WINDOWS_COPY_MODE_WARNING =
  'workspaceMode "copy" on local-windows: the app runs in a filtered copy without dependency directories (node_modules, .venv, …); use "mount" to run it in the project with its existing environment';

export const WINDOWS_MOUNT_DESCRIPTION = "the project directory itself (writable)";
export const WINDOWS_COPY_DESCRIPTION = "writable filtered copy (without dependency directories)";

const defaultCopy: CopyWorkspace = async (projectRoot, dest, rules, signal) => {
  const set = await buildFileSet(projectRoot, { allow: rules.allow, deny: rules.deny, signal });
  return copyFileSet(set, dest, signal);
};

export class LocalWindowsBackend implements Backend, DriftCapability, ResetCapability, SweepAvailability, RunnerCapability, SmokeCapability {
  readonly id: BackendId = "local-windows";
  readonly runner: CommandRunner;
  readonly spawner: LocalSpawner;
  readonly version: string;
  readonly #options: LocalWindowsOptions;

  constructor(options: LocalWindowsOptions = {}) {
    this.#options = options;
    this.runner = options.runner ?? createSpawnRunner();
    this.spawner = options.spawner ?? createLocalSpawner();
    this.version = options.version ?? packageVersion();
  }

  get #env(): Readonly<Record<string, string | undefined>> {
    return this.#options.env ?? process.env;
  }

  get #fs(): WinFs {
    return this.#options.fs ?? nodeWinFs;
  }

  get #platform(): NodeJS.Platform {
    return this.#options.platform ?? process.platform;
  }

  get #helperDir(): string {
    return this.#options.helperDir ?? HELPER_DIR;
  }

  get #processProbe(): ProcessProbe {
    return this.#options.processProbe ?? defaultProbe(DEFAULT_PROC_ROOT, "win32");
  }

  /** Footprint options, or `undefined` when this is not a usable Windows host. */
  #footprint(signal?: AbortSignal): WinFootprintOptions | undefined {
    try {
      return {
        fs: this.#fs,
        runner: this.runner,
        powershell: powershellPath(this.#env),
        env: passedWindowsEnv(this.#env),
        root: localTempRoot(this.#env),
        clientRoot: this.#options.clientTmpRoot ?? clientTempRoot(this.#env),
        probe: this.#processProbe,
        ...(signal ? { signal } : {}),
      };
    } catch {
      return undefined;
    }
  }

  checks(): Check[] {
    return localWindowsChecks({
      runner: this.runner,
      fs: this.#fs,
      env: this.#env,
      helperDir: this.#helperDir,
      ...(this.#options.probeTimeoutMs !== undefined ? { probeTimeoutMs: this.#options.probeTimeoutMs } : {}),
      ...(this.#options.common ? { common: this.#options.common } : {}),
    });
  }

  /** Package, Pi, and protocol versions for the drift check; runs no command. */
  async currentVersions(): Promise<Record<string, string>> {
    return {
      "package.version": this.version,
      "pi.version": this.#options.common?.piVersion ?? PI_VERSION,
      protocol: String(PROTOCOL_VERSION),
    };
  }

  #probe(name: "foreground" | "env", signal: AbortSignal): Promise<ProbeOutcome> {
    const env = this.#env;
    return runHelperProbe(name, {
      runner: this.runner,
      powershell: powershellPath(env),
      helperDir: this.#helperDir,
      env: passedWindowsEnv(env),
      cwd: win32.join(systemRoot(env), "System32"),
      signal,
      ...(this.#options.probeTimeoutMs !== undefined ? { timeoutMs: this.#options.probeTimeoutMs } : {}),
    });
  }

  async startSession(options: SessionStartOptions): Promise<Session> {
    const { signal, config } = options;
    const shared = config.shared;
    if (shared.network === "none") {
      throw new SessionError("UNSUPPORTED", 'local-windows cannot block the app\'s network ("network": "none"); set "network": "default"');
    }
    if (this.#platform !== "win32") throw new SessionError("START_FAILED", `local-windows runs on Windows hosts only (this host is ${this.#platform})`);
    const env = this.#env;
    const fs = this.#fs;
    let powershell: string;
    let root: string;
    let cwd: string;
    try {
      powershell = powershellPath(env);
      root = localTempRoot(env);
      cwd = win32.join(systemRoot(env), "System32");
    } catch (error) {
      throw new SessionError("START_FAILED", (error as Error).message);
    }
    const helperScript = win32.join(this.#helperDir, "helper.ps1");
    if ((await fs.lstat(helperScript).catch(() => undefined)) !== "file") throw new SessionError("START_FAILED", `the Windows helper ${helperScript} is missing; reinstall the package and run /gui-doctor local-windows`);
    if ((await fs.lstat(powershell).catch(() => undefined)) !== "file") throw new SessionError("START_FAILED", `${powershell} not found; run /gui-doctor local-windows`);

    const warnings: string[] = [];
    if ((shared.setup ?? []).length > 0) warnings.push(windowsSetupSkippedWarning(shared.setup!.length));

    let workspace: string | undefined;
    if (shared.workspaceMode !== "copy") {
      try {
        workspace = await fs.realpath(options.projectRoot);
      } catch (error) {
        throw new SessionError("START_FAILED", `cannot resolve the project directory ${options.projectRoot}: ${boundedText((error as Error).message)}`);
      }
      if ((await fs.lstat(workspace)) !== "dir") throw new SessionError("START_FAILED", `${workspace} is not a directory`);
    }

    const owner = ownerRecordFrom(await fs.readFile(win32.join(options.sessionDir, OWNER_FILE), 64 * 1024).catch(() => ""));
    if (!owner) throw new SessionError("START_FAILED", `the session's ${OWNER_FILE} in ${options.sessionDir} cannot be read`);

    let foreground: { before: ForegroundWindow; probe(signal: AbortSignal): Promise<ProbeOutcome> } | undefined;
    let elevationProbe: ProbeOutcome | undefined;
    if (this.#options.foregroundCheck !== false) {
      options.onStatus?.("reading the foreground window");
      const outcome = await this.#probe("foreground", signal);
      elevationProbe = outcome;
      const before = foregroundOf(outcome);
      if (!before) throw new SessionError("START_FAILED", `the Windows helper could not read the foreground window: ${outcome.problem ?? "malformed report"}; run /gui-doctor local-windows`);
      foreground = { before, probe: (s) => this.#probe("foreground", s) };
    }
    // Refused before anything is created: with an elevated Pi, the client's own writes into the session
    // folders would run elevated while the app runs as the normal user (DEVELOPMENT "Known gaps").
    elevationProbe ??= await this.#probe("env", signal);
    const elevated = reportBoolean(elevationProbe.report, "elevated");
    if (elevated !== false) {
      throw new SessionError(
        elevated === true ? "UNSUPPORTED" : "START_FAILED",
        elevated === true
          ? "Pi runs elevated (as administrator); local-windows needs Pi started from a normal, non-administrator terminal"
          : `the Windows helper could not report whether Pi runs elevated: ${elevationProbe.problem ?? "malformed report"}; run /gui-doctor local-windows`,
      );
    }

    const heartbeat = this.#options.heartbeatTimeoutMs;
    /** The session over `runtimeDir`; also the retry handle of a start that failed before the helper ran. */
    const makeSession = (runtimeDir: string, workspacePath: string, extra: { warnings?: string[]; sync?: SyncSummary } = {}) =>
      new LocalWindowsSession({
        id: options.sessionId,
        backend: this.id,
        packageVersion: this.version,
        onLog: options.onLog,
        spawner: this.spawner,
        argv: helperArgv(powershell, this.#helperDir),
        env: localHelperEnv({
          base: env,
          workspace: workspacePath,
          runtimeDir,
          tag: runtimeDirTag(runtimeDir)!,
          ...(heartbeat !== undefined ? { heartbeatTimeoutMs: heartbeat } : {}),
        }),
        cwd,
        workspacePath,
        workspaceDescription: shared.workspaceMode === "copy" ? WINDOWS_COPY_DESCRIPTION : WINDOWS_MOUNT_DESCRIPTION,
        ...(extra.warnings?.length ? { warnings: extra.warnings } : {}),
        runtimeDir,
        // Not the start signal: teardown and audits run long after the start finished.
        footprint: this.#footprint()!,
        owner,
        recordResource: options.recordResource,
        ...(options.onExitCleanup ? { onExitCleanup: options.onExitCleanup } : {}),
        processProbe: this.#processProbe,
        powershell,
        ...(foreground ? { foreground } : {}),
        ...(extra.sync ? { sync: extra.sync } : {}),
        ...(this.#options.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.#options.readyTimeoutMs } : {}),
        ...(heartbeat !== undefined ? { heartbeatIntervalMs: Math.max(250, Math.floor(heartbeat / 3)) } : {}),
        ...(this.#options.exitWaitMs !== undefined ? { exitWaitMs: this.#options.exitWaitMs } : {}),
        ...(this.#options.killWaitMs !== undefined ? { killWaitMs: this.#options.killWaitMs } : {}),
        ...(this.#options.recordWaitMs !== undefined ? { recordWaitMs: this.#options.recordWaitMs } : {}),
      });

    let runtimeDir: string | undefined;
    let sync: SyncSummary | undefined;
    let session: LocalWindowsSession;
    try {
      options.onStatus?.("creating the private temp dir");
      runtimeDir = await createRuntimeDir({
        fs,
        runner: this.runner,
        env,
        root,
        signal,
        recordResource: options.recordResource,
        // Only a dir this call created is ever removed below, never one that existed before.
        onCreated: (dir) => void (runtimeDir = dir),
      });
      await writeRuntimeOwner(fs, runtimeDir, { ...owner, resources: [...owner.resources, { kind: "tempdir", id: runtimeDir }] });
      if (shared.workspaceMode === "copy") {
        options.onStatus?.("copying the workspace (sync rules apply)");
        workspace = win32.join(runtimeDir, "workspace");
        sync = await (this.#options.copyWorkspace ?? defaultCopy)(options.projectRoot, workspace, { allow: shared.sync?.allow, deny: shared.sync?.deny }, signal);
        warnings.push(WINDOWS_COPY_MODE_WARNING);
      }
      session = makeSession(runtimeDir, workspace!, { warnings, ...(sync ? { sync } : {}) });
    } catch (error) {
      const failure = error instanceof SessionError ? error : new SessionError("START_FAILED", boundedText((error as Error).message, 600));
      if (runtimeDir) {
        // The same teardown as a stop: whatever it cannot remove stays attached to the error (and retryable), never dropped.
        const pending = makeSession(runtimeDir, workspace ?? win32.join(runtimeDir, "workspace"));
        const left = await stopAfterFailedStart(pending, failure);
        if (left.length > 0) failure.message += `; ${left[0].id} could not be removed (${left[0].detail ?? "unknown"})`;
      }
      throw failure;
    }

    options.onStatus?.("starting the Windows helper (compiling it takes a few seconds)");
    // On failure (a spawn that throws included) start() has stopped the session; leftovers stay attached to the error.
    await session.start(signal);
    return session;
  }

  /** The bundled WinForms app, run with Windows PowerShell from the package directory. */
  smokeApp(): { cmd: string; args: string[] } {
    let cmd = "powershell.exe";
    try {
      cmd = powershellPath(this.#env);
    } catch {
      // Reported by the checks; the launch then fails with the helper's NOT_FOUND.
    }
    const args: string[] = [...POWERSHELL_FILE_ARGS];
    // -STA goes before -File: everything after the script path is a script argument.
    args.splice(args.indexOf("-File"), 0, "-STA");
    return { cmd, args: [...args, this.#options.smokeAppPath ?? WINDOWS_SMOKE_APP_PATH] };
  }

  /** The smoke session targets Windows and needs the host network: `none` cannot be enforced here. */
  smokeConfig(base: ResolvedConfig): ResolvedConfig {
    return { ...base, shared: { ...base.shared, targets: ["windows"], network: "default" } };
  }

  /** Swept only on Windows hosts with a usable `%LOCALAPPDATA%`. Runs no command. */
  async sweepAvailable(): Promise<boolean> {
    return this.#platform === "win32" && this.#footprint() !== undefined;
  }

  readonly resetSummary = "Stops its sessions and removes its verified state and backend choice. local-windows installs nothing, so nothing else is removed.";
  readonly resetNote = "system software: setup installs nothing for local-windows; Windows PowerShell and the .NET Framework are part of Windows";

  async auditOrphans(signal: AbortSignal): Promise<Leftover[]> {
    const footprint = this.#platform === "win32" ? this.#footprint(signal) : undefined;
    return footprint ? auditWindowsOrphans(footprint) : [];
  }

  async sweepOrphans(signal: AbortSignal): Promise<Leftover[]> {
    const footprint = this.#platform === "win32" ? this.#footprint(signal) : undefined;
    return footprint ? sweepWindowsOrphans(footprint) : [];
  }
}
