import { promises as fs } from "node:fs";
import path from "node:path";
import { getFrozenEntries, materializeAnalyzerWorkspace } from "../lib/capture.mjs";
import { cloneLineUnion, digestJson } from "../lib/metrics.mjs";
import { createScannerTempRoot, resolveTrustedExecutable, runBounded, sha256File } from "../lib/runner.mjs";

const JSCPD_VERSION = "5.2.0";
const JSCPD_WINDOWS_SHA256 = "e5d85c518e917b304a11f63864bb93e6a2afa23c315e5b657321cd29fb156265";
const FORMATS = Object.freeze(["javascript", "typescript", "python"]);
const CONFIGURATION = Object.freeze({
  reporters: ["json"],
  minTokens: 5,
  minLines: 2,
  maxLines: 100,
  mode: "strict",
  format: [...FORMATS],
  ignore: [],
  noGitignore: true,
  absolute: false,
  silent: true,
});
const OPTIONS = Object.freeze([
  "--config=<scanner-owned-config>",
  "--no-gitignore",
  "--output=<scanner-owned-output>",
  "no-baseline-no-blame-no-cross-format-no-exit-code-v1",
]);

function analyzerEnvironment(home) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
  };
}

function unavailable(reason, definition) {
  return Object.freeze({ status: "unavailable", reason, rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0, uniqueCoveredLines: null, coverage: { selectedFiles: 0, analyzedFiles: 0, complete: false }, definition, stopAnalysis: false });
}

export function jscpdCompatibility({ requested = false } = {}) {
  return Object.freeze({
    version: "jscpd-adapter-v1",
    requested: Boolean(requested),
    executable: {
      expectedVersion: JSCPD_VERSION,
      expectedSha256: JSCPD_WINDOWS_SHA256,
      supportedPlatform: "win32-x64",
      resolution: "explicit-trusted-absolute-executable-v1",
    },
    options: OPTIONS,
    configuration: CONFIGURATION,
    configurationSha256: digestJson(CONFIGURATION),
    coverage: "format-source-count-and-parameter-fixtures-v1",
    lineAccounting: "inclusive-physical-span-union-v1",
  });
}

async function verifyExecutable(executablePath, { checkoutRoot, deadline, tracker, signal = null }) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new TypeError("jscpd pinned adapter is only validated on win32-x64.");
  const executable = await resolveTrustedExecutable({ explicitPath: executablePath, checkoutRoot });
  const actualHash = await sha256File(executable, { deadline, maxBytes: 64 * 1024 * 1024 });
  if (actualHash !== JSCPD_WINDOWS_SHA256) throw new TypeError("jscpd executable hash does not match the pinned adapter.");
  const response = await runBounded(executable, ["--version"], {
    cwd: path.dirname(executable),
    env: analyzerEnvironment(path.dirname(executable)),
    deadline,
    tracker,
    kind: "analyzer",
    signal,
  });
  if (response.stdout.toString("utf8").trim() !== `jscpd ${JSCPD_VERSION}`) throw new TypeError("jscpd executable version does not match the pinned adapter.");
  return executable;
}

async function readOwnedJson(filename, deadline) {
  const metadata = await fs.lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8 * 1024 * 1024) throw new TypeError("jscpd report is unsafe or oversized.");
  const handle = await fs.open(filename, "r");
  try {
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      deadline.assertWorkAvailable();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new TypeError("jscpd report ended early.");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) throw new TypeError("jscpd report changed during reading.");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function span(file, mapping) {
  if (!file || typeof file.name !== "string" || !Number.isSafeInteger(file.start) || !Number.isSafeInteger(file.end) || file.start < 1 || file.end < file.start) {
    throw new TypeError("jscpd clone span is malformed.");
  }
  const entry = mapping.get(path.basename(file.name));
  if (!entry) throw new TypeError("jscpd clone references an unexpected file.");
  return Object.freeze({ path: entry.path, startLine: file.start, endLine: file.end });
}

function parseReport(value, mapping) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.duplicates) || !value.statistics || typeof value.statistics !== "object") {
    throw new TypeError("jscpd JSON report is malformed.");
  }
  const rows = value.duplicates.map((duplicate) => {
    if (!duplicate || typeof duplicate !== "object" || !FORMATS.includes(duplicate.format) || !Number.isSafeInteger(duplicate.tokens) || duplicate.tokens < 0 || typeof duplicate.kind !== "string") {
      throw new TypeError("jscpd duplicate is malformed.");
    }
    return Object.freeze({ kind: duplicate.kind, format: duplicate.format, tokens: duplicate.tokens, first: span(duplicate.firstFile, mapping), second: span(duplicate.secondFile, mapping) });
  });
  rows.sort((left, right) => left.first.path.localeCompare(right.first.path) || left.first.startLine - right.first.startLine || left.second.path.localeCompare(right.second.path) || left.second.startLine - right.second.startLine);
  return { rows, statistics: value.statistics };
}

function selectedEntries(snapshot) {
  return [...getFrozenEntries(snapshot).values()].filter((entry) => FORMATS.includes(entry.language));
}

function coverageFor(statistics, selected) {
  const expected = new Map();
  for (const entry of selected) expected.set(entry.language, (expected.get(entry.language) ?? 0) + 1);
  let analyzedFiles = 0;
  let complete = true;
  for (const [format, count] of expected) {
    const sources = statistics?.formats?.[format]?.sources;
    if (!Number.isSafeInteger(sources) || sources < 0) complete = false;
    else {
      analyzedFiles += sources;
      if (sources !== count) complete = false;
    }
  }
  return Object.freeze({ selectedFiles: selected.length, analyzedFiles, complete, reason: complete ? null : "jscpd-format-source-coverage-incomplete" });
}

/** Runs the pinned direct binary against a scanner-owned frozen workspace only. */
export async function runJscpd({ executablePath, checkoutRoot, snapshot, budget, definition }) {
  if (!executablePath) return unavailable("jscpd-not-configured", definition);
  const entries = selectedEntries(snapshot);
  if (entries.length === 0) return Object.freeze({ status: "not-applicable", reason: "no-parameter-validated-source-language", rows: [], totalRows: 0, reportedRows: 0, omittedRows: 0, uniqueCoveredLines: { definition: "inclusive-physical-span-union-v1", lines: 0, byPath: [] }, coverage: { selectedFiles: 0, analyzedFiles: 0, complete: true }, definition, stopAnalysis: false });
  let executable;
  try {
    executable = await verifyExecutable(executablePath, { checkoutRoot, deadline: budget.deadline, tracker: budget.tracker, signal: budget.signal });
  } catch {
    return unavailable("jscpd-untrusted-or-unsupported", definition);
  }
  let workspace;
  let outputRoot;
  let failure = null;
  let parsed = null;
  try {
    workspace = await materializeAnalyzerWorkspace(snapshot, entries, budget);
    outputRoot = await createScannerTempRoot("pi-code-quality-jscpd-output-");
    const configPath = path.join(outputRoot, "jscpd-config.json");
    const reportRoot = path.join(outputRoot, "report");
    await fs.writeFile(configPath, JSON.stringify(CONFIGURATION), { flag: "wx", mode: 0o600 });
    await fs.mkdir(reportRoot, { mode: 0o700 });
    await runBounded(executable, ["--config", configPath, "--no-gitignore", "--output", reportRoot, workspace.root], {
      cwd: outputRoot,
      env: analyzerEnvironment(outputRoot),
      deadline: budget.deadline,
      tracker: budget.tracker,
      kind: "analyzer",
      signal: budget.signal,
    });
    parsed = parseReport(await readOwnedJson(path.join(reportRoot, "jscpd-report.json"), budget.deadline), new Map(workspace.files.map((file) => [file.id, file.entry])));
  } catch (error) {
    failure = error;
  }
  const verification = workspace
    ? await workspace.verify().catch(() => ({ valid: false, modified: entries.length }))
    : { valid: true, modified: 0 };
  await workspace?.dispose().catch(() => undefined);
  await fs.rm(outputRoot, { recursive: true, force: true }).catch(() => undefined);
  if (!verification.valid) {
    return Object.freeze({
      status: "unavailable",
      reason: "analyzer-modified-frozen-input",
      rows: [],
      totalRows: 0,
      reportedRows: 0,
      omittedRows: 0,
      uniqueCoveredLines: null,
      coverage: { selectedFiles: entries.length, analyzedFiles: 0, complete: false, reason: "frozen-input-integrity-invalidated" },
      definition,
      stopAnalysis: true,
    });
  }
  if (failure || !parsed) return unavailable("jscpd-execution-or-output-invalid", definition);
  const coverage = coverageFor(parsed.statistics, entries);
  const reported = parsed.rows.slice(0, 1_000);
  return Object.freeze({
    status: coverage.complete && reported.length === parsed.rows.length ? "available" : "partial",
    reason: coverage.complete ? (reported.length === parsed.rows.length ? null : "clone-row-cap") : coverage.reason,
    rows: Object.freeze(reported),
    totalRows: parsed.rows.length,
    reportedRows: reported.length,
    omittedRows: parsed.rows.length - reported.length,
    uniqueCoveredLines: cloneLineUnion(parsed.rows),
    coverage,
    definition,
    stopAnalysis: false,
  });
}
