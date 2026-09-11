import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPATIBILITY_VERSION,
  canonicalJson,
  compareCompatibility,
  createReport,
  validateSavedReport,
  renderHumanReport,
} from "../skills/code-quality/scripts/lib/report.mjs";

const digest = "a".repeat(64);
const coverage = { status: "complete", complete: true, before: { status: "complete", complete: true }, current: { status: "complete", complete: true } };

function compatibility(overrides = {}) {
  return {
    version: COMPATIBILITY_VERSION,
    scanner: { schemaVersion: "code-quality-report-v1", cli: "scan-snapshot-compare-v1", sourcePersistence: "report-safe-metadata-only-v1", reportLimits: { maxReportRows: 1000, maxSnapshotBytes: 4194304, maxValidationDepth: 32, maxValidationNodes: 100000, maxCompatibilityDifferences: 20, maxHumanContributors: 20 } },
    collection: { version: "collection-compatibility-v2", scopeRoots: ["src"], limits: { maxFiles: 5000 }, classification: { version: "classification-v1" }, git: { version: "non-git-filesystem-v1" } },
    git: { version: null, policy: null },
    metrics: { version: "metrics-v1", physicalLines: "physical-lines-lf-delimited-raw-bytes-v1", dependencies: "npm-direct-sections-json-v1", cloneUnion: "inclusive-physical-span-union-v1" },
    adapters: {
      complexity: { version: "no-approved-callable-complexity-adapter-v1" },
      astGrep: { version: "ast-grep-adapter-v1", rules: [{ language: "javascript", rule: "javascript/rule.yml", sha256: digest }] },
      jscpd: { version: "jscpd-adapter-v1", configuration: {}, configurationSha256: digest },
    },
    ...overrides,
  };
}

function unavailable(reason = "fixture") {
  return { status: "unavailable", reason };
}

function measurement(total = 1) {
  return {
    capture: { kind: "fixture", manifestDigest: digest, ignoreIdentity: null, captureIdentity: digest, files: [], coverageStatus: "complete", coverageComplete: true, coverage: { status: "complete", complete: true } },
    physicalLines: { definition: "physical-lines-lf-delimited-raw-bytes-v1", files: 0, total, categories: { fixture: total }, languages: {} },
    dependencies: { status: "not-applicable", reason: "fixture", manifests: [], totalManifests: 0, reportedManifests: 0, omittedManifests: 0, totalDependencyRows: 0, reportedDependencyRows: 0, omittedDependencyRows: 0 },
    complexity: { ...unavailable(), callables: [] },
    erosion: { ...unavailable(), numerator: null, denominator: null, value: null, highComplexityCount: null, maxCc: null },
    callables: { ...unavailable(), policy: "callable-exact-path-and-identity-v1", rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0, added: [], removed: [], unmatched: [] },
    astPatterns: { ...unavailable(), findings: [], totalRows: 0, reportedRows: 0, omittedRows: 0 },
    clones: { ...unavailable(), rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0, uniqueCoveredLines: null },
    verbosityProxy: { ...unavailable(), value: null },
  };
}

function report(value = compatibility()) {
  return createReport({
    operation: "snapshot",
    compatibility: value,
    coverage,
    snapshot: { before: null, current: measurement() },
    comparison: {
      status: "not-applicable",
      reason: "fixture",
      editChurn: { status: "unavailable", reason: "fixture", changes: [], totalRows: 0, reportedRows: 0, omittedRows: 0 },
      dependencyChanges: { status: "not-applicable", reason: "fixture", changes: [], totalRows: 0, reportedRows: 0, omittedRows: 0 },
      matchedFunctionDeltas: { status: "unavailable", reason: "fixture", rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0 },
    },
    provenance: { source: "fixture", gitVersion: null, baselineCommit: null, gitPolicy: null, captureAttempts: 1, processCounts: null },
  });
}

test("canonical compatibility ignores object order but preserves order-sensitive options", () => {
  const first = compatibility();
  first.adapters.astGrep.options = ["strict", "no-ignore"];
  const reorderedObjects = JSON.parse(JSON.stringify(first, Object.keys(first).reverse()));
  const same = structuredClone(first);
  same.adapters = { jscpd: same.adapters.jscpd, astGrep: same.adapters.astGrep, complexity: same.adapters.complexity };
  assert.equal(canonicalJson(first), canonicalJson(same));
  assert.equal(compareCompatibility(first, same).status, "available");
  const orderedChange = structuredClone(first);
  orderedChange.adapters.astGrep.options = ["no-ignore", "strict"];
  assert.equal(compareCompatibility(first, orderedChange).status, "incompatible");
  assert.equal(reorderedObjects.version, COMPATIBILITY_VERSION);
});

test("tool, rule, and scope changes are explicit compatibility mismatches", () => {
  const base = compatibility();
  const scope = structuredClone(base);
  scope.collection.scopeRoots = ["lib"];
  const tool = structuredClone(base);
  tool.git.version = "git version changed";
  const rule = structuredClone(base);
  rule.adapters.astGrep.rules[0].sha256 = "b".repeat(64);
  for (const changed of [scope, tool, rule]) {
    const result = compareCompatibility(base, changed);
    assert.equal(result.status, "incompatible");
    assert.equal(result.differences.length > 0, true);
  }
});

test("saved report validation rejects unknown versions and malformed measurement shape", () => {
  const valid = report();
  assert.equal(validateSavedReport(valid).schemaVersion, "code-quality-report-v1");
  assert.throws(() => validateSavedReport({ ...valid, schemaVersion: "future-v2" }), /schema/u);
  assert.throws(() => validateSavedReport({ ...valid, compatibility: { ...valid.compatibility, version: "future-compatibility" } }), /compatibility/u);
  assert.throws(() => validateSavedReport({ ...valid, snapshot: { before: null, current: { physicalLines: {} } } }), /capture/u);
  const withFragment = structuredClone(valid);
  withFragment.snapshot.current.clones.fragment = "synthetic source must not survive validation";
  assert.throws(() => validateSavedReport(withFragment), /source-bearing/u);
  const withPrivatePath = structuredClone(valid);
  withPrivatePath.snapshot.current.capture.path = "C:/private/source.js";
  assert.throws(() => validateSavedReport(withPrivatePath), /absolute private path/u);
});

test("human report leads with concrete available contributors and discloses omissions", () => {
  const value = report();
  value.comparison = {
    status: "partial",
    reason: "coverage-partial-no-no-regression-conclusion",
    physicalLineDelta: { before: 4, after: 6, delta: 2 },
    editChurn: { status: "partial", reason: "line-change-row-cap", changes: [{ beforePath: "src/a.js", currentPath: "src/a.js", added: 3, deleted: 1, kind: "modified" }], totalRows: 2, reportedRows: 1, omittedRows: 1 },
    dependencyChanges: { status: "available", reason: null, changes: [{ path: "package.json", section: "dependencies", name: "alpha", beforeVersion: "1.0.0", afterVersion: "2.0.0", kind: "changed" }], totalRows: 1, reportedRows: 1, omittedRows: 0 },
    matchedFunctionDeltas: { status: "unavailable", reason: "fixture", rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0 },
  };
  value.snapshot.current.astPatterns = { status: "partial", reason: "ast-grep-parse-completeness-unestablished", findings: [{ path: "src/a.js", range: { startLine: 4, startColumn: 2, endLineExclusive: 4, endColumn: 20 }, ruleId: "no-console-log", ruleVersion: digest, language: "javascript", severity: "warning", message: "Inspect direct logging." }], totalRows: 2, reportedRows: 1, omittedRows: 1, coverage: { complete: false } };
  value.snapshot.current.clones = { status: "available", reason: null, rows: [{ kind: "exact", format: "javascript", tokens: 8, first: { path: "src/a.js", startLine: 1, endLine: 2 }, second: { path: "src/b.js", startLine: 5, endLine: 6 } }], totalRows: 1, reportedRows: 1, omittedRows: 0, uniqueCoveredLines: { definition: "inclusive-physical-span-union-v1", lines: 4, byPath: [{ path: "src/a.js", lines: 2 }, { path: "src/b.js", lines: 2 }] } };
  const human = renderHumanReport(value);
  assert.match(human, /Line-change contributors:[\s\S]*src\/a\.js: \+3 -1/u);
  assert.match(human, /Direct dependency contributors:[\s\S]*dependencies\/alpha: 1\.0\.0 -> 2\.0\.0/u);
  assert.match(human, /AST review candidates:[\s\S]*src\/a\.js:4:2 no-console-log/u);
  assert.match(human, /Token-clone contributors:[\s\S]*src\/a\.js:1-2 and src\/b\.js:5-6/u);
  assert.match(human, /1 row\(s\) omitted/u);
  assert.equal(human.indexOf("Line-change contributors") < human.indexOf("Capture coverage"), true);
});

test("saved report validation rejects invalid counts, paths, spans, status coverage, and shallow compatibility", () => {
  const valid = report();
  const cases = [
    (value) => { value.snapshot.current.physicalLines.total = -123; },
    (value) => { value.snapshot.current.physicalLines.categories.fixture = 2; },
    (value) => { value.snapshot.current.astPatterns = { status: "partial", reason: "fixture", findings: [], totalRows: 1, reportedRows: 1, omittedRows: 1, coverage: { complete: false } }; },
    (value) => { value.snapshot.current.clones = { status: "partial", reason: "fixture", rows: [{ kind: "exact", format: "javascript", tokens: 1, first: { path: "../escape.js", startLine: 1, endLine: 1 }, second: { path: "src/a.js", startLine: 1, endLine: 1 } }], totalRows: 1, reportedRows: 1, omittedRows: 0, uniqueCoveredLines: null }; },
    (value) => { value.coverage = { status: "partial", complete: true, before: { status: "complete", complete: true }, current: { status: "complete", complete: true } }; },
    (value) => { value.compatibility = { version: COMPATIBILITY_VERSION }; },
    (value) => { value.comparison = { ...value.comparison, status: "available", reason: null, physicalLineDelta: { before: 1, after: 2, delta: 1 } }; },
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(() => validateSavedReport(candidate));
  }
});
