import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveDestination } from "./candidate.mjs";

const root = path.resolve("evaluation-root");

test("reject-unsafe-path", () => {
  assert.throws(() => resolveDestination(root, "../outside"), /escapes/u);
  assert.throws(() => resolveDestination(root, ""), /invalid/u);
});

test("accept-normalized-safe-path", () => {
  assert.equal(resolveDestination(root, "reports/../report.json"), path.join(root, "report.json"));
});

test("preserve-caller-error-contract", () => {
  assert.throws(() => resolveDestination(root, root), /escapes/u);
});
