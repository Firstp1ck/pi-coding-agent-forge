import test from "node:test";
import assert from "node:assert/strict";
import { parseRecord } from "./candidate.mjs";

test("parse-valid-record", () => {
  assert.deepEqual(parseRecord("tea|2"), { name: "tea", amount: 2, category: "general" });
  assert.deepEqual(parseRecord("tea|2|drink"), { name: "tea", amount: 2, category: "drink" });
});

test("reject-invalid-record", () => {
  assert.throws(() => parseRecord("tea|two"), /amount/u);
  assert.throws(() => parseRecord("|2"), /name/u);
});

test("preserve-error-location", () => {
  assert.throws(() => parseRecord("tea|2|extra|field"), /field count/u);
});
