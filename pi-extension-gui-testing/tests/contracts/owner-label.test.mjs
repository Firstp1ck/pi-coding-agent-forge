import { test } from "node:test";
import assert from "node:assert/strict";
import { formatOwnerLabel, parseOwnerLabel } from "../../src/owner.ts";

test("owner label round-trips all four fields", () => {
  const owner = { clientId: "c0ffee", pid: 4242, processStartTime: "123456", bootId: "b7e1-boot" };
  assert.deepEqual(parseOwnerLabel(formatOwnerLabel(owner)), owner);
});

test("owner labels with missing or malformed fields are not parsed, so they are never swept", () => {
  for (const value of ["c0ffee:4242:boot", "c0ffee:0:1:boot", "c0ffee:x:1:boot", "c0ffee:4242:abc:boot", ":4242:1:boot", "c0ffee:4242:1:"]) {
    assert.equal(parseOwnerLabel(value), undefined, value);
  }
});
