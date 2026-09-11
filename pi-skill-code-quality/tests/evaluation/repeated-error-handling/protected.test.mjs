import test from "node:test";
import assert from "node:assert/strict";
import { runOperations } from "./candidate.mjs";

test("return-original-cause", async () => {
  const cause = new Error("transport unavailable");
  await assert.rejects(
    runOperations(["store"], async () => { throw cause; }, async () => {}),
    (error) => error.cause === cause,
  );
});

test("keep-operation-context", async () => {
  await assert.rejects(
    runOperations(["archive"], async () => { throw new Error("no"); }, async () => {}),
    /operation archive failed/u,
  );
});

test("release-partial-resource", async () => {
  const released = [];
  await assert.rejects(
    runOperations(["first", "second"], async (operation) => {
      if (operation === "second") throw new Error("no");
      return operation;
    }, async (operation) => { released.push(operation); }),
  );
  assert.deepEqual(released, ["first", "second"]);
});
