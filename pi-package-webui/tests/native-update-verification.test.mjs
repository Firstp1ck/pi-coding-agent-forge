import assert from "node:assert/strict";
import path from "node:path";
import { assertRestoredPiState, nativeUpdateOutcome } from "../lib/update/verification.mjs";

for (const [statuses, expected] of [
  [["healthy"], "success"], [["healthy", "unchanged"], "success"],
  [["unchanged", "unchanged"], "unchanged"], [["failed"], "failed"],
  [["healthy", "failed"], "partial"], [["healthy", "unverified"], "partial"],
]) {
  assert.equal(nativeUpdateOutcome(statuses.map((status) => ({ status }))), expected);
}
const sessionFile = path.resolve("fixture", "session.jsonl");
assert.doesNotThrow(() => assertRestoredPiState({ success: true, data: { sessionFile } }, sessionFile));
assert.throws(() => assertRestoredPiState({ success: true, data: { sessionFile: "wrong-session.jsonl" } }, sessionFile), /expected session/);
assert.throws(() => assertRestoredPiState({ success: true, data: { rpcRunning: false, sessionFile } }, sessionFile), /healthy RPC/);
assert.throws(() => assertRestoredPiState({ success: false, error: "spawned but failed" }, sessionFile), /healthy RPC/);
console.log("native-update-verification.test.mjs passed");
