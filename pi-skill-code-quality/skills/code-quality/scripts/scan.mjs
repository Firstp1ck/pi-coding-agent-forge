#!/usr/bin/env node
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectGitInputs, getCollectionRootForOutput, getFrozenEntries, snapshotReportProjection } from "./lib/capture.mjs";
import { compareDirectDependencies, directDependencySnapshot, metricsCompatibility, physicalLineTotals } from "./lib/metrics.mjs";
import {
  COMPATIBILITY_VERSION,
  REPORT_LIMITS,
  canonicalJson,
  comparisonFromSnapshots,
  compareCompatibility,
  createReport,
  lineChangeMetric,
  readSavedReport,
  redactedDiagnostic,
  renderHumanReport,
  resolveOutputPath,
  unavailableStructuralMeasurements,
} from "./lib/report.mjs";
import { CommandFailure, DEFAULT_LIMITS, ScanDeadline, SubprocessTracker } from "./lib/runner.mjs";
import { normalizeScopeRoots } from "./lib/classification.mjs";
import { astGrepCompatibility, runAstGrep } from "./adapters/ast-grep.mjs";
import { jscpdCompatibility, runJscpd } from "./adapters/jscpd.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rulesRoot = path.resolve(scriptDirectory, "..", "rules", "ast-grep");
const VALUE_OPTIONS = new Set(["base", "scope", "format", "out", "git", "ast-grep", "jscpd", "before", "after"]);
const FLAG_OPTIONS = new Set(["include-untracked"]);

function cliError() {
  throw new TypeError("invalid-cli-options");
}

function optionValue(argument, following) {
  const equals = argument.indexOf("=");
  if (equals >= 0) return [argument.slice(2, equals), argument.slice(equals + 1), false];
  return [argument.slice(2), following, true];
}

/** Parses only declared scanner options; shell, config, and implicit discovery are unsupported. */
export function parseArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length === 0) cliError();
  const operation = arguments_[0];
  if (!["scan", "snapshot", "compare"].includes(operation)) cliError();
  const options = { operation, scopes: [], includeUntracked: false, format: "human" };
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--") || argument === "--") cliError();
    const [name, value, consumesNext] = optionValue(argument, arguments_[index + 1]);
    if (FLAG_OPTIONS.has(name)) {
      if (value !== undefined && !consumesNext) cliError();
      if (name === "include-untracked") options.includeUntracked = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name) || value === undefined || value === "" || value.includes("\0")) cliError();
    if (consumesNext) index += 1;
    if (name === "scope") options.scopes.push(value);
    else if (name === "ast-grep") options.astGrep = value;
    else if (name === "jscpd") options.jscpd = value;
    else options[name] = value;
  }
  if (!["json", "human"].includes(options.format)) cliError();
  if (operation === "scan") {
    if (!options.base || options.scopes.length === 0 || options.before || options.after) cliError();
  } else if (operation === "snapshot") {
    if (options.base || options.scopes.length === 0 || options.before || options.after) cliError();
  } else if (!options.before || !options.after || options.scopes.length > 0 || options.base || options.git || options.astGrep || options.jscpd || options.includeUntracked) cliError();
  return Object.freeze(options);
}

function captureForReport(snapshot) {
  const projection = snapshotReportProjection(snapshot);
  return Object.freeze({
    kind: projection.kind,
    manifestDigest: projection.manifestDigest,
    ignoreIdentity: projection.ignoreIdentity,
    captureIdentity: projection.captureIdentity,
    files: projection.files,
    coverageStatus: projection.coverage.status,
    coverageComplete: projection.coverage.complete,
    coverage: projection.coverage,
  });
}

function unavailableAdapter(reason, definition) {
  return Object.freeze({ status: "unavailable", reason, findings: [], rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0, definition, stopAnalysis: false });
}

function invalidatedStructuralMeasurements(compatibility) {
  return Object.freeze({
    ...unavailableStructuralMeasurements("frozen-input-integrity-invalidated"),
    astPatterns: unavailableAdapter("frozen-input-integrity-invalidated", compatibility.astGrep),
    clones: unavailableAdapter("frozen-input-integrity-invalidated", compatibility.jscpd),
    analysisStopped: true,
    analysisInvalidated: true,
  });
}

function assertCommandWork(budget) {
  if (budget.signal?.aborted) throw new CommandFailure("scanner", null, "cancelled");
  budget.deadline.assertWorkAvailable();
}

async function structuralMeasurements({ snapshot, options, budget, compatibility }) {
  const unavailable = unavailableStructuralMeasurements();
  let astPatterns = unavailableAdapter("ast-grep-not-configured", compatibility.astGrep);
  let clones = unavailableAdapter("jscpd-not-configured", compatibility.jscpd);
  let stopped = false;
  if (options.astGrep) {
    astPatterns = await runAstGrep({
      executablePath: path.resolve(options.cwd, options.astGrep),
      checkoutRoot: options.checkoutRoot,
      snapshot,
      ruleRoot: rulesRoot,
      budget,
      definition: compatibility.astGrep,
    });
    stopped = astPatterns.stopAnalysis;
  }
  if (options.jscpd && !stopped) {
    clones = await runJscpd({
      executablePath: path.resolve(options.cwd, options.jscpd),
      checkoutRoot: options.checkoutRoot,
      snapshot,
      budget,
      definition: compatibility.jscpd,
    });
    stopped = clones.stopAnalysis;
  } else if (options.jscpd && stopped) clones = unavailableAdapter("analysis-stopped-after-frozen-input-mutation", compatibility.jscpd);
  return Object.freeze({ ...unavailable, astPatterns, clones, analysisStopped: stopped, analysisInvalidated: stopped });
}

function snapshotMeasurement(snapshot, structural, { forceInconsistent = false } = {}) {
  const entries = getFrozenEntries(snapshot);
  const capture = captureForReport(snapshot);
  const invalidatedCapture = forceInconsistent ? Object.freeze({
    ...capture,
    coverageStatus: "inconsistent",
    coverageComplete: false,
    coverage: Object.freeze({ ...capture.coverage, status: "inconsistent", complete: false }),
  }) : capture;
  return Object.freeze({
    capture: invalidatedCapture,
    physicalLines: physicalLineTotals(entries),
    dependencies: directDependencySnapshot(entries, REPORT_LIMITS.maxReportRows),
    complexity: structural.complexity,
    erosion: structural.erosion,
    callables: structural.callables,
    astPatterns: structural.astPatterns,
    clones: structural.clones,
    verbosityProxy: structural.verbosityProxy,
  });
}

async function scannerCompatibility({ inputs, options, deadline }) {
  const astGrep = await astGrepCompatibility({ ruleRoot: rulesRoot, requested: Boolean(options.astGrep), deadline });
  const jscpd = jscpdCompatibility({ requested: Boolean(options.jscpd) });
  return Object.freeze({
    version: COMPATIBILITY_VERSION,
    scanner: {
      schemaVersion: "code-quality-report-v1",
      cli: "scan-snapshot-compare-v1",
      reportLimits: REPORT_LIMITS,
      sourcePersistence: "report-safe-metadata-only-v1",
    },
    collection: inputs.collectionCompatibility,
    git: {
      version: inputs.provenance.gitVersion ?? null,
      policy: inputs.provenance.gitPolicy ?? null,
    },
    metrics: metricsCompatibility(),
    adapters: {
      complexity: {
        version: "no-approved-callable-complexity-adapter-v1",
        status: "unavailable",
        reason: "parse-completeness-and-callable-identity-contract-unestablished",
      },
      astGrep,
      jscpd,
    },
  });
}

function safeProvenance(inputs, tracker) {
  return Object.freeze({
    source: inputs.provenance.source,
    gitVersion: inputs.provenance.gitVersion ?? null,
    baselineCommit: inputs.provenance.baselineCommit ?? null,
    gitPolicy: inputs.provenance.gitPolicy ?? null,
    captureAttempts: inputs.provenance.captureAttempts,
    untrackedDiscovery: inputs.provenance.untrackedDiscovery ?? null,
    processCounts: tracker.report(),
  });
}

function comparisonCoverage(inputs) {
  return Object.freeze({ status: inputs.coverage.status, complete: inputs.coverage.complete });
}

async function runCaptureOperation(options, cwd, budget) {
  let inputs;
  try {
    assertCommandWork(budget);
    inputs = await collectGitInputs({
      cwd,
      base: options.operation === "scan" ? options.base : null,
      scopeRoots: options.scopes,
      includeUntracked: options.includeUntracked,
      gitExecutable: options.git ? path.resolve(cwd, options.git) : undefined,
      limits: DEFAULT_LIMITS,
      signal: budget.signal,
    }, budget);
    assertCommandWork(budget);
    const repositoryRoot = getCollectionRootForOutput(inputs);
    const compatibility = await scannerCompatibility({ inputs, options: { ...options, cwd }, deadline: budget.deadline });
    let beforeStructural = null;
    let currentStructural;
    if (inputs.before) {
      beforeStructural = await structuralMeasurements({ snapshot: inputs.before, options: { ...options, cwd, checkoutRoot: repositoryRoot }, budget, compatibility: compatibility.adapters });
      if (beforeStructural.analysisStopped) currentStructural = invalidatedStructuralMeasurements(compatibility.adapters);
    }
    if (!currentStructural) currentStructural = await structuralMeasurements({ snapshot: inputs.current, options: { ...options, cwd, checkoutRoot: repositoryRoot }, budget, compatibility: compatibility.adapters });
    const analysisInvalidated = Boolean(beforeStructural?.analysisInvalidated || currentStructural.analysisInvalidated);
    const effectiveCoverage = analysisInvalidated ? Object.freeze({
      ...inputs.coverage,
      status: "inconsistent",
      complete: false,
      before: inputs.coverage.before ? Object.freeze({ ...inputs.coverage.before, status: "inconsistent", complete: false }) : null,
      current: Object.freeze({ ...inputs.coverage.current, status: "inconsistent", complete: false }),
    }) : inputs.coverage;
    const before = inputs.before ? snapshotMeasurement(inputs.before, beforeStructural, { forceInconsistent: analysisInvalidated }) : null;
    const current = snapshotMeasurement(inputs.current, currentStructural, { forceInconsistent: analysisInvalidated });
    const lineChanges = lineChangeMetric(inputs.lineChanges, effectiveCoverage);
    let comparison = comparisonFromSnapshots(before, current, { editChurn: lineChanges, coverage: comparisonCoverage({ coverage: effectiveCoverage }) });
    if (before) {
      comparison = Object.freeze({
        ...comparison,
        dependencyChanges: compareDirectDependencies(before.dependencies, current.dependencies, REPORT_LIMITS.maxReportRows),
        matchedFunctionDeltas: current.callables,
      });
    }
    const report = createReport({
      operation: options.operation,
      compatibility,
      coverage: effectiveCoverage,
      snapshot: { before, current },
      comparison,
      provenance: safeProvenance(inputs, budget.tracker),
    });
    assertCommandWork(budget);
    return { report, repositoryRoot };
  } finally {
    await inputs?.dispose();
  }
}

function compareReports(beforeReport, afterReport, budget) {
  assertCommandWork(budget);
  const compatibility = compareCompatibility(beforeReport.compatibility, afterReport.compatibility);
  const before = beforeReport.snapshot.current;
  const after = afterReport.snapshot.current;
  const comparisonStatus = compatibility.status === "incompatible"
    ? "partial"
    : (beforeReport.coverage.status === "inconsistent" || afterReport.coverage.status === "inconsistent" ? "inconsistent" : (beforeReport.coverage.complete && afterReport.coverage.complete ? "complete" : "partial"));
  const coverage = {
    status: comparisonStatus,
    complete: comparisonStatus === "complete",
    before: beforeReport.coverage.current,
    current: afterReport.coverage.current,
  };
  let comparison = comparisonFromSnapshots(before, after, { compatible: compatibility, coverage });
  if (compatibility.status !== "incompatible" && comparison.status !== "inconsistent") {
    comparison = Object.freeze({
      ...comparison,
      dependencyChanges: compareDirectDependencies(before.dependencies, after.dependencies, REPORT_LIMITS.maxReportRows),
      matchedFunctionDeltas: after.callables,
    });
  }
  const report = createReport({
    operation: "compare",
    compatibility: beforeReport.compatibility,
    coverage,
    snapshot: { before, current: after },
    comparison,
    provenance: { source: "saved-snapshots", gitVersion: null, baselineCommit: null, gitPolicy: null, captureAttempts: null, processCounts: null },
  });
  assertCommandWork(budget);
  return report;
}

function sameFilesystemPath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function inspectExistingAncestry(existing) {
  const volumeRoot = path.parse(existing).root;
  let lexical = volumeRoot;
  let canonical = await fs.realpath(volumeRoot);
  const relative = path.relative(volumeRoot, existing);
  for (const segment of relative ? relative.split(path.sep) : []) {
    lexical = path.join(lexical, segment);
    const metadata = await fs.lstat(lexical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError("unsafe-output-parent");
    const resolved = await fs.realpath(lexical);
    if (!sameFilesystemPath(resolved, path.join(canonical, segment))) throw new TypeError("unsafe-output-parent");
    canonical = resolved;
  }
  return canonical;
}

async function inspectOutputTarget(target) {
  const missingDirectories = [];
  let existing = path.dirname(target);
  while (!(await fs.lstat(existing).then(() => true, () => false))) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new TypeError("unsafe-output-parent");
    missingDirectories.push(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = await inspectExistingAncestry(existing);
  const canonicalTarget = path.join(canonicalExisting, ...missingDirectories.reverse(), path.basename(target));
  return { existing, canonicalExisting, missingDirectories, canonicalTarget };
}

function outputIsInScope(repositoryRoot, canonicalOutputPath, scopes) {
  const relative = path.relative(repositoryRoot, canonicalOutputPath).replaceAll(path.sep, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return false;
  return scopes.some((scope) => scope === "" || relative === scope || relative.startsWith(`${scope}/`));
}

function hasAmbiguousWindowsPathSegment(target) {
  if (process.platform !== "win32") return false;
  const resolved = path.resolve(target);
  const relative = path.relative(path.parse(resolved).root, resolved);
  return relative.split(/[\\/]+/u).some((segment) => /[. ]$/u.test(segment));
}

async function createSafeOutputParent(inspection) {
  let current = inspection.existing;
  for (const segment of inspection.missingDirectories) {
    current = path.join(current, segment);
    await fs.mkdir(current, { mode: 0o700 });
    await inspectExistingAncestry(current);
  }
  const canonicalParent = await inspectExistingAncestry(path.dirname(path.join(inspection.existing, ...inspection.missingDirectories, "report")));
  return { lexicalParent: path.join(inspection.existing, ...inspection.missingDirectories), canonicalParent };
}

/** Explicit report output is create-only and cannot be a selected source path. */
export async function writeExplicitOutput({ cwd, repositoryRoot = cwd, output, scopes, json, budget = null }) {
  if (budget) assertCommandWork(budget);
  const target = resolveOutputPath(cwd, output);
  if (hasAmbiguousWindowsPathSegment(target)) throw new TypeError("ambiguous-output-path");
  if (!Array.isArray(scopes)) throw new TypeError("invalid-output-scopes");
  const normalizedScopes = scopes.length === 0 ? [] : normalizeScopeRoots(scopes);
  const canonicalRepositoryRoot = await fs.realpath(repositoryRoot);
  const inspection = await inspectOutputTarget(target);
  if (outputIsInScope(canonicalRepositoryRoot, inspection.canonicalTarget, normalizedScopes)) throw new TypeError("output-path-is-inside-selected-source-scope");
  if (await fs.lstat(target).then(() => true, () => false)) throw new TypeError("output-path-already-exists");
  const parent = await createSafeOutputParent(inspection);
  if (budget) assertCommandWork(budget);
  const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    if (budget) assertCommandWork(budget);
    await handle.writeFile(json);
    const metadata = await handle.stat();
    const pathname = await fs.lstat(target);
    if (!metadata.isFile() || !pathname.isFile() || pathname.isSymbolicLink()) throw new TypeError("unsafe-output-path");
    const canonicalParent = await inspectExistingAncestry(parent.lexicalParent);
    if (!sameFilesystemPath(canonicalParent, parent.canonicalParent)) throw new TypeError("unsafe-output-parent");
    if (budget) assertCommandWork(budget);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return target;
}

export async function runCli(arguments_, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, signal = null, deadline = new ScanDeadline(DEFAULT_LIMITS), tracker = new SubprocessTracker(DEFAULT_LIMITS) } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const removeExternal = signal ? () => signal.removeEventListener("abort", cancel) : () => undefined;
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", cancel, { once: true });
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const budget = { deadline, tracker, limits: DEFAULT_LIMITS, signal: controller.signal };
  try {
    assertCommandWork(budget);
    const options = parseArguments(arguments_);
    const root = path.resolve(cwd);
    const capture = options.operation === "compare" ? null : await runCaptureOperation(options, root, budget);
    const report = capture
      ? capture.report
      : compareReports(
        await readSavedReport(path.resolve(root, options.before), budget),
        await readSavedReport(path.resolve(root, options.after), budget),
        budget,
      );
    assertCommandWork(budget);
    const json = `${canonicalJson(report)}\n`;
    assertCommandWork(budget);
    if (Buffer.byteLength(json, "utf8") > REPORT_LIMITS.maxSnapshotBytes) throw new TypeError("report-output-exceeds-size-limit");
    if (options.out) await writeExplicitOutput({ cwd: root, repositoryRoot: capture?.repositoryRoot ?? root, output: options.out, scopes: options.scopes, json, budget });
    assertCommandWork(budget);
    const human = options.format === "json" ? json : renderHumanReport(report);
    assertCommandWork(budget);
    stdout.write(human);
    return 0;
  } catch (error) {
    stderr.write(`code-quality scanner: ${redactedDiagnostic(error)}\n`);
    return 2;
  } finally {
    removeExternal();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
