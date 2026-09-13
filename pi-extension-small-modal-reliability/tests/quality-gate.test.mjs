import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  assessReliabilityGate,
  assessTaskCompletion,
  bindFinalOutputCandidate,
  buildEvaluationReport,
  createTaskState,
  executeFrozenOutcomeFixture,
  evaluateStructuredOutputCompletionRequirement,
  hostEvaluationCases,
  isTaskStateV2,
  normalizeConfig,
  outputContractReceiptData,
  outputReceiptHash,
  outputValidationReceiptData,
  parseStructuredOutputContract,
  recordOutputValidation,
  recordQualityGateClaim,
  recordQualityGateEscalation,
  registerOutputContract,
  runBoundedLiveEvaluation,
  stableStringify,
  validateOutputCandidate,
  validateReliabilityGateInput,
} from "../src/core.ts";

const config = normalizeConfig({});
function tempCwd() { return mkdtempSync(join(tmpdir(), "pi-reliability-gate-wave-")); }
function definitionHash(definition) { return createHash("sha256").update(stableStringify(definition)).digest("hex"); }

function nativeTask(cwd) {
  const state = createTaskState(cwd, "Return an approved status.", undefined, config);
  state.task_identity.session_id = "session-g1";
  state.task_identity.session_anchor_entry_id = "user-g1";
  state.current_session = {
    ...state.current_session,
    lifecycle_identity: "available",
    session_id: "session-g1",
    branch_id: state.task_identity.branch_id,
    branch_entry_ids: ["user-g1"],
    output_contract_receipts: [],
    output_validation_receipts: [],
    quality_gate_resolution_receipts: [],
  };
  Object.assign(state.authoritative_instructions.original_user_request, { session_id: "session-g1", session_entry_id: "user-g1" });
  state.current_session.input_authority_receipts = [{ entry_id: "user-g1", task_id: state.task_id, origin: "user-command", text_sha256: createHash("sha256").update(state.user_goal).digest("hex") }];
  return state;
}

function draft(definition) {
  return { path: "/tmp/approved-status.contract.json", sha256: "a".repeat(64), definition_sha256: definitionHash(definition), bytes: 85, definition };
}

function activate(state, definition) {
  const contractDraft = draft(definition);
  const data = outputContractReceiptData(state, "OC1", contractDraft);
  const receipt = { entry_id: "contract-g1", ...data, receipt_hash: outputReceiptHash("reliability-output-contract", data) };
  state.current_session.branch_entry_ids.push(receipt.entry_id);
  state.current_session.output_contract_receipts.push(receipt);
  return registerOutputContract(state, contractDraft, { session: state.current_session, receipt });
}

function persistValidation(state, proposal) {
  const id = `OV${state.id_counters.next_output_validation}`;
  const data = outputValidationReceiptData(state, id, proposal);
  const receipt = { entry_id: `validation-${id}`, ...data, receipt_hash: outputReceiptHash("reliability-output-validation", data) };
  state.current_session.branch_entry_ids.push(receipt.entry_id);
  state.current_session.output_validation_receipts.push(receipt);
  return recordOutputValidation(state, proposal, { session: state.current_session, receipt });
}

test("registered native receipt flow validates all supported structural boundaries", () => {
  const cwd = tempCwd();
  try {
    const jsonState = nativeTask(cwd);
    const json = activate(jsonState, parseStructuredOutputContract({ format: "json", semantic: "structural-only", schema: { type: "object", additionalProperties: false } }));
    const extra = validateOutputCandidate(jsonState, json.contract_id, '{"unexpected":1}', config);
    assert.equal(extra.decision, "fail");
    assert.match(extra.reasons.join(" "), /not allowed/);
    persistValidation(jsonState, extra);

    const csvState = nativeTask(cwd);
    const csv = activate(csvState, parseStructuredOutputContract({ format: "csv", semantic: "structural-only", columns: ["value"], hasHeader: false, minRows: 1, maxRows: 1 }));
    assert.equal(validateOutputCandidate(csvState, csv.contract_id, '"a"oops', config).syntax_valid, false);

    const checklistState = nativeTask(cwd);
    const checklist = activate(checklistState, parseStructuredOutputContract({ format: "markdown-checklist", semantic: "structural-only", items: [{ text: "done", checked: true }], allowExtraItems: false }));
    assert.equal(validateOutputCandidate(checklistState, checklist.contract_id, "- [x] done\n- [ ] done", config).schema_valid, false);

    const enumState = nativeTask(cwd);
    const enumContract = activate(enumState, parseStructuredOutputContract({ format: "enum", semantic: "structural-only", values: ["approved", "rejected"] }));
    const valid = validateOutputCandidate(enumState, enumContract.contract_id, "approved", config);
    assert.equal(valid.decision, "pass");
    assert.equal(valid.semantic_checks_passed, false);
    const validation = persistValidation(enumState, valid);
    bindFinalOutputCandidate(enumState, "different final response");
    assert.equal(evaluateStructuredOutputCompletionRequirement(enumState)?.decision, "escalate");
    bindFinalOutputCandidate(enumState, "approved");
    assert.equal(evaluateStructuredOutputCompletionRequirement(enumState)?.decision, "pass");
    assert.equal(validation.candidate_sha256, enumState.structured_output.final_candidate_sha256);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("unavailable lifecycle and tampered output provenance fail closed", () => {
  const cwd = tempCwd();
  try {
    const state = nativeTask(cwd);
    state.current_session.lifecycle_identity = "unavailable";
    assert.throws(() => registerOutputContract(state, draft(parseStructuredOutputContract({ format: "enum", semantic: "structural-only", values: ["ok"] }))), /available Pi session/);

    const validState = nativeTask(cwd);
    const contract = activate(validState, parseStructuredOutputContract({ format: "enum", semantic: "structural-only", values: ["ok"] }));
    contract.definition.values.push("tampered");
    assert.throws(() => validateOutputCandidate(validState, contract.contract_id, "ok", config), /lacks current user-confirmed/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("quality escalation is enforced by the shared final authority and phase purpose excludes future final criteria", () => {
  const cwd = tempCwd();
  try {
    const state = nativeTask(cwd);
    recordQualityGateEscalation(state, { action: "escalate", reason: "need user decision", decisionNeeded: "approve scope", evidence: [] });
    assert.equal(assessTaskCompletion(state).decision, "escalate");
    assert.equal(assessReliabilityGate(state, "final").decision, "escalate");
    const retrieval = assessReliabilityGate(state, "retrieval");
    assert.equal(retrieval.decision, "escalate", "pending escalation remains shared even in a phase gate");
    const criterion = state.criteria[0];
    const record = validateReliabilityGateInput({ action: "record", gate: "final", criterion: criterion.id, status: "passed", evidence: "model assertion only" });
    recordQualityGateClaim(state, record);
    assert.notEqual(assessTaskCompletion(state).decision, "pass");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("frozen outcome runner executes independent fixtures and exact-model adapter path is fake-only", async () => {
  const cwd = tempCwd();
  try {
    const report = buildEvaluationReport(cwd, config.evaluation, { suite: "retrieval", model: "unconfigured/model" });
    assert.equal(report.frozen_outcomes.length, 1);
    assert.equal(report.frozen_outcomes[0].passed, true);
    assert.equal(report.live?.calls_made, 0);
    assert.equal(executeFrozenOutcomeFixture(report.frozen_fixtures[0]).passed, true);
    const liveConfig = normalizeConfig({ evaluation: { liveModels: ["fake/model"], timeoutMs: 1_000, maxCases: 2 } });
    const live = await runBoundedLiveEvaluation({ suite: "retrieval", model: "fake/model" }, liveConfig.evaluation, hostEvaluationCases("retrieval"), {
      model: "fake/model",
      async invoke(packet) { return packet.cases.map((item) => ({ id: item.id, output: "I cannot find evidence in the supplied sources." })); },
    });
    assert.equal(live.status, "completed");
    assert.equal(live.calls_made, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("bounded live adapter keeps oracle data host-only and rejects wrong, duplicate, and late outputs", async () => {
  const cases = hostEvaluationCases("all");
  const liveConfig = { liveModels: ["fake/model"], timeoutMs: 5, maxCases: 50 };
  const wrong = await runBoundedLiveEvaluation({ suite: "agentic", model: "fake/model" }, liveConfig, cases, {
    model: "fake/model",
    async invoke(packet) {
      assert.equal("expected_outcome" in packet.cases[0], false);
      assert.equal("evaluateOutput" in packet.cases[0], false);
      return packet.cases.map((item) => ({ id: item.id, output: "SEND external-email" }));
    },
  });
  assert.equal(wrong.status, "completed");
  assert.equal(wrong.results?.[0].passed, false, "wrong observed action cannot pass the host oracle");

  const duplicate = await runBoundedLiveEvaluation({ suite: "all", model: "fake/model" }, liveConfig, cases, {
    model: "fake/model",
    async invoke(packet) { return packet.cases.map(() => ({ id: packet.cases[0].id, output: "x" })); },
  });
  assert.equal(duplicate.status, "failed");
  assert.equal(duplicate.calls_made, 1);

  const late = await runBoundedLiveEvaluation({ suite: "retrieval", model: "fake/model" }, liveConfig, cases, {
    model: "fake/model",
    async invoke() { return await new Promise(() => {}); },
  });
  assert.equal(late.status, "cancelled");
  assert.equal(late.calls_made, 1, "a timed-out invocation is still an attempted call");

  const syncThrow = await runBoundedLiveEvaluation({ suite: "retrieval", model: "fake/model" }, liveConfig, cases, {
    model: "fake/model",
    invoke() { throw new Error("synchronous adapter failure"); },
  });
  assert.equal(syncThrow.status, "failed");
  assert.equal(syncThrow.calls_made, 1);

  const modelAuthoredUsage = await runBoundedLiveEvaluation({ suite: "retrieval", model: "fake/model" }, liveConfig, cases, {
    model: "fake/model",
    async invoke(packet) { return packet.cases.map((item) => ({ id: item.id, output: "I cannot find evidence.", input_tokens: 999, output_tokens: 999 })); },
  });
  assert.equal(modelAuthoredUsage.usage, "unknown", "per-case fields from generated output never become billing metrics");
  assert.equal(modelAuthoredUsage.aggregate_usage, undefined);

  const abortController = new AbortController();
  const callerAbort = runBoundedLiveEvaluation({ suite: "retrieval", model: "fake/model" }, { ...liveConfig, timeoutMs: 1_000 }, cases, {
    model: "fake/model",
    async invoke() { return await new Promise(() => {}); },
  }, abortController.signal);
  queueMicrotask(() => abortController.abort());
  assert.equal((await callerAbort).status, "cancelled", "caller abort settles even when the adapter ignores abort");

  const throwingOracle = [{ ...hostEvaluationCases("retrieval")[0], evaluateOutput() { throw new Error("oracle failure"); } }];
  const oracleFailure = await runBoundedLiveEvaluation({ suite: "retrieval", model: "fake/model" }, liveConfig, throwingOracle, {
    model: "fake/model",
    async invoke(packet) { return packet.cases.map((item) => ({ id: item.id, output: "I cannot find evidence." })); },
  });
  assert.equal(oracleFailure.status, "failed");
  assert.equal(oracleFailure.calls_made, 1);
});

test("inactive explicit lane gates escalate rather than vacuously passing", () => {
  const cwd = tempCwd();
  try {
    const state = nativeTask(cwd);
    assert.equal(assessReliabilityGate(state, "retrieval").decision, "escalate");
    assert.match(assessReliabilityGate(state, "agentic").reasons.join(" "), /has not started/);
    assert.match(assessReliabilityGate(state, "coding").reasons.join(" "), /has not started/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("fresh Wave 4 state validates and rejects free-form model promotion", () => {
  const cwd = tempCwd();
  try {
    const state = nativeTask(cwd);
    assert.equal(isTaskStateV2(state), true);
    const invalidRecord = validateReliabilityGateInput({ action: "record", gate: "final", criterion: "free text", status: "passed", evidence: "x" });
    assert.throws(() => recordQualityGateClaim(state, invalidRecord), /exact active criterion ID/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("RF2 scope diagnostics come from the common scope assessment", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Bounded task", undefined, config);
    state.scope_state.violations.push("denied");
    state.scope_state.usage.last_block_reason = "outside allowed scope";
    const decision = assessReliabilityGate(state, "final");
    assert.ok(decision.scopeViolations.some(reason => /outside allowed scope/.test(reason)));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
