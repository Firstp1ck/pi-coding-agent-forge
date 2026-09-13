import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, initTheme } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import reliabilityExtension from "../index.ts";
import {
  addTrustedCheckMapping,
  applyReliabilityScopeAction,
  approveScopeApproval,
  approveScopeChange,
  createApprovalRequest,
  createTaskState,
  clearScope,
  evaluateScopeToolCall,
  evaluateStructuredOutputCompletionRequirement,
  assessTaskCompletion,
  isTaskStateV2,
  hashToolCall,
  migrateTaskState,
  normalizeConfig,
  normalizeScopeEffect,
  nativeAuthorityReceiptHash,
  evaluateScopeCompletionRequirement,
  recordScopeToolResult,
  scopeFingerprint,
  recordToolCall,
  updateToolResult,
} from "../src/core.ts";

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "pi-reliability-scope-"));
}

function cleanup(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

function scopeInput(overrides = {}) {
  return {
    action: "set",
    lane: "agentic",
    allowedTools: ["read", "write", "edit", "bash"],
    allowedReadPaths: ["."],
    allowedWritePaths: ["."],
    forbiddenPaths: [],
    maxToolCalls: 20,
    maxErrors: 3,
    maxIterations: 20,
    externalSideEffects: "approval-required",
    validationCommands: [],
    stopConditions: ["Stop when the configured budget is exhausted."],
    escalationConditions: ["Escalate missing user authority."],
    ...overrides,
  };
}

function scopedTask(cwd, config = normalizeConfig({}), overrides = {}) {
  const task = createTaskState(cwd, "perform bounded agent work", undefined, config);
  const result = applyReliabilityScopeAction(task, scopeInput(overrides), config);
  const requestId = result.scope_change?.id;
  if (requestId) approveScopeChange(task, requestId, "native-confirmation");
  assert.equal(task.scope_state.active_scope?.scope_id, "S1");
  return task;
}

function evaluate(task, toolName, input, config, options = {}) {
  return evaluateScopeToolCall(task, toolName, input, config, { trustedTool: true, ...options });
}

function settleRead(task, path, config, callId = `read-${task.id_counters.next_receipt}`, isError = false) {
  const input = { path };
  const decision = evaluate(task, "read", input, config);
  assert.equal(decision.allowed, true);
  recordToolCall(task, callId, "read", input, { host_provenance: "host-tool" });
  const receipt = updateToolResult(task, callId, "read", input, isError, isError ? "ERROR: read" : "OK: read", "contents", config, {});
  recordScopeToolResult(task, receipt, input);
  return receipt;
}

test("scope blocks path escape, unknown mutation, stale edit, and same-batch read-to-edit", () => {
  const cwd = tempCwd();
  const outside = tempCwd();
  try {
    writeFileSync(join(cwd, "target.txt"), "before\n");
    writeFileSync(join(outside, "outside.txt"), "outside\n");
    symlinkSync(outside, join(cwd, "outside-link"), "dir");
    const config = normalizeConfig({ scope: { maxToolCalls: 40, maxErrors: 3, maxIterations: 30 } });
    const task = scopedTask(cwd, config);

    const pendingRead = evaluate(task, "read", { path: "target.txt" }, config);
    assert.equal(pendingRead.allowed, true);
    const sameBatchEdit = evaluate(task, "edit", { path: "target.txt", oldText: "before", newText: "after" }, config);
    assert.equal(sameBatchEdit.allowed, false);
    assert.match(sameBatchEdit.reason, /fresh.*read|current.*read/i);

    settleRead(task, "target.txt", config);
    const freshEdit = evaluate(task, "edit", { path: "target.txt", oldText: "before", newText: "after" }, config);
    assert.equal(freshEdit.allowed, true);

    const traversal = evaluate(task, "read", { path: "../outside.txt" }, config);
    assert.equal(traversal.allowed, false);
    assert.match(traversal.reason, /escapes|outside/i);

    const symlinkEscape = evaluate(task, "write", { path: "outside-link/new.txt", content: "blocked" }, config);
    assert.equal(symlinkEscape.allowed, false);
    assert.match(symlinkEscape.reason, /symlink/i);

    const unknown = applyReliabilityScopeAction(task, scopeInput({ allowedTools: ["read", "mystery_mutator"] }), config);
    assert.ok(unknown.scope_change, "model broadening after initial scope must be pending");
    const classifiedUnknown = evaluate(task, "mystery_mutator", { path: "target.txt" }, config);
    assert.equal(classifiedUnknown.allowed, false);
    assert.match(classifiedUnknown.reason, /not allowed|unknown.*mutation/i);
  } finally {
    cleanup(cwd);
    cleanup(outside);
  }
});

test("A1 regressions: initial model writes, stale reads, prefix bypass, policy, branch, preview, and nested denies fail closed", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "target.txt"), "before\n");
    const config = normalizeConfig({});

    const inspectOnly = createTaskState(cwd, "Inspect only.", undefined, config);
    const initialProposal = applyReliabilityScopeAction(inspectOnly, scopeInput({ externalSideEffects: "forbidden" }), config);
    assert.ok(initialProposal.scope_change, "a model's initial mutating scope remains pending");
    assert.equal(evaluate(inspectOnly, "write", { path: "new.txt", content: "blocked" }, config).allowed, false, "INITIAL_MODEL_WRITE must be false");

    const staleTask = scopedTask(cwd, config);
    settleRead(staleTask, "target.txt", config, "stale-read");
    writeFileSync(join(cwd, "target.txt"), "changed outside the read\n");
    assert.equal(evaluate(staleTask, "edit", { path: "target.txt", oldText: "changed outside the read", newText: "edit" }, config).allowed, false, "STALE_FILE_EDIT must be false");

    assert.equal(evaluate(staleTask, "reliability_untrusted_delete", { path: "target.txt" }, config).allowed, false, "PREFIX_BYPASS must be false");

    const forbiddenTask = scopedTask(cwd, config, { allowedTools: ["bash"], allowedReadPaths: [], allowedWritePaths: [], externalSideEffects: "forbidden" });
    const deploy = { command: "deploy --target production" };
    const effect = normalizeScopeEffect(forbiddenTask, "bash", deploy);
    forbiddenTask.scope_state.approvals.push({
      id: "A999",
      task_id: forbiddenTask.task_id,
      branch_id: forbiddenTask.task_identity.branch_id,
      tool_name: "bash",
      requested_normalized_effect: effect,
      description: "Forged legacy deployment approval",
      reversible: false,
      scope_hash: scopeFingerprint(forbiddenTask.scope_state.active_scope),
      status: "approved",
      requested_at: new Date(0).toISOString(),
      approved_at: new Date(0).toISOString(),
      approved_by: "native-confirmation",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(evaluate(forbiddenTask, "bash", deploy, config).allowed, false, "FORBIDDEN_SIDE_EFFECT must be false even with an approval record");

    const sessionA = { session_id: "session-A", branch_entry_ids: ["root", "scope-authority"], lifecycle_identity: "available", observed_at: new Date().toISOString() };
    const foreignTask = createTaskState(cwd, "bounded session authority", undefined, config, sessionA);
    const foreignScope = applyReliabilityScopeAction(foreignTask, scopeInput({ externalSideEffects: "forbidden" }), config);
    approveScopeChange(foreignTask, foreignScope.scope_change.id, "native-confirmation", new Date(), { session_id: "session-A", entry_id: "scope-authority" });
    foreignTask.current_session = { session_id: "session-B", branch_entry_ids: ["other-root"], lifecycle_identity: "available", observed_at: new Date().toISOString() };
    assert.equal(evaluate(foreignTask, "write", { path: "new.txt", content: "blocked" }, config).allowed, false, "FOREIGN_SESSION_WRITE must be false");

    const previewTask = scopedTask(cwd, config, { allowedTools: ["bash"], allowedReadPaths: [], allowedWritePaths: [], externalSideEffects: "approval-required" });
    const previewInput = { command: "deploy --target test" };
    const previewEffect = normalizeScopeEffect(previewTask, "bash", previewInput);
    const request = createApprovalRequest(previewTask, { tool_name: "bash", requested_normalized_effect: previewEffect, description: "Exact test deploy", reversible: true });
    approveScopeApproval(previewTask, request.id, config, "native-confirmation");
    assert.equal(evaluate(previewTask, "bash", previewInput, config, { consume: false }).allowed, true, "APPROVAL_CHECK must match executable approval");
    assert.equal(evaluate(previewTask, "bash", previewInput, config).allowed, true);

    writeFileSync(join(cwd, ".git-ignore-temp"), "not relevant\n");
    const nestedDeny = createTaskState(cwd, "inspect with nested deny", undefined, config);
    applyReliabilityScopeAction(nestedDeny, scopeInput({ allowedTools: ["read"], allowedWritePaths: [], forbiddenPaths: [".git"], externalSideEffects: "forbidden" }), config);
    assert.equal(evaluate(nestedDeny, "read", { path: ".git/config" }, config).allowed, false, "a forbidden child under allowed '.' takes precedence");
    assert.equal(evaluate(nestedDeny, "read", { path: ".pi/tasks/policy.json" }, config).allowed, false, "runtime-owned policy state is never generic read access");
  } finally {
    cleanup(cwd);
  }
});

test("A1 revalidation: no scope authorizes only trusted reads, and fresh writes require stable full reads", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "target.txt"), "before\n");
    const config = normalizeConfig({});
    const unscoped = createTaskState(cwd, "observe only", undefined, config);
    assert.equal(evaluate(unscoped, "read", { path: "target.txt" }, config).allowed, true, "balanced observe retains trusted read-only behavior");
    assert.equal(evaluate(unscoped, "bash", { command: "deploy --target production" }, config).allowed, false, "NO_SCOPE_SHELL must be false");
    const policyWrite = evaluate(unscoped, "write", { path: ".pi/reliability.json", content: "{}" }, config);
    assert.equal(policyWrite.allowed, false, "NO_SCOPE_POLICY_WRITE must be false");
    assert.match(policyWrite.reason, /runtime-owned|scope/i);

    const changedBeforeResult = scopedTask(cwd, config);
    const readInput = { path: "target.txt" };
    assert.equal(evaluate(changedBeforeResult, "read", readInput, config).allowed, true);
    recordToolCall(changedBeforeResult, "changed-before-result", "read", readInput, { host_provenance: "host-tool" });
    writeFileSync(join(cwd, "target.txt"), "changed before the host read result\n");
    const staleReceipt = updateToolResult(changedBeforeResult, "changed-before-result", "read", readInput, false, "OK: stale result", "before", config, {});
    recordScopeToolResult(changedBeforeResult, staleReceipt, readInput);
    assert.equal(evaluate(changedBeforeResult, "write", { path: "target.txt", content: "overwrite" }, config).allowed, false, "READ_CHANGED_BEFORE_RESULT must be false");

    writeFileSync(join(cwd, "target.txt"), "full content\n");
    const partial = scopedTask(cwd, config);
    const partialInput = { path: "target.txt", offset: 0, limit: 1 };
    assert.equal(evaluate(partial, "read", partialInput, config).allowed, true);
    recordToolCall(partial, "partial-read", "read", partialInput, { host_provenance: "host-tool" });
    const partialReceipt = updateToolResult(partial, "partial-read", "read", partialInput, false, "OK: partial result", "f", config, {});
    recordScopeToolResult(partial, partialReceipt, partialInput);
    assert.equal(evaluate(partial, "write", { path: "target.txt", content: "overwrite" }, config).allowed, false, "a partial or truncated read cannot authorize a whole-file overwrite");
  } finally {
    cleanup(cwd);
  }
});

test("scope clear retains narrowed bounds, and exact approval dispositions only its blocked effect", () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({});
    const task = scopedTask(cwd, config);
    const narrowed = applyReliabilityScopeAction(task, scopeInput({ allowedTools: ["read"], allowedWritePaths: [], externalSideEffects: "forbidden" }), config);
    assert.equal(narrowed.scope?.scope_id, "S2");
    assert.deepEqual(task.scope_state.active_scope.allowed_tools, ["read"]);
    const retained = clearScope(task);
    assert.deepEqual(retained.allowed_tools, ["read"], "scope clear must not restore broader authority");

    const approvalTask = scopedTask(cwd, config, { allowedTools: ["bash"], allowedReadPaths: [], allowedWritePaths: [], externalSideEffects: "approval-required" });
    const input = { command: "deploy --target test" };
    assert.equal(evaluate(approvalTask, "bash", input, config).allowed, false);
    assert.ok(approvalTask.scope_state.usage.last_block_reason);
    const violationsBeforeApproval = approvalTask.scope_state.violations.length;
    const effect = normalizeScopeEffect(approvalTask, "bash", input);
    const request = createApprovalRequest(approvalTask, { tool_name: "bash", requested_normalized_effect: effect, description: "Bounded test deploy", reversible: true });
    approveScopeApproval(approvalTask, request.id, config, "native-confirmation");
    assert.equal(approvalTask.scope_state.usage.last_block_reason, undefined, "the exact native approval dispositions its blocked effect");
    assert.equal(approvalTask.scope_state.violations.length, violationsBeforeApproval, "historical violations remain durable");
    assert.equal(evaluate(approvalTask, "bash", input, config).allowed, true);
    assert.equal(evaluateScopeCompletionRequirement(approvalTask), undefined, "the repaired, consumed effect does not permanently block completion");
  } finally {
    cleanup(cwd);
  }
});

test("scope and exact-effect authority require matching persisted receipt payloads", () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({});
    const session = { session_id: "receipt-session", branch_entry_ids: ["root", "scope-entry", "approval-entry"], lifecycle_identity: "available", observed_at: new Date().toISOString() };
    const task = createTaskState(cwd, "receipt authority", undefined, config, session);
    const scopeChange = applyReliabilityScopeAction(task, scopeInput({ allowedTools: ["bash"], allowedReadPaths: [], allowedWritePaths: [], externalSideEffects: "approval-required" }), config);
    const scopeHash = scopeFingerprint(scopeChange.scope_change.requested_scope);
    const scopeData = { task_id: task.task_id, scope_change_id: scopeChange.scope_change.id, scope_hash: scopeHash };
    approveScopeChange(task, scopeChange.scope_change.id, "native-confirmation", new Date(), {
      session_id: session.session_id,
      entry_id: "scope-entry",
      receipt_hash: nativeAuthorityReceiptHash("reliability-scope-authorization", scopeData),
    });
    assert.equal(evaluate(task, "bash", { command: "deploy --target test" }, config).allowed, false, "an arbitrary entry ID cannot establish scope authority");
    task.current_session.scope_authorization_receipts = [{ entry_id: "scope-entry", ...scopeData, receipt_hash: nativeAuthorityReceiptHash("reliability-scope-authorization", scopeData) }];
    const effect = normalizeScopeEffect(task, "bash", { command: "deploy --target test" });
    const request = createApprovalRequest(task, { tool_name: "bash", requested_normalized_effect: effect, description: "Bounded test deploy", reversible: true });
    const approvalData = { task_id: task.task_id, approval_id: request.id, scope_hash: scopeFingerprint(task.scope_state.active_scope), normalized_effect_hash: hashToolCall("approval", effect) };
    approveScopeApproval(task, request.id, config, "native-confirmation", new Date(), {
      session_id: session.session_id,
      entry_id: "approval-entry",
      receipt_hash: nativeAuthorityReceiptHash("reliability-exact-approval", approvalData),
    });
    assert.equal(evaluate(task, "bash", { command: "deploy --target test" }, config, { consume: false }).allowed, false, "an approval entry without matching receipt content cannot authorize an effect");
    task.current_session.scope_approval_receipts = [{ entry_id: "approval-entry", ...approvalData, receipt_hash: nativeAuthorityReceiptHash("reliability-exact-approval", approvalData) }];
    assert.equal(evaluate(task, "bash", { command: "deploy --target test" }, config, { consume: false }).allowed, true);
    task.current_session.scope_approval_receipts[0].normalized_effect_hash = "0".repeat(64);
    assert.equal(evaluate(task, "bash", { command: "deploy --target test" }, config, { consume: false }).allowed, false, "changed receipt content must invalidate exact approval authority");
  } finally {
    cleanup(cwd);
  }
});

test("scope call, error, and iteration budgets stop later actions without resetting recovery state", () => {
  const cwd = tempCwd();
  try {
    const base = normalizeConfig({});
    const callBudgetTask = createTaskState(cwd, "bound calls", undefined, base);
    applyReliabilityScopeAction(callBudgetTask, scopeInput({ allowedTools: ["read"], allowedWritePaths: [], externalSideEffects: "forbidden", maxToolCalls: 1, maxErrors: 3, maxIterations: 3 }), base);
    assert.equal(evaluate(callBudgetTask, "read", { path: "." }, base).allowed, true);
    const overCalls = evaluate(callBudgetTask, "read", { path: "." }, base);
    assert.equal(overCalls.allowed, false);
    assert.match(overCalls.reason, /call budget/i);
    assert.equal(callBudgetTask.scope_state.usage.tool_calls_used, 2, "blocked calls remain part of the total action budget");

    const errorBudgetTask = createTaskState(cwd, "bound errors", undefined, base);
    applyReliabilityScopeAction(errorBudgetTask, scopeInput({ allowedTools: ["read"], allowedWritePaths: [], externalSideEffects: "forbidden", maxToolCalls: 3, maxErrors: 1, maxIterations: 3 }), base);
    settleRead(errorBudgetTask, ".", base, "error-read", true);
    const overErrors = evaluate(errorBudgetTask, "read", { path: "." }, base);
    assert.equal(overErrors.allowed, false);
    assert.match(overErrors.reason, /error budget/i);

    const iterationBudgetTask = createTaskState(cwd, "bound iterations", undefined, base);
    applyReliabilityScopeAction(iterationBudgetTask, scopeInput({ allowedTools: ["read"], allowedWritePaths: [], externalSideEffects: "forbidden", maxToolCalls: 3, maxErrors: 3, maxIterations: 1 }), base);
    settleRead(iterationBudgetTask, ".", base, "iteration-read");
    const overIterations = evaluate(iterationBudgetTask, "read", { path: "." }, base);
    assert.equal(overIterations.allowed, false);
    assert.match(overIterations.reason, /iteration budget/i);
  } finally {
    cleanup(cwd);
  }
});

test("scope narrowing applies immediately while expansion requires a user decision", () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({});
    const task = createTaskState(cwd, "bounded scope transition", undefined, config);
    const initial = applyReliabilityScopeAction(task, scopeInput({ allowedTools: ["read"], allowedWritePaths: [], externalSideEffects: "forbidden" }), config);
    assert.equal(initial.scope?.scope_id, "S1");

    const expansion = applyReliabilityScopeAction(task, scopeInput({ allowedTools: ["read", "write"], allowedWritePaths: ["."], externalSideEffects: "approval-required" }), config);
    assert.equal(expansion.scope_change?.id, "SC1");
    assert.deepEqual(task.scope_state.active_scope?.allowed_tools, ["read"]);

    const approved = approveScopeChange(task, "SC1", "native-confirmation");
    assert.deepEqual(approved.allowed_tools, ["read", "write"]);
    assert.equal(approved.authority, "native-confirmation");

    const broaderAgain = applyReliabilityScopeAction(task, scopeInput({ allowedTools: ["read", "write", "bash"], allowedWritePaths: ["."], externalSideEffects: "approval-required" }), config);
    assert.ok(broaderAgain.scope_change, "a model cannot broaden a user-authoritative scope");
    assert.equal(task.scope_state.pending_scope_changes.filter((item) => item.status === "pending").length, 1);
  } finally {
    cleanup(cwd);
  }
});

test("approvals bind one exact normalized effect, scope, and expiry", () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({ scope: { approvalTtlMs: 1_000 } });
    const task = scopedTask(cwd, config);
    const input = { command: "deploy --target test" };
    const effect = normalizeScopeEffect(task, "bash", input);
    const request = createApprovalRequest(task, {
      tool_name: "bash",
      requested_normalized_effect: effect,
      description: "Deploy the bounded test target.",
      reversible: true,
    }, new Date(0));
    approveScopeApproval(task, request.id, config, "native-confirmation", new Date(0));

    const first = evaluate(task, "bash", input, config, { now: new Date(100) });
    assert.equal(first.allowed, true);
    assert.equal(first.approval_id, request.id);
    assert.equal(task.scope_state.approvals[0].status, "consumed");

    const replay = evaluate(task, "bash", input, config, { now: new Date(200) });
    assert.equal(replay.allowed, false);
    assert.match(replay.reason, /single-use|validation/i);

    const changedEffect = normalizeScopeEffect(task, "bash", { command: "deploy --target production" });
    const changedRequest = createApprovalRequest(task, {
      tool_name: "bash",
      requested_normalized_effect: changedEffect,
      description: "Do not run after expiry.",
      reversible: false,
    }, new Date(0));
    approveScopeApproval(task, changedRequest.id, config, "user-command", new Date(0));
    const expired = evaluate(task, "bash", { command: "deploy --target production" }, config, { now: new Date(2_000) });
    assert.equal(expired.allowed, false);
    assert.equal(task.scope_state.approvals.find((item) => item.id === changedRequest.id)?.status, "expired");
  } finally {
    cleanup(cwd);
  }
});

test("exact trusted mappings permit declared validation but do not authorize arbitrary shell", () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({});
    const task = createTaskState(cwd, "run bounded validation", undefined, config);
    addTrustedCheckMapping(task, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "user-command" });
    const scope = applyReliabilityScopeAction(task, scopeInput({ allowedTools: ["bash"], allowedReadPaths: [], allowedWritePaths: [], externalSideEffects: "approval-required", validationCommands: ["npm test"] }), config);
    approveScopeChange(task, scope.scope_change.id, "native-confirmation");

    const validation = evaluate(task, "bash", { command: "npm test" }, config);
    assert.equal(validation.allowed, false, "a criterion mapping is evidence metadata, not shell permission");
    const compound = evaluate(task, "bash", { command: "npm test && rm -rf ." }, config);
    assert.equal(compound.allowed, false);
    assert.match(compound.reason, /validation command text alone|single-use/i);
  } finally {
    cleanup(cwd);
  }
});

test("pre-scope v2 state migrates additively without changing its evidence fields", () => {
  const cwd = tempCwd();
  try {
    const original = createTaskState(cwd, "migrate scope fields", undefined, normalizeConfig({}));
    const legacy = structuredClone(original);
    for (const key of ["dependency_evidence", "coding_boundary", "working_context", "authoritative_instructions", "structured_output", "quality_gate", "context_epoch", "context_checkpoints", "active_checkpoint_id", "context_reset", "advisor_state"]) delete legacy[key];
    for (const key of ["next_output_contract", "next_output_validation", "next_quality_gate_claim", "next_quality_gate_escalation", "next_quality_gate_assessment", "next_quality_gate_resolution", "next_checkpoint", "next_advisor_advice"]) delete legacy.id_counters[key];
    for (const key of ["output_contract_receipts", "output_validation_receipts", "quality_gate_resolution_receipts"]) delete legacy.current_session[key];
    for (const step of legacy.plan) for (const key of ["exit_conditions", "exit_evidence_receipt_ids", "exit_evidence_artifact_refs"]) delete step[key];
    delete legacy.scope_state;
    delete legacy.id_counters.next_scope;
    delete legacy.id_counters.next_scope_change;
    delete legacy.id_counters.next_approval;
    const migrated = migrateTaskState(legacy);
    assert.ok(migrated);
    assert.equal(isTaskStateV2(migrated), true);
    assert.deepEqual(migrated.evidence_packs, original.evidence_packs);
    assert.equal(migrated.scope_state.active_scope, undefined);
    assert.equal(migrated.id_counters.next_scope, 1);
  } finally {
    cleanup(cwd);
  }
});

function createCommandHarness(cwd, { hasUI = true, confirm = true, select = "agentic", activeTools = [], sessionManager } = {}) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const notifications = [];
  const entries = [];
  const setActiveCalls = [];
  const pi = {
    registerFlag() {},
    getFlag() { return false; },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    getAllTools() { return ["bash", "read", "grep", "find", "ls"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(next) { activeTools.splice(0, activeTools.length, ...next); setActiveCalls.push([...next]); },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data, id: `entry-${entries.length + 1}` }); sessionManager?.appendCustomEntry(customType, data); },
    sendUserMessage() {},
  };
  reliabilityExtension(pi);
  const ctx = {
    cwd,
    hasUI,
    isProjectTrusted: () => true,
    sessionManager: sessionManager ?? {
      getBranch: () => entries,
      getSessionId: () => "scope-command-session",
      getSessionFile: () => join(cwd, "scope-command-session.jsonl"),
    },
    ui: {
      notify(message, level = "info") { notifications.push({ message, level }); },
      confirm: async () => confirm,
      select: async () => select,
      setStatus() {},
      setWidget() {},
      theme: { fg: (_color, text) => text, bold: (text) => text, strikethrough: (text) => text },
    },
  };
  const emit = async (name, event = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  return { commands, tools, emit, ctx, notifications, activeTools, setActiveCalls, entries };
}

test("native confirmation creates one exact approval while headless approval remains blocked", async () => {
  const cwd = tempCwd();
  const headlessCwd = tempCwd();
  try {
    const harness = createCommandHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on bounded approval command", harness.ctx);
    const scopeTool = harness.tools.get("reliability_scope");
    await scopeTool.execute("scope-set", scopeInput({ allowedTools: ["bash"], allowedReadPaths: [], allowedWritePaths: [], externalSideEffects: "approval-required" }), undefined, undefined, harness.ctx);
    await harness.commands.get("reliability").handler("scope approve SC1", harness.ctx);
    const check = await scopeTool.execute("scope-check", { action: "check", candidateTool: "bash", candidateInput: { command: "deploy --target test" } }, undefined, undefined, harness.ctx);
    const request = await scopeTool.execute("scope-request", {
      action: "request-approval",
      description: "Run the bounded deployment command.",
      toolName: "bash",
      normalizedEffect: check.details.decision.normalized_effect,
      reversible: true,
    }, undefined, undefined, harness.ctx);
    await harness.commands.get("reliability").handler(`approval approve ${request.details.approvalId}`, harness.ctx);
    const approved = await harness.emit("tool_call", { toolCallId: "approved-bash", toolName: "bash", input: { command: "deploy --target test" } });
    assert.equal(approved.some((result) => result?.block), false);

    const headless = createCommandHarness(headlessCwd, { hasUI: false });
    await headless.emit("session_start");
    await headless.commands.get("reliability").handler("on headless approval command", headless.ctx);
    const headlessScope = headless.tools.get("reliability_scope");
    await headlessScope.execute("headless-scope", scopeInput({ allowedTools: ["bash"], allowedReadPaths: [], allowedWritePaths: [], externalSideEffects: "approval-required" }), undefined, undefined, headless.ctx);
    await headless.commands.get("reliability").handler("scope approve SC1", headless.ctx);
    const blocked = await headless.emit("tool_call", { toolCallId: "headless-bash", toolName: "bash", input: { command: "deploy --target test" } });
    assert.equal(blocked.some((result) => result?.block), true);
    assert.match(headless.notifications.at(-1).message, /headless|single-use|validation/i);
  } finally {
    cleanup(cwd);
    cleanup(headlessCwd);
  }
});

test("optional phase focus preserves other owners and never resurrects disabled tools", async () => {
  const cwd = tempCwd();
  try {
    const harness = createCommandHarness(cwd, {
      activeTools: ["read", "third_party_tool", "reliability_scope", "reliability_status", "reliability_evidence"],
    });
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on focus controls", harness.ctx);
    await harness.commands.get("reliability").handler("focus", harness.ctx);
    assert.deepEqual(harness.activeTools, ["read", "third_party_tool", "reliability_scope", "reliability_status"]);
    assert.equal(harness.activeTools.includes("reliability_gate"), false, "a user-disabled future tool must stay disabled");
    await harness.commands.get("reliability").handler("focus off", harness.ctx);
    assert.equal(harness.activeTools.includes("reliability_evidence"), false, "focus-off must not restore a stale active-tool snapshot");
    assert.equal(harness.setActiveCalls.length, 1, "stable default focus-off does not mutate the catalog");
  } finally {
    cleanup(cwd);
  }
});

test("installed AgentSession native scope confirmation permits an approved in-scope write", async () => {
  const cwd = tempCwd();
  const agentDir = tempCwd();
  let session;
  try {
    initTheme(undefined, false);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const provider = fauxProvider({ provider: "scope-approval", api: "scope-approval" });
    modelRuntime.registerNativeProvider(provider.provider);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "approved.txt", content: "approved through native scope confirmation\n" }, { id: "approved-write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The approved file was written."),
    ]);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [{ name: "scope-approval", factory: reliabilityExtension }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir,
      model: provider.getModel(),
      modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
      tools: ["write", "reliability_scope"],
    });
    session = created.session;
    await session.prompt("/reliability on write one bounded approved file");

    const command = session.extensionRunner.getCommand("reliability");
    const scopeDefinition = session.extensionRunner.getToolDefinition("reliability_scope");
    assert.ok(command);
    assert.ok(scopeDefinition);
    const baseCommandContext = session.extensionRunner.createCommandContext();
    const commandContext = Object.create(baseCommandContext);
    const nativeUi = Object.create(baseCommandContext.ui);
    nativeUi.confirm = async () => true;
    nativeUi.notify = () => {};
    Object.defineProperties(commandContext, {
      hasUI: { value: true },
      ui: { value: nativeUi },
    });
    await scopeDefinition.execute("installed-scope-set", scopeInput({
      allowedTools: ["write"],
      allowedReadPaths: [],
      allowedWritePaths: ["."],
      externalSideEffects: "forbidden",
    }), undefined, undefined, commandContext);
    await command.handler("scope approve SC1", commandContext);

    const preflight = await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "installed-approved-preflight",
      toolName: "write",
      input: { path: "approved.txt", content: "approved through native scope confirmation\n" },
    });
    assert.equal(preflight?.block, undefined, "the installed runner accepts a native-authorized in-scope write before execution");
    await session.sendCustomMessage({ customType: "fixture-continuation", content: "Write the approved file now.", display: false }, { triggerTurn: true });
    await session.waitForIdle();
    assert.equal(existsSync(join(cwd, "approved.txt")), true);

    const taskEntry = (await (await import("node:fs/promises")).readdir(join(cwd, ".pi", "tasks"), { withFileTypes: true })).find((entry) => entry.isDirectory());
    assert.ok(taskEntry);
    const state = JSON.parse(await (await import("node:fs/promises")).readFile(join(cwd, ".pi", "tasks", taskEntry.name, "state.json"), "utf8"));
    assert.equal(state.scope_state.active_scope.authority, "native-confirmation");
    assert.ok(state.scope_state.active_scope.authority_entry_id);
    assert.equal(state.scope_state.usage.tool_calls_used >= 2, true);
  } finally {
    session?.dispose();
    cleanup(cwd);
    cleanup(agentDir);
  }
});

test("installed AgentSession fake-provider flow registers scope and blocks an out-of-scope write before execution", async () => {
  const cwd = tempCwd();
  const agentDir = tempCwd();
  let session;
  try {
    writeFileSync(join(cwd, "allowed.txt"), "allowed content\n");
    initTheme(undefined, false);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const provider = fauxProvider({ provider: "scope-flow", api: "scope-flow" });
    modelRuntime.registerNativeProvider(provider.provider);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("reliability_scope", scopeInput({ allowedTools: ["read"], allowedWritePaths: [], externalSideEffects: "forbidden" }), { id: "scope-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The scope is now established."),
      fauxAssistantMessage(fauxToolCall("read", { path: "allowed.txt" }, { id: "read-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The allowed file was read."),
      fauxAssistantMessage(fauxToolCall("write", { path: "blocked.txt", content: "must not exist" }, { id: "write-call" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The attempted write was blocked."),
    ]);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [{ name: "scope-flow", factory: reliabilityExtension }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir,
      model: provider.getModel(),
      modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
      tools: ["read", "write", "reliability_scope"],
    });
    session = created.session;
    assert.equal(created.extensionsResult.errors.length, 0);
    const scopeTool = session.extensionRunner.getAllRegisteredTools().find((candidate) => candidate.definition.name === "reliability_scope");
    assert.ok(scopeTool);
    assert.equal(scopeTool.definition.parameters.type, "object");
    assert.deepEqual(scopeTool.definition.parameters.properties.action.enum, ["set", "request-approval", "status", "check"]);

    await session.prompt("/reliability on run a bounded fake-provider scope flow");
    await session.sendCustomMessage({ customType: "fixture-continuation", content: "Establish the scope now.", display: false }, { triggerTurn: true });
    await session.waitForIdle();
    await session.sendCustomMessage({ customType: "fixture-continuation", content: "Read the allowed file now.", display: false }, { triggerTurn: true });
    await session.waitForIdle();
    await session.sendCustomMessage({ customType: "fixture-continuation", content: "Continue after the allowed read.", display: false }, { triggerTurn: true });
    await session.waitForIdle();
    await session.sendCustomMessage({ customType: "fixture-continuation", content: "Attempt the forbidden write now.", display: false }, { triggerTurn: true });
    await session.waitForIdle();
    await session.sendCustomMessage({ customType: "fixture-continuation", content: "Proceed with the requested write now.", display: false }, { triggerTurn: true });
    await session.waitForIdle();
    const blockedWrite = await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "installed-scope-blocked-write",
      toolName: "write",
      input: { path: "blocked.txt", content: "must not exist" },
    });
    assert.equal(blockedWrite?.block, true, "the installed runner blocks the out-of-scope write before execution");

    const taskRoot = join(cwd, ".pi", "tasks");
    const fsPromises = await import("node:fs/promises");
    const taskEntry = (await fsPromises.readdir(taskRoot, { withFileTypes: true })).find((entry) => entry.isDirectory());
    assert.ok(taskEntry);
    const state = JSON.parse(await fsPromises.readFile(join(taskRoot, taskEntry.name, "state.json"), "utf8"));
    assert.deepEqual(state.scope_state.active_scope.allowed_tools, ["read"]);
    assert.ok(state.scope_state.usage.tool_calls_used >= 2, "the read and blocked write are both counted as attempts");
    assert.ok(state.scope_state.usage.blocked_tool_calls >= 1);
    assert.equal(existsSync(join(cwd, "blocked.txt")), false);
  } finally {
    session?.dispose();
    cleanup(cwd);
    cleanup(agentDir);
  }
});


test("RF1 A01 registered searches reject forbidden and runtime-owned descendants without consuming preview budgets", async () => {
  const cwd = tempCwd();
  try {
    const harness = createCommandHarness(cwd);
    await harness.emit("session_start");
    await harness.commands.get("reliability").handler("on bounded search", harness.ctx);
    const scope = harness.tools.get("reliability_scope");
    await scope.execute("set", scopeInput({ allowedTools: ["read", "grep", "find", "ls"], allowedReadPaths: ["."], allowedWritePaths: [], forbiddenPaths: ["public/private"] }), undefined, undefined, harness.ctx);
    await harness.commands.get("reliability").handler("scope approve SC1", harness.ctx);
    const state = (await harness.tools.get("reliability_status").execute()).details.task;
    const before = state.scope_state.usage.tool_calls_used;
    for (const tool of ["grep", "find"]) {
      for (const path of ["public", ".", ".pi"]) {
        const result = await scope.execute("check", { action: "check", candidateTool: tool, candidateInput: { path, pattern: "*", glob: "*.ts" } }, undefined, undefined, harness.ctx);
        assert.equal(result.details.decision.allowed, false, `${tool} ${path}`);
        assert.match(result.details.decision.reason, /descendant|recursive|runtime-owned/i);
      }
      const safe = await scope.execute("check", { action: "check", candidateTool: tool, candidateInput: { path: "public/safe", pattern: "*" } }, undefined, undefined, harness.ctx);
      assert.equal(safe.details.decision.allowed, true);
    }
    assert.equal(state.scope_state.usage.tool_calls_used, before);
    const blocked = await harness.emit("tool_call", { toolCallId: "blocked-recursive", toolName: "grep", input: { path: "public", pattern: "." } });
    assert.ok(blocked.some((r) => r?.block));
    const noScope = createTaskState(cwd, "Protected reads without scope", undefined, normalizeConfig({}));
    assert.equal(evaluateScopeToolCall(noScope, "grep", { path: ".", pattern: "." }, normalizeConfig({}), { trustedTool: true }).allowed, false);
  } finally { cleanup(cwd); }
});

for (const action of ["reject-after-approve", "remove-approval", "remove-receipt", "wrong-session"]) {
  test(`RF1 A02 registered semantic review ${action} cannot reuse historical approval`, async () => {
    const cwd = tempCwd();
    try {
      writeFileSync(join(cwd, "output.json"), JSON.stringify({ format: "enum", semantic: "human-review-required", values: ["ok"] }));
      const harness = createCommandHarness(cwd);
      const command = (text) => harness.commands.get("reliability").handler(text, harness.ctx);
      await harness.emit("session_start");
      await command("on bounded output");
      await command("output-contract output.json");
      const gate = harness.tools.get("reliability_gate");
      await gate.execute("validate", { action: "validate-output", contractId: "OC1", candidate: "ok" }, undefined, undefined, harness.ctx);
      await command("gate review OV1 approve");
      // A normal registered control synchronizes all current receipt expectations.
      await gate.execute("status", { action: "status" }, undefined, undefined, harness.ctx);
      const state = (await harness.tools.get("reliability_status").execute()).details.task;
      assert.equal(evaluateStructuredOutputCompletionRequirement(state, false).decision, "pass");
      if (action === "reject-after-approve") await command("gate review OV1 reject");
      if (action === "remove-approval") harness.entries.splice(harness.entries.findIndex((e) => e.customType === "reliability-quality-gate-resolution"), 1);
      if (action === "wrong-session") harness.ctx.sessionManager.getSessionId = () => "another-session";
      await gate.execute("status2", { action: "status" }, undefined, undefined, harness.ctx);
      if (action === "remove-receipt") state.current_session.quality_gate_resolution_receipts = [];
      assert.equal(evaluateStructuredOutputCompletionRequirement(state, false).decision, "escalate");
    } finally { cleanup(cwd); }
  });
}

test("RF1 A02 resolved escalation needs its current native resolution receipt at consumption", async () => {
  const cwd = tempCwd();
  try {
    const harness = createCommandHarness(cwd);
    const command = (text) => harness.commands.get("reliability").handler(text, harness.ctx);
    await harness.emit("session_start");
    await command("on bounded escalation");
    const gate = harness.tools.get("reliability_gate");
    await gate.execute("escalate", { action: "escalate", reason: "Need review", decisionNeeded: "Inspect result" }, undefined, undefined, harness.ctx);
    await command("gate resolve QGE1 approve");
    const state = (await harness.tools.get("reliability_status").execute()).details.task;
    assert.equal(assessTaskCompletion(state).reasons.some((r) => /quality escalation/.test(r)), false);
    harness.entries.splice(harness.entries.findIndex((e) => e.customType === "reliability-quality-gate-resolution"), 1);
    await gate.execute("status", { action: "status" }, undefined, undefined, harness.ctx);
    assert.equal(assessTaskCompletion(state).reasons.some((r) => /quality escalation/.test(r)), true);
  } finally { cleanup(cwd); }
});

for (const change of ["workspace", "criterion", "session", "branch", "none"]) {
  test(`RF1 A10 native attestation confirmation binds ${change}`, async () => {
    const cwd = tempCwd();
    try {
      writeFileSync(join(cwd, "result.txt"), "observed result");
      const harness = createCommandHarness(cwd);
      const command = (text) => harness.commands.get("reliability").handler(text, harness.ctx);
      await harness.emit("session_start");
      await command("on attest observed behavior");
      const state = (await harness.tools.get("reliability_status").execute()).details.task;
      let release;
      harness.ctx.ui.confirm = () => new Promise((resolve) => { release = resolve; });
      const pending = command("attest C1 User observed behavior");
      assert.equal(typeof release, "function");
      if (change === "workspace") writeFileSync(join(cwd, "result.txt"), "unreviewed result");
      if (change === "criterion") { state.criteria[0].requirement = "Changed requirement"; state.success_criteria[0] = "Changed requirement"; }
      if (change === "session") harness.ctx.sessionManager.getSessionId = () => "different-session";
      if (change === "branch") harness.entries.push({ type: "message", id: "other-branch-entry" });
      release(true);
      await pending;
      const attestation = harness.entries.find((e) => e.customType === "reliability-user-attestation");
      if (change === "none") {
        assert.ok(state.criterion_results.some((r) => r.criterion_id === "C1" && r.fresh));
        assert.ok(attestation?.data.workspace_revision, "persist the confirmed revision identity");
        assert.ok(attestation?.data.criterion_hash);
      } else {
        assert.equal(state.criterion_results.some((r) => r.criterion_id === "C1" && r.fresh), false);
        assert.equal(attestation, undefined, "no authority receipt for changed identity");
        assert.match(harness.notifications.at(-1).message, /changed|stale|identity/i);
      }
    } finally { cleanup(cwd); }
  });
}


for (const kind of ["escalation", "semantic-review"]) {
  for (const drift of ["task", "target", "session", "branch", "input", "input-pause", "decision", "cancel", "none"]) {
    test(`RF3 quality-gate native ${kind} confirmation rejects ${drift} drift`, async () => {
      const cwd = tempCwd();
      try {
        writeFileSync(join(cwd, "output.json"), JSON.stringify({ format: "enum", semantic: "human-review-required", values: ["ok"] }));
        const manager = SessionManager.inMemory(cwd);
        const harness = createCommandHarness(cwd, { sessionManager: manager });
        const command = text => harness.commands.get("reliability").handler(text, harness.ctx);
        const task = async () => (await harness.tools.get("reliability_status").execute()).details.task;
        const gate = (id, input) => harness.tools.get("reliability_gate").execute(id, input, undefined, undefined, harness.ctx);
        const setupTarget = async () => {
          if (kind === "escalation") await gate("escalate", { action: "escalate", reason: "Review the exact result", decisionNeeded: "Inspect this result before proceeding" });
          else {
            await command("output-contract output.json");
            await gate("validate", { action: "validate-output", contractId: "OC1", candidate: "ok" });
          }
        };
        await harness.emit("session_start");
        await command("on Original quality decision owner");
        await setupTarget();
        const original = await task();
        const target = kind === "escalation" ? original.quality_gate.escalations[0] : original.structured_output.validations[0];
        const action = kind === "escalation" ? "resolve QGE1" : "review OV1";
        let release;
        let disclosure;
        harness.ctx.ui.confirm = (_title, body) => { disclosure = body; return new Promise(resolve => { release = resolve; }); };
        const pending = command(`gate ${action} approve`);
        assert.equal(typeof release, "function");
        harness.ctx.ui.confirm = async () => true;
        if (drift === "task") { await command("on Replacement quality decision owner"); await setupTarget(); }
        if (drift === "target") {
          if (kind === "escalation") target.decision_needed = "A different decision";
          else target.reasons.push("A different review requirement");
        }
        if (drift === "session") harness.ctx.sessionManager = { getBranch: () => manager.getBranch(), getSessionId: () => "different-session" };
        if (drift === "branch") manager.appendMessage({ role: "user", content: "Another branch entry", timestamp: Date.now() });
        if (drift === "input" || drift === "input-pause") {
          await harness.emit("input", { text: "Recheck the requirements", source: "interactive" });
          if (drift === "input") await command("input confirm");
        }
        if (drift === "decision") await command(`gate ${action} reject`);
        const before = manager.getEntries().filter(e => e.customType === "reliability-quality-gate-resolution").length;
        release(drift !== "cancel");
        await pending;
        const receipts = manager.getEntries().filter(e => e.customType === "reliability-quality-gate-resolution");
        assert.equal(receipts.length, before + (drift === "none" ? 1 : 0), "stale/canceled UI must not mint authority, including duplicate dialogs");
        assert.equal((await task()).quality_gate.resolutions.length, drift === "none" || drift === "decision" ? 1 : 0);
        if (drift === "decision") assert.equal(original.quality_gate.resolutions[0].decision, "rejected");
        if (drift === "none") {
          assert.ok(disclosure.includes(original.task_id));
          assert.ok(disclosure.includes(target.id));
          assert.ok(disclosure.includes(kind === "escalation" ? target.decision_needed : target.candidate_sha256));
        }
      } finally { cleanup(cwd); }
    });
  }
}

test("RF3 escalation can receive a new native decision after branch removal without reviving history", async () => {
  const cwd = tempCwd();
  try {
    const manager = SessionManager.inMemory(cwd);
    const harness = createCommandHarness(cwd, { sessionManager: manager });
    const command = text => harness.commands.get("reliability").handler(text, harness.ctx);
    const task = async () => (await harness.tools.get("reliability_status").execute()).details.task;
    await harness.emit("session_start");
    await command("on Resolve on the current branch");
    await harness.tools.get("reliability_gate").execute("escalate", { action: "escalate", reason: "Need review", decisionNeeded: "Inspect result" }, undefined, undefined, harness.ctx);
    const beforeResolution = manager.getLeafId();
    await command("gate resolve QGE1 approve");
    const original = structuredClone((await task()).quality_gate.resolutions[0]);
    const count = () => manager.getEntries().filter(e => e.customType === "reliability-quality-gate-resolution").length;
    manager.branch(beforeResolution);
    await command("gate final");
    assert.ok(assessTaskCompletion(await task()).reasons.some(reason => /quality escalation/.test(reason)));
    await command("gate resolve QGE1 reject");
    const state = await task();
    assert.equal(state.quality_gate.resolutions.length, 2);
    assert.deepEqual(state.quality_gate.resolutions[0], original);
    assert.equal(state.quality_gate.escalations[0].resolution_id, "QGR2");
    assert.equal(state.quality_gate.escalations[0].status, "rejected");
    assert.deepEqual(state.current_session.quality_gate_resolution_receipts.map(r => r.resolution_id), ["QGR2"]);
    assert.equal(assessTaskCompletion(state).reasons.some(reason => /quality escalation/.test(reason)), false);
    await command(`resume ${state.task_id}`);
    await command("gate resolve QGE1 approve");
    assert.equal(count(), 2, "already-current decisions are refused before receipt append");
  } finally { cleanup(cwd); }
});

async function rf3CodingFixture(cwd, commands = ["npm test"]) {
  const manager = SessionManager.inMemory(cwd);
  const harness = createCommandHarness(cwd, { sessionManager: manager });
  const command = text => harness.commands.get("reliability").handler(text, harness.ctx);
  const task = async () => (await harness.tools.get("reliability_status").execute()).details.task;
  const gate = (id, input) => harness.tools.get("reliability_gate").execute(id, input, undefined, undefined, harness.ctx);
  await harness.emit("session_start");
  await command("on Validate the current coding requirements");
  await harness.tools.get("reliability_scope").execute("scope", scopeInput({ lane: "coding", allowedReadPaths: [cwd], allowedWritePaths: [cwd], validationCommands: commands }), undefined, undefined, harness.ctx);
  await command("scope approve SC1");
  for (const check of commands) await command(`map C1 bash ${check}`);
  let sequence = 0;
  // Simulated built-in results, reconciled through the registered gate against real SessionManager entries.
  const run = async check => {
    const state = await task();
    const id = `rf3-check-${++sequence}`;
    const input = { command: check };
    const host = { host_provenance: "pi-builtin-bash", session: state.current_session };
    recordToolCall(state, id, "bash", input, host);
    const receipt = updateToolResult(state, id, "bash", input, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, host);
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "Tests: 1 passed" }], isError: false, timestamp: Date.now() });
    await gate(`sync-${id}`, { action: "status" });
    assert.ok(receipt.session_anchor_entry_id);
    return receipt;
  };
  const reaffirm = async () => {
    await harness.emit("input", { text: "Rerun every mandatory check for these requirements", source: "interactive" });
    await command("input confirm");
    assert.equal((await task()).input_pause, undefined);
  };
  const assess = async () => { await command("gate coding"); return assessTaskCompletion(await task(), undefined, { purpose: "coding" }); };
  return { manager, harness, command, task, gate, run, reaffirm, assess };
}

for (const invalidation of ["branch", "reaffirmation"]) {
  test(`RF3 coding host reviews require current native verification after ${invalidation}`, async () => {
    const cwd = tempCwd();
    try {
      writeFileSync(join(cwd, "auth.ts"), "export const allowed = false;\n");
      const f = await rf3CodingFixture(cwd);
      writeFileSync(join(cwd, "auth.ts"), "export const allowed = true;\n");
      await f.run("npm test");
      await f.assess();
      const review = (await f.task()).coding_boundary.review_dispositions.find(r => r.kind === "security");
      assert.ok(review);
      const beforeAttestation = f.manager.getLeafId();
      await f.command(`attest ${review.criterion_id} Inspected this exact security diff`);
      assert.equal((await f.assess()).decision, "pass");
      if (invalidation === "branch") f.manager.branch(beforeAttestation);
      else { await f.reaffirm(); await f.run("npm test"); }
      const assessment = await f.assess();
      assert.notEqual(assessment.decision, "pass");
      assert.ok(assessment.reasons.some(reason => /review.*current|review.*pending/i.test(reason)));
      await f.command(`attest ${review.criterion_id} Reinspected the exact security diff`);
      assert.equal((await f.assess()).decision, "pass", "fresh user review restores only coding eligibility");
      assert.notEqual(assessTaskCompletion(await f.task()).decision, "pass", "unrelated future criteria still block final, not coding");
    } finally { cleanup(cwd); }
  });
}

test("RF3 shared-criterion coding commands each require post-reaffirmation native receipts across reload and identical corrections", async () => {
  const cwd = tempCwd();
  try {
    const f = await rf3CodingFixture(cwd, ["npm test", "npm run typecheck"]);
    await f.run("npm test");
    await f.run("npm run typecheck");
    assert.equal((await f.assess()).decision, "pass");
    const originalReceipts = structuredClone((await f.task()).execution_receipts);
    const originalRevision = (await f.task()).workspace_revision.digest;
    for (let generation = 1; generation <= 2; generation++) {
      await f.reaffirm();
      assert.equal((await f.task()).authoritative_instructions.corrections.length, generation);
      assert.equal((await f.task()).workspace_revision.digest, originalRevision);
      await f.run("npm test");
      const assessment = await f.assess();
      assert.notEqual(assessment.decision, "pass", "one rerun must not certify the other pre-correction command");
      assert.ok(assessment.reasons.some(reason => reason.includes("npm run typecheck")));
      const state = await f.task();
      assert.deepEqual(state.execution_receipts.slice(0, originalReceipts.length), originalReceipts, "parsed historical outcomes remain immutable");
      await f.command(`resume ${state.task_id}`);
      assert.notEqual((await f.assess()).decision, "pass", "reload cannot restore old command currency");
      await f.run("npm run typecheck");
      assert.equal((await f.assess()).decision, "pass");
    }
  } finally { cleanup(cwd); }
});

test("RF3 native mapping retirement preserves receipts, claims and counters through assessment and reload", async () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "parser.test.ts"), "export const value = 1;\n");
    const f = await rf3CodingFixture(cwd);
    writeFileSync(join(cwd, "parser.test.ts"), "export const value = 2;\n");
    await f.assess();
    const review = (await f.task()).coding_boundary.review_dispositions[0];
    await f.command(`map ${review.criterion_id} bash npm test`);
    await f.gate("claim", { action: "record", gate: "coding", criterion: review.criterion_id, status: "passed", evidence: "Historical model claim" });
    await f.run("npm test");
    const before = JSON.parse(JSON.stringify(await f.task()));
    writeFileSync(join(cwd, "parser.test.ts"), "export const value = 3;\n");
    await f.assess();
    const state = await f.task();
    assert.equal(state.trusted_check_mappings.some(m => m.criterion_id === review.criterion_id), false);
    assert.equal(isTaskStateV2(state), true);
    assert.deepEqual(state.execution_receipts, before.execution_receipts);
    assert.deepEqual(state.quality_gate.claims, before.quality_gate.claims);
    assert.deepEqual(state.counters, before.counters);
    assert.deepEqual(state.scope_state.usage, before.scope_state.usage);
    assert.equal(state.id_counters.next_mapping, before.id_counters.next_mapping);
    await f.command(`resume ${state.task_id}`);
    const current = await f.task();
    assert.ok(current.retired_criterion_ids.includes(review.criterion_id));
    await f.run("npm test");
    const receipt = (await f.task()).execution_receipts.at(-1);
    assert.deepEqual(receipt.criterion_ids, ["C1"], "retired mapping cannot promote replacement host review");
    assert.notEqual((await f.assess()).decision, "pass");
  } finally { cleanup(cwd); }
});

test("RF1 A02 installed SessionManager branch navigation and task reload require the latest native receipt", async () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "output.json"), JSON.stringify({ format: "enum", semantic: "human-review-required", values: ["ok"] }));
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage({ role: "user", content: "Review this output", timestamp: Date.now() });
    const harness = createCommandHarness(cwd, { sessionManager: manager });
    const command = (text) => harness.commands.get("reliability").handler(text, harness.ctx);
    const task = async () => (await harness.tools.get("reliability_status").execute()).details.task;
    await harness.emit("session_start");
    await command("on review output");
    await command("output-contract output.json");
    await harness.tools.get("reliability_gate").execute("validate", { action: "validate-output", contractId: "OC1", candidate: "ok" }, undefined, undefined, harness.ctx);
    const validationAnchor = manager.getLeafId();
    await command("gate review OV1 approve");
    const approvalAnchor = manager.getLeafId();
    const id = (await task()).task_id;
    await command(`resume ${id}`);
    await command("gate structured-output");
    assert.equal((await task()).current_session.quality_gate_resolution_receipts.length, 1);
    assert.equal(evaluateStructuredOutputCompletionRequirement(await task(), false).decision, "pass");
    manager.branch(validationAnchor);
    await command("gate structured-output");
    assert.equal(evaluateStructuredOutputCompletionRequirement(await task(), false).decision, "escalate");
    manager.branch(approvalAnchor);
    await command("gate structured-output");
    assert.equal(evaluateStructuredOutputCompletionRequirement(await task(), false).decision, "pass");
    await command("gate review OV1 reject");
    await command(`resume ${id}`);
    await command("gate structured-output");
    assert.equal(evaluateStructuredOutputCompletionRequirement(await task(), false).decision, "escalate");
    // Removing the latest rejection cannot resurrect an earlier approval.
    manager.branch(approvalAnchor);
    await command("gate structured-output");
    assert.equal(evaluateStructuredOutputCompletionRequirement(await task(), false).decision, "escalate");
  } finally { cleanup(cwd); }
});
