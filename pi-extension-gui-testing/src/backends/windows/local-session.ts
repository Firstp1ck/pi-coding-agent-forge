/**
 * One `local-windows` session (spec §4.5, §6, §7a): the Windows helper in
 * `local` mode, spawned directly on the client with an explicit environment.
 * It creates a private desktop, starts every app suspended inside a
 * kill-on-close Job Object with a non-elevated token, and tears all of it
 * down when its stdin closes.
 *
 * The client does not trust that alone: before handing the session out it
 * checks what the helper reported (private desktop, no `exec`), the session
 * record the helper wrote, and that the user's foreground window did not
 * change while the helper started. After every stop it ends whatever the
 * record still names and removes the runtime dir.
 */
import { win32 } from "node:path";
import { SessionError, type SyncSummary } from "../../backend.ts";
import type { ProcessProbe } from "../../cleanup/identity.ts";
import type { BackendId } from "../../config/types.ts";
import type { OwnerRecord } from "../../owner.ts";
import type { Leftover, LogEvent } from "../../protocol.ts";
import { HelperSession } from "../../transport/helper-session.ts";
import type { LocalSpawner } from "../../transport/local-process.ts";
import { forbiddenLocalHelperEnv } from "./env.ts";
import { auditRuntimeDir, cleanupRuntimeDir, readSessionRecord, type WinFootprintOptions } from "./footprint.ts";
import type { ProbeOutcome } from "./probe.ts";
import { reportString } from "./probe.ts";
import { writeRuntimeOwner } from "./runtime-dir.ts";
import type { WinSessionRecord } from "./session-record.ts";

/** The user's foreground window as `-Probe foreground` reports it. */
export interface ForegroundWindow {
  /** `win:0x…`, or `null` when no window has the focus (locked screen, service session). */
  hwnd: string | null;
  title: string;
}

/** Reads a foreground report; `undefined` when the probe failed or the report is malformed. */
export function foregroundOf(outcome: ProbeOutcome): ForegroundWindow | undefined {
  if (!outcome.ok || !outcome.report) return undefined;
  const raw = outcome.report.hwnd;
  if (raw !== null && (typeof raw !== "string" || !/^win:0x[0-9a-f]{1,16}$/.test(raw))) return undefined;
  return { hwnd: raw, title: reportString(outcome.report, "title", 120) ?? "" };
}

function describe(window: ForegroundWindow): string {
  return window.hwnd === null ? "no foreground window" : `${window.hwnd}${window.title ? ` "${window.title}"` : ""}`;
}

export interface LocalWindowsSessionOptions {
  id: string;
  backend: BackendId;
  packageVersion: string;
  onLog(event: LogEvent): void;
  spawner: LocalSpawner;
  /** `powershell.exe … -File helper.ps1`. */
  argv: string[];
  /** Helper environment without the token ({@link localHelperEnv}). */
  env: Record<string, string>;
  /** Working directory of the helper (`%SystemRoot%\System32`, never the project). */
  cwd: string;
  workspacePath: string;
  workspaceDescription?: string;
  warnings?: readonly string[];
  /** `PI_GUI_RUNTIME_DIR`, already created by the backend. */
  runtimeDir: string;
  footprint: WinFootprintOptions;
  /** The session's owner record; a copy with the helper process goes into the runtime dir. */
  owner: OwnerRecord;
  recordResource(kind: string, id: string): Promise<void>;
  onExitCleanup?(argv: string[]): void;
  /** Start time of a PID in the format of `owner.json` process ids. */
  processProbe: ProcessProbe;
  /** `%SystemRoot%\System32\taskkill.exe`. */
  taskkill: string;
  /** Foreground window before the helper started, and the probe for after; absent when the check is off (tests). */
  foreground?: { before: ForegroundWindow; probe(signal: AbortSignal): Promise<ProbeOutcome> };
  sync?: SyncSummary;
  readyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  exitWaitMs?: number;
  killWaitMs?: number;
  /** How long `verifyAfterStart` waits for the session record (it is written before READY). Default 5 s. */
  recordWaitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class LocalWindowsSession extends HelperSession {
  readonly #win: LocalWindowsSessionOptions;
  /** `<pid>:<start time>` of the helper process the client spawned. */
  #helperId?: string;
  #recorded?: Promise<void>;
  #record?: WinSessionRecord;

  constructor(options: LocalWindowsSessionOptions) {
    const forbidden = forbiddenLocalHelperEnv(options.env);
    if (forbidden.length > 0) throw new SessionError("ISOLATION", `refusing to start the helper with ${forbidden.join(", ")} in its environment`);
    super({
      id: options.id,
      backend: options.backend,
      packageVersion: options.packageVersion,
      workspacePath: options.workspacePath,
      ...(options.workspaceDescription ? { workspaceDescription: options.workspaceDescription } : {}),
      ...(options.warnings?.length ? { warnings: options.warnings } : {}),
      onLog: options.onLog,
      ...(options.sync ? { sync: options.sync } : {}),
      // Every start compiles the helper with Add-Type (twice when it drops elevation), so the 10 s default is too short.
      readyTimeoutMs: options.readyTimeoutMs ?? 45_000,
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.exitWaitMs !== undefined ? { exitWaitMs: options.exitWaitMs } : {}),
      ...(options.killWaitMs !== undefined ? { killWaitMs: options.killWaitMs } : {}),
      labels: { launcher: "the Windows GUI helper", target: "the Windows GUI helper", inside: "on the private desktop", stillRunning: "Windows GUI helper still running" },
      hooks: {
        spawn: (env) => this.#spawn(env),
        verifyAfterStart: (signal) => this.#verify(signal),
        teardown: () => this.#teardown(),
        audit: () => auditRuntimeDir(this.#win.runtimeDir, this.#win.footprint),
      },
    });
    this.#win = options;
  }

  /** The runtime dir (`PI_GUI_RUNTIME_DIR`). */
  get runtimeDir(): string {
    return this.#win.runtimeDir;
  }

  /** The private desktop's name, once verified. */
  get desktop(): string | undefined {
    return this.#record?.desktop;
  }

  /**
   * Isolation assertion of the smoke test (spec §5.5): the user's foreground
   * window now, compared with the one before the helper started.
   */
  async foregroundUnchanged(signal: AbortSignal): Promise<{ ok: boolean; observed: string }> {
    const check = this.#win.foreground;
    if (!check) return { ok: true, observed: "foreground check disabled" };
    const after = foregroundOf(await check.probe(signal));
    if (!after) return { ok: false, observed: "the foreground window could not be read" };
    const ok = after.hwnd === check.before.hwnd;
    return { ok, observed: ok ? `foreground unchanged (${describe(after)})` : `foreground changed from ${describe(check.before)} to ${describe(after)}` };
  }

  /** `taskkill /T /F` of the helper process tree; the helper's jobs then end every app. `[]` once it exited. */
  forceRemoveArgv(): string[] {
    const pid = this.helperPid;
    return pid !== undefined && this.processRunning ? [this.#win.taskkill, "/PID", String(pid), "/T", "/F"] : [];
  }

  #spawn(tokenEnv: Record<string, string>) {
    const child = this.#win.spawner.spawn(this.#win.argv, { env: { ...this.#win.env, ...tokenEnv }, cwd: this.#win.cwd });
    const pid = child.pid;
    if (pid !== undefined) {
      // A process id needs the process: record it right after the spawn, before READY can arrive.
      this.#recorded = (async () => {
        const start = this.#win.processProbe.startTime(pid);
        if (!start) throw new Error(`cannot read the start time of process ${pid}`);
        this.#helperId = `${pid}:${start}`;
        await this.#win.recordResource("process", this.#helperId);
        // The runtime dir's owner copy lists it too, so the generic sweep of a dead owner ends it.
        await writeRuntimeOwner(this.#win.footprint.fs, this.#win.runtimeDir, {
          ...this.#win.owner,
          resources: [...this.#win.owner.resources, { kind: "tempdir", id: this.#win.runtimeDir }, { kind: "process", id: this.#helperId }],
        });
      })();
      this.#recorded.catch(() => {});
      this.#win.onExitCleanup?.([this.#win.taskkill, "/PID", String(pid), "/T", "/F"]);
    }
    return child;
  }

  async #verify(signal: AbortSignal): Promise<void> {
    if (!this.#recorded) throw new SessionError("START_FAILED", "the Windows GUI helper has no process id");
    try {
      await this.#recorded;
    } catch (error) {
      throw new SessionError("START_FAILED", `could not record the Windows GUI helper process: ${(error as Error).message}`);
    }
    const capabilities = this.capabilities;
    const problems: string[] = [];
    if (!capabilities.includes("desktop-private")) problems.push("the helper does not report a private desktop");
    if (capabilities.includes("desktop-interactive")) problems.push("the helper reports the interactive desktop");
    if (capabilities.includes("exec")) problems.push("the helper allows exec, which local-windows never enables");
    if (problems.length > 0) throw new SessionError("ISOLATION", `the Windows helper breaks the isolation rules (${problems.join("; ")}); the session was stopped`);

    const deadline = Date.now() + (this.#win.recordWaitMs ?? 5_000);
    let read = await readSessionRecord(this.#win.footprint.fs, this.#win.runtimeDir);
    while (read.state === "missing" && Date.now() < deadline && !signal.aborted) {
      await sleep(100);
      read = await readSessionRecord(this.#win.footprint.fs, this.#win.runtimeDir);
    }
    if (read.state !== "ok") {
      const why = read.state === "missing" ? "was not written" : read.problem;
      throw new SessionError("ISOLATION", `the helper's session record ${win32.join(this.#win.runtimeDir, "session.json")} ${why}; the session was stopped`);
    }
    if (read.record.status !== "running") throw new SessionError("ISOLATION", "the helper's session record says it already stopped; the session was stopped");
    this.#record = read.record;
    await this.#win.recordResource("desktop", read.record.desktop);

    if (this.#win.foreground) {
      const result = await this.foregroundUnchanged(signal);
      if (!result.ok) {
        throw new SessionError(
          "ISOLATION",
          `the user's foreground window changed while the helper started (${result.observed}); the session was stopped. If you switched windows yourself, start it again`,
        );
      }
    }
  }

  /** After the helper exited: end whatever its record still names and remove the runtime dir. */
  async #teardown(): Promise<Leftover[]> {
    if (this.processRunning) return [{ kind: "process", id: this.#helperId ?? String(this.helperPid ?? "?"), detail: "Windows GUI helper did not exit" }];
    return cleanupRuntimeDir(this.#win.runtimeDir, this.#win.footprint);
  }
}

