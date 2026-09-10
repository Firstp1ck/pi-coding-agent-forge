import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { bashRuleGrant, isKnownBashRuleId, ruleAllowKey } from "../src/approvals.ts";

test("branch-creation grants use a stable identity across simple names and both supported flags", () => {
  for (const command of ["git switch -c feature/a", "git switch --create branch-b", " git\tswitch -c v2.0_fix \t"]) {
    assert.deepEqual(bashRuleGrant(command), {
      id: "git.switch.create.v1",
      label: "git switch branch creation",
    });
  }
});

test("broader grants reject every unsupported command shape", () => {
  for (const command of [
    "git switch", "git switch main", "git switch -C branch-a", "git switch --force-create branch-a",
    "git switch --discard-changes main", "git switch -f main", "git switch -c branch-a --discard-changes",
    "git switch -c branch-a HEAD~1", "git switch -cbranch-a", "git switch --create=branch-a",
    "git -C elsewhere switch -c branch-a", "git -c core.hooksPath=elsewhere switch -c branch-a",
    "sudo git switch -c branch-a", "env git switch -c branch-a", "command git switch -c branch-a",
    "cd elsewhere && git switch -c branch-a", "GIT_DIR=elsewhere git switch -c branch-a",
    "git switch -c branch-a && rm -rf ./important-data", "git switch -c branch-a; echo done",
    "git switch -c branch-a | cat", "git switch -c branch-a &", "git switch -c branch-a > .env",
    "git switch -c branch-a 2>/tmp/log", "git switch -c $(touch injected)", "git switch -c `touch injected`",
    "git switch -c $BRANCH", "git switch -c ${BRANCH}", "git switch -c *.txt", "git switch -c {a,b}",
    "git switch -c 'branch-a'", 'git switch -c "branch-a"', "git switch -c branch\\-a",
    "git switch -c branch-a\n", "git switch -c branch-a\r\n", "git switch -c branch-a\nrm -rf ./important-data",
    "git switch -c branch-a #comment", "git switch -c branch-a\u0000", "GIT SWITCH -c branch-a",
    "git switch -c --orphan", "git switch -c", "git switch -c branch-a <<EOF\ntext\nEOF",
    "git switch -c branch-a\u2028", "git switch -c branch-a\u2029",
  ]) assert.equal(bashRuleGrant(command), undefined, command);
});

test("rule keys are cwd-scoped, normalized, and disjoint from legacy exact keys", () => {
  const cwd = path.resolve("workspace");
  const key = ruleAllowKey("git.switch.create.v1", cwd);
  assert.equal(key, ruleAllowKey("git.switch.create.v1", path.join(cwd, "child", "..")));
  assert.notEqual(key, ruleAllowKey("git.switch.create.v1", `${cwd}-other`));
  for (const value of ["git switch", "git switch branch creation", "git.switch.create.v1", key]) {
    assert.notEqual(key, `bash:${cwd}:${value}`);
  }
  assert.equal(isKnownBashRuleId("git.switch.create.v1"), true);
  assert.equal(isKnownBashRuleId("git.switch.create.v2"), false);
});
