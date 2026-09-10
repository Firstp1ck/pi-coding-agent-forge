import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeShell, SHELL_INPUT_MAX, SHELL_OPERATIONS_MAX } from "../src/shell-analysis.ts";
import { operationRule, operationAllowKey, operationRuleAllowKey, ruleAllowKey } from "../src/approvals.ts";

test("real Bash grammar separates linear commands while retaining literal argv", async () => {
  const source = `git 'switch' -c "feature/one" && echo 'rm -rf /'\ngit branch -d old # ignored git reset --hard\n`;
  const result = await analyzeShell(source);
  assert.equal(result.supported, true);
  assert.deepEqual(result.operations.map((operation) => operation.argv), [
    ["git", "switch", "-c", "feature/one"], ["echo", "rm -rf /"], ["git", "branch", "-d", "old"],
  ]);
  assert.equal(result.operations[0].text, `git 'switch' -c "feature/one"`);
});

test("all supported separators preserve every operation", async () => {
  for (const separator of [" && ", " || ", "; ", "\n", " | "]) {
    const result = await analyzeShell(`git switch one${separator}git switch two`);
    assert.equal(result.supported, true, separator);
    assert.equal(result.operations.length, 2);
  }
  assert.deepEqual(await analyzeShell("# comment only\n"), { supported: true, operations: [] });
  assert.deepEqual(await analyzeShell(""), { supported: true, operations: [] });
});

test("pipeline membership is preserved without leaking to sequential siblings", async () => {
  const result = await analyzeShell("echo first; echo second | cat | psql; echo last");
  assert.equal(result.supported, true);
  assert.deepEqual(result.operations.map((operation) => operation.inPipeline), [false, true, true, true, false]);
});

test("unsupported constructs never yield reusable partial operations", async () => {
  for (const command of [
    "git switch one &&", "git switch one ||", "git switch one &", "git switch one |& cat",
    "echo first; echo second | cat | psql && echo last",
    "git switch $(echo one)", "git switch `echo one`", "git switch $BRANCH", 'git switch "$BRANCH"',
    "git switch ${BRANCH}", "git switch *", "git switch {one,two}", "git switch ~", "git sw\\itch one",
    "git switch one >out", "git switch one 2>&1", "git switch one <in", "cat <<<word",
    "psql <<SQL\nDROP TABLE example;\nSQL", "(git switch one)", "{ git switch one; }",
    "if true; then git switch one; fi", "for x in one; do git switch $x; done", "f() { git switch one; }; f",
    "GIT_DIR=other git switch one", "cd other && git switch one", "pushd other; git switch one",
    "export GIT_DIR=other; git switch one", "set -e; git switch one", "env git switch one",
    "command git switch one", "sudo git switch one", "timeout 3 git switch one",
    "bash -c 'git switch one'", "python3 -c 'print(1)'", "node -e '0'", "xargs rm",
    "find . -exec rm {} +", "git -C other switch one", "git -c core.hooksPath=other switch one",
    "/usr/bin/git switch one", "git switch one\u0000", "git switch one\u001b[0m", "git switch one\u2028",
    "git switch one\u2029", "git switch 'multi\nline'", "echo a\\ b", "git sw\"itch\" one",
  ]) {
    const result = await analyzeShell(command);
    assert.equal(result.supported, false, command);
    assert.equal(result.operations, undefined, command);
  }
});

test("literal quoting does not evaluate embedded shell instructions", async () => {
  for (const command of ["echo '$(rm -rf /)'", "printf '%s' 'git reset --hard'", 'echo "literal text"']) {
    assert.equal((await analyzeShell(command)).supported, true, command);
  }
});

test("input and operation-count bounds fall back without partial grants", async () => {
  assert.equal((await analyzeShell("x".repeat(SHELL_INPUT_MAX + 1))).supported, false);
  const result = await analyzeShell(Array.from({ length: SHELL_OPERATIONS_MAX + 1 }, () => "git switch one").join(";"));
  assert.equal(result.supported, false);
});

test("catalog types never include force flags, extra arguments, or other operations", () => {
  for (const [first, second] of [
    [["git", "switch", "-c", "one"], ["git", "switch", "--create", "two"]],
    [["git", "switch", "one"], ["git", "switch", "two"]],
    [["git", "branch", "-d", "one"], ["git", "branch", "-d", "two"]],
  ]) assert.equal(operationRule(first).id, operationRule(second).id);
  for (const argv of [
    ["git", "switch", "-C", "one"], ["git", "switch", "--discard-changes", "main"],
    ["git", "switch", "-c", "one", "HEAD"], ["git", "branch", "-D", "one"],
    ["git", "branch", "-d", "one", "two"], ["git", "switch", "one", "--force"],
    ["git", "switch", "--detach"], ["git", "switch", "-c", "one\n"],
    ["git", "tag", "-d", "one"], ["npm", "uninstall", "one"],
  ]) assert.equal(operationRule(argv), undefined, JSON.stringify(argv));
});

test("new grant namespaces do not collide with legacy keys or argv boundaries", () => {
  const argv = ["git", "switch", "one"];
  const exact = operationAllowKey(argv, ".");
  const rule = operationRuleAllowKey(operationRule(argv).id, ".");
  assert.notEqual(exact, operationAllowKey(["git", "switch one"], "."));
  assert.notEqual(exact, operationAllowKey(argv, "other"));
  assert.notEqual(rule, ruleAllowKey("git.switch.create.v1", "."));
  assert.notEqual(rule, exact);
});
