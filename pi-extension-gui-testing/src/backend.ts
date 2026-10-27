/**
 * Backend contract. A backend owns its checks, starts isolated sessions, and
 * audits its own footprint. Tools never talk to Docker or a helper directly.
 */
import type { Check } from "./checks/types.ts";
import type { BackendId, ResolvedConfig } from "./config/types.ts";
import type { ErrorCode, Leftover, LogEvent, Method, Params, Result } from "./protocol.ts";

export interface SessionStartOptions {
  sessionId: string;
  /** Absolute project root on the client. */
  projectRoot: string;
  /** Client session temp dir (mode 0700) that already contains `owner.json`. */
  sessionDir: string;
  config: ResolvedConfig;
  /** Value of the `pi-gui-testing.owner` label for every object this session creates. */
  ownerLabel: string;
  /**
   * Called before each resource is created, so `owner.json` lists it first.
   * Must resolve before the backend creates the resource.
   */
  recordResource(kind: string, id: string): Promise<void>;
  onLog(event: LogEvent): void;
  /** Progress text for `ctx.ui.setStatus`. */
  onStatus?(text: string): void;
  signal: AbortSignal;
}

/** Summary of a workspace sync (`copy` mode, remote backends). */
export interface SyncSummary {
  files: number;
  bytes: number;
  excluded: number;
}

export interface Session {
  readonly id: string;
  readonly backend: BackendId;
  /** Target architecture reported by `hello`, e.g. `x86_64`. */
  readonly arch: string;
  readonly sync?: SyncSummary;
  /**
   * Sends one protocol request. Requests other than `ping` and `cancel` run
   * sequentially per session. Rejects with a {@link SessionError} carrying the
   * protocol error code.
   */
  request<M extends Method>(method: M, params: Params<M>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Result<M>>;
  /** Idempotent. Stops the helper and removes this session's resources; returns what could not be removed. */
  stop(): Promise<Leftover[]>;
  /** Read-only audit of this session's resources only (spec §7a.4). */
  auditFootprint(): Promise<Leftover[]>;
}

/** Failure of a session request; `code` is a protocol {@link ErrorCode} or a client-only code such as `CLOSED`. */
export class SessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

export interface Backend {
  readonly id: BackendId;
  /** All checks for this backend, including the common ones. */
  checks(): Check[];
  startSession(options: SessionStartOptions): Promise<Session>;
  /**
   * Read-only audit of orphans: resources of every type whose owner is gone
   * (spec §7a.4). Live owners are exempt.
   */
  auditOrphans(signal: AbortSignal): Promise<Leftover[]>;
  /** Removes the orphans that {@link auditOrphans} reports; returns what could not be removed. */
  sweepOrphans(signal: AbortSignal): Promise<Leftover[]>;
}
