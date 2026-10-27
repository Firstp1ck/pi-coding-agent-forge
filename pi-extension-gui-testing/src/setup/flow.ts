/**
 * Setup flow (spec §5.2): checks → one remediation plan → one confirmation (or
 * `--fix`) → re-check → smoke test → persist → one summary. Backend-agnostic:
 * the caller supplies the checks, the smoke test, and persistence.
 */
import type { Leftover } from "../protocol.ts";
import type { BackendId, VerifiedBackend } from "../config/types.ts";
import type { CommandRunner, RunResult } from "../runner/types.ts";
import { DEFAULT_CHECK_TIMEOUT_MS, type Check, type CheckResult, type SetupStatus } from "../checks/types.ts";
import { requiredChecksPass, runChecks } from "../checks/runner.ts";
import { buildRemediationPlan, formatCommand, type PlanItem, type RemediationPlan } from "./plan.ts";
import { MissingInputError, type SetupUi } from "./ui.ts";

/** Result of the backend's smoke test (spec §5.5). */
export interface SmokeOutcome {
  ok: boolean;
  /** What happened, e.g. the failed step. */
  observed: string;
  /** Target architecture from `hello`. */
  arch?: string;
  /** Leftovers from the final footprint audit; non-empty means failure. */
  leftovers?: Leftover[];
  /** Extra values for drift detection (merged into `toolVersions`). */
  facts?: Record<string, string>;
}

export interface AppliedRemediation {
  checkId: string;
  command: string[];
  ok: boolean;
  /** Exit status and output tail on failure. */
  observed: string;
}

/** Everything a setup or doctor run found; rendered by `report.ts`. */
export interface SetupReport {
  kind: "setup" | "doctor";
  backend: BackendId;
  status: SetupStatus;
  /** One-line outcome. */
  message: string;
  /** Final check results (after remediation when it ran). */
  results: CheckResult[];
  /** Results before remediation, when remediation ran. */
  initialResults?: CheckResult[];
  plan?: RemediationPlan;
  applied: AppliedRemediation[];
  /** Plan items the user must do; non-empty with `needs-user-action`. */
  manual: PlanItem[];
  /** Flags that would have replaced a prompt in a no-UI run. */
  missingFlags?: string[];
  smoke?: SmokeOutcome;
  /** Optional capabilities lost, from `warn` results. */
  degraded: string[];
  durationMs: number;
}

export interface SetupFlowInput {
  backend: BackendId;
  checks: Check[];
  runner: CommandRunner;
  ui: SetupUi;
  flags: { fix: boolean; noFix: boolean };
  projectRoot: string;
  /** Setup's own abort signal (session_shutdown, dialog timeout, `/gui-cleanup`). */
  signal: AbortSignal;
  smoke: (signal: AbortSignal) => Promise<SmokeOutcome>;
  /** Persists the verified state; called at most once, only on success and never after abort. */
  persist: (record: VerifiedBackend) => Promise<void>;
  /** Resolved inputs to record (never secrets). */
  inputs?: Record<string, string>;
  /** Runs one approved item. Default: the item's argv through `runner`. */
  applyRemediation?: (item: PlanItem, signal: AbortSignal) => Promise<RunResult>;
  /** Whether `sudo` works without a password. Default: `sudo -n true` via `runner`, only asked when a sudo item exists. */
  passwordlessSudo?: (signal: AbortSignal) => Promise<boolean>;
  now?: () => Date;
}

export const APPLY_ALL = "Apply all fixes";
export const REVIEW_EACH = "Review each fix";
export const CANCEL = "Cancel";

/** Thrown internally to end the flow with a report. */
class Stop {
  readonly status: SetupStatus;
  readonly message: string;
  constructor(status: SetupStatus, message: string) {
    this.status = status;
    this.message = message;
  }
}

/** `true` for errors caused by aborting. */
export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error as Error)?.name === "AbortError";
}

function tail(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** Merges the facts of passing results (and optional extra facts) into a `toolVersions` map. */
export function collectToolVersions(results: readonly CheckResult[], extra?: Record<string, string>): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const r of results) if (r.status === "pass" || r.status === "warn") Object.assign(versions, r.facts);
  return { ...versions, ...extra };
}

function degradedOf(results: readonly CheckResult[]): string[] {
  return results.filter((r) => r.status === "warn" && r.degrades).map((r) => `${r.id}: ${r.degrades}`);
}

function failingRequired(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((r) => r.required && (r.status === "fail" || r.status === "blocked"));
}

async function defaultApply(runner: CommandRunner, item: PlanItem, signal: AbortSignal): Promise<RunResult> {
  return runner.run(item.remediation.command!, {
    timeoutMs: item.remediation.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    signal,
  });
}

async function defaultSudo(runner: CommandRunner, signal: AbortSignal): Promise<boolean> {
  try {
    const result = await runner.run(["sudo", "-n", "true"], { timeoutMs: 5_000, signal });
    return result.exitCode === 0;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

/**
 * Runs the setup flow and returns one report. Never throws for check failures,
 * declines, missing flags, or aborts (status `cancelled`, nothing persisted);
 * throws only for programming errors such as an invalid check graph.
 */
export async function runSetup(input: SetupFlowInput): Promise<SetupReport> {
  const started = Date.now();
  const { signal, ui } = input;
  const report: SetupReport = {
    kind: "setup",
    backend: input.backend,
    status: "failed",
    message: "",
    results: [],
    applied: [],
    manual: [],
    degraded: [],
    durationMs: 0,
  };
  const check = () => {
    if (signal.aborted) throw signal.reason ?? new Error("setup cancelled");
  };
  const checkOptions = {
    runner: input.runner,
    backend: input.backend,
    projectRoot: input.projectRoot,
    signal,
    onResult: (r: CheckResult) => ui.setStatus(`checking ${input.backend}: ${r.id} ${r.status}`),
  };

  try {
    check();
    report.results = await runChecks(input.checks, checkOptions);

    if (!requiredChecksPass(report.results)) {
      const failing = failingRequired(report.results);
      const unfixable = failing.filter((r) => r.status === "fail" && !r.remediation);
      if (unfixable.length > 0) {
        throw new Stop("failed", `required checks failed without an automatic fix: ${unfixable.map((r) => r.id).join(", ")}`);
      }
      const needsSudo = report.results.some((r) => r.remediation?.needsSudo && !r.remediation.manual);
      const sudoOk = needsSudo ? await (input.passwordlessSudo ?? ((s) => defaultSudo(input.runner, s)))(signal) : false;
      check();
      const plan = buildRemediationPlan(report.results, sudoOk);
      report.plan = plan;
      const automated = plan.items.filter((i) => i.automated);
      report.manual = plan.items.filter((i) => !i.automated && i.required);
      if (automated.length === 0 && report.manual.length === 0) {
        throw new Stop("failed", `required checks failed: ${failing.map((r) => r.id).join(", ")}`);
      }

      if (input.flags.noFix) {
        throw new Stop("failed", `required checks failed; --no-fix given, so ${plan.items.length} fix(es) were not applied`);
      }

      const approved = await approve(automated, input);
      check();
      for (const item of approved) {
        ui.setStatus(`fixing ${item.checkId}: ${item.remediation.summary}`);
        const result = await (input.applyRemediation ?? ((i, s) => defaultApply(input.runner, i, s)))(item, signal);
        check();
        const ok = result.exitCode === 0 && !result.timedOut;
        const observed = ok
          ? `exit 0 in ${result.durationMs} ms`
          : `${result.timedOut ? "timed out" : `exit ${result.exitCode ?? result.signal}`}: ${tail(result.stderr || result.stdout)}`;
        report.applied.push({ checkId: item.checkId, command: [...item.remediation.command!], ok, observed });
        if (!ok) throw new Stop("failed", `fix for ${item.checkId} failed (${formatCommand(item.remediation.command!)}): ${observed}`);
      }

      if (report.manual.length > 0) {
        throw new Stop(
          "needs-user-action",
          `${report.manual.length} step(s) need you; do them, then run /gui-setup ${input.backend} again`,
        );
      }

      report.initialResults = report.results;
      report.results = await runChecks(input.checks, checkOptions);
      if (!requiredChecksPass(report.results)) {
        const still = failingRequired(report.results).map((r) => r.id);
        throw new Stop("failed", `required checks still fail after the fixes: ${still.join(", ")}`);
      }
    }

    report.smoke = await runSmoke(input.smoke, signal, ui, input.backend);
    check();
    if (!report.smoke.ok) throw new Stop("failed", `smoke test failed: ${report.smoke.observed}`);

    check();
    await input.persist({
      verifiedAt: (input.now?.() ?? new Date()).toISOString(),
      toolVersions: collectToolVersions(report.results, report.smoke.facts),
      checksPassed: report.results.filter((r) => r.status === "pass").map((r) => r.id),
      ...(input.inputs ? { inputs: input.inputs } : {}),
    });
    report.status = "verified";
    report.message = `${input.backend} is set up and verified${report.smoke.arch ? ` (${report.smoke.arch})` : ""}`;
  } catch (error) {
    if (error instanceof Stop) {
      report.status = error.status;
      report.message = error.message;
    } else if (error instanceof MissingInputError) {
      report.status = "failed";
      report.missingFlags = error.missingFlags;
      report.message = `setup needs a decision but there is no interactive UI; re-run with ${error.missingFlags.join(" or ")}`;
    } else if (isAbortError(error, signal)) {
      report.status = "cancelled";
      report.message = `setup cancelled${error instanceof Error && error.message ? `: ${error.message}` : ""}; nothing was saved`;
    } else {
      throw error;
    }
  } finally {
    ui.setStatus(undefined);
  }
  report.degraded = degradedOf(report.results);
  report.durationMs = Date.now() - started;
  return report;
}

/** Asks once for the whole plan (or uses `--fix`); returns the approved items. */
async function approve(automated: PlanItem[], input: SetupFlowInput): Promise<PlanItem[]> {
  if (automated.length === 0 || input.flags.fix) return automated;
  const { ui } = input;
  const flags = { flags: ["--fix", "--no-fix"] };
  const summary = automated.map((i) => `${i.checkId}: ${i.remediation.summary}${i.remediation.command ? ` ($ ${formatCommand(i.remediation.command)})` : ""}`).join("\n");
  const choice = await ui.select(`Apply ${automated.length} fix(es) for ${input.backend}?\n${summary}`, [APPLY_ALL, REVIEW_EACH, CANCEL], flags);
  if (choice === APPLY_ALL) return automated;
  if (choice !== REVIEW_EACH) throw new Stop("failed", "fixes declined; nothing was changed");
  const approved: PlanItem[] = [];
  for (const item of automated) {
    const command = item.remediation.command ? `\n$ ${formatCommand(item.remediation.command)}` : "";
    if (await ui.confirm(`Fix ${item.checkId}?`, `${item.remediation.summary}${command}`, flags)) approved.push(item);
  }
  if (approved.length === 0) throw new Stop("failed", "all fixes declined; nothing was changed");
  return approved;
}

async function runSmoke(smoke: SetupFlowInput["smoke"], signal: AbortSignal, ui: Pick<SetupUi, "setStatus">, backend: string): Promise<SmokeOutcome> {
  ui.setStatus(`${backend}: running smoke test`);
  try {
    const outcome = await smoke(signal);
    if (outcome.ok && outcome.leftovers && outcome.leftovers.length > 0) {
      return { ...outcome, ok: false, observed: `footprint audit not empty: ${outcome.leftovers.map((l) => `${l.kind} ${l.id}`).join(", ")}` };
    }
    return outcome;
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return { ok: false, observed: (error as Error)?.message ?? String(error) };
  }
}
