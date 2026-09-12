import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { BASH_CHOICES, buildBashPrompt, formatBashPrompt } from "../src/bash-prompt.ts";
import { displayRiskLabels, formatPromptCommand, mergePromptTriggers } from "../src/prompt-format.ts";
import { operationRule } from "../src/approvals.ts";

const theme = { fg: (_tone, value) => value, bold: (value) => `\x1b[1m${value}\x1b[22m` };

test("screenshot pipeline displays the command, merged risk and scope reason only once", () => {
  const command = "setsid rm -rf --help | head -5";
  const start = command.indexOf("rm -rf");
  const triggers = [
    { reason: "force rm", range: { start: start - 1, end: start + 6 } },
    { reason: "recursive rm", range: { start, end: start + 6 } },
  ];
  const operations = [
    { text: "setsid rm -rf --help", risks: ["force rm", "recursive rm"], approved: false },
    { text: "head -5", risks: [], approved: false },
  ];
  const before = structuredClone({ triggers, operations });
  const reason = "This pipeline includes an execution wrapper. Approval covers the complete invocation.";
  const prompt = buildBashPrompt(command, operations, reason, "force rm\nrepeated excerpt\n\nrecursive rm\nrepeated excerpt", triggers);
  assert.deepEqual(prompt.sections.map(({ label }) => label), ["Command", "Risk", "Whole-command approval required"]);
  assert.equal(prompt.message.split("setsid").length - 1, 1);
  assert.equal(prompt.message.split(">>> rm -rf <<<").length - 1, 1);
  assert.equal(prompt.message.split("recursive force rm").length - 1, 1);
  assert.equal(prompt.message.split(reason).length - 1, 1);
  assert.ok(!prompt.message.includes("repeated excerpt"));
  assert.ok(prompt.message.length < 400, prompt.message);
  assert.equal(prompt.sections[0].body, "setsid >>> rm -rf <<< --help | head -5");
  assert.deepEqual([...prompt.choices.keys()], [BASH_CHOICES.once]);
  assert.deepEqual({ triggers, operations }, before, "presentation must not mutate detection or approval data");
  assert.equal(stripVTControlCharacters(formatBashPrompt(prompt, theme)), prompt.message);
});

test("overlapping spans merge but independent occurrences and risk meanings survive", () => {
  const command = "rm -rf a; rm -rf a";
  const triggers = [
    { reason: "force rm", range: { start: 0, end: 6 } },
    { reason: "recursive rm", range: { start: 0, end: 8 } },
    { reason: "rm targeting root/home/current directory", range: { start: 3, end: 8 } },
    { reason: "force rm", range: { start: 10, end: 16 } },
  ];
  const merged = mergePromptTriggers(command, triggers);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { range: { start: 0, end: 8 }, reason: "recursive force rm; rm targeting root/home/current directory" });
  assert.deepEqual(merged[1].range, { start: 10, end: 16 });
  assert.equal(formatPromptCommand(command, triggers).split(">>>").length - 1, 2);
  assert.deepEqual(displayRiskLabels(["force rm", "force rm"]), ["force rm"]);
  assert.deepEqual(displayRiskLabels(["recursive rm"]), ["recursive rm"]);
});

test("invalid ranges do not fabricate highlights or discard risk labels", () => {
  const command = "echo ok";
  const triggers = [undefined, { start: -1, end: 4 }, { start: 2, end: 1 }, { start: 0, end: 99 }, { start: 1.5, end: 3 }]
    .map((range) => ({ reason: "risk with unavailable location", range }));
  assert.equal(formatPromptCommand(command, triggers), command);
  const prompt = buildBashPrompt(command, [{ text: command, risks: ["risk with unavailable location"], approved: false }], "Whole command only", "additional context", triggers);
  assert.ok(prompt.message.includes("risk with unavailable location"));
  assert.ok(prompt.message.includes("additional context"));
  assert.ok(!prompt.message.includes(">>>"));
});

test("multiline commands retain every line and escape controls without styling forged markers", () => {
  const command = "echo '>>> rm -f <<<'\nrm -f --help\necho \u001b[2J\u202e";
  const start = command.indexOf("rm -f --help");
  const highlighted = [];
  const text = formatPromptCommand(command, [{ reason: "force rm", range: { start, end: start + 5 } }], (value) => { highlighted.push(value); return value; });
  assert.deepEqual(highlighted, [">>> rm -f <<<"]);
  assert.match(text, /^1 \| echo/);
  assert.match(text, /2 \| >>> rm -f <<< --help/);
  assert.match(text, /3 \| echo \\u001b\[2J\\u202e/);
  assert.ok(!text.includes("\u001b"));
});

test("compact presentation preserves distinct approval states and choice identities", () => {
  const create = { text: "git switch -c one", risks: ["git switch"], approved: false, rule: operationRule(["git", "switch", "-c", "one"]) };
  const prompt = buildBashPrompt(`${create.text}; git branch -d old`, [
    create, { text: "git branch -d old", risks: ["git branch delete"], approved: true },
  ]);
  assert.deepEqual([...prompt.choices.keys()], Object.values(BASH_CHOICES));
  assert.match(prompt.message, /1\. NEEDS APPROVAL.*git switch/);
  assert.match(prompt.message, /2\. ALREADY APPROVED.*git branch/);
  assert.ok(!prompt.sections.some(({ label }) => label === "Risk"));
  const oversized = buildBashPrompt("x".repeat(20_000), [create], undefined, "", [{ reason: "git switch", range: { start: 0, end: 4 } }]);
  assert.deepEqual([...oversized.choices.keys()], [BASH_CHOICES.once]);
  assert.match(oversized.message, /^Preview truncated/);
  assert.ok(oversized.message.length < 13_000);
});
