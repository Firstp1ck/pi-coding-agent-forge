/**
 * One `cua` session (spec §4.3, §6, §7a): one cloud sandbox, the Linux helper
 * deployed into it, and the helper's stdio carried by `cua sandbox exec -i`.
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

/** Guest directory of every session dir (`<root>/<sessionId>`); removed whenever a kept sandbox is reused. */
export const GUEST_ROOT = "/tmp/pi-gui-testing";

/** Guest directory of one session: the helper under `tools/`, the synced project under `workspace/`. */
export function guestDir(sessionId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId)) throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
  return `${GUEST_ROOT}/${sessionId}`;
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
}

/**
 * The sandbox of one session. `remove()` is idempotent and retryable: once a
 * deletion is confirmed (or the sandbox was kept) later calls return `[]`.
 */
export class SandboxHandle {
  readonly ref: string;
  readonly name: string;
  readonly #o: SandboxHandleOptions;
  /** Set once `sandbox create` returned; until then a kept sandbox cannot exist and every path deletes. */
  #created = false;
  #done = false;

  constructor(options: SandboxHandleOptions) {
    this.#o = options;
    this.ref = options.ref;
    this.name = options.name;
  }

  /** `true` when a stop keeps the sandbox: `keepSandbox` and the sandbox was created. */
  get keeps(): boolean {
    return this.#o.keep && this.#created;
  }

  markCreated(): void {
    this.#created = true;
  }

  /** Argv for the synchronous exit handler; `[]` when the sandbox is kept or already removed. */
  forceRemoveArgv(): string[] {
    return this.keeps || this.#done ? [] : this.#o.api.forceDeleteArgv(this.ref);
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
      const dir = guestDir(this.#o.sessionId);
      const leftovers: Leftover[] = [];
      try {
        const result = await api.exec(this.ref, ["rm", "-rf", "--", dir], { timeoutMs: 60_000 });
        if (result.exitCode !== 0) leftovers.push({ kind: "sandbox-dir", id: `${this.ref}:${dir}`, detail: `kept sandbox: removing the session dir failed (exit ${result.exitCode}): ${redact(result.stderr.trim())}` });
      } catch (error) {
        leftovers.push({ kind: "sandbox-dir", id: `${this.ref}:${dir}`, detail: `kept sandbox: removing the session dir failed: ${redact((error as Error).message)}` });
      }
      if (leftovers.length > 0) return leftovers;
      await ledger.markKept(this.name, this.#o.sessionId).catch(() => undefined);
      // The kept sandbox keeps billing (tracked per sandbox until it is deleted); only this session's share ends.
      cost.release(this.#o.sessionId);
      this.#done = true;
      return [];
    }
    try {
      await ledger.update(this.name, { phase: "deleting" }).catch(() => undefined);
      await api.deleteSandbox(this.ref);
    } catch (error) {
      return [{ kind: "sandbox", id: this.ref, detail: `delete failed (it may keep billing; /gui-cleanup retries): ${redact((error as Error).message)}` }];
    }
    cost.stop(this.#o.sessionId);
    await ledger.remove(this.name).catch(() => undefined);
    this.#done = true;
    return [];
  }

  /** Read-only: the sandbox if it still exists (unless kept). */
  async audit(): Promise<Leftover[]> {
    if (this.keeps && this.#done) return [];
    try {
      const info = await this.#o.api.getSandbox(this.ref);
      return info ? [{ kind: "sandbox", id: this.ref, detail: `still exists (${info.status})` }] : [];
    } catch (error) {
      return [{ kind: "sandbox", id: this.ref, detail: `audit failed: ${redact((error as Error).message)}` }];
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

export class CuaSession extends HelperSession {
  readonly handle: SandboxHandle;

  constructor(options: CuaSessionOptions) {
    super({
      id: options.id,
      backend: options.backend,
      packageVersion: options.packageVersion,
      workspacePath: `${guestDir(options.id)}/workspace`,
      workspaceDescription: "writable copy uploaded to the sandbox (changes stay there)",
      sync: options.sync,
      onLog: options.onLog,
      // `cua sandbox exec -i` crosses the relay: allow more than the local 10 s for READY.
      readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.exitWaitMs !== undefined ? { exitWaitMs: options.exitWaitMs } : {}),
      ...(options.killWaitMs !== undefined ? { killWaitMs: options.killWaitMs } : {}),
      labels: { launcher: "cua", target: "the Cua sandbox session", inside: "inside the sandbox", stillRunning: "cua sandbox exec still running" },
      hooks: {
        spawn: (env) => options.api.spawnHelper(options.handle.ref, helperArgv(options.id), { ...cuaHelperEnv(options.id), ...env }),
        // The sandbox is deleted after the stream; ending the CLI process ends the guest command too.
        teardown: () => options.handle.remove(),
        audit: () => options.handle.audit(),
        // The CLI's stderr can quote requests and cloud SDK errors: redact it like every other cua output.
        sanitizeDiagnostic: (text) => redact(text),
      },
    });
    this.handle = options.handle;
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
