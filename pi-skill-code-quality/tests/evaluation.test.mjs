import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evaluationRoot = path.join(packageRoot, "tests", "evaluation");
const scenarioNames = ["parser-growth", "repeated-error-handling", "validation-boundary"];

async function readJson(filename) {
  return JSON.parse(await fs.readFile(path.join(evaluationRoot, filename), "utf8"));
}

test("held-out maintenance scenarios have four cumulative steps and fixed protected correctness tests", async () => {
  const scenarios = await Promise.all(scenarioNames.map((name) => readJson(`${name}.json`)));
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, 3);
  for (const scenario of scenarios) {
    assert.equal(scenario.heldOut, true, `${scenario.id} is held out`);
    assert.equal(scenario.ruleDevelopmentAllowed, false, `${scenario.id} is not rule-development data`);
    assert.equal(scenario.startingRepository, "fixed-temporary-fixture");
    assert.equal(scenario.cumulativeSteps.length, 4, `${scenario.id} has four cumulative changes`);
    assert.equal(new Set(scenario.cumulativeSteps.map((step) => step.id)).size, 4);
    assert.equal(scenario.cumulativeSteps.every((step) => typeof step.requirement === "string" && step.requirement.length > 20), true);
    assert.equal(scenario.protectedCorrectnessTests.length >= 3, true);
    assert.equal(scenario.protectedCorrectnessTests.every((check) => check.expected === "pass" && check.agentMayEdit === false), true);
    assert.match(scenario.protectedTestPath, /^tests\/evaluation\/[a-z-]+\/protected\.test\.mjs$/u);
    const protectedPath = path.join(packageRoot, scenario.protectedTestPath);
    const protectedSource = await fs.readFile(protectedPath, "utf8");
    for (const check of scenario.protectedCorrectnessTests) assert.equal(protectedSource.includes(`test("${check.id}"`), true);
    assert.equal(await fs.access(path.join(path.dirname(protectedPath), "candidate.mjs")).then(() => true, () => false), true);
  }
});

test("evaluation protocol is blinded, human-reviewed, and budgeted without a paid campaign claim", async () => {
  const protocol = await readJson("protocol.json");
  assert.equal(protocol.version, "code-quality-evaluation-v1");
  assert.deepEqual(protocol.treatments, ["old-guidance", "revised-loop"]);
  assert.equal(protocol.comparisonControls.includes("same-protected-correctness-tests"), true);
  assert.equal(protocol.humanReview.required, true);
  assert.equal(protocol.humanReview.blindTreatmentLabels, true);
  assert.equal(protocol.humanReview.modelJudgmentAloneAllowed, false);
  assert.equal(protocol.budget.maxRunsPerTreatmentPerScenario, 2);
  assert.equal(protocol.budget.maxWallClockMinutesPerRun, 45);
  assert.equal(protocol.budget.maxSpendUsd, 0);
  assert.equal(protocol.budget.requiresApprovalForNonzeroSpend, true);
  assert.match(protocol.claimPolicy, /does not establish effectiveness/u);
  assert.match(protocol.claimPolicy, /nonzero spend/u);
});
