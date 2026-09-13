import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import {
  applyReliabilityScopeAction, approveScopeChange, createTaskState,
  evaluateScopeToolCall, nativeAuthorityReceiptHash, normalizeConfig,
  normalizeScopePath, recordScopeToolResult, recordToolCall,
  scopeAuthorityIsCurrent, scopeFingerprint, updateToolResult,
} from "../src/core.ts";

function proposedScope(overrides = {}) {
  return {
    action: "set", lane: "coding", allowedTools: ["read", "write", "edit"],
    allowedReadPaths: ["."], allowedWritePaths: ["."], forbiddenPaths: [],
    maxToolCalls: 20, maxErrors: 3, maxIterations: 20,
    externalSideEffects: "forbidden", validationCommands: [],
    stopConditions: ["Stop at budget"], escalationConditions: ["Ask for permission"],
    ...overrides,
  };
}

function workspace() {
  return mkdtempSync(join(tmpdir(), "reliability-scope-edges-"));
}

test("scope rejects dangling symlink targets before native writes", () => {
  const cwd = workspace();
  const outside = workspace();
  try {
    symlinkSync(join(outside, "not-created.txt"), join(cwd, "target.txt"));
    assert.throws(() => normalizeScopePath(cwd, "target.txt"), /symlink/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an installed read truncated by line count cannot authorize overwriting unseen lines", async () => {
  const cwd = workspace();
  try {
    writeFileSync(join(cwd, "many-lines.txt"), Array(2100).fill("line").join("\n"));
    const config = normalizeConfig({});
    const state = createTaskState(cwd, "Repair a bounded file", undefined, config);
    const proposal = applyReliabilityScopeAction(state, proposedScope(), config);
    approveScopeChange(state, proposal.scope_change.id, "native-confirmation");
    const input = { path: "many-lines.txt" };
    recordToolCall(state, "read-many-lines", "read", input, { host_provenance: "host-tool" });
    const result = await createReadTool(cwd).execute("read-many-lines", input);
    assert.equal(result.details?.truncation?.truncated, true);
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const receipt = updateToolResult(state, "read-many-lines", "read", input, false, "read", text, config, result.details);
    recordScopeToolResult(state, receipt, input);
    assert.equal(evaluateScopeToolCall(state, "write", { path: input.path, content: "replacement" }, config, { trustedTool: true }).allowed, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a narrowed scope remains authorized by its unchanged approved ancestor", () => {
  const cwd = workspace();
  try {
    const config = normalizeConfig({});
    const session = { session_id: "scope-session", branch_entry_ids: ["root", "scope-approval"], lifecycle_identity: "available", observed_at: new Date().toISOString() };
    const state = createTaskState(cwd, "Repair a bounded file", undefined, config, session);
    const proposal = applyReliabilityScopeAction(state, proposedScope(), config).scope_change;
    const data = { task_id: state.task_id, scope_change_id: proposal.id, scope_hash: scopeFingerprint(proposal.requested_scope) };
    const receiptHash = nativeAuthorityReceiptHash("reliability-scope-authorization", data);
    state.current_session.scope_authorization_receipts = [{ entry_id: "scope-approval", ...data, receipt_hash: receiptHash }];
    approveScopeChange(state, proposal.id, "native-confirmation", new Date(), { session_id: session.session_id, entry_id: "scope-approval", receipt_hash: receiptHash });
    assert.equal(scopeAuthorityIsCurrent(state), true);
    applyReliabilityScopeAction(state, proposedScope({ allowedTools: ["read", "write"], allowedWritePaths: ["src"], maxToolCalls: 10 }), config);
    assert.equal(scopeAuthorityIsCurrent(state), true);
    state.scope_state.active_scope.allowed_write_paths = [join(cwd, "outside-approved-src")];
    assert.equal(scopeAuthorityIsCurrent(state), true, "the original authority allows cwd; active narrowing is independently checked on model changes");
    state.scope_state.active_scope.allowed_write_paths = [tmpdir()];
    assert.equal(scopeAuthorityIsCurrent(state), false);
    state.scope_state.active_scope.allowed_write_paths = [join(cwd, "src")];
    state.current_session.scope_authorization_receipts[0].scope_hash = "0".repeat(64);
    assert.equal(scopeAuthorityIsCurrent(state), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
