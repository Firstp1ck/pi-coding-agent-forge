import { test } from "node:test";
import assert from "node:assert/strict";
import { isRelativeInside, isWithin } from "../../../src/paths.ts";

test("isWithin compares path components: names starting with .. stay inside", () => {
  assert.equal(isWithin("/a/s", "/a/s"), true);
  assert.equal(isWithin("/a/s/x", "/a/s"), true);
  assert.equal(isWithin("/a/s/..kept", "/a/s"), true);
  assert.equal(isWithin("/a/s/..kept/y", "/a/s"), true);
  assert.equal(isWithin("/a", "/a/s"), false);
  assert.equal(isWithin("/a/t", "/a/s"), false);
  assert.equal(isWithin("/a/s2", "/a/s"), false);
  assert.equal(isRelativeInside(".."), false);
  assert.equal(isRelativeInside("../x"), false);
  assert.equal(isRelativeInside("..x"), true);
  assert.equal(isRelativeInside("/abs"), false);
});
