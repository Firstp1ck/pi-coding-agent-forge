import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTaskState } from "../src/task-state.ts";
import { normalizeConfig } from "../src/config.ts";
import { isTaskStateV2, migrateTaskState } from "../src/state-migration.ts";
import { recordAuthoritativeCorrection } from "../src/working-context.ts";
import { inputAuthorityBlockReason, inputTextHash } from "../src/input-authority.ts";

test("RF2b v2 validates new authority/observation fields and rejects mixed historic corruption", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rf2b-state-"));
  try {
    const state = createTaskState(cwd, "An exact goal", undefined, normalizeConfig({}));
    const input = { origin: "native-confirmation", session_id: "session", session_entry_id: "receipt" };
    Object.assign(state.authoritative_instructions.original_user_request, input);
    state.task_identity.session_id = "session";
    state.task_identity.session_anchor_entry_id = "receipt";
    state.current_session = { ...state.current_session, session_id: "session", lifecycle_identity: "available", branch_entry_ids: ["receipt"], input_authority_receipts: [{ entry_id: "receipt", task_id: state.task_id, origin: "native-confirmation", text_sha256: inputTextHash("An exact goal") }] };
    assert.ok(isTaskStateV2(state));
    assert.equal(inputAuthorityBlockReason(state), undefined);
    const paused = structuredClone(state);
    paused.input_pause = { observation_id: "observation", text_sha256: inputTextHash("unconfirmed") };
    assert.ok(isTaskStateV2(paused));
    for (const mutate of [
      item => { item.input_pause.text = "must not persist raw input"; },
      item => { item.input_pause.text_sha256 = "bad"; },
      item => { item.authoritative_instructions.original_user_request.origin = "raw-guessed"; },
      item => { delete item.authoritative_instructions.original_user_request.session_entry_id; },
      item => { item.current_session.input_authority_receipts[0].origin = "interactive"; },
      item => { item.current_session.input_authority_receipts.push(item.current_session.input_authority_receipts[0]); },
      item => { delete item.advisor_state; },
    ]) {
      const corrupt = structuredClone(paused);
      mutate(corrupt);
      assert.equal(isTaskStateV2(corrupt), false);
      assert.equal(migrateTaskState(corrupt), undefined);
    }
    const historical = structuredClone(state);
    historical.authoritative_instructions.original_user_request.origin = "interactive";
    assert.ok(isTaskStateV2(historical), "old records remain inspectable history");
    assert.match(inputAuthorityBlockReason(historical), /historic|authority/);
    const counters = structuredClone(state.counters);
    const scopeUsage = structuredClone(state.scope_state.usage);
    state.plan[0].status = "complete";
    assert.equal(recordAuthoritativeCorrection(state, "An exact goal", { ...input, session_entry_id: "new-receipt" }), true);
    assert.equal(state.plan[0].status, "pending");
    state.plan[0].status = "complete";
    assert.equal(recordAuthoritativeCorrection(state, "An exact goal", { ...input, session_entry_id: "new-receipt" }), false);
    assert.equal(state.plan[0].status, "complete", "one receipt invalidates proof exactly once");
    assert.deepEqual(state.counters, counters);
    assert.deepEqual(state.scope_state.usage, scopeUsage);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
