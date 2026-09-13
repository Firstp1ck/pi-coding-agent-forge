import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyReliabilityEvidenceAction,
  assessEvidencePack,
  assessTaskCompletion,
  createTaskState,
  evaluateRetrievalEvidenceRequirement,
  evidencePackPath,
  executeReliabilityEvidenceTransaction,
  formatEvidenceActionResult,
  isTaskStateV2,
  loadTaskState,
  migrateTaskState,
  normalizeConfig,
  readEvidencePack,
  recordUserAttestation,
  saveTaskState,
} from "../src/core.ts";

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "pi-reliability-evidence-"));
}

function cleanup(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

const CLOCK = new Date("2026-09-12T12:00:00.000Z");

function setupState(cwd, goal = "Answer the evidence-backed question.") {
  writeFileSync(join(cwd, "source.txt"), "authoritative local source\n");
  return createTaskState(cwd, goal, undefined, normalizeConfig({}));
}

function startPack(state, freshness, options = {}) {
  return applyReliabilityEvidenceAction(state, {
    action: "start",
    question: "What does the source establish?",
    requirements: ["Use exact source passages."],
    freshness,
  }, normalizeConfig({}), { now: CLOCK, ...options });
}

function addSource(state, options = {}) {
  return applyReliabilityEvidenceAction(state, {
    action: "add-source",
    packId: state.active_evidence_pack_id,
    sourceId: options.sourceId ?? "S1",
    title: options.title ?? "Local source",
    locator: options.locator ?? "source.txt",
    sourceKind: options.sourceKind ?? "local-file",
    publishedAt: options.publishedAt,
    retrievedAt: options.retrievedAt ?? CLOCK.toISOString(),
    passages: options.passages ?? [{ passageId: options.passageId ?? "P1", text: options.text ?? "The local source establishes the requested fact.", location: "line 1" }],
  }, normalizeConfig({}), { now: CLOCK });
}

function addMaterialClaim(state, options = {}) {
  return applyReliabilityEvidenceAction(state, {
    action: "add-claim",
    packId: state.active_evidence_pack_id,
    claimId: options.claimId ?? "C1",
    claim: options.claim ?? "The requested fact is supported by the local source.",
    material: options.material ?? true,
    support: options.support ?? [{ sourceId: options.sourceId ?? "S1", passageIds: options.passageIds ?? ["P1"] }],
    contradicts: options.contradicts,
  }, normalizeConfig({}), { now: CLOCK });
}

function bindRevision(state, result, session, receiptId) {
  const summary = result.summary;
  const receipt = {
    entry_id: receiptId,
    task_id: state.task_id,
    pack_id: summary.pack_id,
    sha256: summary.sha256,
    action: result.action,
  };
  return {
    session: {
      ...session,
      branch_entry_ids: [...session.branch_entry_ids, receiptId],
      evidence_revision_receipts: [...(session.evidence_revision_receipts ?? []), receipt],
      lifecycle_identity: "available",
      observed_at: CLOCK.toISOString(),
    },
    receipt,
  };
}

function transactEvidence(state, input, session, receiptId, commit = (result) => saveTaskState(state, `evidence_${result.action}`)) {
  return executeReliabilityEvidenceTransaction(
    state,
    input,
    normalizeConfig({}),
    commit,
    {
      now: CLOCK,
      session,
      finalizeRevision: (result) => bindRevision(state, result, session, receiptId),
    },
  );
}

test("evidence packs preserve exact passages, reload atomically, and expose compact assessment state", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    const started = startPack(state, { maxAgeDays: 5, basis: "publishedAt" });
    assert.equal(started.pack_id, "E1");
    const exactPassage = "Exact first line.\n  Exact indented second line.  ";
    addSource(state, { publishedAt: "2026-09-07T12:00:00.000Z", text: exactPassage });
    addMaterialClaim(state);

    const pack = readEvidencePack(state, "E1");
    assert.equal(pack.sources[0].passages[0].text, exactPassage);
    const assessment = assessEvidencePack(pack, CLOCK);
    assert.equal(assessment.outcome, "supported");
    assert.equal(assessment.integrity_passed, true);
    assert.equal(assessment.semantic_review_required, true);
    assert.equal(assessment.freshness_status, "fresh");
    assert.equal(evaluateRetrievalEvidenceRequirement(state, { now: CLOCK })?.decision, "pass");

    applyReliabilityEvidenceAction(state, { action: "assess", packId: "E1" }, normalizeConfig({}), { now: CLOCK });
    assert.equal(state.evidence_packs[0].assessment?.outcome, "supported");
    assert.equal(state.evidence_packs[0].assessment?.semantic_review_required, true);
    saveTaskState(state, "evidence-reload-fixture");
    const loaded = loadTaskState(cwd, state.task_id);
    assert.equal(loaded?.evidence_packs[0].pack_id, "E1");
    assert.equal(readEvidencePack(loaded, "E1").sources[0].passages[0].text, exactPassage);
  } finally {
    cleanup(cwd);
  }
});

test("invalid evidence actions and cross-task pack IDs preserve authoritative task state", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    startPack(state);
    const packPath = join(cwd, ".pi", "tasks", state.task_id, "evidence", "E1.json");
    const beforeState = JSON.stringify(state);
    const beforePack = readFileSync(packPath, "utf8");

    assert.throws(() => addSource(state, { passages: [{ passageId: "P1", text: "" }] }), /non-empty/i);
    assert.equal(JSON.stringify(state), beforeState);
    assert.equal(readFileSync(packPath, "utf8"), beforePack);

    addSource(state);
    const afterSourceState = JSON.stringify(state);
    const afterSourcePack = readFileSync(packPath, "utf8");
    assert.throws(() => addSource(state, { sourceId: "S1", passageId: "P2" }), /already exists/i);
    assert.equal(JSON.stringify(state), afterSourceState);
    assert.equal(readFileSync(packPath, "utf8"), afterSourcePack);

    const other = setupState(cwd, "A distinct task needs separate evidence.");
    assert.throws(() => applyReliabilityEvidenceAction(other, {
      action: "add-source",
      packId: "E1",
      sourceId: "S2",
      title: "Cross task source",
      locator: "source.txt",
      sourceKind: "local-file",
      retrievedAt: CLOCK.toISOString(),
      passages: [{ passageId: "P2", text: "No cross-task import is permitted." }],
    }, normalizeConfig({}), { now: CLOCK }), /does not belong to this task/i);
    assert.equal(other.evidence_packs.length, 0);
  } finally {
    cleanup(cwd);
  }
});

test("a malformed persisted pack cannot change task state through assessment", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    startPack(state);
    addSource(state);
    addMaterialClaim(state);
    const packPath = join(cwd, ".pi", "tasks", state.task_id, "evidence", "E1.json");
    const malformed = JSON.parse(readFileSync(packPath, "utf8"));
    malformed.limits.max_sources = 0;
    const bytes = `${JSON.stringify(malformed, null, 2)}\n`;
    writeFileSync(packPath, bytes);
    state.evidence_packs[0].sha256 = createHash("sha256").update(bytes).digest("hex");
    const before = JSON.stringify(state);

    assert.throws(() => applyReliabilityEvidenceAction(state, {
      action: "assess",
      packId: "E1",
    }, normalizeConfig({}), { now: CLOCK }), /maxSources must be an integer/i);
    assert.equal(JSON.stringify(state), before);
  } finally {
    cleanup(cwd);
  }
});

test("source locators permit canonical external metadata while evidence storage rejects ancestor symlinks", () => {
  const cwd = tempCwd();
  const outside = tempCwd();
  try {
    writeFileSync(join(outside, "outside.txt"), "outside\n");
    const state = setupState(cwd);
    startPack(state);
    addSource(state, { locator: `@${join(outside, "outside.txt")}` });
    assert.equal(readEvidencePack(state, "E1").sources[0].locator, join(outside, "outside.txt"));
    assert.throws(() => addSource(state, { sourceId: "S2", passageId: "P2", locator: "ftp://example.test/source" }), /HTTP\(S\)/i);

    const guarded = setupState(tempCwd(), "Ancestor symlinks must not redirect evidence.");
    const guardedCwd = guarded.cwd;
    const redirected = tempCwd();
    mkdirSync(join(guardedCwd, ".pi"));
    symlinkSync(redirected, join(guardedCwd, ".pi", "tasks"));
    assert.throws(() => startPack(guarded), /ancestor.*symlink|real directory/i);
    assert.equal(existsSync(join(redirected, guarded.task_id, "evidence", "E1.json")), false);
    cleanup(redirected);
    cleanup(guardedCwd);
  } finally {
    cleanup(cwd);
    cleanup(outside);
  }
});

test("evidence reads never create absent directories and reject dangling ancestor symlinks", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    assert.throws(() => evidencePackPath(state, "E1"), /does not exist/i);
    assert.equal(existsSync(join(cwd, ".pi")), false);
    mkdirSync(join(cwd, ".pi"));
    symlinkSync(join(cwd, "missing-tasks"), join(cwd, ".pi", "tasks"));
    assert.throws(() => evidencePackPath(state, "E1"), /real directory|symlink/i);
    assert.equal(existsSync(join(cwd, "missing-tasks", state.task_id, "evidence", "E1.json")), false);
  } finally {
    cleanup(cwd);
  }
});

test("freshness policy observes boundary, stale, missing-date, and no-policy cases", () => {
  const cwd = tempCwd();
  try {
    const boundary = setupState(cwd);
    startPack(boundary, { maxAgeDays: 5, basis: "publishedAt" });
    addSource(boundary, { publishedAt: "2026-09-07T12:00:00.000Z" });
    addMaterialClaim(boundary);
    assert.equal(assessEvidencePack(readEvidencePack(boundary, "E1"), CLOCK).freshness_status, "fresh");

    const stale = setupState(cwd, "A stale source must be surfaced.");
    startPack(stale, { maxAgeDays: 5, basis: "publishedAt" });
    addSource(stale, { publishedAt: "2026-09-06T11:59:59.999Z" });
    addMaterialClaim(stale);
    assert.equal(assessEvidencePack(readEvidencePack(stale, "E1"), CLOCK).freshness_status, "stale");
    assert.equal(evaluateRetrievalEvidenceRequirement(stale, { now: CLOCK })?.decision, "escalate");

    const missingDate = setupState(cwd, "A missing publication date must remain unresolved.");
    startPack(missingDate, { maxAgeDays: 5, basis: "publishedAt" });
    addSource(missingDate);
    addMaterialClaim(missingDate);
    assert.equal(assessEvidencePack(readEvidencePack(missingDate, "E1"), CLOCK).freshness_status, "unknown");
    assert.equal(evaluateRetrievalEvidenceRequirement(missingDate, { now: CLOCK })?.decision, "escalate");

    const noPolicy = setupState(cwd, "No freshness policy does not claim currentness.");
    startPack(noPolicy);
    addSource(noPolicy, { publishedAt: "2020-01-01T00:00:00.000Z" });
    addMaterialClaim(noPolicy);
    const noPolicyAssessment = assessEvidencePack(readEvidencePack(noPolicy, "E1"), CLOCK);
    assert.equal(noPolicyAssessment.freshness_status, "not-constrained");
    assert.equal(evaluateRetrievalEvidenceRequirement(noPolicy, { now: CLOCK })?.decision, "pass");
  } finally {
    cleanup(cwd);
  }
});

test("unresolved conflicts escalate, a report-conflict disposition remains honest, and citation gaps fail", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    startPack(state);
    addSource(state, { sourceId: "S1", passageId: "P1", text: "The feature is enabled." });
    addSource(state, { sourceId: "S2", passageId: "P2", text: "The feature is disabled." });
    addMaterialClaim(state, {
      support: [{ sourceId: "S1", passageIds: ["P1"] }],
      contradicts: [{ sourceId: "S2", passageIds: ["P2"] }],
    });
    assert.equal(evaluateRetrievalEvidenceRequirement(state, { now: CLOCK })?.decision, "escalate");

    applyReliabilityEvidenceAction(state, {
      action: "disposition-conflict",
      packId: "E1",
      claimId: "C1",
      disposition: "report-conflict",
      rationale: "The cited sources disagree; the response will state that disagreement.",
    }, normalizeConfig({}), { now: CLOCK });
    const assessed = assessEvidencePack(readEvidencePack(state, "E1"), CLOCK);
    assert.equal(assessed.outcome, "conflicting");
    assert.equal(assessed.integrity_passed, true);
    assert.equal(evaluateRetrievalEvidenceRequirement(state, { now: CLOCK })?.decision, "pass");

    const missing = setupState(cwd, "An unsupported material claim must fail.");
    startPack(missing);
    addSource(missing);
    addMaterialClaim(missing, { support: [] });
    assert.equal(assessEvidencePack(readEvidencePack(missing, "E1"), CLOCK).outcome, "insufficient");
    assert.equal(evaluateRetrievalEvidenceRequirement(missing, { now: CLOCK })?.decision, "fail");
  } finally {
    cleanup(cwd);
  }
});

test("all retained packs remain mandatory completion inputs and direct completion cannot bypass retrieval", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    recordUserAttestation(state, "C1", "User confirmed the base task criterion.", "user-confirmed");
    startPack(state);
    addSource(state);
    addMaterialClaim(state, { support: [] });
    assert.equal(evaluateRetrievalEvidenceRequirement(state, { now: CLOCK })?.decision, "fail");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "fail");

    startPack(state);
    addSource(state);
    addMaterialClaim(state);
    const requirement = evaluateRetrievalEvidenceRequirement(state, { now: CLOCK });
    assert.equal(requirement?.decision, "fail");
    assert.match(requirement?.reasons.join(" ") ?? "", /\[E1\].*no resolved supporting passage/i);
    assert.equal(assessTaskCompletion(state, "explicit").decision, "fail");
  } finally {
    cleanup(cwd);
  }
});

test("assess returns bounded actual issue and escalation details while full output retains claim metadata", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    startPack(state);
    addSource(state, { sourceId: "S1", passageId: "P1", text: "The enabled result." });
    addSource(state, { sourceId: "S2", passageId: "P2", text: "The disabled result." });
    addMaterialClaim(state, {
      support: [{ sourceId: "S1", passageIds: ["P1"] }],
      contradicts: [{ sourceId: "S2", passageIds: ["P2"] }],
    });
    applyReliabilityEvidenceAction(state, {
      action: "disposition-conflict",
      packId: "E1",
      claimId: "C1",
      disposition: "escalate",
      rationale: "The sources are irreconcilable without an authorized decision.",
    }, normalizeConfig({}), { now: CLOCK });
    const result = applyReliabilityEvidenceAction(state, { action: "assess", packId: "E1" }, normalizeConfig({}), { now: CLOCK });
    assert.deepEqual(result.assessment?.explicit_escalation_claim_ids, ["C1"]);
    assert.match(result.assessment?.issues.join(" ") ?? "", /explicitly requires escalation/i);
    const full = applyReliabilityEvidenceAction(state, { action: "get", packId: "E1", view: "full" }, normalizeConfig({}), { now: CLOCK });
    assert.match(formatEvidenceActionResult(full, "full"), /Claim C1 \(material\)[\s\S]*support=S1:P1; conflicts=S2:P2; disposition=escalate/i);
  } finally {
    cleanup(cwd);
  }
});

test("evidence transactions restore prior pack and summary when state persistence fails", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    startPack(state);
    saveTaskState(state, "transaction-baseline");
    const packPath = join(cwd, ".pi", "tasks", state.task_id, "evidence", "E1.json");
    const beforeState = JSON.stringify(state);
    const beforePack = readFileSync(packPath, "utf8");
    assert.throws(() => executeReliabilityEvidenceTransaction(state, {
      action: "add-source",
      packId: "E1",
      sourceId: "S1",
      title: "Local source",
      locator: "source.txt",
      sourceKind: "local-file",
      retrievedAt: CLOCK.toISOString(),
      passages: [{ passageId: "P1", text: "Transactional source text." }],
    }, normalizeConfig({}), () => {
      throw new Error("injected state save failure");
    }, { now: CLOCK }), /injected state save failure/);
    assert.equal(JSON.stringify(state), beforeState);
    assert.equal(readFileSync(packPath, "utf8"), beforePack);
    assert.equal(existsSync(`${packPath}.transaction.json`), false);
  } finally {
    cleanup(cwd);
  }
});

test("a failed receipt-bound assessment never reports an unchanged prior hash as a committed revision", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "source.txt"), "authoritative local source\n");
    const initialSession = { session_id: "session-A", branch_entry_ids: ["root", "task-anchor"], lifecycle_identity: "available", observed_at: CLOCK.toISOString() };
    const state = createTaskState(cwd, "A receipt-bound transaction must remain atomic.", undefined, normalizeConfig({}), initialSession);
    transactEvidence(state, {
      action: "start",
      question: "What does the source establish?",
      requirements: ["Use exact source passages."],
    }, initialSession, "create-receipt");
    const packPath = join(cwd, ".pi", "tasks", state.task_id, "evidence", "E1.json");
    const beforeState = JSON.stringify(state);
    const beforePack = readFileSync(packPath, "utf8");

    assert.throws(() => executeReliabilityEvidenceTransaction(state, {
      action: "assess",
      packId: "E1",
    }, normalizeConfig({}), () => {
      throw new Error("injected state save failure after receipt append");
    }, {
      now: CLOCK,
      session: state.current_session,
      finalizeRevision: (result) => bindRevision(state, result, state.current_session, "failed-assessment-receipt"),
    }), (error) => {
      assert.equal(error.state_committed, undefined);
      return /injected state save failure after receipt append/.test(error.message);
    });
    assert.equal(JSON.stringify(state), beforeState);
    assert.equal(readFileSync(packPath, "utf8"), beforePack);
    assert.equal(existsSync(`${packPath}.transaction.json`), false);
  } finally {
    cleanup(cwd);
  }
});

test("journal recovery restores a pre-commit pack revision after restart", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    startPack(state);
    addSource(state);
    saveTaskState(state, "journal-recovery-baseline");
    const packPath = join(cwd, ".pi", "tasks", state.task_id, "evidence", "E1.json");
    const beforeBytes = readFileSync(packPath, "utf8");
    const beforeHash = createHash("sha256").update(beforeBytes).digest("hex");
    addMaterialClaim(state);
    const afterBytes = readFileSync(packPath, "utf8");
    assert.notEqual(afterBytes, beforeBytes);
    writeFileSync(`${packPath}.transaction.json`, `${JSON.stringify({
      schema_version: 1,
      task_id: state.task_id,
      pack_id: "E1",
      previous_summary_sha256: beforeHash,
      previous_pack_base64: Buffer.from(beforeBytes, "utf8").toString("base64"),
    })}\n`);
    const recovered = loadTaskState(cwd, state.task_id);
    assert.ok(recovered);
    assert.equal(readEvidencePack(recovered, "E1").claims.length, 0);
    assert.equal(readFileSync(packPath, "utf8"), beforeBytes);
    assert.equal(existsSync(`${packPath}.transaction.json`), false);
  } finally {
    cleanup(cwd);
  }
});

test("each evidence revision requires its finalized Pi receipt, including after branch navigation", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "source.txt"), "authoritative local source\n");
    const beforePack = { session_id: "session-A", branch_entry_ids: ["root", "before-pack"], lifecycle_identity: "available", observed_at: CLOCK.toISOString() };
    const state = createTaskState(cwd, "Session-bound evidence is required.", undefined, normalizeConfig({}), beforePack);
    const started = transactEvidence(state, {
      action: "start",
      question: "What does the source establish?",
      requirements: ["Use exact source passages."],
    }, beforePack, "create-receipt");
    assert.equal(started.summary.revision_receipt_entry_id, "create-receipt");
    assert.equal(readEvidencePack(state, "E1").session_id, "session-A");

    const beforeCreateBranch = { session_id: "session-A", branch_entry_ids: ["root"], lifecycle_identity: "available", observed_at: CLOCK.toISOString() };
    const createBlocked = createTaskState(cwd, "A navigated branch cannot start evidence.", undefined, normalizeConfig({}), beforePack);
    createBlocked.current_session = beforeCreateBranch;
    assert.throws(() => executeReliabilityEvidenceTransaction(createBlocked, {
      action: "start",
      question: "What does the source establish?",
      requirements: ["Use exact source passages."],
    }, normalizeConfig({}), () => {}, {
      now: CLOCK,
      session: beforeCreateBranch,
      finalizeRevision: (result) => bindRevision(createBlocked, result, beforeCreateBranch, "blocked-create-receipt"),
    }), /outside the task's persisted Pi branch/i);
    assert.equal(createBlocked.evidence_packs.length, 0);

    const afterCreate = state.current_session;
    state.current_session = beforePack;
    const packPath = join(cwd, ".pi", "tasks", state.task_id, "evidence", "E1.json");
    const beforeUpdate = readFileSync(packPath, "utf8");
    assert.throws(() => transactEvidence(state, {
      action: "add-source",
      packId: "E1",
      sourceId: "S1",
      title: "Local source",
      locator: "source.txt",
      sourceKind: "local-file",
      retrievedAt: CLOCK.toISOString(),
      passages: [{ passageId: "P1", text: "The source supports continuation." }],
    }, beforePack, "blocked-update-receipt"), /finalized Pi revision receipt|persisted Pi branch revision/i);
    assert.equal(readFileSync(packPath, "utf8"), beforeUpdate);
    state.current_session = afterCreate;

    const continued = transactEvidence(state, {
      action: "add-source",
      packId: "E1",
      sourceId: "S1",
      title: "Local source",
      locator: "source.txt",
      sourceKind: "local-file",
      retrievedAt: CLOCK.toISOString(),
      passages: [{ passageId: "P1", text: "The source supports continuation." }],
    }, afterCreate, "source-receipt");
    assert.equal(continued.summary.revision_receipt_entry_id, "source-receipt");
    assert.equal(readEvidencePack(state, "E1").sources.length, 1);

    state.current_session = { session_id: "session-B", branch_entry_ids: [...state.current_session.branch_entry_ids], lifecycle_identity: "available", observed_at: CLOCK.toISOString() };
    assert.throws(() => readEvidencePack(state, "E1"), /different Pi session revision/i);
    state.current_session = { session_id: "session-A", branch_entry_ids: ["root", "before-pack"], lifecycle_identity: "available", observed_at: CLOCK.toISOString() };
    assert.throws(() => readEvidencePack(state, "E1"), /finalized Pi revision receipt|persisted Pi branch revision/i);
  } finally {
    cleanup(cwd);
  }
});

test("bounds, timestamps, missing sources, and credential-bearing passages reject before persistence", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    startPack(state, { maxAgeDays: 1, basis: "retrievedAt" });
    const before = JSON.stringify(state);
    assert.throws(() => addSource(state, { retrievedAt: "2026-09-13T12:00:00.000Z" }), /future/i);
    assert.throws(() => addSource(state, { text: "Bearer top-secret-token-value" }), /credential material/i);
    assert.throws(() => addSource(state, { passages: Array.from({ length: 5 }, (_, index) => ({ passageId: `P${index + 1}`, text: "bounded" })) }), /one through 4/i);
    assert.equal(JSON.stringify(state), before);
    addSource(state);
    assert.throws(() => addMaterialClaim(state, { support: [{ sourceId: "S-missing", passageIds: ["P1"] }] }), /unregistered source or passage/i);
    assert.throws(() => addSource(state, { sourceId: "S2", passageId: "P2", locator: "source.txt", publishedAt: "not-a-date" }), /ISO-8601/i);
  } finally {
    cleanup(cwd);
  }
});

test("pre-evidence v2 records migrate to the same strict v2 schema", () => {
  const cwd = tempCwd();
  try {
    const state = setupState(cwd);
    const preEvidence = structuredClone(state);
    for (const key of ["scope_state", "dependency_evidence", "coding_boundary", "working_context", "authoritative_instructions", "structured_output", "quality_gate", "context_epoch", "context_checkpoints", "active_checkpoint_id", "context_reset", "advisor_state"]) delete preEvidence[key];
    for (const key of ["next_scope", "next_scope_change", "next_approval", "next_output_contract", "next_output_validation", "next_quality_gate_claim", "next_quality_gate_escalation", "next_quality_gate_assessment", "next_quality_gate_resolution", "next_checkpoint", "next_advisor_advice"]) delete preEvidence.id_counters[key];
    for (const key of ["output_contract_receipts", "output_validation_receipts", "quality_gate_resolution_receipts"]) delete preEvidence.current_session[key];
    for (const step of preEvidence.plan) for (const key of ["exit_conditions", "exit_evidence_receipt_ids", "exit_evidence_artifact_refs"]) delete step[key];
    delete preEvidence.evidence_packs;
    delete preEvidence.active_evidence_pack_id;
    delete preEvidence.id_counters.next_evidence_pack;
    assert.equal(isTaskStateV2(preEvidence), false);
    const migrated = migrateTaskState(preEvidence);
    assert.ok(migrated);
    assert.equal(migrated.evidence_packs.length, 0);
    assert.equal(migrated.id_counters.next_evidence_pack, 1);
    assert.equal(isTaskStateV2(migrated), true);
  } finally {
    cleanup(cwd);
  }
});
