import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArguments } from "../skills/code-quality/scripts/scan.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(packageRoot, "skills", "code-quality");

async function read(relativePath) {
  return fs.readFile(path.join(packageRoot, relativePath), "utf8");
}

function fencedBlockCount(markdown) {
  return markdown.split(/\r?\n/u).filter((line) => line.startsWith("```")).length;
}

function relativeMarkdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)]
    .map((match) => match[1])
    .filter((target) => !/^[a-z][a-z\d+.-]*:/iu.test(target) && !target.startsWith("//"));
}

test("skill frontmatter and workflow keep review-only, dirty-baseline, and bounded-cleanup behavior", async () => {
  const skill = await read("skills/code-quality/SKILL.md");
  assert.match(skill, /^---\r?\nname: code-quality\r?\ndescription: .+/u);
  assert.match(skill, /Start in \*\*review-only\*\* mode/u);
  assert.match(skill, /dirty workspace/u);
  assert.match(skill, /\*\*S0\*\*/u);
  assert.match(skill, /\*\*S1\*\*/u);
  assert.match(skill, /\*\*S2\*\*/u);
  assert.match(skill, /at most \*\*three confirmed findings\*\*/u);
  assert.match(skill, /one focused pass/u);
  assert.match(skill, /Failed checks take priority/u);
  assert.doesNotMatch(skill, /MEMORY\.md/iu);
  assert.doesNotMatch(skill, /\bArc\b|\bZero\b/u);
  assert.doesNotMatch(skill, /<\s*25|data flow complexity/u);
  assert.doesNotMatch(skill, /test-threads=1/u);
});

test("workflow documents only declared scanner operations and options", () => {
  assert.deepEqual(parseArguments(["scan", "--base", "HEAD", "--scope", "src", "--format", "human"]), {
    operation: "scan", base: "HEAD", scopes: ["src"], includeUntracked: false, format: "human",
  });
  assert.deepEqual(parseArguments(["snapshot", "--scope", "src", "--out", "report.json"]), {
    operation: "snapshot", scopes: ["src"], includeUntracked: false, format: "human", out: "report.json",
  });
  assert.deepEqual(parseArguments(["compare", "--before", "before.json", "--after", "after.json", "--format", "json"]), {
    operation: "compare", scopes: [], includeUntracked: false, format: "json", before: "before.json", after: "after.json",
  });
  assert.throws(() => parseArguments(["compare", "--before", "before.json", "--after", "after.json", "--scope", "src"]));
  assert.throws(() => parseArguments(["scan", "--base", "HEAD", "--scope", "src", "--help"]));
});

test("documentation layers, fences, and relative links remain valid", async () => {
  const files = [
    "README.md",
    "TECHNICAL.md",
    "DEVELOPMENT.md",
    "skills/code-quality/SKILL.md",
    "skills/code-quality/references/language-checks.md",
    "skills/code-quality/references/measurement-guide.md",
  ];
  const documents = await Promise.all(files.map(async (file) => [file, await read(file)]));
  for (const [file, document] of documents) {
    assert.equal(fencedBlockCount(document) % 2, 0, `${file} has balanced fences`);
    assert.equal(document.includes("C:\\Users\\"), false, `${file} does not disclose a private path`);
    for (const target of relativeMarkdownLinks(document)) {
      const destination = path.resolve(path.dirname(path.join(packageRoot, file)), target);
      assert.equal(await fs.access(destination).then(() => true, () => false), true, `${file} link resolves: ${target}`);
    }
  }
  const readme = documents.find(([file]) => file === "README.md")[1];
  const technical = documents.find(([file]) => file === "TECHNICAL.md")[1];
  const development = documents.find(([file]) => file === "DEVELOPMENT.md")[1];
  assert.match(readme, /## Helpful when/u);
  assert.match(readme, /## What to share with Pi/u);
  assert.match(readme, /## Technical details/u);
  assert.match(readme, /\[TECHNICAL\.md\]\(TECHNICAL\.md\)/u);
  assert.match(readme, /Git-only scanner path has current Linux evidence/u);
  assert.doesNotMatch(readme, /npm pack|scripts\/scan|tests\//iu);
  assert.match(technical, /Git-only capture and report path has current Linux evidence/u);
  assert.match(technical, /Windows x64-only/u);
  assert.doesNotMatch(technical, /npm --prefix|node --test|tests\//iu);
  assert.match(development, /## Scanner interface contract/u);
  assert.match(development, /F8-F12 hardening changes and C3 human-summary display-cap correction are implemented and have regression coverage/u);
  assert.match(development, /per-category notice whenever it hides nonempty contributor rows/u);
  assert.match(development, /Independent Anthropic and Moonshot reviews are complete/u);
  assert.match(development, /CODE_QUALITY_AST_GREP_EXE/u);
  assert.match(development, /CODE_QUALITY_JSCPD_EXE/u);
  assert.doesNotMatch(development, /C3 follow-up/u);
  assert.match(development, /## Research context and limits/u);
  assert.match(development, /SlopCodeBench v1/u);
  assert.doesNotMatch(development, /pending the recorded runtime fix|pending the parent-owned runtime correction/u);
  assert.match(development, /## Evaluation protocol/u);
});

test("opt-in examples retain language configuration profiles without invented standards", async () => {
  const examples = await read("skills/code-quality/references/language-checks.md");
  const measurements = await read("skills/code-quality/references/measurement-guide.md");
  assert.match(examples, /Repository policy comes first/u);
  assert.match(examples, /## Optional configuration profiles/u);
  assert.match(examples, /existing `Cargo\.toml`:/u);
  assert.doesNotMatch(examples, /\.clippy\.toml/u);
  assert.match(examples, /\[lints\.clippy\]/u);
  assert.match(examples, /"noUncheckedIndexedAccess": true/u);
  assert.match(examples, /\[tool\.ruff\]/u);
  assert.match(examples, /not a universal Rust profile/u);
  assert.match(examples, /not a generic Python baseline/u);
  assert.match(examples, /cargo fmt --check/u);
  assert.match(examples, /## Shell/u);
  assert.match(examples, /## Security concerns/u);
  assert.match(examples, /available code-security skill/u);
  assert.match(examples, /not the user's standards/u);
  assert.doesNotMatch(examples, /Cyclomatic < 25|MEMORY\.md|test-threads=1/iu);
  assert.match(measurements, /unavailable/u);
  assert.match(measurements, /never a clean result/u);
  assert.match(measurements, /do not make a quality score, a merge gate/u);
});
