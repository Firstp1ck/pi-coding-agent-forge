/**
 * Check framework types (spec §5.3). Checks never prompt; remediation runs only
 * after one confirmation or `--fix` (R9).
 */
import type { TargetOs } from "../config/types.ts";
import type { CommandRunner, DockerEndpoint } from "../runner/types.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "blocked";

/** `observe` checks have no side effects; `probe` checks may create only labelled temporary resources and remove them before returning. */
export type CheckKind = "observe" | "probe";

export interface Remediation {
  /** Shown to the user. */
  summary: string;
  /** Exact command, shown before confirmation. Absent when the fix is manual. */
  command?: string[];
  needsSudo?: boolean;
  /** Needs a password or human judgement; never automated, ends setup with `needs-user-action`. */
  manual?: boolean;
  downloadBytes?: number;
  estimatedSeconds?: number;
  /** Bound for running the remediation; defaults to the check timeout. */
  timeoutMs?: number;
}

export interface CheckOutcome {
  status: Exclude<CheckStatus, "blocked">;
  /** The observed value, e.g. `29.9.1` or `unix:///var/run/docker.sock`. */
  observed: string;
  /** Machine-readable values persisted for drift detection (tool versions etc.). */
  facts?: Record<string, string>;
}

export interface CheckResult {
  id: string;
  status: CheckStatus;
  observed: string;
  required: boolean;
  durationMs: number;
  facts?: Record<string, string>;
  remediation?: Remediation;
  degrades?: string;
  /** For `blocked`: the failed dependency ids. */
  blockedBy?: string[];
}

export interface CheckContext {
  runner: CommandRunner;
  /** Aborted when setup is cancelled or the check times out. */
  signal: AbortSignal;
  backend: string;
  /** Results of checks this one depends on, by id. */
  dependencies: ReadonlyMap<string, CheckResult>;
  /** Set once `docker.endpoint` passed; Docker checks must use it. */
  dockerEndpoint?: DockerEndpoint;
  /** Absolute project root. */
  projectRoot: string;
  /** Target OSes requested by `/gui-setup --targets`; checks fall back to the project's `targets` when unset. */
  targets?: readonly TargetOs[];
}

export interface Check {
  /** e.g. `docker.daemon`. Unique per backend. */
  id: string;
  description: string;
  kind: CheckKind;
  /** A dependency that fails or is blocked makes this check `blocked`. */
  dependsOn?: string[];
  /** `false` → a failure is reported as `warn` with {@link degrades}. */
  required: boolean;
  /** Default 15 s. */
  timeoutMs?: number;
  run(ctx: CheckContext): Promise<CheckOutcome>;
  remediation?: Remediation;
  degrades?: string;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 15_000;

/** Overall result of a setup or doctor run. */
export type SetupStatus = "verified" | "failed" | "needs-user-action" | "cancelled";
