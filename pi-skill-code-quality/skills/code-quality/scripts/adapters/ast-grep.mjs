import { promises as fs } from "node:fs";
import path from "node:path";
import { materializeAnalyzerWorkspace } from "../lib/capture.mjs";
import { resolveTrustedExecutable, runBounded, sha256File } from "../lib/runner.mjs";

const AST_GREP_VERSION = "0.45.3";
const AST_GREP_WINDOWS_SHA256 = "daff0f5963faab7617045833132a3538c85eee65f3afeedf347f829a7b8d83fb";
const RULES = Object.freeze([
  { language: "javascript", filename: "javascript/no-console-log.yml" },
  { language: "typescript", filename: "typescript/no-console-log.yml" },
  { language: "python", filename: "python/inspect-print.yml" },
]);
const OPTIONS = Object.freeze([
  "scan",
  "--rule=<scanner-owned-rule>",
  "--json=compact",
  "--include-metadata",
  "--color=never",
  "--no-ignore=hidden",
  "--no-ignore=dot",
  "--no-ignore=vcs",
  "--no-ignore=global",
]);

function safeRuleId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/iu.test(value);
}

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
  return Object.freeze({ status: "unavailable", reason, findings: [], totalRows: 0, reportedRows: 0, omittedRows: 0, definition, stopAnalysis: false });
}

async function ruleDefinitions(ruleRoot, deadline) {
  const definitions = [];
  for (const rule of RULES) {
    const filename = path.resolve(ruleRoot, rule.filename);
    const digest = await sha256File(filename, { deadline, maxBytes: 64 * 1024 });
    definitions.push(Object.freeze({ language: rule.language, rule: rule.filename, sha256: digest }));
  }
  return Object.freeze(definitions);
}

/** Adapter configuration is always explicit, scanner-owned, and source-free. */
export async function astGrepCompatibility({ ruleRoot, requested = false, deadline }) {
  let rules;
  try {
    rules = await ruleDefinitions(ruleRoot, deadline);
  } catch {
    rules = Object.freeze(RULES.map((rule) => Object.freeze({ language: rule.language, rule: rule.filename, sha256: null })));
  }
  return Object.freeze({
    version: "ast-grep-adapter-v1",
    requested: Boolean(requested),
    executable: {
      expectedVersion: AST_GREP_VERSION,
      expectedSha256: AST_GREP_WINDOWS_SHA256,
      supportedPlatform: "win32-x64",
      resolution: "explicit-trusted-absolute-executable-v1",
    },
    options: OPTIONS,
    rules,
    parseCompleteness: "unestablished-partial-even-empty-v1",
  });
}

function selectedForRule(entries, language) {
  return [...entries.values()].filter((entry) => entry.language === language);
}

function validateResponse(value, mapping, definition) {
  if (!Array.isArray(value)) throw new TypeError("ast-grep JSON must be an array.");
  const rows = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || !safeRuleId(item.ruleId) || !item.range || typeof item.file !== "string") throw new TypeError("ast-grep result is malformed.");
    const file = mapping.get(path.basename(item.file));
    const start = item.range.start;
    const end = item.range.end;
    if (!file || !start || !end || !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.column) || !Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.column) || start.line < 0 || end.line < start.line || start.column < 0 || end.column < 0) {
      throw new TypeError("ast-grep result references an unexpected range.");
    }
    rows.push(Object.freeze({
      ruleId: item.ruleId,
      ruleVersion: definition.sha256,
      path: file.path,
      language: file.language,
      severity: typeof item.severity === "string" ? item.severity : "unknown",
      message: typeof item.message === "string" ? item.message : "Inspect this pattern.",
      range: Object.freeze({
        startLine: start.line + 1,
        startColumn: start.column,
        endLineExclusive: end.line + 1,
        endColumn: end.column,
      }),
    }));
  }
  return rows;
}

async function verifyExecutable(executablePath, { checkoutRoot, deadline, tracker, signal = null }) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new TypeError("ast-grep pinned adapter is only validated on win32-x64.");
  const executable = await resolveTrustedExecutable({ explicitPath: executablePath, checkoutRoot });
  const actualHash = await sha256File(executable, { deadline, maxBytes: 64 * 1024 * 1024 });
  if (actualHash !== AST_GREP_WINDOWS_SHA256) throw new TypeError("ast-grep executable hash does not match the pinned adapter.");
  const response = await runBounded(executable, ["--version"], {
    cwd: path.dirname(executable),
    env: analyzerEnvironment(path.dirname(executable)),
    deadline,
    tracker,
    kind: "analyzer",
    signal,
  });
  if (response.stdout.toString("utf8").trim() !== `ast-grep ${AST_GREP_VERSION}`) throw new TypeError("ast-grep executable version does not match the pinned adapter.");
  return executable;
}

/**
 * Runs no default discovery: every invocation receives one packaged rule and
 * frozen scanner-owned file paths. The parser's completeness is not established,
 * so a successful empty finding list remains partial evidence.
 */
export async function runAstGrep({ executablePath, checkoutRoot, snapshot, ruleRoot, budget, definition }) {
  if (!executablePath) return unavailable("ast-grep-not-configured", definition);
  let executable;
  try {
    executable = await verifyExecutable(executablePath, { checkoutRoot, deadline: budget.deadline, tracker: budget.tracker, signal: budget.signal });
  } catch {
    return unavailable("ast-grep-untrusted-or-unsupported", definition);
  }
  const findings = [];
  let selectedFiles = 0;
  for (const rule of RULES) {
    try {
      budget.deadline.assertWorkAvailable();
      if (budget.signal?.aborted) return unavailable("ast-grep-cancelled", definition);
      const entries = selectedForRule(await importFrozenEntries(snapshot), rule.language);
      if (entries.length === 0) continue;
      selectedFiles += entries.length;
      const workspace = await materializeAnalyzerWorkspace(snapshot, entries, budget);
      let failure = null;
      let rows = [];
      try {
        const rulePath = path.resolve(ruleRoot, rule.filename);
        const mapping = new Map(workspace.files.map((file) => [file.id, file.entry]));
        const response = await runBounded(executable, [
          "scan",
          "--rule", rulePath,
          "--json=compact",
          "--include-metadata",
          "--color", "never",
          "--no-ignore", "hidden",
          "--no-ignore", "dot",
          "--no-ignore", "vcs",
          "--no-ignore", "global",
          ...workspace.files.map((file) => file.filePath),
        ], {
          cwd: workspace.root,
          env: analyzerEnvironment(workspace.root),
          deadline: budget.deadline,
          tracker: budget.tracker,
          kind: "analyzer",
          signal: budget.signal,
        });
        const raw = JSON.parse(response.stdout.toString("utf8"));
        const configuredRule = definition.rules.find((item) => item.language === rule.language);
        rows = validateResponse(raw, mapping, configuredRule);
      } catch (error) {
        failure = error;
      }
      const verification = await workspace.verify().catch(() => ({ valid: false, modified: workspace.files.length }));
      await workspace.dispose();
      if (!verification.valid) {
        return Object.freeze({
          status: "unavailable",
          reason: "analyzer-modified-frozen-input",
          findings: [],
          totalRows: 0,
          reportedRows: 0,
          omittedRows: 0,
          coverage: Object.freeze({ selectedFiles, analyzedFiles: 0, complete: false, reason: "frozen-input-integrity-invalidated" }),
          definition,
          stopAnalysis: true,
        });
      }
      if (failure) return unavailable("ast-grep-execution-or-output-invalid", definition);
      findings.push(...rows);
    } catch {
      return unavailable("ast-grep-execution-or-output-invalid", definition);
    }
  }
  findings.sort((left, right) => left.path.localeCompare(right.path) || left.range.startLine - right.range.startLine || left.ruleId.localeCompare(right.ruleId));
  const reported = findings.slice(0, 1_000);
  return Object.freeze({
    status: "partial",
    reason: "ast-grep-parse-completeness-unestablished",
    findings: Object.freeze(reported),
    totalRows: findings.length,
    reportedRows: reported.length,
    omittedRows: findings.length - reported.length,
    coverage: Object.freeze({ selectedFiles, analyzedFiles: selectedFiles, complete: false, reason: "parse-completeness-unestablished" }),
    definition,
    stopAnalysis: false,
  });
}

async function importFrozenEntries(snapshot) {
  const { getFrozenEntries } = await import("../lib/capture.mjs");
  return getFrozenEntries(snapshot);
}
