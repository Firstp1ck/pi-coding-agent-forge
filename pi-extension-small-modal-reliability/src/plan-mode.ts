import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskState } from "./types.ts";
import { taskDir } from "./paths.ts";
import { nowIso, readJsonFile, truncate, writeJsonFile } from "./utils.ts";
import { assessTaskCompletion } from "./completion-gate.ts";
import { assertPlanStoragePath } from "./plan-mode-artifacts.ts";
export { readPlanModeArtifact, writePlanModeArtifact } from "./plan-mode-artifacts.ts";

export type PlanModePhase = "explore" | "plan" | "implement" | "summarize" | "verify" | "report" | "complete" | "stopped";

export type PlanModeRun = {
  schema_version: 1;
  run_id: string;
  task_id: string;
  cwd: string;
  goal: string;
  enabled: boolean;
  phase: PlanModePhase;
  created_at: string;
  updated_at: string;
  iteration: number;
  max_iterations: number;
  /** Persisted token prevents duplicate queued continuations across reloads. */
  next_continuation_nonce: number;
  pending_continuation_token?: string;
  artifacts: PlanModeArtifacts;
  last_issue?: string;
};

export type PlanModeArtifacts = {
  dir: string;
  state: string;
  exploration: string;
  plan: string;
  summary: string;
  verification: string;
  failuresDir: string;
  finalReport: string;
};

export type PlanModePointer = {
  enabled: boolean;
  armed: boolean;
  taskId?: string;
  runId?: string;
  updatedAt: string;
};

export type PlanModeProgress = {
  total: number;
  done: number;
  open: number;
  inProgress: number;
  finished: boolean;
  nextOpen?: string;
};

export const PLAN_MODE_CUSTOM_STATE_TYPE = "reliability-plan-mode-state";
export const PLAN_MODE_STATUS_KEY = "reliability-plan-mode";
export const PLAN_MODE_WIDGET_KEY = "reliability-plan-mode";

const MIN_ARTIFACT_CHARS = 80;

export function planModeArtifacts(cwd: string, taskId: string): PlanModeArtifacts {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) throw new Error("Unsafe plan task identity.");
  const dir = join(taskDir(cwd, taskId), "plan-mode");
  return {
    dir,
    state: join(dir, "plan-mode-state.json"),
    exploration: join(dir, "01-exploration.md"),
    plan: join(dir, "02-implementation-plan.md"),
    summary: join(dir, "03-summary.md"),
    verification: join(dir, "04-verification.md"),
    failuresDir: join(dir, "failures"),
    finalReport: join(dir, "05-final-report.md"),
  };
}

export function createPlanModeRun(state: TaskState): PlanModeRun {
  const artifacts = planModeArtifacts(state.cwd, state.task_id);
  assertPlanStoragePath(artifacts.state, true);
  mkdirSync(artifacts.failuresDir, { recursive: true });
  const now = nowIso();
  const run: PlanModeRun = {
    schema_version: 1,
    run_id: state.task_id,
    task_id: state.task_id,
    cwd: state.cwd,
    goal: state.normalized_goal || state.user_goal,
    enabled: true,
    phase: "explore",
    created_at: now,
    updated_at: now,
    iteration: 0,
    max_iterations: 50,
    next_continuation_nonce: 1,
    artifacts,
  };
  ensurePlanModeTemplates(run);
  savePlanModeRun(run);
  return run;
}

export function loadPlanModeRun(cwd: string, taskId: string | undefined): PlanModeRun | undefined {
  if (!taskId) return undefined;
  const statePath = planModeArtifacts(cwd, taskId).state;
  if (!existsSync(statePath)) return undefined;
  assertPlanStoragePath(statePath);
  const loaded = readJsonFile<PlanModeRun>(statePath);
  if (loaded?.schema_version !== 1 || loaded.task_id !== taskId || loaded.run_id !== taskId || loaded.cwd !== cwd
    || typeof loaded.enabled !== "boolean" || !["explore", "plan", "implement", "summarize", "verify", "report", "complete", "stopped"].includes(loaded.phase)
    || !Number.isSafeInteger(loaded.iteration) || loaded.iteration < 0 || loaded.max_iterations !== 50) return undefined;
  return {
    ...loaded,
    next_continuation_nonce: Number.isSafeInteger(loaded.next_continuation_nonce) && loaded.next_continuation_nonce > 0 ? loaded.next_continuation_nonce : 1,
    artifacts: planModeArtifacts(cwd, taskId),
  };
}

export function savePlanModeRun(run: PlanModeRun): void {
  run.updated_at = nowIso();
  assertPlanStoragePath(run.artifacts.state, true);
  assertPlanStoragePath(join(run.artifacts.failuresDir, "failure-1.md"), true);
  writeJsonFile(run.artifacts.state, run);
}

export function planModePointer(run: PlanModeRun | undefined, armed: boolean): PlanModePointer {
  return {
    enabled: Boolean(run?.enabled || armed),
    armed,
    taskId: run?.task_id,
    runId: run?.run_id,
    updatedAt: nowIso(),
  };
}

export function persistPlanModePointer(pi: ExtensionAPI, run: PlanModeRun | undefined, armed: boolean): void {
  pi.appendEntry(PLAN_MODE_CUSTOM_STATE_TYPE, planModePointer(run, armed));
}

export function persistedPlanModePointerFromSession(ctx: ExtensionContext): PlanModePointer | undefined {
  const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: PlanModePointer }>;
  return branch
    .filter((entry) => entry.type === "custom" && entry.customType === PLAN_MODE_CUSTOM_STATE_TYPE)
    .map((entry) => entry.data)
    .filter((data): data is PlanModePointer => !!data && typeof data.enabled === "boolean")
    .at(-1);
}

export function readTextFile(filePath: string): string {
  assertPlanStoragePath(filePath);
  if (!existsSync(filePath)) return "";
  if (lstatSync(filePath).size > 32_768) throw new Error("Plan Markdown exceeds 32768 bytes.");
  return readFileSync(filePath, "utf8");
}

function writeTextFile(filePath: string, content: string): void {
  if (Buffer.byteLength(content, "utf8") + (content.endsWith("\n") ? 0 : 1) > 32_768) throw new Error("Plan Markdown exceeds 32768 bytes.");
  assertPlanStoragePath(filePath, true);
  writeFileSync(filePath, content.endsWith("\n") ? content : `${content}\n`, { encoding: "utf8", mode: 0o600 });
}

function ensureFile(filePath: string, content: string): void {
  if (!existsSync(filePath)) writeTextFile(filePath, content);
}

export function ensurePlanModeTemplates(run: PlanModeRun): void {
  assertPlanStoragePath(run.artifacts.state, true);
  assertPlanStoragePath(join(run.artifacts.failuresDir, "failure-1.md"), true);
  ensureFile(run.artifacts.exploration, [
    "# Plan Mode Exploration",
    "",
    `Run: ${run.run_id}`,
    `Goal: ${run.goal}`,
    "Status: TODO",
    "",
    "## Necessary information",
    "- TBD",
    "",
    "## Files, commands, and docs inspected",
    "- TBD",
    "",
    "## Decisions and constraints discovered",
    "- TBD",
    "",
    "## Risks, unknowns, and assumptions",
    "- TBD",
    "",
    "## Handoff to planning",
    "TBD",
  ].join("\n"));
  ensureFile(run.artifacts.plan, [
    "# Detailed Implementation Plan",
    "",
    `Run: ${run.run_id}`,
    `Goal: ${run.goal}`,
    "Status: TODO",
    "",
    "## Proposed steps",
    "Describe concrete steps here, then submit the canonical structured plan through reliability_set_plan. Markdown status markers are not completion evidence.",
    "",
    "## Step details",
    "TBD",
    "",
    "## Implementation log",
    "- TBD",
    "",
    "## Deviations",
    "- None yet.",
    "",
    "## Verification failures",
    "- None yet.",
  ].join("\n"));
  ensureFile(run.artifacts.summary, [
    "# Plan Mode Implementation Summary",
    "",
    `Run: ${run.run_id}`,
    `Goal: ${run.goal}`,
    "Status: TODO",
  ].join("\n"));
  ensureFile(run.artifacts.verification, [
    "# Plan Mode Verification",
    "",
    `Run: ${run.run_id}`,
    `Goal: ${run.goal}`,
    "Status: TODO",
  ].join("\n"));
  ensureFile(run.artifacts.finalReport, [
    "# Plan Mode Final Report",
    "",
    `Run: ${run.run_id}`,
    `Goal: ${run.goal}`,
    "Status: TODO",
  ].join("\n"));
}

export function artifactReady(filePath: string): boolean {
  const text = readTextFile(filePath).trim();
  if (text.length < MIN_ARTIFACT_CHARS) return false;
  return !/^Status:\s*TODO\s*$/im.test(text);
}

export function extractPlanModeProgress(planMarkdown: string): PlanModeProgress {
  const checkboxPattern = /^\s*-\s*\[([ xX\-])\]\s+(.+)$/gm;
  let total = 0;
  let done = 0;
  let open = 0;
  let inProgress = 0;
  let nextOpen: string | undefined;
  for (const match of planMarkdown.matchAll(checkboxPattern)) {
    total += 1;
    const marker = match[1];
    const text = match[2].trim();
    if (marker === "x" || marker === "X") {
      done += 1;
    } else if (marker === "-") {
      inProgress += 1;
      open += 1;
      nextOpen ??= text;
    } else {
      open += 1;
      nextOpen ??= text;
    }
  }
  return { total, done, open, inProgress, finished: total > 0 && open === 0, nextOpen };
}

export function listPlanModeFailureFiles(run: PlanModeRun): string[] {
  try {
    if (!existsSync(run.artifacts.failuresDir)) return [];
    return readdirSync(run.artifacts.failuresDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(run.artifacts.failuresDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export function unresolvedPlanModeFailureFiles(run: PlanModeRun): string[] {
  return listPlanModeFailureFiles(run).filter((file) => !/^Status:\s*(RESOLVED|PASSED)\s*$/im.test(readTextFile(file)));
}

export function verificationLooksFailed(run: PlanModeRun): boolean {
  const verification = readTextFile(run.artifacts.verification);
  if (/^Status:\s*(FAILED|FAIL|BLOCKED)\s*$/im.test(verification)) return true;
  if (/\b(FAILED|FAILURE|BLOCKED|UNKNOWN)\b/i.test(verification) && !/^Status:\s*PASSED\s*$/im.test(verification)) return true;
  return unresolvedPlanModeFailureFiles(run).length > 0;
}

export function ensureGenericVerificationFailure(run: PlanModeRun, reason: string): string {
  const index = Array.from({ length: 12 }, (_, i) => i + 1).find(i => !existsSync(join(run.artifacts.failuresDir, `failure-${i}.md`)));
  if (!index) throw new Error("Plan mode reached its 12 failure-artifact limit.");
  const failurePath = join(run.artifacts.failuresDir, `failure-${index}.md`);
  writeTextFile(failurePath, [
    "# Verification Failure",
    "",
    "Status: OPEN",
    `Run: ${run.run_id}`,
    `Goal: ${run.goal}`,
    "",
    "## Failure",
    reason,
    "",
    "## Required remediation",
    "- Record the failure in the implementation-plan audit log and submit a canonical plan revision with a reachable remediation step.",
    "- Fix the issue in the retained implementation session.",
    "- Mark this file Status: RESOLVED only after verification evidence passes.",
  ].join("\n"));

  const plan = readTextFile(run.artifacts.plan);
  writeTextFile(run.artifacts.plan, `${plan.trimEnd()}\n\n## Verification remediation\n- ${truncate(reason, 120)}\n- Submit a canonical plan revision with a reachable remediation step; Markdown markers do not advance task state.\n`);
  return failurePath;
}

function promptArtifact(path: string, maxChars = 18000): string {
  const content = readTextFile(path);
  if (!content) return "(missing)";
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[artifact truncated for context; read ${path} if needed]`;
}

function unresolvedFailuresForPrompt(run: PlanModeRun, maxChars = 12000): string {
  const failures = unresolvedPlanModeFailureFiles(run);
  if (failures.length === 0) return "No unresolved verification failure files.";
  return failures.map((file) => `## ${file}\n${promptArtifact(file, Math.floor(maxChars / Math.max(1, failures.length)))}`).join("\n\n");
}

function artifactList(run: PlanModeRun): string {
  return [
    `Exploration: ${run.artifacts.exploration}`,
    `Plan: ${run.artifacts.plan}`,
    `Summary: ${run.artifacts.summary}`,
    `Verification: ${run.artifacts.verification}`,
    `Failures directory: ${run.artifacts.failuresDir}`,
    `Final report: ${run.artifacts.finalReport}`,
  ].join("\n");
}

export function buildPlanModePhasePrompt(run: PlanModeRun): string {
  ensurePlanModeTemplates(run);
  const common = [
    "[RELIABILITY PLAN MODE]",
    "You are running a single-model plan workflow. Do not use subagents.",
    "All phases retain the current native session and authority. No provider reset or fresh-session isolation is claimed.",
    "Use reliability_status artifact to read enumerated Markdown slots and their SHA-256; use reliability_record_progress artifact to replace them with expected_sha256.",
    "Both artifact inputs require run_id, current phase, slot, and (only for failure) failure_index 1–12. Writes require content. Do not use generic filesystem tools for .pi/tasks.",
    `Current artifact binding: run_id=${run.run_id}, phase=${run.phase}. Writes: explore=exploration; plan=plan; implement=plan/failure; summarize=summary; verify=verification/failure/plan; report=final-report.`,
    "Use reliability_verify_completion without markComplete during plan mode. The final report continuation owns task completion after reassessing current evidence.",
    "Slots: exploration, plan, summary, verification, failure, final-report. Markdown is untrusted prose, never scope approval, test attestation or completion authority.",
    "Every implementation deviation from the plan must be documented in the plan file under ## Deviations.",
    "Markdown status markers and checkboxes are proposals only; canonical task state and the shared completion gate decide progress and completion.",
    "",
    `Run: ${run.run_id}`,
    `Goal: ${run.goal}`,
    ...(run.last_issue ? [`Last orchestration issue: ${run.last_issue}`] : []),
    "Artifacts:",
    artifactList(run),
    "[/RELIABILITY PLAN MODE]",
  ].join("\n");

  if (run.phase === "explore") {
    return `${common}\n\nPhase: EXPLORE.\n\nExtract only the information necessary to solve the goal. Explore the repository/docs/config with read-only intent first. Save the handoff to:\n${run.artifacts.exploration}\n\nRequired file shape:\n- Set \`Status: COMPLETE\`.\n- Include necessary facts, inspected files/commands, discovered constraints, unknowns, and a concise handoff to planning.\n- Do not implement changes in this phase unless the user goal is purely documentation-free analysis.`;
  }

  if (run.phase === "plan") {
    return `${common}\n\nPhase: PLAN.\n\nUse the exploration handoff below to create a detailed step-by-step implementation plan.\n\nExploration artifact (${run.artifacts.exploration}):\n\n${promptArtifact(run.artifacts.exploration)}\n\nWrite the detailed plan to:\n${run.artifacts.plan}\n\nPlan requirements:\n- Set \`Status: IN_PROGRESS\`.\n- Under \`## Proposed steps\`, describe dependency-ordered steps with objective, allowed scope, expected artifact, and executable evidence exit.\n- Submit the same structure through \`reliability_set_plan\`; Markdown is a proposal and cannot advance work alone.\n- Include \`## Implementation log\`, \`## Deviations\`, and \`## Verification failures\` sections.\n- Document how each item should be verified.`;
  }

  if (run.phase === "implement") {
    const plan = promptArtifact(run.artifacts.plan);
    return `${common}\n\nPhase: IMPLEMENT ONE STEP.\n\nUse reliability_supervisor_decision to inspect the one canonical current step.\n\nDetailed plan proposal (${run.artifacts.plan}):\n\n${plan}\n\nUnresolved verification failure files:\n\n${unresolvedFailuresForPrompt(run)}\n\nInstructions:\n- Implement only the canonical current step (or the highest-priority unresolved failure if one exists).\n- Complete it only through reliability_record_progress or reliability_submit_worker_result with actual receipts/artifacts required by the step exit condition.\n- Add an entry under \`## Implementation log\` with files changed, commands run, and evidence; it is audit context, not completion authority.\n- If you deviate from the plan, append the deviation and reason under \`## Deviations\`, then submit a validated canonical plan revision if needed.\n- If a failure file is resolved, set its \`Status: RESOLVED\` and cite evidence.\n- Stop after this one step; the extension may launch the next continuation only after canonical state advances.`;
  }

  if (run.phase === "summarize") {
    return `${common}\n\nPhase: SUMMARY.\n\nThe implementation plan shows no open tracked checklist items. Create a concise implementation summary based only on the finished plan file.\n\nPlan artifact (${run.artifacts.plan}):\n\n${promptArtifact(run.artifacts.plan)}\n\nWrite the summary to:\n${run.artifacts.summary}\n\nSummary requirements:\n- Set \`Status: COMPLETE\`.\n- Include goal, implemented changes, files changed, deviations, commands/checks already run, and remaining verification needs.\n- Do not modify implementation files in this phase.`;
  }

  if (run.phase === "verify") {
    return `${common}\n\nPhase: VERIFY.\n\nVerify the implementation based on the summary file in this retained session.\n\nSummary artifact (${run.artifacts.summary}):\n\n${promptArtifact(run.artifacts.summary)}\n\nPlan artifact (${run.artifacts.plan}):\n\n${promptArtifact(run.artifacts.plan, 12000)}\n\nWrite verification results to:\n${run.artifacts.verification}\n\nVerification requirements:\n- Run or inspect whatever is necessary to verify the summary.\n- Set \`Status: PASSED\` only if all relevant checks pass. Set \`Status: FAILED\` if any check fails or required evidence is missing.\n- For each failure, create a separate Markdown file in ${run.artifacts.failuresDir} with \`Status: OPEN\`, failure evidence, suspected affected plan item, and remediation instructions.\n- If verification fails, update ${run.artifacts.plan} with remediation context and submit a canonical plan revision that leaves or creates a reachable pending step. Markdown checkboxes cannot reopen or complete work.\n- Do not report final success to the user from this phase.`;
  }

  if (run.phase === "report") {
    return `${common}\n\nPhase: FINAL REPORT.\n\nVerification passed and no unresolved failure files remain. Create a final report Markdown file, then report to the user.\n\nSummary artifact (${run.artifacts.summary}):\n\n${promptArtifact(run.artifacts.summary)}\n\nVerification artifact (${run.artifacts.verification}):\n\n${promptArtifact(run.artifacts.verification)}\n\nWrite final report to:\n${run.artifacts.finalReport}\n\nFinal response requirements:\n- Set the final report file \`Status: COMPLETE\`.\n- Tell the user what changed, what was verified, where the artifacts are, and any remaining risks.\n- Be concise and grounded in the artifacts.`;
  }

  return `${common}\n\nPlan mode is ${run.phase}. No model action is required.`;
}

export function nextPlanModePhaseAfterAgent(run: PlanModeRun, task?: TaskState): { phase: PlanModePhase; issue?: string; complete?: boolean } {
  ensurePlanModeTemplates(run);
  if (run.phase === "explore") {
    if (!artifactReady(run.artifacts.exploration)) return { phase: "explore", issue: "Exploration artifact is missing or still marked TODO." };
    return { phase: "plan" };
  }
  if (run.phase === "plan") {
    if (!artifactReady(run.artifacts.plan)) return { phase: "plan", issue: "Implementation plan proposal is missing or still marked TODO." };
    if (!task?.plan.length) return { phase: "plan", issue: "A canonical structured plan must be present before implementation." };
    return { phase: "implement" };
  }
  if (run.phase === "implement") {
    if (!task) return { phase: "implement", issue: "Canonical task state is unavailable; Markdown cannot choose the next step." };
    const completed = task.plan.filter((step) => step.status === "complete" || step.status === "skipped").length;
    if (completed === task.plan.length) return { phase: "summarize" };
    if (!task.plan.some((step) => step.status === "pending" || step.status === "in_progress" || step.status === "blocked")) {
      return { phase: "implement", issue: "Canonical plan has no reachable next step; record a blocked outcome or submit a valid plan revision." };
    }
    return { phase: "implement" };
  }
  if (run.phase === "summarize") {
    if (!artifactReady(run.artifacts.summary)) return { phase: "summarize", issue: "Summary artifact is missing or still marked TODO." };
    return { phase: "verify" };
  }
  if (run.phase === "verify") {
    if (!artifactReady(run.artifacts.verification)) return { phase: "verify", issue: "Verification artifact is missing or still marked TODO." };
    if (verificationLooksFailed(run)) {
      const failures = unresolvedPlanModeFailureFiles(run);
      if (failures.length === 0) {
        ensureGenericVerificationFailure(run, "Verification artifact indicates failure or unknown evidence, but no failure file was created.");
      }
      return { phase: "implement", issue: "Verification failed; returning to implementation for remediation." };
    }
    if (!task || assessTaskCompletion(task).decision !== "pass") return { phase: "verify", issue: "Verification Markdown cannot replace current evidence required by the shared completion gate." };
    return { phase: "report" };
  }
  if (run.phase === "report") {
    if (!artifactReady(run.artifacts.finalReport)) return { phase: "report", issue: "Final report artifact is missing or still marked TODO." };
    if (!task || assessTaskCompletion(task, "plan-mode").decision !== "pass") {
      return { phase: "verify", issue: "Plan-mode Markdown artifacts are not completion evidence; the shared completion gate remains unresolved." };
    }
    return { phase: "complete", complete: true };
  }
  return { phase: run.phase, complete: run.phase === "complete" };
}

export function formatPlanModeStatus(run: PlanModeRun | undefined, armed = false): string {
  if (!run) return armed ? "Reliability plan mode: armed for the next user task." : "Reliability plan mode: off.";
  const progress = extractPlanModeProgress(readTextFile(run.artifacts.plan));
  const failures = unresolvedPlanModeFailureFiles(run).length;
  return [
    `Reliability plan mode: ${run.enabled ? "on" : "off"}`,
    `Run: ${run.run_id}`,
    `Goal: ${run.goal}`,
    `Phase: ${run.phase}`,
    `Plan progress: ${progress.done}/${progress.total} done, ${progress.open} open`,
    `Unresolved failures: ${failures}`,
    "Artifacts:",
    artifactList(run),
  ].join("\n");
}

export function updatePlanModeUi(ctx: ExtensionContext, run: PlanModeRun | undefined, armed = false): void {
  if (!run && !armed) {
    ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, undefined);
    ctx.ui.setWidget(PLAN_MODE_WIDGET_KEY, undefined);
    return;
  }
  if (!run) {
    ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, ctx.ui.theme.fg("muted", "Plan armed"));
    ctx.ui.setWidget(PLAN_MODE_WIDGET_KEY, [ctx.ui.theme.fg("dim", "Reliability plan mode armed for next task")]);
    return;
  }
  const progress = extractPlanModeProgress(readTextFile(run.artifacts.plan));
  const failures = unresolvedPlanModeFailureFiles(run).length;
  ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, ctx.ui.theme.fg(failures ? "warning" : "accent", `Plan ${run.phase} ${progress.done}/${progress.total}`));
  ctx.ui.setWidget(PLAN_MODE_WIDGET_KEY, [
    ctx.ui.theme.bold(`Plan mode: ${run.phase}`),
    `Goal: ${truncate(run.goal, 90)}`,
    `Progress: ${progress.done}/${progress.total} done, ${progress.open} open`,
    `Failures: ${failures}`,
    `Plan: ${run.artifacts.plan}`,
  ]);
}
