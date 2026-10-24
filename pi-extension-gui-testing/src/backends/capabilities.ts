/**
 * Optional backend capabilities. The runtime, tools, and commands work with
 * any {@link Backend}; a backend that has more to offer (a base image, drift
 * observation, a reset step, a gated sweep, …) implements the matching
 * interface and is detected with its type guard. Nothing here names a backend.
 */
import type { Backend } from "../backend.ts";
import type { CheckResult } from "../checks/types.ts";
import type { ResolvedConfig } from "../config/types.ts";
import type { Leftover } from "../protocol.ts";
import type { CommandRunner, RunResult } from "../runner/types.ts";

/** Id of the check whose remediation is {@link ImageCapability.buildImage}. */
export const IMAGE_CHECK_ID = "image.base";

/** A backend that runs sessions from a base image it builds itself. */
export interface ImageCapability {
  /** Local tag of the base image for this package version. */
  readonly imageTag: string;
  /** Builds the base image (the {@link IMAGE_CHECK_ID} remediation); `onLine` gets progress lines. */
  buildImage(signal: AbortSignal, onLine?: (line: string) => void): Promise<RunResult>;
  /** `/gui-reset`: removes every base image of this package. Returns what could not be removed. */
  removeBaseImages(signal: AbortSignal): Promise<{ removed: string[]; leftovers: Leftover[] }>;
}

/**
 * A backend that can observe, before each launch, the versions its verified
 * record holds (spec §7). A change blocks new launches; running sessions continue.
 */
export interface DriftCapability {
  /** This package's version as the backend reports it (recorded by the smoke test). */
  readonly version: string;
  /**
   * Current values for the record's keys. A key that cannot be observed now
   * is left out; it is not evidence of drift.
   *
   * @throws Error when the backend is unreachable (the launch is refused).
   */
  currentVersions(signal?: AbortSignal): Promise<Record<string, string>>;
}

/** What `/gui-reset` removes and keeps for a backend, beyond sessions and the verified state. */
export interface ResetCapability {
  /** Confirmation text, e.g. "Stops its sessions and removes its base images, …". */
  readonly resetSummary: string;
  /** Last report line: what setup installed on the system and what stays. */
  readonly resetNote: string;
  /** Removes backend-owned data (images, caches, remote dirs); returns report lines and what could not be removed. */
  resetData?(signal: AbortSignal): Promise<{ lines: string[]; leftovers: Leftover[] }>;
}

export interface SweepContext {
  /** `true` for the automatic sweep at Pi startup, `false` for `/gui-cleanup` and `/gui-reset`. */
  startup: boolean;
}

/**
 * Gate for {@link Backend.sweepOrphans} and {@link Backend.auditOrphans}.
 * Without it the backend is always swept. Must be cheap and side-effect free:
 * no command, no network call (e.g. "is a `docker` executable on PATH").
 */
export interface SweepAvailability {
  sweepAvailable(context: SweepContext): Promise<boolean>;
}

/** Decides from doctor's check results whether the orphan audit can reach the backend. */
export interface OrphanAuditGate {
  orphanAuditReady(results: readonly CheckResult[]): boolean;
}

/** Runs remediation commands of this backend's checks (e.g. on the right Docker endpoint or remote host). */
export interface RunnerCapability {
  readonly runner: CommandRunner;
}

/** How the smoke test (spec §5.5) runs the bundled GTK 3 app on this backend. */
export interface SmokeCapability {
  /** Command, arguments, and working directory (default: the session's workspace) of the smoke app as the helper sees them. */
  smokeApp(): { cmd: string; args: string[]; cwd?: string };
  /** Adjusts the smoke session config (e.g. `workspaceMode: "copy"` where mounts do not exist). */
  smokeConfig?(base: ResolvedConfig): ResolvedConfig;
}

/** A backend with every optional capability it may have. */
export type RuntimeBackend = Backend &
  Partial<ImageCapability & DriftCapability & ResetCapability & SweepAvailability & OrphanAuditGate & RunnerCapability & SmokeCapability>;

const isFunction = (value: unknown): boolean => typeof value === "function";

export function hasImage(backend: Backend): backend is Backend & ImageCapability {
  const b = backend as Partial<ImageCapability>;
  return typeof b.imageTag === "string" && isFunction(b.buildImage) && isFunction(b.removeBaseImages);
}

export function hasDrift(backend: Backend): backend is Backend & DriftCapability {
  const b = backend as Partial<DriftCapability>;
  return typeof b.version === "string" && isFunction(b.currentVersions);
}

export function hasReset(backend: Backend): backend is Backend & ResetCapability {
  const b = backend as Partial<ResetCapability>;
  return typeof b.resetSummary === "string" && typeof b.resetNote === "string" && (b.resetData === undefined || isFunction(b.resetData));
}

export function hasSweepAvailability(backend: Backend): backend is Backend & SweepAvailability {
  return isFunction((backend as Partial<SweepAvailability>).sweepAvailable);
}

export function hasOrphanAuditGate(backend: Backend): backend is Backend & OrphanAuditGate {
  return isFunction((backend as Partial<OrphanAuditGate>).orphanAuditReady);
}

export function hasRunner(backend: Backend): backend is Backend & RunnerCapability {
  const runner = (backend as Partial<RunnerCapability>).runner;
  return typeof runner === "object" && runner !== null && isFunction(runner.run);
}

export function hasSmoke(backend: Backend): backend is Backend & SmokeCapability {
  return isFunction((backend as Partial<SmokeCapability>).smokeApp);
}

/**
 * Whether the backend may be swept now. A backend without the gate is always
 * swept; a gate that throws counts as "no" (nothing runs).
 */
export async function sweepAllowed(backend: Backend, context: SweepContext): Promise<boolean> {
  if (!hasSweepAvailability(backend)) return true;
  return backend.sweepAvailable(context).catch(() => false);
}
