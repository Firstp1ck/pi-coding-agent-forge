/**
 * `/gui-doctor` (spec §5.1): re-runs every check and the smoke test. Never
 * prompts, never remediates, never changes configuration choices. Success
 * refreshes the verified state; failure marks the backend unverified; an
 * aborted run changes nothing.
 */
import type { BackendId, VerifiedBackend } from "../config/types.ts";
import type { CommandRunner } from "../runner/types.ts";
import type { Check } from "../checks/types.ts";
import { requiredChecksPass, runChecks } from "../checks/runner.ts";
import { buildRemediationPlan } from "./plan.ts";
import { collectToolVersions, isAbortError, type SetupReport, type SmokeOutcome } from "./flow.ts";

export interface DoctorInput {
  backend: BackendId;
  checks: Check[];
  runner: CommandRunner;
  projectRoot: string;
  signal: AbortSignal;
  smoke: (signal: AbortSignal) => Promise<SmokeOutcome>;
  /** Refreshes the verified record (success). */
  persist: (record: VerifiedBackend) => Promise<void>;
  /** Removes the verified record (failure). */
  unverify: () => Promise<void>;
  /** Inputs recorded at setup, carried over unchanged. */
  inputs?: Record<string, string>;
  onStatus?: (text: string | undefined) => void;
  now?: () => Date;
}

/**
 * Runs doctor and returns its report. Remediation hints appear in
 * `report.plan` for display only; nothing is applied.
 */
export async function runDoctor(input: DoctorInput): Promise<SetupReport> {
  const started = Date.now();
  const { signal } = input;
  const report: SetupReport = {
    kind: "doctor",
    backend: input.backend,
    status: "failed",
    message: "",
    results: [],
    applied: [],
    manual: [],
    degraded: [],
    durationMs: 0,
  };
  try {
    report.results = await runChecks(input.checks, {
      runner: input.runner,
      backend: input.backend,
      projectRoot: input.projectRoot,
      signal,
      onResult: (r) => input.onStatus?.(`checking ${input.backend}: ${r.id} ${r.status}`),
    });
    if (requiredChecksPass(report.results)) {
      input.onStatus?.(`${input.backend}: running smoke test`);
      try {
        report.smoke = await input.smoke(signal);
        if (report.smoke.ok && report.smoke.leftovers?.length) {
          report.smoke = {
            ...report.smoke,
            ok: false,
            observed: `footprint audit not empty: ${report.smoke.leftovers.map((l) => `${l.kind} ${l.id}`).join(", ")}`,
          };
        }
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        report.smoke = { ok: false, observed: (error as Error)?.message ?? String(error) };
      }
    } else {
      const plan = buildRemediationPlan(report.results, false);
      if (plan.items.length > 0) report.plan = plan;
    }
    if (signal.aborted) throw signal.reason;

    if (report.smoke?.ok) {
      await input.persist({
        verifiedAt: (input.now?.() ?? new Date()).toISOString(),
        toolVersions: collectToolVersions(report.results, report.smoke.facts),
        checksPassed: report.results.filter((r) => r.status === "pass").map((r) => r.id),
        ...(input.inputs ? { inputs: input.inputs } : {}),
      });
      report.status = "verified";
      report.message = `${input.backend} is healthy${report.smoke.arch ? ` (${report.smoke.arch})` : ""}`;
    } else {
      await input.unverify();
      report.message = report.smoke
        ? `smoke test failed: ${report.smoke.observed}; ${input.backend} is marked unverified`
        : `required checks failed; ${input.backend} is marked unverified; run /gui-setup ${input.backend} to fix`;
    }
  } catch (error) {
    if (!isAbortError(error, signal)) throw error;
    report.status = "cancelled";
    report.message = "doctor cancelled; verified state unchanged";
  } finally {
    input.onStatus?.(undefined);
  }
  report.degraded = report.results.filter((r) => r.status === "warn" && r.degrades).map((r) => `${r.id}: ${r.degrades}`);
  report.durationMs = Date.now() - started;
  return report;
}
