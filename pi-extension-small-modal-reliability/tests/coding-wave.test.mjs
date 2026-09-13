import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyReliabilityScopeAction,
  assessCodingChanges,
  assessTaskCompletion,
  approveScopeChange,
  bindCodingBoundaryScope,
  buildContextHeader,
  captureCodingBoundary,
  codingRepairMutationBlockReason,
  codingReviewKinds,
  completePlanStep,
  createDependencyEvidence,
  createTaskState,
  ensureCodingReviewCriteria,
  evaluateCodingCompletionRequirement,
  evaluateMicroplanCompletion,
  loadTaskState,
  normalizeConfig,
  projectRangeAllows,
  recordAuthoritativeCorrection,
  recordQualityGateClaim,
  isTaskStateV2,
  replaceTaskCriteria,
  recordScopeToolResult,
  recordToolCall,
  recordUserAttestation,
  replacePlan,
  saveTaskState,
  updateToolResult,
} from "../src/core.ts";

const config = normalizeConfig({});
const HOST = { host_provenance: "host-tool" };

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "pi-reliability-coding-wave-"));
}

function cleanup(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

function setReadScope(state, cwd) {
  applyReliabilityScopeAction(state, {
    action: "set",
    lane: "coding",
    allowedTools: ["read"],
    allowedReadPaths: [cwd],
    allowedWritePaths: [],
    forbiddenPaths: [],
    maxToolCalls: config.scope.maxToolCalls,
    maxErrors: config.scope.maxErrors,
    maxIterations: config.scope.maxIterations,
    externalSideEffects: "forbidden",
    validationCommands: [],
    stopConditions: [],
    escalationConditions: [],
  }, config);
}

function setCodingMutationScope(state, cwd) {
  const result = applyReliabilityScopeAction(state, {
    action: "set",
    lane: "coding",
    allowedTools: ["read", "edit", "bash"],
    allowedReadPaths: [cwd],
    allowedWritePaths: [cwd],
    forbiddenPaths: [],
    maxToolCalls: config.scope.maxToolCalls,
    maxErrors: config.scope.maxErrors,
    maxIterations: config.scope.maxIterations,
    externalSideEffects: "forbidden",
    validationCommands: ["npm test"],
    stopConditions: [],
    escalationConditions: [],
  }, config);
  assert.ok(result.scope_change);
  approveScopeChange(state, result.scope_change.id, "native-confirmation", new Date(), {});
}

function hostRead(state, callId, path) {
  recordToolCall(state, callId, "read", { path }, HOST);
  const receipt = updateToolResult(state, callId, "read", { path }, false, "read", "read", config, undefined, HOST);
  recordScopeToolResult(state, receipt, { path });
  return receipt;
}

function hostEdit(state, callId, path, oldText, newText) {
  const input = { path, oldText, newText };
  recordToolCall(state, callId, "edit", input, HOST);
  const file = join(state.cwd, path);
  writeFileSync(file, readFileSync(file, "utf8").replace(oldText, newText));
  return updateToolResult(state, callId, "edit", input, false, "edited", "edited", config, undefined, HOST);
}

function hostVerification(state, callId, passed) {
  const input = { command: "npm test" };
  const context = { host_provenance: "pi-builtin-bash" };
  recordToolCall(state, callId, "bash", input, context);
  return updateToolResult(state, callId, "bash", input, !passed, passed ? "Tests: 1 passed" : "Tests: 1 failed", passed ? "Tests: 1 passed" : "Tests: 1 failed", config, { exitCode: passed ? 0 : 1 }, context);
}

function evidencePack(state) {
  return {
    schema_version: 1,
    pack_id: "E1",
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    question: "Version contract",
    requirements: [],
    limits: { max_sources: 1, max_passages: 1, max_passages_per_source: 4, max_passage_chars: 2000, max_claims: 1 },
    sources: [{ source_id: "src", title: "Installed source", locator: join(state.cwd, "node_modules", "dep", "types.d.ts"), source_kind: "local-file", retrieved_at: new Date().toISOString(), passages: [{ passage_id: "p1", text: "export declare const api: string;" }] }],
    claims: [],
    dependencies: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

test("complex plan rejects a foreign receipt and accepts only a reducer-created current step receipt", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "target.ts"), "export const target = 1;\n");
    const state = createTaskState(cwd, "Repair the parser behavior.", undefined, config);
    captureCodingBoundary(state);
    setReadScope(state, cwd);
    replacePlan(state, [{
      step_id: "repair",
      title: "Repair parser",
      allowed_scope: { allowed_tools: ["read"], allowed_read_paths: [cwd], allowed_write_paths: [] },
      exit_conditions: [{ kind: "observed-tool-result", description: "Host observed the target read." }],
    }], true);
    state.execution_receipts.push({
      id: "R999",
      task_id: "other-task",
      branch_id: "other-branch",
      batch_id: "B999",
      tool_call_id: "foreign",
      step_id: "repair",
      operation: "read",
      input_hash: "foreign",
      outcome: "success",
      execution_observed: true,
      host_provenance: "host-tool",
      cwd,
      workspace_revision_before: state.workspace_revision.digest,
      workspace_revision_after: state.workspace_revision.digest,
      criterion_ids: [], artifact_refs: [join(cwd, "target.ts")], resource_refs: [join(cwd, "target.ts")], batch_settled: true,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    });
    assert.throws(() => completePlanStep(state, "repair", { receipt_ids: ["R999"] }), /task-, branch-, step-, scope-, and revision-bound/i);

    const receipt = hostRead(state, "read-target", "target.ts");
    completePlanStep(state, "repair", { receipt_ids: [receipt.id] });
    assert.equal(state.plan[0].status, "complete");
  } finally {
    cleanup(cwd);
  }
});

test("normal inspect-edit-verify microplan preserves historical stage evidence while final verification stays current", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "target.ts"), "export const target = 1;\n");
    const state = createTaskState(cwd, "Repair target.", undefined, config);
    captureCodingBoundary(state);
    setCodingMutationScope(state, cwd);
    replacePlan(state, [
      { step_id: "inspect", title: "Inspect", allowed_scope: { allowed_tools: ["read"], allowed_read_paths: [cwd], allowed_write_paths: [] }, exit_conditions: [{ kind: "observed-tool-result", description: "Read target." }] },
      { step_id: "edit", title: "Edit", depends_on: ["inspect"], allowed_scope: { allowed_tools: ["edit"], allowed_read_paths: [], allowed_write_paths: [cwd] }, exit_conditions: [{ kind: "artifact-produced", description: "Produce target.", artifact_refs: [join(cwd, "target.ts")] }] },
      { step_id: "verify", title: "Verify", depends_on: ["edit"], allowed_scope: { allowed_tools: ["bash"], allowed_read_paths: [], allowed_write_paths: [] }, exit_conditions: [{ kind: "observed-tool-result", description: "Run final tests." }] },
    ], true);

    const inspected = hostRead(state, "inspect-target", "target.ts");
    completePlanStep(state, "inspect", { receipt_ids: [inspected.id] });
    const edited = hostEdit(state, "edit-target", "target.ts", "= 1", "= 2");
    completePlanStep(state, "edit", { receipt_ids: [edited.id], artifact_refs: [join(cwd, "target.ts")] });
    const verified = hostVerification(state, "verify-target", true);
    completePlanStep(state, "verify", { receipt_ids: [verified.id] });
    assert.equal(evaluateMicroplanCompletion(state), undefined);
  } finally {
    cleanup(cwd);
  }
});

test("authoritative exact correction invalidates passing evidence and preserves trusted provenance", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Initial request.\nFinal constraint: preserve API compatibility.", undefined, config);
    for (const criterion of state.criteria) recordUserAttestation(state, criterion.id, "User observed the criterion.", `attestation:${criterion.id}`);
    assert.equal(assessTaskCompletion(state, "explicit").decision, "pass");
    const exact = "  Later user correction: do not change the exported type.  ";
    assert.equal(recordAuthoritativeCorrection(state, exact, { origin: "interactive", session_id: "session-1", session_entry_id: "entry-1" }), true);
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
    for (const contextMode of ["full", "compact", "delta"]) {
      const header = buildContextHeader(state, normalizeConfig({ contextMode })).header;
      assert.match(header, /  Later user correction: do not change the exported type\.  /);
      assert.match(header, /interactive \(entry-1\)/);
    }
  } finally {
    cleanup(cwd);
  }
});

test("baseline capture rejects symlinked .pi/tasks ancestors without outside writes", () => {
  const cwd = tempCwd();
  const outside = tempCwd();
  try {
    mkdirSync(join(cwd, ".pi"));
    symlinkSync(outside, join(cwd, ".pi", "tasks"));
    const state = createTaskState(cwd, "Repair safely.", undefined, config);
    captureCodingBoundary(state);
    assert.equal(state.coding_boundary.status, "missing");
    assert.match(state.coding_boundary.reason, /ancestor.*symlink|real directory/i);
    assert.equal(existsSync(join(outside, state.task_id)), false);
  } finally {
    cleanup(cwd);
    cleanup(outside);
  }
});

test("exact-diff review lifecycle supersedes old records, remains saveable, and detects security filenames", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "parser.test.ts"), "export const version = 1;\n");
    const state = createTaskState(cwd, "Repair tests.", undefined, config);
    captureCodingBoundary(state);
    for (const version of [2, 3, 4]) {
      writeFileSync(join(cwd, "parser.test.ts"), `export const version = ${version};\n`);
      ensureCodingReviewCriteria(state, assessCodingChanges(state));
    }
    const activeReviews = state.criteria.filter((criterion) => criterion.origin === "host-coding-review");
    assert.equal(activeReviews.length, 1);
    assert.equal(state.coding_boundary.review_dispositions.length, 3);
    assert.equal(state.coding_boundary.review_dispositions.filter((review) => review.status === "superseded").length, 2);
    saveTaskState(state, "review-lifecycle");
    assert.equal(loadTaskState(cwd, state.task_id)?.coding_boundary.review_dispositions.filter((review) => review.status === "superseded").length, 2);
    assert.deepEqual(codingReviewKinds([{ path: "src/auth.ts", kind: "modified" }, { path: "src/permission/check.ts", kind: "modified" }]), ["security"]);
  } finally {
    cleanup(cwd);
  }
});

test("repair accounting permits multi-file cycles, ignores failed/read-only actions, survives reload, and blocks only a third cycle", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "one.ts"), "export const one = 1;\n");
    writeFileSync(join(cwd, "two.ts"), "export const two = 1;\n");
    writeFileSync(join(cwd, "three.ts"), "export const three = 1;\n");
    const state = createTaskState(cwd, "Repair target.", undefined, config);
    captureCodingBoundary(state);

    hostVerification(state, "initial-failure", false);
    hostVerification(state, "repeated-before-repair", false);
    assert.equal(state.coding_boundary.repair_intervals[0].cycles.length, 0);
    recordToolCall(state, "read-error", "read", { path: "one.ts" }, HOST);
    updateToolResult(state, "read-error", "read", { path: "one.ts" }, true, "read failed", "read failed", config, undefined, HOST);
    recordToolCall(state, "failed-write", "edit", { path: "one.ts", oldText: "= 1", newText: "= x" }, HOST);
    updateToolResult(state, "failed-write", "edit", { path: "one.ts", oldText: "= 1", newText: "= x" }, true, "write failed", "write failed", config, undefined, HOST);
    assert.equal(state.coding_boundary.repair_intervals[0].cycles.length, 0);

    hostEdit(state, "cycle-one-file-one", "one.ts", "= 1", "= 2");
    hostEdit(state, "cycle-one-file-two", "two.ts", "= 1", "= 2");
    assert.equal(state.coding_boundary.repair_intervals[0].cycles.length, 1);
    assert.equal(state.coding_boundary.repair_intervals[0].cycles[0].mutation_receipt_ids.length, 2);
    hostVerification(state, "cycle-one-failure", false);
    assert.equal(state.coding_boundary.repair_intervals[0].cycles[0].outcome, "failed");

    hostEdit(state, "cycle-two-file-one", "three.ts", "= 1", "= 2");
    hostEdit(state, "cycle-two-file-two", "one.ts", "= 2", "= 3");
    assert.equal(codingRepairMutationBlockReason(state, "edit"), undefined);
    hostVerification(state, "cycle-two-failure", false);
    saveTaskState(state, "repair-cycle-reload");
    const reloaded = loadTaskState(cwd, state.task_id);
    assert.ok(reloaded);
    assert.equal(reloaded.coding_boundary.repair_intervals[0].cycles.length, 2);
    assert.match(codingRepairMutationBlockReason(reloaded, "edit"), /two failed repair cycles/i);
    hostVerification(reloaded, "stable-pass", true);
    assert.equal(codingRepairMutationBlockReason(reloaded, "edit"), undefined);
  } finally {
    cleanup(cwd);
  }
});

test("non-code and unsupported imports require an exact current local-only review rather than a silent exemption", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "README.md"), "before\n");
    writeFileSync(join(cwd, "alias.ts"), "export const value = 1;\n");
    const state = createTaskState(cwd, "Update local documentation and aliases.", undefined, config);
    captureCodingBoundary(state);
    setCodingMutationScope(state, cwd);
    bindCodingBoundaryScope(state);
    writeFileSync(join(cwd, "README.md"), "after\n");
    writeFileSync(join(cwd, "alias.ts"), "import value from '#local/value';\nexport { value };\n");
    const first = evaluateCodingCompletionRequirement(state);
    assert.equal(first?.decision, "escalate");
    const firstReview = state.coding_boundary.review_dispositions.find((review) => review.kind === "local-only");
    assert.ok(firstReview);
    writeFileSync(join(cwd, "README.md"), "after again\n");
    evaluateCodingCompletionRequirement(state);
    assert.equal(firstReview.status, "superseded");
    assert.equal(state.coding_boundary.review_dispositions.filter((review) => review.kind === "local-only" && review.status !== "superseded").length, 1);
  } finally {
    cleanup(cwd);
  }
});

test("coding gate rejects absent scope and installed/lock disagreement using receipt-bound reads", () => {
  const cwd = tempCwd();
  try {
    mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { dep: "^1.0.0" } }));
    writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ packages: { "node_modules/dep": { version: "1.0.0" } } }));
    writeFileSync(join(cwd, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", version: "2.0.0" }));
    writeFileSync(join(cwd, "node_modules", "dep", "types.d.ts"), "export declare const api: string;\n");
    const state = createTaskState(cwd, "Update coding behavior.", undefined, config);
    state.lane = "coding";
    assert.equal(evaluateCodingCompletionRequirement(state)?.decision, "escalate");

    captureCodingBoundary(state);
    setReadScope(state, cwd);
    for (const path of ["package.json", "package-lock.json", "node_modules/dep/package.json", "node_modules/dep/types.d.ts"]) hostRead(state, `read-${path}`, path);
    assert.throws(() => createDependencyEvidence(state, evidencePack(state), {
      package: "dep",
      installedVersion: "1.0.0",
      manifestPath: "node_modules/dep/package.json",
      lockfilePath: "package-lock.json",
      sourceKind: "installed-types",
      sourceId: "src",
      passageIds: ["p1"],
    }, new Date().toISOString()), /manifestPath identifies dep@2\.0\.0/i);
  } finally {
    cleanup(cwd);
  }
});

test("dependency record supports an optional lockfile only when installed, project, source, and receipt evidence agree", () => {
  const cwd = tempCwd();
  try {
    mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { dep: "^0.1.0" } }));
    writeFileSync(join(cwd, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", version: "0.1.5" }));
    writeFileSync(join(cwd, "node_modules", "dep", "types.d.ts"), "export declare const api: string;\n");
    const state = createTaskState(cwd, "Use dependency API.", undefined, config);
    captureCodingBoundary(state);
    setReadScope(state, cwd);
    for (const path of ["package.json", "node_modules/dep/package.json", "node_modules/dep/types.d.ts"]) hostRead(state, `read-${path}`, path);
    const dependency = createDependencyEvidence(state, evidencePack(state), {
      package: "dep",
      installedVersion: "0.1.5",
      manifestPath: "node_modules/dep/package.json",
      sourceKind: "installed-types",
      sourceId: "src",
      passageIds: ["p1"],
    }, new Date().toISOString());
    assert.equal(dependency.status, "verified");
    assert.ok(dependency.source_content_sha256);
    assert.ok(dependency.source_receipt_id);
    assert.equal(projectRangeAllows("^0.1.0", "0.2.0"), false);
    assert.equal(projectRangeAllows("^0.1.0", "0.1.5"), true);
    assert.equal(projectRangeAllows("^1.0.0", "1.0.1-beta.1"), undefined);
  } finally {
    cleanup(cwd);
  }
});


test("RF1 A06 all three exact-diff review kinds save and reload alongside eight user criteria", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "auth.test.ts"), "export const before = 1;\n");
    const state = createTaskState(cwd, "Review the authentication test.", undefined, config);
    replaceTaskCriteria(state, Array.from({ length: 8 }, (_, i) => `User requirement ${i + 1}`));
    state.lane = "coding";
    const userCriteria = structuredClone(state.criteria);
    captureCodingBoundary(state);
    writeFileSync(join(cwd, "auth.test.ts"), "export const after = import(name);\n");
    evaluateCodingCompletionRequirement(state);
    assert.deepEqual(state.coding_boundary.review_dispositions.map((r) => r.kind), ["test-integrity", "security", "local-only"]);
    assert.equal(isTaskStateV2(state), true);
    saveTaskState(state, "rf1-three-reviews");
    const reloaded = loadTaskState(cwd, state.task_id);
    assert.deepEqual(reloaded.criteria.filter((c) => c.origin !== "host-coding-review"), userCriteria);
    assert.equal(reloaded.criteria.length, 11);
  } finally { cleanup(cwd); }
});

test("RF1 A07 retired review claims remain non-authoritative saveable history", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "parser.test.ts"), "export const value = 1;\n");
    const state = createTaskState(cwd, "Review parser tests.", undefined, config);
    captureCodingBoundary(state);
    writeFileSync(join(cwd, "parser.test.ts"), "export const value = 2;\n");
    const [review] = ensureCodingReviewCriteria(state, assessCodingChanges(state));
    recordQualityGateClaim(state, { action: "record", gate: "coding", criterion: review.id, status: "passed", evidence: "Model claim, not approval" });
    const originalClaim = structuredClone(state.quality_gate.claims[0]);
    writeFileSync(join(cwd, "parser.test.ts"), "export const value = 3;\n");
    ensureCodingReviewCriteria(state, assessCodingChanges(state));
    assert.equal(isTaskStateV2(state), true);
    saveTaskState(state, "rf1-retired-review");
    const reloaded = loadTaskState(cwd, state.task_id);
    assert.deepEqual(reloaded.quality_gate.claims, [originalClaim]);
    assert.ok(reloaded.retired_criterion_ids.includes(review.id));
    assert.equal(reloaded.criteria.some((c) => c.id === review.id), false);
    assert.notEqual(assessTaskCompletion(reloaded).decision, "pass");
    reloaded.quality_gate.claims[0].criterion_id = "C9999";
    assert.equal(isTaskStateV2(reloaded), false, "arbitrary dangling IDs remain invalid");
  } finally { cleanup(cwd); }
});

for (const attack of ["decoy manifest", "invented passage", "different installed root", "nested installed dependency"]) {
  test(`RF1 A08 dependency evidence rejects ${attack}`, () => {
    const cwd = tempCwd();
    try {
      mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
      mkdirSync(join(cwd, "nested", "node_modules", "dep"), { recursive: true });
      mkdirSync(join(cwd, "node_modules", "dep", "node_modules", "other"), { recursive: true });
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { dep: "^1.0.0" } }));
      writeFileSync(join(cwd, "node_modules/dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
      writeFileSync(join(cwd, "decoy.json"), JSON.stringify({ name: "dep", version: "1.9.0" }));
      for (const path of ["node_modules/dep/types.d.ts", "nested/node_modules/dep/types.d.ts", "node_modules/dep/node_modules/other/types.d.ts"]) writeFileSync(join(cwd, path), "export declare const api: string;\n");
      const state = createTaskState(cwd, "Use actual installed API.", undefined, config);
      setReadScope(state, cwd);
      for (const path of ["package.json", "decoy.json", "node_modules/dep/package.json", "node_modules/dep/types.d.ts", "nested/node_modules/dep/types.d.ts", "node_modules/dep/node_modules/other/types.d.ts"]) hostRead(state, `read-${path}`, path);
      const pack = evidencePack(state);
      if (attack === "invented passage") pack.sources[0].passages[0].text = "export declare function invented(): never;";
      if (attack === "nested installed dependency") pack.sources[0].locator = join(cwd, "node_modules/dep/node_modules/other/types.d.ts");
      if (attack === "different installed root") pack.sources[0].locator = join(cwd, "nested/node_modules/dep/types.d.ts");
      let result;
      try {
        result = createDependencyEvidence(state, pack, {
          package: "dep", installedVersion: attack === "decoy manifest" ? "1.9.0" : "1.0.0",
          manifestPath: attack === "decoy manifest" ? "decoy.json" : "node_modules/dep/package.json",
          sourceKind: "installed-types", sourceId: "src", passageIds: ["p1"],
        }, new Date().toISOString());
      } catch (error) { assert.match(error.message, /installed|passage|package/i); return; }
      assert.equal(result.status, "unknown");
    } finally { cleanup(cwd); }
  });
}

test("RF2 coding gate requires mapped current runtime validation but excludes unrelated report criteria", async () => {
  const { addTrustedCheckMapping, computeVerification } = await import("../src/core.ts");
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Validate code", undefined, config);
    captureCodingBoundary(state);
    setCodingMutationScope(state, cwd);
    bindCodingBoundaryScope(state);
    assert.notEqual(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass");
    for (const criterion of state.criteria) recordUserAttestation(state, criterion.id, "Manually checked", `a:${criterion.id}`);
    assert.notEqual(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass", "manual-only does not exempt coding validation");
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    hostVerification(state, "failed", false);
    assert.equal(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "fail");
    hostVerification(state, "passed", true);
    assert.equal(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass");
    writeFileSync(join(cwd, "local.js"), "export const local = 1;\n");
    assert.notEqual(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass");
    hostVerification(state, "fresh", true);
    assert.equal(computeVerification(state).find(c => c.criterion_id === "C2").status, "unknown");
    assert.equal(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass");
  } finally { cleanup(cwd); }
});

test("RF2 mapped validation cannot auto-promote custom executable S3", async () => {
  const { addTrustedCheckMapping } = await import("../src/core.ts");
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Validate work", undefined, config);
    replacePlan(state, [{ step_id: "S3", title: "Verify output", depends_on: [], allowed_scope: { allowed_tools: ["bash"], allowed_read_paths: [], allowed_write_paths: [] }, exit_conditions: [{ kind: "criteria-passed", criterion_ids: ["C2"], description: "Requires C2, not C1" }] }], true);
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    hostVerification(state, "check", true);
    assert.notEqual(state.plan[0].status, "complete");
  } finally { cleanup(cwd); }
});

test("RF2 two commands mapped to one criterion cannot hide a parsed failure behind exit zero", async () => {
  const { addTrustedCheckMapping } = await import("../src/core.ts");
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Validate code", undefined, config);
    captureCodingBoundary(state);
    setCodingMutationScope(state, cwd);
    bindCodingBoundaryScope(state);
    state.scope_state.active_scope.validation_commands.push("npm run typecheck");
    state.scope_state.authoritative_scope.validation_commands.push("npm run typecheck");
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm run typecheck", created_by: "host" });
    const run = (id, command, output) => {
      const host = { host_provenance: "pi-builtin-bash" };
      recordToolCall(state, id, "bash", { command }, host);
      return updateToolResult(state, id, "bash", { command }, false, output, output, config, { exitCode: 0 }, host);
    };
    assert.equal(run("failed-parser", "npm test", "Tests: 1 failed").validation_status, "failed");
    run("other-passed", "npm run typecheck", "No errors");
    assert.notEqual(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass");
    run("both-passed", "npm test", "Tests: 1 passed");
    assert.equal(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass");
  } finally { cleanup(cwd); }
});

test("RF2 receipt validation status is schema-v2 validated; absent history cannot fabricate coding pass", async () => {
  const { addTrustedCheckMapping } = await import("../src/core.ts");
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Validate code", undefined, config);
    captureCodingBoundary(state);
    setCodingMutationScope(state, cwd);
    bindCodingBoundaryScope(state);
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    let receipt = hostVerification(state, "current", true);
    assert.equal(receipt.validation_status, "passed");
    saveTaskState(state, "parsed_validation_observed");
    assert.equal(loadTaskState(cwd, state.task_id).execution_receipts.at(-1).validation_status, "passed");
    receipt = state.execution_receipts.at(-1);
    assert.equal(isTaskStateV2(state), true);
    receipt.validation_status = "invented";
    assert.equal(isTaskStateV2(state), false);
    delete receipt.validation_status;
    assert.equal(isTaskStateV2(state), true);
    assert.equal(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass", "current runtime result proves this exact historical receipt");
    recordUserAttestation(state, "C1", "Manually checked", "manual");
    assert.notEqual(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass", "manual attestation cannot reconstruct the missing runtime status");
    receipt.validation_status = "passed";
    hostVerification(state, "new-current", true);
    writeFileSync(join(cwd, "changed.js"), "export const changed = true;\n");
    assert.notEqual(assessTaskCompletion(state, undefined, { purpose: "coding" }).decision, "pass", "retained status never overrides revision freshness");
  } finally { cleanup(cwd); }
});

test("RF2 JavaScript failure-only summaries retain terminal counts without requiring a trailing separator", async () => {
  const { parseVerificationResult } = await import("../src/core.ts");
  for (const label of ["Tests:", "Test Files"]) {
    for (const suffix of ["", "\n", "\u001b[0m"]) {
      const parsed = parseVerificationResult("npm test", `\u001b[31m${label} 1 failed${suffix}`, false);
      assert.equal(parsed.status, "failed", `${label} terminal suffix ${JSON.stringify(suffix)}`);
      assert.equal(parsed.counts.failed, 1);
    }
    for (const text of [`${label} 1 failed, 2 passed`, `${label} 1 failed | 2 passed`]) {
      const parsed = parseVerificationResult("npm test", text, false);
      assert.equal(parsed.status, "failed");
      assert.equal(parsed.counts.failed, 1);
      assert.equal(parsed.counts.passed, 2);
    }
    assert.equal(parseVerificationResult("npm test", `${label} 0 failed`, false).status, "passed");
    assert.equal(parseVerificationResult("npm test", `${label} 0 failed, 2 passed`, false).status, "passed");
    assert.equal(parseVerificationResult("npm test", `${label} 0 failed, 2 passed`, true).status, "failed");
  }
});
