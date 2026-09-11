import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { CommandFailure } from "./runner.mjs";
import { normalizeReportPath } from "./classification.mjs";

export const REPORT_SCHEMA_VERSION = "code-quality-report-v1";
export const COMPATIBILITY_VERSION = "scanner-compatibility-v1";

export const REPORT_LIMITS = Object.freeze({
  maxReportRows: 1_000,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxValidationDepth: 32,
  maxValidationNodes: 100_000,
  maxCompatibilityDifferences: 20,
  maxHumanContributors: 20,
});

const STATUSES = new Set(["available", "partial", "unavailable", "not-applicable", "incompatible", "inconsistent"]);
const OPERATIONS = new Set(["scan", "snapshot", "compare"]);

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > REPORT_LIMITS.maxValidationNodes) throw new TypeError("Saved report exceeds the validation node limit.");
  if (depth > REPORT_LIMITS.maxValidationDepth) throw new TypeError("Saved report exceeds the validation depth limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Saved report contains a non-finite number.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, state, depth + 1);
    return;
  }
  if (!plainObject(value)) throw new TypeError("Saved report contains a non-JSON object.");
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 256) throw new TypeError("Saved report contains an invalid key.");
    assertJsonValue(item, state, depth + 1);
  }
}

/** Canonical JSON sorts object keys but deliberately preserves every array order. */
export function canonicalize(value) {
  assertJsonValue(value, { nodes: 0 });
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => [key, canonicalize(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function differencePaths(left, right, prefix = "", output = []) {
  if (output.length >= REPORT_LIMITS.maxCompatibilityDifferences) return output;
  if (Object.is(left, right)) return output;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      output.push(prefix || "$ ");
      return output;
    }
    for (let index = 0; index < left.length && output.length < REPORT_LIMITS.maxCompatibilityDifferences; index += 1) differencePaths(left[index], right[index], `${prefix}[${index}]`, output);
    return output;
  }
  if (plainObject(left) && plainObject(right)) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)]).values()) {
      if (output.length >= REPORT_LIMITS.maxCompatibilityDifferences) break;
      const next = prefix ? `${prefix}.${key}` : key;
      if (!(key in left) || !(key in right)) output.push(next);
      else differencePaths(left[key], right[key], next, output);
    }
    return output;
  }
  output.push(prefix || "$ ");
  return output;
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value);
}

function isRelativeReportPath(value) {
  return typeof value === "string" && normalizeReportPath(Buffer.from(value, "utf8")) === value;
}

function assertReportLimits(value) {
  if (!plainObject(value)) throw new TypeError("Malformed report limits.");
  for (const [key, expected] of Object.entries(REPORT_LIMITS)) {
    if (value[key] !== expected) throw new TypeError("Unknown report limits.");
  }
  if (Object.keys(value).length !== Object.keys(REPORT_LIMITS).length) throw new TypeError("Unknown report limits.");
}

function assertCompatibility(value) {
  if (!plainObject(value) || value.version !== COMPATIBILITY_VERSION) throw new TypeError("Unknown or malformed compatibility version.");
  if (!plainObject(value.scanner) || value.scanner.schemaVersion !== REPORT_SCHEMA_VERSION || value.scanner.cli !== "scan-snapshot-compare-v1" || value.scanner.sourcePersistence !== "report-safe-metadata-only-v1") throw new TypeError("Malformed scanner compatibility.");
  assertReportLimits(value.scanner.reportLimits);
  if (!plainObject(value.collection) || value.collection.version !== "collection-compatibility-v2" || !Array.isArray(value.collection.scopeRoots) || value.collection.scopeRoots.some((scope) => typeof scope !== "string" || (scope !== "" && !isRelativeReportPath(scope)))) throw new TypeError("Malformed collection compatibility.");
  if (!plainObject(value.collection.classification) || value.collection.classification.version !== "classification-v1" || !plainObject(value.collection.limits)) throw new TypeError("Malformed collection compatibility.");
  if (!plainObject(value.collection.git) || !["git-capture-v2", "non-git-filesystem-v1"].includes(value.collection.git.version)) throw new TypeError("Malformed collection compatibility.");
  if (!plainObject(value.git) || !(value.git.version === null || typeof value.git.version === "string") || !(value.git.policy === null || plainObject(value.git.policy))) throw new TypeError("Malformed Git compatibility.");
  if (!plainObject(value.metrics) || value.metrics.version !== "metrics-v1" || value.metrics.physicalLines !== "physical-lines-lf-delimited-raw-bytes-v1" || value.metrics.dependencies !== "npm-direct-sections-json-v1" || value.metrics.cloneUnion !== "inclusive-physical-span-union-v1") throw new TypeError("Malformed metric compatibility.");
  if (!plainObject(value.adapters) || !plainObject(value.adapters.complexity) || value.adapters.complexity.version !== "no-approved-callable-complexity-adapter-v1" || !plainObject(value.adapters.astGrep) || value.adapters.astGrep.version !== "ast-grep-adapter-v1" || !plainObject(value.adapters.jscpd) || value.adapters.jscpd.version !== "jscpd-adapter-v1") throw new TypeError("Malformed adapter compatibility.");
  if (!Array.isArray(value.adapters.astGrep.rules) || value.adapters.astGrep.rules.some((rule) => !plainObject(rule) || typeof rule.language !== "string" || !isRelativeReportPath(rule.rule) || !(rule.sha256 === null || isDigest(rule.sha256)))) throw new TypeError("Malformed ast-grep compatibility.");
  if (!plainObject(value.adapters.jscpd.configuration) || !isDigest(value.adapters.jscpd.configurationSha256)) throw new TypeError("Malformed jscpd compatibility.");
  return canonicalize(value);
}

/** Exact compatibility equality over canonical JSON; output is bounded and source-free. */
export function compareCompatibility(before, after) {
  const canonicalBefore = assertCompatibility(before);
  const canonicalAfter = assertCompatibility(after);
  const beforeJson = JSON.stringify(canonicalBefore);
  const afterJson = JSON.stringify(canonicalAfter);
  if (beforeJson === afterJson) return Object.freeze({ status: "available", differences: [], truncated: false });
  const differences = differencePaths(canonicalBefore, canonicalAfter);
  return Object.freeze({
    status: "incompatible",
    differences: Object.freeze(differences),
    truncated: differences.length >= REPORT_LIMITS.maxCompatibilityDifferences,
  });
}

const SOURCE_BEARING_KEYS = new Set([
  "text",
  "fragment",
  "metavariables",
  "metavariable",
  "labels",
  "transformed",
  "byteoffset",
  "charcount",
  "firstfile",
  "secondfile",
  "sourcecode",
  "contents",
]);

function isAbsolutePrivatePath(value) {
  return typeof value === "string" && (path.isAbsolute(value) || /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\"));
}

/** Saved reports are not a pass-through channel for raw analyzer output or private paths. */
function assertNoSourceBearingValues(value, ancestry = []) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSourceBearingValues(item, ancestry);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SOURCE_BEARING_KEYS.has(key.toLowerCase())) throw new TypeError("Saved report contains source-bearing analyzer fields.");
    if ((key === "path" || key === "file") && isAbsolutePrivatePath(item)) throw new TypeError("Saved report contains an absolute private path.");
    assertNoSourceBearingValues(item, [...ancestry, key]);
  }
}

function assertMetricStatus(metric, name) {
  if (!plainObject(metric) || !STATUSES.has(metric.status)) throw new TypeError(`Malformed ${name} metric status.`);
  if (metric.status === "available") {
    if (metric.reason !== null && metric.reason !== undefined) throw new TypeError(`Malformed ${name} available status.`);
  } else if (typeof metric.reason !== "string" || !metric.reason) throw new TypeError(`Malformed ${name} non-available status.`);
}

function assertRowAccounting(metric, key = "rows") {
  if (!Array.isArray(metric[key]) || !isSafeCount(metric.totalRows) || !isSafeCount(metric.reportedRows) || !isSafeCount(metric.omittedRows) || metric.reportedRows !== metric[key].length || metric.totalRows !== metric.reportedRows + metric.omittedRows || metric.reportedRows > REPORT_LIMITS.maxReportRows) {
    throw new TypeError("Malformed metric row accounting.");
  }
  if (metric.omittedRows > 0 && metric.status === "available") throw new TypeError("Complete metric omits rows.");
}

function assertCoverageState(coverage, name = "coverage") {
  if (!plainObject(coverage) || typeof coverage.status !== "string" || typeof coverage.complete !== "boolean" || !["complete", "partial", "inconsistent"].includes(coverage.status)) throw new TypeError(`Malformed ${name}.`);
  if ((coverage.status === "complete") !== coverage.complete) throw new TypeError(`Inconsistent ${name} status.`);
}

function assertCapture(capture) {
  if (!plainObject(capture) || typeof capture.kind !== "string" || !isDigest(capture.manifestDigest) || !(capture.ignoreIdentity === null || isDigest(capture.ignoreIdentity)) || !(capture.captureIdentity === null || isDigest(capture.captureIdentity)) || !Array.isArray(capture.files) || typeof capture.coverageStatus !== "string" || typeof capture.coverageComplete !== "boolean") throw new TypeError("Malformed capture projection.");
  assertCoverageState(capture.coverage, "snapshot coverage");
  if (capture.coverage.status !== capture.coverageStatus || capture.coverage.complete !== capture.coverageComplete) throw new TypeError("Capture coverage does not agree with projection.");
  for (const file of capture.files) {
    if (!plainObject(file) || !isRelativeReportPath(file.path) || typeof file.mode !== "string" || typeof file.category !== "string" || !(file.language === null || typeof file.language === "string") || typeof file.classificationRule !== "string" || !isSafeCount(file.byteLength) || !isDigest(file.sha256) || typeof file.captureSource !== "string") throw new TypeError("Malformed captured file.");
  }
}

function assertPhysicalLines(metric) {
  if (!plainObject(metric) || metric.definition !== "physical-lines-lf-delimited-raw-bytes-v1" || !isSafeCount(metric.files) || !isSafeCount(metric.total) || !plainObject(metric.categories) || !plainObject(metric.languages)) throw new TypeError("Malformed physical-line metric.");
  let categoryTotal = 0;
  for (const [category, lines] of Object.entries(metric.categories)) {
    if (!category || !isSafeCount(lines)) throw new TypeError("Malformed physical-line category.");
    categoryTotal += lines;
  }
  if (categoryTotal !== metric.total) throw new TypeError("Physical-line category totals do not match.");
  for (const [language, lines] of Object.entries(metric.languages)) if (!language || !isSafeCount(lines) || lines > metric.total) throw new TypeError("Malformed physical-line language total.");
}

function assertDependencyRows(metric) {
  assertMetricStatus(metric, "dependencies");
  if (!Array.isArray(metric.manifests) || !isSafeCount(metric.totalManifests) || !isSafeCount(metric.reportedManifests) || !isSafeCount(metric.omittedManifests) || metric.totalManifests !== metric.reportedManifests + metric.omittedManifests || metric.reportedManifests !== metric.manifests.length || !isSafeCount(metric.totalDependencyRows) || !isSafeCount(metric.reportedDependencyRows) || !isSafeCount(metric.omittedDependencyRows) || metric.totalDependencyRows !== metric.reportedDependencyRows + metric.omittedDependencyRows) throw new TypeError("Malformed dependency metric.");
  if (metric.status === "partial" && metric.omittedDependencyRows === 0 && metric.omittedManifests === 0) throw new TypeError("Partial dependency metric omits no evidence.");
  for (const manifest of metric.manifests) {
    if (!plainObject(manifest) || !isRelativeReportPath(manifest.path)) throw new TypeError("Malformed dependency manifest.");
    assertRowAccounting(manifest);
    for (const row of manifest.rows) if (!plainObject(row) || typeof row.name !== "string" || !row.name || typeof row.version !== "string" || typeof row.section !== "string") throw new TypeError("Malformed dependency row.");
  }
}

function assertAstRows(metric) {
  assertMetricStatus(metric, "astPatterns");
  if (!Array.isArray(metric.findings)) throw new TypeError("Malformed AST findings.");
  assertRowAccounting({ ...metric, rows: metric.findings });
  for (const finding of metric.findings) {
    const range = finding?.range;
    if (!plainObject(finding) || typeof finding.ruleId !== "string" || !isDigest(finding.ruleVersion) || !isRelativeReportPath(finding.path) || typeof finding.language !== "string" || typeof finding.severity !== "string" || typeof finding.message !== "string" || !plainObject(range) || !Number.isSafeInteger(range.startLine) || range.startLine < 1 || !Number.isSafeInteger(range.startColumn) || range.startColumn < 0 || !Number.isSafeInteger(range.endLineExclusive) || range.endLineExclusive < range.startLine || !Number.isSafeInteger(range.endColumn) || range.endColumn < 0) throw new TypeError("Malformed AST finding.");
  }
  if (metric.status === "partial" && (!plainObject(metric.coverage) || metric.coverage.complete !== false || !isSafeCount(metric.coverage.selectedFiles) || !isSafeCount(metric.coverage.analyzedFiles))) throw new TypeError("AST partial coverage is malformed.");
}

function assertCloneRows(metric) {
  assertMetricStatus(metric, "clones");
  if (!Array.isArray(metric.rows)) throw new TypeError("Malformed clone rows.");
  assertRowAccounting(metric);
  for (const row of metric.rows) {
    const validSpan = (span) => plainObject(span) && isRelativeReportPath(span.path) && Number.isSafeInteger(span.startLine) && span.startLine >= 1 && Number.isSafeInteger(span.endLine) && span.endLine >= span.startLine;
    if (!plainObject(row) || typeof row.kind !== "string" || typeof row.format !== "string" || !isSafeCount(row.tokens) || !validSpan(row.first) || !validSpan(row.second)) throw new TypeError("Malformed clone row.");
  }
  if (["available", "partial", "not-applicable"].includes(metric.status) && (!plainObject(metric.coverage) || !isSafeCount(metric.coverage.selectedFiles) || !isSafeCount(metric.coverage.analyzedFiles) || typeof metric.coverage.complete !== "boolean")) throw new TypeError("Malformed clone coverage.");
  if (metric.status === "available" && metric.coverage.complete !== true) throw new TypeError("Complete clone metric has incomplete coverage.");
  if (metric.uniqueCoveredLines !== null && metric.uniqueCoveredLines !== undefined) {
    if (!plainObject(metric.uniqueCoveredLines) || metric.uniqueCoveredLines.definition !== "inclusive-physical-span-union-v1" || !isSafeCount(metric.uniqueCoveredLines.lines) || !Array.isArray(metric.uniqueCoveredLines.byPath)) throw new TypeError("Malformed clone line union.");
    let unionLines = 0;
    for (const row of metric.uniqueCoveredLines.byPath) {
      if (!plainObject(row) || !isRelativeReportPath(row.path) || !isSafeCount(row.lines)) throw new TypeError("Malformed clone line union.");
      unionLines += row.lines;
    }
    if (unionLines !== metric.uniqueCoveredLines.lines) throw new TypeError("Clone line union totals do not match.");
  }
}

function assertCallableRows(metric) {
  assertMetricStatus(metric, "callables");
  if (metric.policy !== "callable-exact-path-and-identity-v1" || !Array.isArray(metric.rows) || !Array.isArray(metric.added) || !Array.isArray(metric.removed) || !Array.isArray(metric.unmatched)) throw new TypeError("Malformed callable metric.");
  assertRowAccounting(metric);
}

function assertSnapshotMeasurement(snapshot) {
  if (!plainObject(snapshot)) throw new TypeError("Malformed saved snapshot measurement.");
  assertCapture(snapshot.capture);
  assertPhysicalLines(snapshot.physicalLines);
  if (snapshot.physicalLines.files !== snapshot.capture.files.length) throw new TypeError("Physical-line file count does not match capture.");
  assertDependencyRows(snapshot.dependencies);
  assertMetricStatus(snapshot.complexity, "complexity");
  assertMetricStatus(snapshot.erosion, "erosion");
  assertCallableRows(snapshot.callables);
  assertAstRows(snapshot.astPatterns);
  assertCloneRows(snapshot.clones);
  assertMetricStatus(snapshot.verbosityProxy, "verbosityProxy");
  if (snapshot.complexity.status !== "unavailable" || snapshot.erosion.status !== "unavailable" || snapshot.callables.status !== "unavailable" || snapshot.verbosityProxy.status !== "unavailable") throw new TypeError("Unavailable callable measurements cannot be advertised as available.");
  if (snapshot.astPatterns.status === "available") throw new TypeError("AST parse-incomplete evidence cannot be advertised as complete.");
}

function assertCollectionCoverage(coverage) {
  assertCoverageState(coverage, "capture coverage");
  if (!(coverage.before === null || plainObject(coverage.before)) || !plainObject(coverage.current)) throw new TypeError("Malformed aggregate coverage.");
  if (coverage.before) assertCoverageState(coverage.before, "before coverage");
  assertCoverageState(coverage.current, "current coverage");
  if (coverage.status === "complete" && ((coverage.before && !coverage.before.complete) || !coverage.current.complete)) throw new TypeError("Complete aggregate coverage contains partial input.");
}

/** Rejects unknown schema/compatibility versions and malformed or oversized saved reports. */
function assertComparison(comparison, report) {
  assertMetricStatus(comparison, "comparison");
  if (!["available", "partial", "incompatible", "inconsistent", "not-applicable"].includes(comparison.status)) throw new TypeError("Malformed comparison status.");
  if (comparison.status === "available" && (report.coverage.status !== "complete" || !report.snapshot.before || report.snapshot.before.capture.coverageStatus !== "complete" || report.snapshot.current.capture.coverageStatus !== "complete")) throw new TypeError("Incomplete evidence is advertised as a complete comparison.");
  if (["available", "partial"].includes(comparison.status)) {
    const delta = comparison.physicalLineDelta;
    if (!plainObject(delta) || !isSafeCount(delta.before) || !isSafeCount(delta.after) || !Number.isSafeInteger(delta.delta) || delta.delta !== delta.after - delta.before) throw new TypeError("Malformed physical-line comparison.");
  }
  if (comparison.status === "incompatible" && (!plainObject(comparison.compatibility) || comparison.compatibility.status !== "incompatible" || !Array.isArray(comparison.compatibility.differences))) throw new TypeError("Malformed incompatible comparison.");
  for (const name of ["editChurn", "dependencyChanges", "matchedFunctionDeltas"]) {
    if (!plainObject(comparison[name]) || !STATUSES.has(comparison[name].status)) throw new TypeError("Malformed comparison metric.");
    if (Array.isArray(comparison[name].changes) || Array.isArray(comparison[name].rows)) assertRowAccounting(comparison[name], Array.isArray(comparison[name].changes) ? "changes" : "rows");
  }
}

export function validateSavedReport(report) {
  assertJsonValue(report, { nodes: 0 });
  assertNoSourceBearingValues(report);
  if (!plainObject(report) || report.schemaVersion !== REPORT_SCHEMA_VERSION || !OPERATIONS.has(report.operation)) throw new TypeError("Unknown or malformed report schema.");
  assertReportLimits(report.reportLimits);
  assertCompatibility(report.compatibility);
  assertCollectionCoverage(report.coverage);
  if (!plainObject(report.snapshot) || !(report.snapshot.before === null || plainObject(report.snapshot.before)) || !plainObject(report.snapshot.current)) {
    throw new TypeError("Malformed saved report snapshots.");
  }
  if (report.snapshot.before) assertSnapshotMeasurement(report.snapshot.before);
  assertSnapshotMeasurement(report.snapshot.current);
  assertComparison(report.comparison, report);
  if (!plainObject(report.provenance) || typeof report.provenance.source !== "string") throw new TypeError("Malformed report provenance.");
  return canonicalize(report);
}

function assertReportWork(budget) {
  if (budget?.signal?.aborted) throw new CommandFailure("scanner", null, "cancelled");
  budget?.deadline?.assertWorkAvailable();
}

async function readBoundedFile(filename, budget = null) {
  assertReportWork(budget);
  const metadata = await fs.lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > REPORT_LIMITS.maxSnapshotBytes) throw new TypeError("Saved snapshot path is unsafe or exceeds the size limit.");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (before.size !== metadata.size || !before.isFile() || before.size > REPORT_LIMITS.maxSnapshotBytes) throw new TypeError("Saved snapshot changed before reading.");
    const output = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < output.length) {
      assertReportWork(budget);
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead === 0) throw new TypeError("Saved snapshot ended before its declared size.");
      offset += bytesRead;
    }
    assertReportWork(budget);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new TypeError("Saved snapshot changed during reading.");
    return output;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readSavedReport(filename, budget = null) {
  const bytes = await readBoundedFile(filename, budget);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Saved snapshot is not valid JSON.");
  }
  assertReportWork(budget);
  return validateSavedReport(parsed);
}

function statusFromCoverage(coverage) {
  if (coverage.status === "inconsistent") return "inconsistent";
  return coverage.complete ? "available" : "partial";
}

export function capReportRows(rows, order) {
  const sorted = [...rows].sort(order);
  return Object.freeze({
    rows: Object.freeze(sorted.slice(0, REPORT_LIMITS.maxReportRows)),
    totalRows: sorted.length,
    reportedRows: Math.min(sorted.length, REPORT_LIMITS.maxReportRows),
    omittedRows: Math.max(0, sorted.length - REPORT_LIMITS.maxReportRows),
  });
}

export function lineChangeMetric(lineChanges, coverage) {
  if (!Array.isArray(lineChanges)) return Object.freeze({ status: "unavailable", reason: "edit-churn-unavailable-without-frozen-git-comparison", changes: [], totalRows: 0, reportedRows: 0, omittedRows: 0, totals: {} });
  const capped = capReportRows(lineChanges, (left, right) => (left.currentPath ?? left.beforePath).localeCompare(right.currentPath ?? right.beforePath) || left.kind.localeCompare(right.kind));
  const totals = new Map();
  for (const change of lineChanges) {
    if (change.added !== null) {
      const category = change.currentCategory ?? change.beforeCategory ?? "uncategorized";
      const value = totals.get(category) ?? { added: 0, deleted: 0, net: 0 };
      value.added += change.added;
      value.net += change.added;
      totals.set(category, value);
    }
    if (change.deleted !== null) {
      const category = change.beforeCategory ?? change.currentCategory ?? "uncategorized";
      const value = totals.get(category) ?? { added: 0, deleted: 0, net: 0 };
      value.deleted += change.deleted;
      value.net -= change.deleted;
      totals.set(category, value);
    }
  }
  const status = coverage.status === "inconsistent" ? "inconsistent" : (!coverage.complete || capped.omittedRows > 0 ? "partial" : "available");
  return Object.freeze({
    status,
    reason: capped.omittedRows > 0 ? "line-change-row-cap" : (coverage.complete ? null : "capture-coverage-partial"),
    changes: Object.freeze(capped.rows),
    totalRows: capped.totalRows,
    reportedRows: capped.reportedRows,
    omittedRows: capped.omittedRows,
    totals: Object.freeze(Object.fromEntries([...totals.entries()].sort(([left], [right]) => left.localeCompare(right)))),
  });
}

export function unavailableStructuralMeasurements(reason = "callable-complexity-adapter-unavailable") {
  return Object.freeze({
    complexity: Object.freeze({ status: "unavailable", reason, callables: [] }),
    erosion: Object.freeze({ status: "unavailable", reason, numerator: null, denominator: null, value: null, highComplexityCount: null, maxCc: null }),
    callables: Object.freeze({ status: "unavailable", reason, policy: "callable-exact-path-and-identity-v1", rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0, added: [], removed: [], unmatched: [] }),
    verbosityProxy: Object.freeze({ status: "unavailable", reason: "complete-compatible-pattern-and-clone-line-union-unavailable", value: null }),
  });
}

function noComparison(reason) {
  return Object.freeze({
    status: "not-applicable",
    reason,
    editChurn: Object.freeze({ status: "unavailable", reason: "edit-churn-requires-frozen-git-scan", changes: [], totalRows: 0, reportedRows: 0, omittedRows: 0 }),
    dependencyChanges: Object.freeze({ status: "not-applicable", reason, changes: [], totalRows: 0, reportedRows: 0, omittedRows: 0 }),
    matchedFunctionDeltas: Object.freeze({ status: "unavailable", reason: "callable-complexity-adapter-unavailable", rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0, added: [], removed: [], unmatched: [] }),
  });
}

export function comparisonFromSnapshots(before, after, { editChurn = null, compatible = null, coverage } = {}) {
  if (!before) return noComparison("baseline-not-captured");
  if (compatible?.status === "incompatible") {
    return Object.freeze({ ...noComparison("compatibility-mismatch"), status: "incompatible", compatibility: compatible });
  }
  if (coverage?.status === "inconsistent") {
    return Object.freeze({ ...noComparison("capture-inconsistent"), status: "inconsistent" });
  }
  const partial = !coverage?.complete || before.capture?.coverageStatus !== "complete" || after.capture?.coverageStatus !== "complete";
  const status = partial ? "partial" : "available";
  const beforeTotal = before.physicalLines.total;
  const afterTotal = after.physicalLines.total;
  return Object.freeze({
    status,
    reason: partial ? "coverage-partial-no-no-regression-conclusion" : null,
    physicalLineDelta: { before: beforeTotal, after: afterTotal, delta: afterTotal - beforeTotal },
    editChurn: editChurn ?? Object.freeze({ status: "unavailable", reason: "edit-churn-requires-frozen-git-scan", changes: [], totalRows: 0, reportedRows: 0, omittedRows: 0 }),
    dependencyChanges: Object.freeze({ status: "unavailable", reason: "dependency-comparison-not-provided", changes: [], totalRows: 0, reportedRows: 0, omittedRows: 0 }),
    matchedFunctionDeltas: Object.freeze({ status: "unavailable", reason: "callable-complexity-adapter-unavailable", rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0, added: [], removed: [], unmatched: [] }),
  });
}

export function createReport({ operation, compatibility, coverage, snapshot, comparison, provenance }) {
  if (!OPERATIONS.has(operation)) throw new TypeError("Unsupported report operation.");
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    operation,
    compatibility: assertCompatibility(compatibility),
    coverage,
    snapshot,
    comparison,
    provenance,
    reportLimits: REPORT_LIMITS,
  };
  return validateSavedReport(report);
}

function appendOmission(lines, label, metric) {
  if (metric?.omittedRows > 0) lines.push(`${label}: ${metric.omittedRows} row(s) omitted by the 1,000-row JSON cap. See --format json; unlisted contributors are not evidence of no regression.`);
}

/** A deterministic, source-free contributor summary. Full rows remain in JSON unless capped. */
export function renderHumanReport(report) {
  const current = report.snapshot.current;
  const comparison = report.comparison;
  const lines = [`Code quality ${report.operation} report`];
  let remaining = REPORT_LIMITS.maxHumanContributors;
  const add = (label, rows, format) => {
    if (rows.length === 0) return;
    const shown = rows.slice(0, remaining);
    if (shown.length > 0) {
      lines.push(`${label}:`);
      for (const row of shown) lines.push(`- ${format(row)}`);
      remaining -= shown.length;
    }
    const omittedForDisplay = rows.length - shown.length;
    if (omittedForDisplay > 0) lines.push(`${label}: ${omittedForDisplay} row(s) not shown by the ${REPORT_LIMITS.maxHumanContributors}-item human display cap. See --format json; unlisted contributors are not evidence of no regression.`);
  };
  if (["available", "partial"].includes(comparison.editChurn?.status)) {
    add("Line-change contributors", comparison.editChurn.changes ?? [], (row) => `${row.currentPath ?? row.beforePath}: +${row.added ?? "?"} -${row.deleted ?? "?"} (${row.kind})`);
    appendOmission(lines, "Line-change contributors", comparison.editChurn);
  }
  if (["available", "partial"].includes(comparison.dependencyChanges?.status)) {
    add("Direct dependency contributors", comparison.dependencyChanges.changes ?? [], (row) => `${row.path} ${row.section}/${row.name}: ${row.beforeVersion ?? "absent"} -> ${row.afterVersion ?? "absent"} (${row.kind})`);
    appendOmission(lines, "Direct dependency contributors", comparison.dependencyChanges);
  }
  if (["partial", "available"].includes(current.astPatterns.status)) {
    add("AST review candidates", current.astPatterns.findings ?? [], (row) => `${row.path}:${row.range.startLine}:${row.range.startColumn} ${row.ruleId} — ${row.message}`);
    appendOmission(lines, "AST review candidates", current.astPatterns);
  }
  if (["partial", "available"].includes(current.clones.status)) {
    add("Token-clone contributors", current.clones.rows ?? [], (row) => `${row.first.path}:${row.first.startLine}-${row.first.endLine} and ${row.second.path}:${row.second.startLine}-${row.second.endLine} (${row.kind}, ${row.tokens} tokens)`);
    appendOmission(lines, "Token-clone contributors", current.clones);
  }
  const callableRows = comparison.matchedFunctionDeltas?.rows ?? [];
  add("Growing callable contributors", callableRows.filter((row) => row.delta.mass > 0), (row) => `${row.path} ${row.identity}: mass +${row.delta.mass.toFixed(2)}`);
  add("Improving callable contributors", callableRows.filter((row) => row.delta.mass < 0), (row) => `${row.path} ${row.identity}: mass ${row.delta.mass.toFixed(2)}`);
  appendOmission(lines, "Callable contributors", comparison.matchedFunctionDeltas);
  lines.push(`Capture coverage: ${report.coverage.status}`);
  lines.push(`Physical lines: ${current.physicalLines.total}`);
  if (["available", "partial"].includes(comparison.status)) lines.push(`Physical-line delta: ${comparison.physicalLineDelta.delta >= 0 ? "+" : ""}${comparison.physicalLineDelta.delta}`);
  else lines.push(`Comparison: ${comparison.status} (${comparison.reason ?? "compatibility or coverage prevents comparison"})`);
  lines.push(`AST patterns: ${current.astPatterns.status}; findings: ${current.astPatterns.totalRows ?? 0}`);
  lines.push(`Token clones: ${current.clones.status}; pairs: ${current.clones.totalRows ?? 0}`);
  lines.push(`Complexity/SLOC/erosion: ${current.complexity.status} (${current.complexity.reason})`);
  return `${lines.join("\n")}\n`;
}

/** Diagnostics are intentionally reduced to stable category/reason labels. */
export function redactedDiagnostic(error) {
  if (error && typeof error === "object" && typeof error.reason === "string") return error.reason;
  if (error instanceof SyntaxError) return "invalid-json";
  if (error instanceof TypeError) return "invalid-input";
  return "scanner-failed";
}

export function resolveOutputPath(cwd, value) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new TypeError("Output path must be a non-empty string.");
  return path.resolve(cwd, value);
}
