import test from "node:test";
import assert from "node:assert/strict";
import {
  classificationCompatibility,
  classifyPath,
  globMatches,
  normalizeReportPath,
  normalizeScopeRoots,
  pathIsInScope,
} from "../skills/code-quality/scripts/lib/classification.mjs";

test("classification preserves precedence and does not let overrides re-include artifacts", () => {
  assert.equal(classifyPath("src/service.ts").category, "production");
  assert.equal(classifyPath("src/service.test.ts").category, "test");
  assert.equal(classifyPath("docs/guide.md").category, "documentation");
  assert.equal(classifyPath("src/nested/node_modules/pkg.js").included, false);
  const excluded = classifyPath("vendor/lib.js", { overrides: [{ pattern: "vendor/**", category: "production" }] });
  assert.deepEqual(excluded, {
    category: "artifact",
    language: null,
    included: false,
    reason: "vendor-directory",
    rule: "**/vendor/**",
    safetyExcluded: true,
  });
});

test("classification handles root globs, scopes, and strict report path decoding", () => {
  assert.equal(globMatches("**/*.md", "README.md"), true);
  assert.equal(globMatches("**/tests/**", "tests/unit/a.js"), true);
  assert.equal(globMatches("src/**", "lib/a.js"), false);
  assert.deepEqual(normalizeScopeRoots(["./src/", "docs"]), ["docs", "src"]);
  assert.equal(pathIsInScope("src/a.js", ["src"]), true);
  assert.equal(pathIsInScope("source/a.js", ["src"]), false);
  assert.equal(normalizeReportPath(Buffer.from([0xff])), null);
  assert.equal(normalizeReportPath(Buffer.from("src/a.js")), "src/a.js");
});

test("classification compatibility is explicit and serializable", () => {
  const compatibility = classificationCompatibility({ overrides: [{ pattern: "examples/**", category: "documentation", name: "examples" }] });
  assert.equal(compatibility.version, "classification-v1");
  assert.equal(compatibility.caseSensitive, true);
  assert.equal(compatibility.overrides[0].name, "examples");
});
