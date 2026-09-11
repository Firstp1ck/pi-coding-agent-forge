import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectGitInputs, materializeAnalyzerWorkspace } from "../skills/code-quality/scripts/lib/capture.mjs";
import { DEFAULT_LIMITS, ScanDeadline, SubprocessTracker } from "../skills/code-quality/scripts/lib/runner.mjs";
import { astGrepCompatibility, runAstGrep } from "../skills/code-quality/scripts/adapters/ast-grep.mjs";
import { jscpdCompatibility, runJscpd } from "../skills/code-quality/scripts/adapters/jscpd.mjs";
import { removeDirectory, temporaryDirectory, writeFixture } from "./helpers/fixture.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rulesRoot = path.join(repositoryRoot, "skills", "code-quality", "rules", "ast-grep");
const astExecutable = process.env.CODE_QUALITY_AST_GREP_EXE;
const jscpdExecutable = process.env.CODE_QUALITY_JSCPD_EXE;

function budget() {
  return {
    deadline: new ScanDeadline(DEFAULT_LIMITS),
    tracker: new SubprocessTracker(DEFAULT_LIMITS),
    limits: DEFAULT_LIMITS,
  };
}

async function hasCandidate(filename) {
  if (!filename || !path.isAbsolute(filename)) return false;
  return fs.access(filename).then(() => true, () => false);
}

async function capturedFixture(files) {
  const root = await temporaryDirectory();
  for (const [filename, source] of Object.entries(files)) await writeFixture(root, filename, source);
  const inputs = await collectGitInputs({ cwd: root, scopeRoots: ["src"], limits: DEFAULT_LIMITS }, budget());
  return { root, inputs };
}

test("missing optional analyzer is unavailable rather than an empty clean result", async () => {
  const fixture = await capturedFixture({ "src/value.js": "console.log('inspect');\n" });
  try {
    const definition = await astGrepCompatibility({ ruleRoot: rulesRoot, requested: true, deadline: new ScanDeadline(DEFAULT_LIMITS) });
    const result = await runAstGrep({ executablePath: path.join(fixture.root, "missing.exe"), checkoutRoot: fixture.root, snapshot: fixture.inputs.current, ruleRoot: rulesRoot, budget: budget(), definition });
    assert.equal(result.status, "unavailable");
    assert.equal(result.findings.length, 0);
  } finally {
    await fixture.inputs.dispose();
    await removeDirectory(fixture.root);
  }
});

test("frozen analyzer workspaces detect mutation without modifying captured source", async () => {
  const fixture = await capturedFixture({ "src/value.js": "export const value = 1;\n" });
  let workspace;
  try {
    workspace = await materializeAnalyzerWorkspace(fixture.inputs.current, null, budget());
    await fs.appendFile(workspace.files[0].filePath, "// attempted mutation\n");
    assert.deepEqual(await workspace.verify(), { valid: false, modified: 1 });
    assert.equal((await fs.readFile(path.join(fixture.root, "src", "value.js"), "utf8")).includes("attempted mutation"), false);
  } finally {
    await workspace?.dispose();
    await fixture.inputs.dispose();
    await removeDirectory(fixture.root);
  }
});

test("true checkout root rejects a pinned executable copied into the repository", { skip: process.platform !== "win32" || !(await hasCandidate(astExecutable)) }, async () => {
  const fixture = await capturedFixture({ "src/value.js": "console.log('inspect');\n" });
  const insideCheckout = path.join(fixture.root, "tools", "ast-grep.exe");
  try {
    await fs.mkdir(path.dirname(insideCheckout), { recursive: true });
    await fs.copyFile(astExecutable, insideCheckout);
    const execution = budget();
    const definition = await astGrepCompatibility({ ruleRoot: rulesRoot, requested: true, deadline: execution.deadline });
    const result = await runAstGrep({ executablePath: insideCheckout, checkoutRoot: fixture.root, snapshot: fixture.inputs.current, ruleRoot: rulesRoot, budget: execution, definition });
    assert.equal(result.status, "unavailable");
    assert.equal(execution.tracker.report().totalProcesses, 0);
  } finally {
    await fixture.inputs.dispose();
    await removeDirectory(fixture.root);
  }
});

test("pinned ast-grep produces source-free partial findings, including an empty malformed scan", { skip: process.platform !== "win32" || !(await hasCandidate(astExecutable)) }, async () => {
  const fixture = await capturedFixture({
    "src/pattern.js": "console.log('inspect');\n",
    "src/negative.js": "logger.info('keep this wrapper');\n",
    "src/broken.js": "function {\n",
  });
  try {
    const definition = await astGrepCompatibility({ ruleRoot: rulesRoot, requested: true, deadline: new ScanDeadline(DEFAULT_LIMITS) });
    const result = await runAstGrep({ executablePath: astExecutable, checkoutRoot: fixture.root, snapshot: fixture.inputs.current, ruleRoot: rulesRoot, budget: budget(), definition });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "ast-grep-parse-completeness-unestablished");
    assert.equal(result.findings.length, 1);
    assert.equal(JSON.stringify(result).includes("console.log('inspect')"), false);
    assert.deepEqual(Object.keys(result.findings[0]).sort(), ["language", "message", "path", "range", "ruleId", "ruleVersion", "severity"]);
  } finally {
    await fixture.inputs.dispose();
    await removeDirectory(fixture.root);
  }
});

test("pinned ast-grep treats malformed source with no matches as partial rather than clean", { skip: process.platform !== "win32" || !(await hasCandidate(astExecutable)) }, async () => {
  const fixture = await capturedFixture({ "src/broken.js": "function {\n" });
  try {
    const definition = await astGrepCompatibility({ ruleRoot: rulesRoot, requested: true, deadline: new ScanDeadline(DEFAULT_LIMITS) });
    const result = await runAstGrep({ executablePath: astExecutable, checkoutRoot: fixture.root, snapshot: fixture.inputs.current, ruleRoot: rulesRoot, budget: budget(), definition });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.findings, []);
  } finally {
    await fixture.inputs.dispose();
    await removeDirectory(fixture.root);
  }
});

test("actual ast-grep failure path verifies frozen inputs before allowing later analysis", { concurrency: false, skip: process.platform !== "win32" || !(await hasCandidate(astExecutable)) }, async () => {
  const fixture = await capturedFixture({ "src/value.js": "console.log('inspect');\n" });
  const originalWriteFile = fs.writeFile;
  let mutated = false;
  try {
    fs.writeFile = async function patchedWriteFile(filename, ...args) {
      const result = await originalWriteFile.call(this, filename, ...args);
      if (!mutated && path.basename(String(filename)).startsWith("input-")) {
        mutated = true;
        await fs.appendFile(filename, "\n// mutation during adapter fixture\n");
      }
      return result;
    };
    const definition = await astGrepCompatibility({ ruleRoot: rulesRoot, requested: true, deadline: new ScanDeadline(DEFAULT_LIMITS) });
    const result = await runAstGrep({ executablePath: astExecutable, checkoutRoot: fixture.root, snapshot: fixture.inputs.current, ruleRoot: path.join(fixture.root, "missing-rules"), budget: budget(), definition });
    assert.equal(mutated, true);
    assert.equal(result.reason, "analyzer-modified-frozen-input");
    assert.equal(result.stopAnalysis, true);
  } finally {
    fs.writeFile = originalWriteFile;
    await fixture.inputs.dispose();
    await removeDirectory(fixture.root);
  }
});

test("actual jscpd path verifies frozen inputs after execution", { concurrency: false, skip: process.platform !== "win32" || !(await hasCandidate(jscpdExecutable)) }, async () => {
  const fixture = await capturedFixture({ "src/value.js": "export const value = 1;\n" });
  const originalWriteFile = fs.writeFile;
  let mutated = false;
  try {
    fs.writeFile = async function patchedWriteFile(filename, ...args) {
      const result = await originalWriteFile.call(this, filename, ...args);
      if (!mutated && path.basename(String(filename)).startsWith("input-")) {
        mutated = true;
        await fs.appendFile(filename, "\n// mutation during adapter fixture\n");
      }
      return result;
    };
    const result = await runJscpd({ executablePath: jscpdExecutable, checkoutRoot: fixture.root, snapshot: fixture.inputs.current, budget: budget(), definition: jscpdCompatibility({ requested: true }) });
    assert.equal(mutated, true);
    assert.equal(result.reason, "analyzer-modified-frozen-input");
    assert.equal(result.stopAnalysis, true);
  } finally {
    fs.writeFile = originalWriteFile;
    await fixture.inputs.dispose();
    await removeDirectory(fixture.root);
  }
});

test("pinned jscpd uses parameter-validated clone coverage and discards fragments", { skip: process.platform !== "win32" || !(await hasCandidate(jscpdExecutable)) }, async () => {
  const fixture = await capturedFixture({
    "src/clones.js": "export function first(input) {\n  const normalized = String(input).trim();\n  if (!normalized) {\n    return { ok: false, reason: 'missing' };\n  }\n  return { ok: true, value: normalized.toLowerCase() };\n}\n\nexport function second(input) {\n  const normalized = String(input).trim();\n  if (!normalized) {\n    return { ok: false, reason: 'missing' };\n  }\n  return { ok: true, value: normalized.toLowerCase() };\n}\n",
  });
  try {
    const definition = jscpdCompatibility({ requested: true });
    const result = await runJscpd({ executablePath: jscpdExecutable, checkoutRoot: fixture.root, snapshot: fixture.inputs.current, budget: budget(), definition });
    assert.equal(result.status, "available");
    assert.equal(result.totalRows, 1);
    assert.equal(result.uniqueCoveredLines.lines, 14);
    assert.equal(JSON.stringify(result).includes("fragment"), false);
    assert.equal(JSON.stringify(result).includes("normalized = String"), false);
  } finally {
    await fixture.inputs.dispose();
    await removeDirectory(fixture.root);
  }
});
