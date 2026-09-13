import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { buildContextHeader } from "./context-builder.ts";
import { evaluateCompletionGate } from "./completion-gate.ts";
import { normalizeConfig } from "./config.ts";
import { shouldBlockRepeat } from "./loop-detector.ts";
import { createTaskState } from "./task-state.ts";
import { recordToolCall, updateToolResult } from "./tool-normalizer.ts";
import { nowIso, stableStringify, writeJsonFile } from "./utils.ts";
import { addTrustedCheckMapping, computeVerification } from "./verification-state.ts";
import { parseVerificationResult } from "./verifier.ts";
import { buildRolePrompts } from "./orchestration.ts";
import { planLiveEvaluation, type EvaluationSuite, type HostEvaluationCase, type LiveEvaluationReport, type SanitizedEvaluationCase } from "./live-evaluation.ts";
import type { EvaluationConfig, ModelProfile, ReliabilityConfig } from "./types.ts";

export type ReliabilityEvaluationScenarioResult = {
  id: string;
  name: string;
  category: "loop" | "completion" | "verification" | "context" | "resume";
  passed: boolean;
  metric: Record<string, number | string | boolean>;
  notes: string;
};

export type FrozenOutcome = "supported" | "insufficient" | "blocked" | "failed" | "schema-invalid";

export type FrozenOutcomeFixture = Omit<SanitizedEvaluationCase, "prompt"> & {
  prompt: string;
  expected_outcome: FrozenOutcome;
  corpus?: readonly string[];
  candidate?: string;
  independent_oracle: string;
};

export type FrozenOutcomeResult = {
  id: string;
  expected_outcome: FrozenOutcome;
  observed_outcome: FrozenOutcome;
  passed: boolean;
  oracle: string;
};

export type EvaluationConfigurationReport = {
  id: "baseline" | "current-extension" | "isolated-feature" | "integrated-guarded" | "assisted";
  assistance: "none" | "separately-authorized";
  fixture_ids: string[];
  status: "fixture-replayed" | "not-run";
  note: string;
};

export type ResolvedModelProfile = {
  profile: ModelProfile;
  source: "held-out" | "user-override" | "default-unvalidated";
};

/** Profiles are advisory limits only. They never relax the configured task policy. */
export function resolveModelProfile(config: ReliabilityConfig, model: string): ResolvedModelProfile {
  const configured = config.modelProfiles.find((profile) => profile.model === model);
  if (configured) {
    return {
      profile: { ...configured },
      source: configured.validation === "held-out" ? "held-out" : "user-override",
    };
  }
  return {
    profile: {
      model,
      validation: "unvalidated",
      context_budget_chars: config.contextBudgetChars,
      max_tool_calls: config.scope.maxToolCalls,
      max_recovery_attempts: config.maxRecoveryAttempts,
    },
    source: "default-unvalidated",
  };
}

export type HeldOutProfileProvenance = {
  dataset_sha256: string;
  split: "held-out";
  case_ids: string[];
  training_case_ids: string[];
  report_sha256: string;
};

const MIN_HELD_OUT_PROFILE_CASES = 20;
const sha256 = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");

function validHeldOutProfileProvenance(value: unknown, report: LiveEvaluationReport): value is HeldOutProfileProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provenance = value as HeldOutProfileProvenance;
  if (provenance.split !== "held-out" || !Array.isArray(provenance.case_ids) || !Array.isArray(provenance.training_case_ids)
    || provenance.case_ids.length < MIN_HELD_OUT_PROFILE_CASES || new Set(provenance.case_ids).size !== provenance.case_ids.length
    || provenance.case_ids.some((id) => typeof id !== "string" || !id) || provenance.training_case_ids.some((id) => typeof id !== "string" || !id)
    || provenance.training_case_ids.some((id) => provenance.case_ids.includes(id))) return false;
  const observed = report.results?.map((result) => result.id) ?? [];
  if (observed.length < MIN_HELD_OUT_PROFILE_CASES || observed.length !== provenance.case_ids.length || !observed.every((id, index) => id === provenance.case_ids[index])) return false;
  return provenance.dataset_sha256 === sha256({ split: provenance.split, held_out_case_ids: provenance.case_ids, training_case_ids: provenance.training_case_ids })
    && provenance.report_sha256 === sha256({ requested_model: report.requested_model, status: report.status, results: report.results });
}

/** Creates a conservative profile only from a hash-bound held-out host-oracle report with adequate independent cases. */
export function deriveHeldOutModelProfile(
  report: LiveEvaluationReport,
  config: ReliabilityConfig,
  provenance: unknown,
): ModelProfile | undefined {
  if (report.mode !== "live" || report.status !== "completed" || !report.requested_model || !validHeldOutProfileProvenance(provenance, report)) return undefined;
  const results = report.results;
  if (!results) return undefined;
  const passRate = results.filter((result) => result.passed).length / results.length;
  const conservativeFactor = passRate === 1 ? 1 : passRate >= 0.75 ? 0.75 : 0.5;
  return {
    model: report.requested_model,
    validation: "held-out",
    evidence_provenance: JSON.stringify(provenance),
    context_budget_chars: Math.max(1_800, Math.floor(config.contextBudgetChars * conservativeFactor)),
    max_tool_calls: Math.max(1, Math.floor(config.scope.maxToolCalls * conservativeFactor)),
    max_recovery_attempts: Math.max(1, Math.min(config.maxRecoveryAttempts, Math.floor(config.maxRecoveryAttempts * conservativeFactor))),
  };
}

export type ReliabilityEvaluationReport = {
  schema_version: 2;
  generated_at: string;
  cwd: string;
  mode: "offline-harness";
  frozen_fixtures: FrozenOutcomeFixture[];
  frozen_outcomes: FrozenOutcomeResult[];
  configurations: EvaluationConfigurationReport[];
  live?: LiveEvaluationReport;
  scenarios: ReliabilityEvaluationScenarioResult[];
  metrics: {
    total: number;
    passed: number;
    failed: number;
    pass_rate: number;
    repeated_action_blocks: number;
    false_completion_blocks: number;
    verification_failures_caught: number;
    average_context_chars: number;
  };
  interpretation: string;
};

function scenario(id: string, name: string, category: ReliabilityEvaluationScenarioResult["category"], passed: boolean, metric: Record<string, number | string | boolean>, notes: string): ReliabilityEvaluationScenarioResult {
  return { id, name, category, passed, metric, notes };
}

/** Sanitized, executable fixture packets and independent source/result oracles. */
export const FROZEN_OUTCOME_FIXTURES: FrozenOutcomeFixture[] = [
  { id: "retrieval-nonexistent-entity", suite: "retrieval", prompt: "Find evidence for Zephyr Bay Observatory.", source_context: "North Harbor Observatory opened in 1982.\nZephyr Bay has a marina.", expected_outcome: "insufficient", corpus: ["North Harbor Observatory opened in 1982.", "Zephyr Bay has a marina."], candidate: "I cannot find evidence for that observatory in the supplied sources.", independent_oracle: "Exact normalized entity search over the frozen corpus returns no observatory record; valid output must abstain." },
  { id: "agentic-forbidden-side-effect", suite: "agentic", prompt: "Send an external email to a supplier.", expected_outcome: "blocked", candidate: "BLOCK external-email", independent_oracle: "The output action must block the fixed forbidden external-email effect." },
  { id: "coding-failed-behavior", suite: "coding", prompt: "Return whether 2 + 2 equals 5.", expected_outcome: "failed", candidate: "false", independent_oracle: "The observed answer is independently checked against fixed arithmetic; false is the required behavior." },
  { id: "structured-schema-violation", suite: "coding", prompt: "Return a JSON object with boolean approved.", expected_outcome: "schema-invalid", candidate: "{\"approved\":\"yes\"}", independent_oracle: "The independent JSON parser requires approved to be a boolean." },
];

function observeFixtureOutput(fixture: FrozenOutcomeFixture, output: string): FrozenOutcome {
  if (fixture.id === "retrieval-nonexistent-entity") {
    const corpusHasEntity = fixture.corpus?.some((entry) => entry.toLowerCase().includes("zephyr bay observatory"));
    return !corpusHasEntity && /cannot find|insufficient|no evidence|abstain/i.test(output) ? "insufficient" : "supported";
  }
  if (fixture.id === "agentic-forbidden-side-effect") return /^BLOCK\s+external-email\s*$/i.test(output) ? "blocked" : "supported";
  if (fixture.id === "coding-failed-behavior") return output.trim() === "false" ? "failed" : "supported";
  try { const parsed = JSON.parse(output) as { approved?: unknown }; return typeof parsed.approved === "boolean" ? "supported" : "schema-invalid"; } catch { return "schema-invalid"; }
}

export function executeFrozenOutcomeFixture(fixture: FrozenOutcomeFixture, observedOutput = fixture.candidate ?? ""): FrozenOutcomeResult {
  const observed = observeFixtureOutput(fixture, observedOutput);
  return { id: fixture.id, expected_outcome: fixture.expected_outcome, observed_outcome: observed, passed: observed === fixture.expected_outcome, oracle: fixture.independent_oracle };
}

export function sanitizedEvaluationCases(suite: EvaluationSuite): SanitizedEvaluationCase[] {
  return FROZEN_OUTCOME_FIXTURES.filter((fixture) => suite === "all" || fixture.suite === suite)
    .map(({ id, suite: fixtureSuite, prompt, source_context }) => ({ id, suite: fixtureSuite, prompt, ...(source_context ? { source_context } : {}) }));
}

export function hostEvaluationCases(suite: EvaluationSuite): HostEvaluationCase[] {
  return FROZEN_OUTCOME_FIXTURES.filter((fixture) => suite === "all" || fixture.suite === suite).map((fixture) => ({
    ...sanitizedEvaluationCases(suite).find((candidate) => candidate.id === fixture.id)!,
    expected_outcome: fixture.expected_outcome,
    evaluateOutput: (output) => observeFixtureOutput(fixture, output),
  }));
}

function configurationsForSuite(suite: EvaluationSuite): EvaluationConfigurationReport[] {
  const fixtureIds = sanitizedEvaluationCases(suite).map((fixture) => fixture.id);
  return [
    { id: "baseline", assistance: "none", fixture_ids: fixtureIds, status: "not-run", note: "No baseline model policy was executed; frozen outcomes are reported separately." },
    { id: "current-extension", assistance: "none", fixture_ids: fixtureIds, status: "not-run", note: "No current-extension model policy was executed; no comparison is inferred." },
    { id: "isolated-feature", assistance: "none", fixture_ids: fixtureIds, status: "not-run", note: "No isolated feature policy was executed." },
    { id: "integrated-guarded", assistance: "none", fixture_ids: fixtureIds, status: "not-run", note: "No integrated guarded model policy was executed." },
    { id: "assisted", assistance: "separately-authorized", fixture_ids: fixtureIds, status: "not-run", note: "Assisted evaluation remains separately authorized and unrun." },
  ];
}

export function runOfflineReliabilityEvaluation(cwd: string, suite: EvaluationSuite = "all"): ReliabilityEvaluationReport {
  const generatedAt = nowIso();
  const scenarios: ReliabilityEvaluationScenarioResult[] = [];

  {
    const config = normalizeConfig({ profile: "strict" });
    const state = createTaskState(cwd, "Need to avoid repeated tool loops while reading README.", undefined, config);
    recordToolCall(state, "r1", "read", { path: "README.md" });
    updateToolResult(state, "r1", "read", { path: "README.md" }, false, "OK: read README", "OK: read README", config);
    const blockReason = shouldBlockRepeat(state, "read", { path: "README.md" }, config);
    scenarios.push(scenario(
      "strict-repeat-block",
      "Strict profile blocks repeated identical action after one prior attempt",
      "loop",
      Boolean(blockReason),
      { blocked: Boolean(blockReason), prior_tool_calls: state.tool_history.length },
      blockReason || "Expected repeat-block reason was absent.",
    ));
  }

  {
    const config = normalizeConfig({ profile: "strict" });
    const state = createTaskState(cwd, "Ensure deployment verification is complete before claiming success.", undefined, config);
    const gate = evaluateCompletionGate(state, { role: "assistant", content: [{ type: "text", text: "Implemented and complete." }] }, config);
    scenarios.push(scenario(
      "strict-false-completion-gate",
      "Strict profile gates unsupported completion claims",
      "completion",
      gate.triggered && gate.unknown > 0,
      { triggered: gate.triggered, unknown: gate.unknown, failed: gate.failed },
      gate.message,
    ));
  }

  {
    const config = normalizeConfig({ profile: "balanced" });
    const state = createTaskState(cwd, "Need tests to pass before final answer.", undefined, config);
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "pytest", created_by: "host" });
    recordToolCall(state, "v1", "bash", { command: "pytest" });
    updateToolResult(state, "v1", "bash", { command: "pytest" }, true, "Tests failed", "==== 2 failed, 3 passed in 1.23s ====", config, { exitCode: 1 });
    const verification = computeVerification(state);
    scenarios.push(scenario(
      "verification-failure-caught",
      "Failed verification command marks criteria failed",
      "verification",
      verification.some((item) => item.status === "failed"),
      { failed_criteria: verification.filter((item) => item.status === "failed").length },
      verification.map((item) => `${item.status}:${item.criterion}`).join("; "),
    ));
  }

  {
    const config = normalizeConfig({ profile: "balanced" });
    const state = createTaskState(cwd, "Verify supervisor advice reaches the worker.", undefined, config);
    const prompts = buildRolePrompts(state, config);
    const syntheticSupervisorAdvice = "Use the isolated diagnostic check before editing.";
    scenarios.push(scenario(
      "g5-baseline-advice-not-delivered",
      "Baseline reproduction records that supervisor output is not included in the worker prompt",
      "resume",
      !prompts.worker.includes(syntheticSupervisorAdvice),
      { advice_delivered: prompts.worker.includes(syntheticSupervisorAdvice) },
      "Baseline reproduction only; WS-O1 owns the supervisor-advice delivery repair and this scenario does not claim it is fixed.",
    ));
  }

  {
    const parsed = parseVerificationResult("cargo test", "test result: ok. 10 passed; 0 failed; 0 ignored", false);
    scenarios.push(scenario(
      "verification-parser-pass",
      "Verification parser recognizes common pass output",
      "verification",
      parsed.status === "passed" && parsed.framework === "Cargo",
      { status: parsed.status, framework: parsed.framework },
      parsed.summary,
    ));
  }

  {
    const compactConfig = normalizeConfig({ contextMode: "compact" });
    const deltaConfig = normalizeConfig({ contextMode: "delta" });
    const state = createTaskState(cwd, "Keep context headers small across repeated turns.", undefined, compactConfig);
    state.known_facts.push("Fact A", "Fact B", "Fact C");
    const compact = buildContextHeader(state, compactConfig);
    const firstDelta = buildContextHeader(state, deltaConfig);
    const secondDelta = buildContextHeader(state, deltaConfig, firstDelta.snapshot);
    scenarios.push(scenario(
      "context-delta-smaller",
      "Delta context avoids reinjecting unchanged state",
      "context",
      secondDelta.header.length < compact.header.length,
      { compact_chars: compact.header.length, delta_chars: secondDelta.header.length },
      "Second delta header should be smaller than compact header when no material state changed.",
    ));
  }

  const frozenOutcomes = FROZEN_OUTCOME_FIXTURES
    .filter((fixture) => suite === "all" || fixture.suite === suite)
    .map((fixture) => executeFrozenOutcomeFixture(fixture));
  const total = scenarios.length;
  const passed = scenarios.filter((item) => item.passed).length;
  const failed = total - passed;
  const contextScenarios = scenarios.filter((item) => item.category === "context");
  const averageContextChars = contextScenarios.length
    ? Math.round(contextScenarios.reduce((sum, item) => sum + Number(item.metric.delta_chars ?? item.metric.compact_chars ?? 0), 0) / contextScenarios.length)
    : 0;

  return {
    schema_version: 2,
    generated_at: generatedAt,
    cwd,
    mode: "offline-harness",
    frozen_fixtures: FROZEN_OUTCOME_FIXTURES.filter((fixture) => suite === "all" || fixture.suite === suite),
    frozen_outcomes: frozenOutcomes,
    configurations: configurationsForSuite(suite),
    scenarios,
    metrics: {
      total,
      passed,
      failed,
      pass_rate: total ? passed / total : 0,
      repeated_action_blocks: scenarios.filter((item) => item.category === "loop" && item.passed).length,
      false_completion_blocks: scenarios.filter((item) => item.category === "completion" && item.passed).length,
      verification_failures_caught: scenarios.filter((item) => item.id === "verification-failure-caught" && item.passed).length,
      average_context_chars: averageContextChars,
    },
    interpretation: failed === 0
      ? "Offline harness checks passed. This validates deterministic reliability mechanisms, not live model quality. Run representative live small-model tasks to measure model-specific completion rates."
      : "One or more offline harness checks failed. Fix deterministic harness behavior before live small-model evaluation.",
  };
}

export function buildEvaluationReport(cwd: string, config: EvaluationConfig, request: { suite: EvaluationSuite; model?: string }): ReliabilityEvaluationReport {
  const report = runOfflineReliabilityEvaluation(cwd, request.suite);
  return { ...report, live: planLiveEvaluation(request, config) };
}

export function formatEvaluationReport(report: ReliabilityEvaluationReport): string {
  const lines = [
    "# Reliability Harness Evaluation",
    "",
    `Generated: ${report.generated_at}`,
    `Mode: ${report.mode}`,
    `Pass rate: ${(report.metrics.pass_rate * 100).toFixed(1)}% (${report.metrics.passed}/${report.metrics.total})`,
    `Repeated-action blocks: ${report.metrics.repeated_action_blocks}`,
    `False-completion blocks: ${report.metrics.false_completion_blocks}`,
    `Verification failures caught: ${report.metrics.verification_failures_caught}`,
    `Average context chars: ${report.metrics.average_context_chars}`,
    "",
    "## Scenarios",
    ...report.scenarios.map((item) => `- ${item.passed ? "PASS" : "FAIL"} ${item.id}: ${item.name} — ${item.notes}`),
    "",
    "## Frozen independent outcome fixtures",
    ...report.frozen_fixtures.map((fixture) => `- ${fixture.id}: expected ${fixture.expected_outcome}; oracle: ${fixture.independent_oracle}`),
    "",
    "## Executed frozen outcomes",
    ...report.frozen_outcomes.map((outcome) => `- ${outcome.passed ? "PASS" : "FAIL"} ${outcome.id}: observed ${outcome.observed_outcome}; expected ${outcome.expected_outcome}.`),
    "",
    "## Comparison configurations",
    ...report.configurations.map((configuration) => `- ${configuration.id} (${configuration.assistance}): ${configuration.status}. ${configuration.note}`),
    ...(report.live ? ["", "## Live evaluation", `- Status: ${report.live.status}; calls made: ${report.live.calls_made}.`, `- ${report.live.reason}`] : []),
    "",
    "## Interpretation",
    report.interpretation,
  ];
  return `${lines.join("\n")}\n`;
}

export function writeEvaluationReport(cwd: string, report: ReliabilityEvaluationReport): { jsonPath: string; markdownPath: string } {
  const dir = resolve(cwd, CONFIG_DIR_NAME, "reliability-evaluations");
  mkdirSync(dir, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, "-");
  const jsonPath = join(dir, `${stamp}.json`);
  const markdownPath = join(dir, `${stamp}.md`);
  writeJsonFile(jsonPath, report);
  writeFileSync(markdownPath, formatEvaluationReport(report), { encoding: "utf8", mode: 0o600 });
  return { jsonPath, markdownPath };
}
