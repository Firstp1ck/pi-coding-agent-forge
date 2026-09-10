import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { Language } from "web-tree-sitter";
import { analyzeShell } from "../src/shell-analysis.ts";
import { buildBashPrompt, formatBashPrompt, BASH_CHOICES } from "../src/bash-prompt.ts";
import { formatCommandTrigger, operationMatchRange, patternMatchRange } from "../src/trigger.ts";

const screenshotCommand = "node --experimental-strip-types --input-type=module <<'JS'\nimport { analyzeShell } from './pi-extension-safety-guard/src/shell-analysis.ts';\nconst commands = ['git diff --stat', 'tsc --noEmit'];\nconsole.log(commands);\nJS";
const theme = { fg: (_tone, text) => text, bold: (text) => `\x1b[1m${text}\x1b[22m` };

test("syntax diagnostics stay separate from the actual pattern highlighted in approval prompts", async () => {
  const analysis = await analyzeShell(screenshotCommand);
  assert.equal(analysis.supported, false);
  assert.match(analysis.reason, /Heredoc/);
  assert.equal(screenshotCommand.slice(analysis.trigger.start, analysis.trigger.end), "<<'JS'");
  assert.equal(analysis.operations, undefined);

  const command = "psql <<SQL\nDROP TABLE sample;\nSQL";
  const reason = "SQL drop table";
  const prompt = buildBashPrompt(command, [{ text: command, risks: [reason], approved: false }], "Reusable operation analysis unavailable", "", [
    { reason, range: patternMatchRange(command, /DROP\s+TABLE/) },
  ]);
  assert.match(prompt.message, /^Trigger\nSQL drop table/);
  assert.ok(prompt.message.indexOf(">>> DROP TABLE <<<") < prompt.message.indexOf("\n\nCommand\n"));
  assert.ok(!prompt.sections[0].body.includes("<<SQL"));
  assert.deepEqual([...prompt.choices.keys()], [BASH_CHOICES.once]);
  const styled = formatBashPrompt(prompt, theme);
  assert.ok(styled.includes(theme.bold(">>> DROP TABLE <<<")));
  assert.equal(stripVTControlCharacters(styled), prompt.message);
});

test("fallback reasons retain precise source spans and never return partial operations", async () => {
  for (const [command, snippet, reason] of [
    ["echo ok > /tmp/out", "> /tmp/out", /redirection/],
    ["echo ok 2>&1", "2>&1", /redirection/],
    ['echo "$HOME"', "$HOME", /Expansion/],
    ["echo $(printf test)", "$(printf test)", /Expansion/],
    ["echo *", "*", /non-literal/],
    ["node -e '0'", "node", /interpreter/],
    ["sudo true", "sudo", /Wrapper/],
    ["cd elsewhere; echo ok", "cd", /execution-context/],
    ["git -C elsewhere diff", "-C", /execution-context/],
    ["find . -exec echo '{}' +", "-exec", /execution-context/],
    ["NAME=value echo ok", "NAME=value", /assignment/],
    ["if true; then echo ok; fi", "if", /structure/],
    ["echo ok\u001b[2J", "\u001b", /Control/],
  ]) {
    const result = await analyzeShell(command);
    assert.equal(result.supported, false, command);
    assert.equal(result.operations, undefined, command);
    assert.match(result.reason, reason, command);
    assert.equal(command.slice(result.trigger.start, result.trigger.end), snippet, command);
    assert.ok(formatCommandTrigger(command, { reason: result.reason, range: result.trigger }).includes(">>> "));
  }
});

test("incomplete syntax marks the missing position without inventing a token", async () => {
  const command = "git diff &&";
  const result = await analyzeShell(command);
  assert.equal(result.supported, false);
  assert.match(result.reason, /incomplete/);
  assert.deepEqual(result.trigger, { start: command.length, end: command.length });
  assert.match(formatCommandTrigger(command, { reason: result.reason, range: result.trigger }), />>> \[missing syntax here\] <<</);
});

test("known risk matches map to original source including quoting and repeated occurrences", async () => {
  for (const [command, pattern, expected] of [
    ["git 'switch' -c one", /\bgit\s+switch\b/i, "git 'switch'"],
    ['git "switch" main', /\bgit\s+switch\b/i, 'git "switch"'],
    ["rm '-rf' ./data", /rm\s+-rf/, "rm '-rf'"],
    ["psql -c 'SELECT 1; DROP TABLE sample;'", /DROP\s+TABLE/i, "DROP TABLE"],
    ["echo '🙂'; git 'switch' main", /git\s+switch/, "git 'switch'"],
    ["echo '界';\ngit switch main", /git\s+switch/, "git switch"],
  ]) {
    const result = await analyzeShell(command);
    assert.equal(result.supported, true, command);
    const range = operationMatchRange(command, result.operations.at(-1), pattern);
    assert.ok(range, command);
    assert.equal(command.slice(range.start, range.end), expected, command);
  }
  const command = "git switch one; git switch two";
  const analysis = await analyzeShell(command);
  const ranges = analysis.operations.map((operation) => operationMatchRange(command, operation, /git\s+switch/));
  assert.notEqual(ranges[0].start, ranges[1].start);
  assert.ok(ranges.every((range) => command.slice(range.start, range.end) === "git switch"));
});

test("source excerpts report line and column, escape controls and label truncation", () => {
  const command = "echo '🙂'\n  echo \"$HOME\"";
  const start = command.indexOf("$HOME");
  assert.match(formatCommandTrigger(command, { reason: "Expansion", range: { start, end: start + 5 } }), /L2:C9.*>>> \$HOME <<</);
  const controls = "\u001b[2J\u009b31m\nnext";
  const excerpt = formatCommandTrigger(controls, { reason: "Control", range: { start: 0, end: controls.length } });
  assert.ok(!/[\u001b\u009b]/.test(excerpt));
  assert.match(excerpt, /\\u001b/);
  assert.match(excerpt, /\\u009b/);
  assert.match(excerpt, /\\nnext/);
  const long = "a".repeat(10_000);
  const bounded = formatCommandTrigger(long, { reason: "Unsupported", range: { start: 0, end: long.length } });
  assert.ok(bounded.length < 400);
  assert.match(bounded, /snippet truncated/);
});

test("unavailable or invalid source locations never fabricate a marker", () => {
  for (const range of [undefined, { start: -1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 100 }]) {
    const text = formatCommandTrigger("echo ok", { reason: "Parser unavailable", range });
    assert.match(text, /No specific snippet identified/);
    assert.ok(!text.includes(">>>"));
  }
});

test("parser initialization failures remain distinct from rejected syntax, including cached failure", async () => {
  const original = Language.load;
  const isolated = await import(`../src/shell-analysis.ts?failed-load=${Date.now()}`);
  try {
    Language.load = async () => { throw new Error("test dependency failure with private details"); };
    const failed = await isolated.analyzeShell("git diff --stat");
    assert.equal(failed.supported, false);
    assert.match(failed.reason, /Shell parser unavailable/);
    assert.equal(failed.trigger, undefined);
    assert.ok(!failed.reason.includes("private details"));
    Language.load = original;
    const cached = await isolated.analyzeShell("tsc --noEmit example.ts");
    assert.match(cached.reason, /Shell parser unavailable/);
    assert.equal(cached.trigger, undefined);
  } finally {
    Language.load = original;
  }
});
