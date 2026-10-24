/**
 * One `cua` session (spec §4.3, §6, §7a): one cloud sandbox, the Linux or the
 * Windows helper deployed into it, and the helper's stdio carried by
 * `cua sandbox exec -i`.
 * The protocol side is the generic {@link HelperSession}; the sandbox side is
 * a {@link SandboxHandle} that deletes the sandbox on every stop (or keeps it
 * for `keepSandbox`) and never trusts the helper for that.
 */
import { SessionError, type Session, type SyncSummary } from "../../backend.ts";
import type { BackendId } from "../../config/types.ts";
import type { Leftover, LogEvent } from "../../protocol.ts";
import { HelperSession } from "../../transport/helper-session.ts";
import {
  HELPER_ALLOW_EXEC_ENV,
  HELPER_DEPS_DIR_ENV,
  HELPER_DISPLAY_LOCK_DIR_ENV,
  HELPER_MODE_ENV,
  HELPER_RUNTIME_DIR_ENV,
  HELPER_WORKSPACE_ENV,
} from "../remote/linux-session.ts";
import { CuaApiError, type CuaApi } from "./api.ts";
import type { CuaCostLedger } from "./cost.ts";
import type { SandboxLedger } from "./ledger.ts";
import { redact } from "./redact.ts";
import { powershellArgv, removeDirScript, windowsGuestPaths, windowsHelperArgv, windowsHelperEnv, WINDOWS_GUEST_ROOT, type CuaTarget } from "./windows.ts";

/** Guest directory of every session dir (`<root>/<sessionId>`); removed whenever a kept sandbox is reused. */
export const GUEST_ROOT = "/tmp/pi-gui-testing";

/** Guest directory of one session: the helper under `tools/`, the synced project under `workspace/`. */
export function guestDir(sessionId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId)) throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
  return `${GUEST_ROOT}/${sessionId}`;
}

/** Root of every session dir in a guest of `target`. */
export function guestRoot(target: CuaTarget): string {
  return target === "windows" ? WINDOWS_GUEST_ROOT : GUEST_ROOT;
}

/** Session dir of `sessionId` in a guest of `target`. */
export function targetGuestDir(target: CuaTarget, sessionId: string): string {
  return target === "windows" ? windowsGuestPaths(sessionId).dir : guestDir(sessionId);
}

/** Workspace (launch and `setup` cwd) of `sessionId` in a guest of `target`. */
export function guestWorkspace(target: CuaTarget, sessionId: string): string {
  return target === "windows" ? windowsGuestPaths(sessionId).workspace : `${guestDir(sessionId)}/workspace`;
}

/** Argv that deletes `dir` in a guest of `target` (Windows: without following junctions or symlinks). */
export function removeGuestDirArgv(target: CuaTarget, dir: string): string[] {
  return target === "windows" ? powershellArgv(removeDirScript(dir)) : ["rm", "-rf", "--", dir];
}

/** What `/gui-reset`, the sweep, and teardown time out at per sandbox deletion (ms). */
export const DELETE_TIMEOUT_MS = 5 * 60_000;

export interface SandboxHandleOptions {
  api: CuaApi;
  ledger: SandboxLedger;
  cost: CuaCostLedger;
  sessionId: string;
  name: string;
  ref: string;
  /** `keepSandbox`: a stop keeps the sandbox (and its billing, still counted by the cost ledger) instead of deleting it. */
  keep: boolean;
  /** When set, ledger transitions also require this owner, not just the session id. */
  ownerLabel?: string;
  /** Guest OS, for removing the session dir of a kept sandbox; default `linux`. */
  target?: CuaTarget;
}

/**
 * The sandbox of one session. `remove()` is idempotent and retryable: once a
 * deletion is confirmed (or the sandbox was kept) and its ledger record moved
 * or removed, later calls return `[]`. A ledger transition that fails (e.g.
 * the ledger lock timed out) is a leftover that `audit()` keeps reporting, so
 * the runtime keeps the session and its retry finishes the transition.
 */
export class SandboxHandle {
  readonly ref: string;
  readonly name: string;
  readonly #o: SandboxHandleOptions;
  /** Set once `sandbox create` returned; until then a kept sandbox cannot exist and every path deletes. */
  #created = false;
  /** Keep path: the session dir is gone from the kept sandbox. */
  #dirRemoved = false;
  /** Delete path: the deletion is confirmed. */
  #deleted = false;
  /** A kept sandbox whose record is gone from the ledger is deleted instead: nothing would find, reuse, or clean it up. */
  #deleteInstead = false;
  /** The ledger transition a stop still owes, reported by `audit()` until a retry completes it. */
  #owed: Leftover | undefined;
  #done = false;

  constructor(options: SandboxHandleOptions) {
    this.#o = options;
    this.ref = options.ref;
    this.name = options.name;
  }

  /** `true` when a stop keeps the sandbox: `keepSandbox` and the sandbox was created. */
  get keeps(): boolean {
    return this.#o.keep && this.#created && !this.#deleteInstead;
  }

  markCreated(): void {
    this.#created = true;
  }

  /** Argv for the synchronous exit handler; `[]` when the sandbox is kept or already removed. */
  forceRemoveArgv(): string[] {
    return this.keeps || this.#done || this.#deleted ? [] : this.#o.api.forceDeleteArgv(this.ref);
  }

  /**
   * A kept record a start claimed but does not use (the sandbox was not
   * touched): moves it back to the kept set. Leftovers as for `remove()`,
   * which retries.
   */
  returnToKept(): Promise<Leftover[]> {
    this.#created = true;
    this.#dirRemoved = true;
    return this.remove();
  }

  /** A claimed kept record whose sandbox is confirmed gone: forgets the record. Leftovers as for `remove()`, which retries. */
  forgetGone(): Promise<Leftover[]> {
    this.#deleteInstead = true;
    this.#deleted = true;
    return this.remove();
  }

  /**
   * Deletes the sandbox and its ledger record, or (with `keepSandbox`)
   * removes the session's guest dir and moves the record to the kept set.
   * Returns what is left; never throws.
   */
  async remove(): Promise<Leftover[]> {
    if (this.#done) return [];
    const { api, ledger, cost } = this.#o;
    if (this.keeps) {
      if (!this.#dirRemoved) {
        const target = this.#o.target ?? "linux";
        const dir = targetGuestDir(target, this.#o.sessionId);
        const leftovers: Leftover[] = [];
        try {
          const result = await api.exec(this.ref, removeGuestDirArgv(target, dir), { timeoutMs: 60_000 });
          if (result.exitCode !== 0) leftovers.push({ kind: "sandbox-dir", id: `${this.ref}:${dir}`, detail: `kept sandbox: removing the session dir failed (exit ${result.exitCode}): ${redact(result.stderr.trim())}` });
        } catch (error) {
          leftovers.push({ kind: "sandbox-dir", id: `${this.ref}:${dir}`, detail: `kept sandbox: removing the session dir failed: ${redact((error as Error).message)}` });
        }
        if (leftovers.length > 0) return leftovers;
        this.#dirRemoved = true;
      }
      try {
        if (!(await ledger.markKept(this.name, this.#expect())) && !(await this.#recorded())) this.#deleteInstead = true;
      } catch (error) {
        return this.#owe({
          kind: "sandbox",
          id: this.ref,
          detail: `kept, but moving its ledger record to the kept set failed, so it is not reused or cleaned up yet and keeps billing; gui_stop, /gui-cleanup, or the Pi shutdown retries: ${redact((error as Error).message)}`,
        });
      }
      if (!this.#deleteInstead) {
        // The kept sandbox keeps billing (tracked per sandbox until it is deleted); only this session's share ends.
        cost.release(this.#o.sessionId);
        return this.#finish();
      }
    }
    if (!this.#deleted) {
      try {
        await ledger.update(this.name, { phase: "deleting" }, this.#expect()).catch(() => undefined);
        await api.deleteSandbox(this.ref);
      } catch (error) {
        return [{ kind: "sandbox", id: this.ref, detail: `delete failed (it may keep billing; /gui-cleanup retries): ${redact((error as Error).message)}` }];
      }
      cost.stop(this.#o.sessionId);
      this.#deleted = true;
    }
    try {
      await ledger.remove(this.name, false, this.#expect());
    } catch (error) {
      return this.#owe({ kind: "ledger", id: this.ref, detail: `sandbox deleted, but removing its ledger record failed; gui_stop, /gui-cleanup, or the Pi shutdown retries: ${redact((error as Error).message)}` });
    }
    return this.#finish();
  }

  /** The record state every ledger transition of this handle requires: this session, and the owner when known. */
  #expect(): { sessionId: string; ownerLabel?: string } {
    return this.#o.ownerLabel === undefined ? { sessionId: this.#o.sessionId } : { sessionId: this.#o.sessionId, ownerLabel: this.#o.ownerLabel };
  }

  /** Is a record of this sandbox (active or kept, or unreadable) still in the ledger? One locked read. */
  async #recorded(): Promise<boolean> {
    return this.#o.ledger.recorded(this.name);
  }

  #owe(leftover: Leftover): Leftover[] {
    this.#owed = leftover;
    return [leftover];
  }

  #finish(): Leftover[] {
    this.#owed = undefined;
    this.#done = true;
    return [];
  }

  /** Read-only: the sandbox if it still exists (unless kept), and any ledger transition a stop still owes. */
  async audit(): Promise<Leftover[]> {
    const owed = this.#owed ? [this.#owed] : [];
    if (this.keeps && (this.#done || this.#dirRemoved)) return owed;
    try {
      const info = await this.#o.api.getSandbox(this.ref);
      return [...owed, ...(info ? [{ kind: "sandbox", id: this.ref, detail: `still exists (${info.status})` }] : [])];
    } catch (error) {
      return [...owed, { kind: "sandbox", id: this.ref, detail: `audit failed: ${redact((error as Error).message)}` }];
    }
  }
}

/**
 * The session handle of a start that failed before the helper ran (create,
 * deploy, or sync failed): its `stop()` removes the sandbox, so
 * `stopAfterFailedStart` and the runtime can retry like any other session.
 */
export function pendingSession(id: string, backend: BackendId, handle: SandboxHandle): Session {
  return {
    id,
    backend,
    arch: "unknown",
    request: () => Promise.reject(new SessionError("CLOSED", `session ${id} is stopped`)),
    stop: () => handle.remove(),
    auditFootprint: () => handle.audit(),
    forceRemoveArgv: () => handle.forceRemoveArgv(),
  };
}

export interface CuaSessionOptions {
  id: string;
  backend: BackendId;
  api: CuaApi;
  handle: SandboxHandle;
  packageVersion: string;
  sync: SyncSummary;
  onLog(event: LogEvent): void;
  /** `Session.warnings` (e.g. kept sandboxes that were not reused). */
  warnings?: readonly string[];
  /** Guest OS: which helper runs and how it gets its environment; default `linux`. */
  target?: CuaTarget;
  readyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  exitWaitMs?: number;
  killWaitMs?: number;
}

/**
 * Host-mode environment of the helper in the sandbox (the contract of
 * `helpers/linux/pi_gui_helper/hostmode.py`, as for remote-linux): it runs as
 * the sandbox user with its runtime files, display locks, and `setup`
 * installs (`PIP_TARGET`, npm prefix below `deps/`) in dirs it owns, so no
 * writable `/deps` and no `python3-venv` are needed. `setup` runs through `exec`.
 */
export function cuaHelperEnv(sessionId: string): Record<string, string> {
  const dir = guestDir(sessionId);
  return {
    [HELPER_MODE_ENV]: "host",
    [HELPER_WORKSPACE_ENV]: `${dir}/workspace`,
    [HELPER_RUNTIME_DIR_ENV]: `${dir}/run`,
    [HELPER_DISPLAY_LOCK_DIR_ENV]: `${GUEST_ROOT}/displays`,
    [HELPER_ALLOW_EXEC_ENV]: "1",
    [HELPER_DEPS_DIR_ENV]: `${dir}/deps`,
  };
}

/** The helper's argv in the guest (`python3 -I`, so neither PYTHONPATH nor the cwd injects modules). */
export function helperArgv(sessionId: string): string[] {
  return ["python3", "-I", `${guestDir(sessionId)}/tools/helper`];
}

/**
 * `READY` timeout of a Windows guest: `cua sandbox exec -i` crosses the relay,
 * and the Windows helper compiles its C# sources with `Add-Type` before it is
 * ready (twice when it relaunches itself).
 */
export const WINDOWS_READY_TIMEOUT_MS = 180_000;

/** Fails the start unless `hello` came from the Windows helper (the image of a Windows target may be anything). */
function requireWindowsHelper(session: HelperSession): void {
  if (!/^Windows /.test(session.platform ?? "")) {
    throw new SessionError("START_FAILED", `the sandbox did not start the Windows helper (it reported ${JSON.stringify(session.platform ?? "no platform")}); check the Windows image chosen at /gui-setup cua`);
  }
}

export class CuaSession extends HelperSession {
  readonly handle: SandboxHandle;
  readonly target: CuaTarget;

  constructor(options: CuaSessionOptions) {
    const windows = options.target === "windows";
    let self: CuaSession | undefined;
    super({
      id: options.id,
      backend: options.backend,
      packageVersion: options.packageVersion,
      workspacePath: guestWorkspace(options.target ?? "linux", options.id),
      workspaceDescription: "writable copy uploaded to the sandbox (changes stay there)",
      sync: options.sync,
      onLog: options.onLog,
      ...(options.warnings?.length ? { warnings: options.warnings } : {}),
      // `cua sandbox exec -i` crosses the relay: allow more than the local 10 s for READY.
      readyTimeoutMs: options.readyTimeoutMs ?? (windows ? WINDOWS_READY_TIMEOUT_MS : 60_000),
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.exitWaitMs !== undefined ? { exitWaitMs: options.exitWaitMs } : {}),
      ...(options.killWaitMs !== undefined ? { killWaitMs: options.killWaitMs } : {}),
      labels: { launcher: "cua", target: "the Cua sandbox session", inside: "inside the sandbox", stillRunning: "cua sandbox exec still running" },
      hooks: {
        spawn: windows
          ? (env) => options.api.spawnHelper(options.handle.ref, windowsHelperArgv(options.id), { ...windowsHelperEnv(options.id), ...env }, { stdinEnv: "powershell" })
          : (env) => options.api.spawnHelper(options.handle.ref, helperArgv(options.id), { ...cuaHelperEnv(options.id), ...env }),
        ...(windows ? { verifyAfterStart: async () => requireWindowsHelper(self as CuaSession) } : {}),
        // The sandbox is deleted after the stream; ending the CLI process ends the guest command too.
        teardown: () => options.handle.remove(),
        audit: () => options.handle.audit(),
        // The CLI's stderr can quote requests and cloud SDK errors: redact it like every other cua output.
        sanitizeDiagnostic: (text) => redact(text),
      },
    });
    self = this;
    this.handle = options.handle;
    this.target = options.target ?? "linux";
  }

  forceRemoveArgv(): string[] {
    return this.handle.forceRemoveArgv();
  }
}

/** Maps an API failure to a session start error with a stable code. */
export function startError(stage: string, error: unknown): SessionError {
  if (error instanceof SessionError) return error;
  if (error instanceof CuaApiError) {
    const code = error.code === "CANCELLED" ? "CANCELLED" : error.code === "AUTH" ? "AUTH" : "START_FAILED";
    return new SessionError(code, `${stage}: ${error.message}`);
  }
  if ((error as Error)?.name === "AbortError") return new SessionError("CANCELLED", `${stage}: cancelled`);
  return new SessionError("START_FAILED", `${stage}: ${redact((error as Error)?.message ?? String(error))}`);
}
