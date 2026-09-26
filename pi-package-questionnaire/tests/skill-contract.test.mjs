import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import questionnaireExtension, {
  LIMITS,
  QuestionnaireParameters,
  normalizeToolInput,
  renderQuestionnaireResult,
} from "../index.ts";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const SKILL = read("../skills/questionnaire/SKILL.md");
const README = read("../README.md");
const TECHNICAL = read("../TECHNICAL.md");
const DEVELOPMENT = read("../DEVELOPMENT.md");
const LICENSE = read("../LICENSE");
const MANIFEST = JSON.parse(read("../package.json"));
const RUNTIME_SOURCE = read("../src/runtime.ts");

function frontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  assert.ok(match, "SKILL.md must start with a YAML frontmatter block");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line);
    assert.ok(field, `unexpected frontmatter line: ${JSON.stringify(line)}`);
    fields[field[1]] = field[2].trim();
  }
  return fields;
}

function jsonBlocks(markdown) {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
}

// Bounds are re-derived from the runtime LIMITS so a limit change breaks the docs check.
const bounded = (value) => new RegExp(`(?:^|[^0-9])${value}(?:[^0-9]|$)`);

test("skill frontmatter is valid and routes questionnaire work without unsupported claims", () => {
  const fields = frontmatter(SKILL);
  assert.equal(fields.name, "questionnaire");
  assert.match(fields.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(fields.name.length <= 64);
  assert.ok(fields.description.length > 0 && fields.description.length <= 1024, `description length ${fields.description.length}`);
  assert.equal(fields.license, "MIT");
  for (const cue of ["single-select", "multi-select", "QUESTIONNAIRE_NEEDS_CLARIFICATION"]) {
    assert.ok(fields.description.includes(cue), `description must mention ${cue}`);
  }
  // Routing must state a should-not-trigger boundary, not only a should-trigger one.
  assert.match(fields.description, /Do not use/);
  assert.match(fields.description, /secrets/);
});

test("skill and development guide use the registered tool name, actions, and no unsupported UI primitive", () => {
  const tools = [];
  questionnaireExtension({ registerTool: (tool) => tools.push(tool) });
  const [tool] = tools;
  for (const doc of [SKILL, DEVELOPMENT]) {
    assert.ok(doc.includes(tool.name), "docs must name the registered tool");
    assert.ok(doc.includes('"action": "start"'), "docs must show the start action");
    assert.ok(doc.includes('"action": "resume"'), "docs must show the resume action");
    // ctx.ui.custom()/confirm() are not used by the runtime and must not be promised.
    assert.equal(/ui\.custom\(|ctx\.ui\.confirm\(/.test(doc), false);
    assert.equal(/checkbox form/.test(doc) && !/not\b[^.]*checkbox form|checkbox form[^.]*\bnot\b/.test(doc), false);
  }
  assert.deepEqual(Object.keys(QuestionnaireParameters.properties).sort(), ["action", "clarificationResponse", "questionnaireId", "questions", "revision"]);
  for (const field of Object.keys(QuestionnaireParameters.properties)) {
    assert.ok(SKILL.includes(field), `skill must mention schema field ${field}`);
  }
});

test("documented start and resume examples satisfy the runtime contract", () => {
  const examples = [...jsonBlocks(SKILL), ...jsonBlocks(DEVELOPMENT)].filter((value) => value && typeof value === "object" && "action" in value);
  const starts = examples.filter((value) => value.action === "start");
  const resumes = examples.filter((value) => value.action === "resume");
  assert.ok(starts.length >= 1, "docs must contain a start example");
  assert.ok(resumes.length >= 1, "docs must contain a resume example");

  for (const example of starts) {
    const normalized = normalizeToolInput(example);
    assert.equal(normalized.action, "start");
    assert.ok(normalized.questions.length >= 1);
    assert.ok(normalized.questions.some((question) => question.type === "single"));
    assert.ok(normalized.questions.some((question) => question.type === "multi"));
  }
  for (const example of resumes) {
    const normalized = normalizeToolInput(example);
    assert.equal(normalized.action, "resume");
    assert.deepEqual(Object.keys(example).sort(), ["action", "clarificationResponse", "questionnaireId", "revision"]);
    assert.ok(normalized.revision >= 1);
  }
});

test("skill states the mandatory explain-then-resume clarification obligation", () => {
  const clarificationMarker = renderQuestionnaireResult({
    version: 1,
    status: "needs_clarification",
    questionnaireId: "id",
    revision: 1,
    currentQuestionIndex: 0,
    questions: [{ id: "q", label: "q", prompt: "p", type: "single", options: [{ id: "o", label: "O" }], allowOther: false, minSelections: 1, maxSelections: 1 }],
    answers: [],
    clarifications: [{ revision: 1, questionId: "q", request: "why?" }],
    clarificationRequest: "why?",
  }).split(" ")[0];
  assert.equal(clarificationMarker, "QUESTIONNAIRE_NEEDS_CLARIFICATION");
  assert.ok(SKILL.includes(clarificationMarker));

  const requirements = [
    /Answer the user's request in normal assistant text/,
    /Immediately call `questionnaire` again with \*\*only\*\*|Immediately call `questionnaire` again with `action: "resume"` and \*\*only\*\*/,
    /Never resend `questions` on resume/,
    /Never start a new questionnaire to recover/,
    /Never infer, assume, or fabricate the pending answer/,
    /Do not end your turn after a clarification result without resuming/,
  ];
  for (const requirement of requirements) assert.match(SKILL, requirement);
});

test("skill carries the required question-design, cancellation, and privacy guidance", () => {
  const guidance = [
    /Combine\.\*\* Put every related question into one `start` call/,
    /Stable IDs\.\*\*/,
    /Concise text\.\*\*/,
    /Honest types\.\*\*/,
    /Realistic bounds\.\*\*/,
    /defaults to `minSelections: 0`/,
    /allowOther` defaults to `true`/,
    /QUESTIONNAIRE_CANCELLED/,
    /QUESTIONNAIRE_UNAVAILABLE/,
    /Never guess the answers the user did not give/,
    /visible to the model and persisted with the session/,
    /Never use `questionnaire` to collect passwords, API keys, tokens, or other secrets/,
    /same session branch/,
  ];
  for (const requirement of guidance) assert.match(SKILL, requirement);
});

test("documented statuses and markers match every runtime status", () => {
  const union = /export type QuestionnaireStatus = ([^;]+);/.exec(RUNTIME_SOURCE);
  assert.ok(union, "runtime must declare a QuestionnaireStatus union");
  const statuses = [...union[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(statuses.sort(), ["cancelled", "completed", "needs_clarification", "unavailable"]);
  for (const status of statuses) {
    const marker = `QUESTIONNAIRE_${status.toUpperCase()}`;
    assert.ok(DEVELOPMENT.includes(marker), `DEVELOPMENT.md must document ${marker}`);
    assert.ok(DEVELOPMENT.includes(`\`${status}\``), `DEVELOPMENT.md must document status ${status}`);
  }
  const reasons = /cancellationReason\?: ([^;]+);/.exec(RUNTIME_SOURCE);
  assert.ok(reasons, "runtime must declare cancellationReason values");
  for (const reason of [...reasons[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1])) {
    assert.ok(DEVELOPMENT.includes(reason), `DEVELOPMENT.md must document cancellation reason ${reason}`);
  }
  assert.ok(DEVELOPMENT.includes("CancellationReason") === false, "DEVELOPMENT.md should document values, not internal type names");
  for (const reason of ["user_cancelled", "aborted"]) assert.ok(DEVELOPMENT.includes(reason));
});

test("documented limits stay aligned with runtime LIMITS", () => {
  assert.match(SKILL, bounded(LIMITS.questions));
  assert.match(SKILL, bounded(LIMITS.options));
  for (const doc of [SKILL, DEVELOPMENT]) {
    for (const limit of [LIMITS.id, LIMITS.label, LIMITS.prompt, LIMITS.description]) {
      assert.match(doc, bounded(limit));
    }
  }
  for (const doc of [TECHNICAL, DEVELOPMENT]) {
    assert.match(doc, bounded(LIMITS.questions));
    assert.match(doc, bounded(LIMITS.options));
  }
  assert.match(DEVELOPMENT, bounded(LIMITS.clarification));
  assert.match(SKILL, bounded(LIMITS.clarification));
  const detailsVersion = /export const QUESTIONNAIRE_DETAILS_VERSION = (\d+)/.exec(RUNTIME_SOURCE);
  assert.ok(detailsVersion);
  assert.ok(DEVELOPMENT.includes(`version: ${detailsVersion[1]}`), "DEVELOPMENT.md must document the current details version");
});

test("user docs cover install and keys; development guide covers install-as-separate-action, cross-mode behavior, privacy, and validation", () => {
  assert.match(README, /pi install npm:@firstpick\/pi-package-questionnaire/);
  assert.match(README, /\(TECHNICAL\.md\)|\/TECHNICAL\.md\)/, "README must link to the technical reference");
  for (const requirement of [
    /pi install npm:@firstpick\/pi-package-questionnaire/,
    /pi remove npm:@firstpick\/pi-package-questionnaire/,
    /`Up` \/ `Down`/,
    /`Enter` \| Confirm/,
    /`Escape` \/ `Ctrl\+C`/,
  ]) assert.match(TECHNICAL, requirement);
  const requirements = [
    /Installation is a \*\*separate, explicit action\*\*/,
    /\*\*mouse-clickable button\*\*/,
    /extension_ui_request` \/ `extension_ui_response/,
    /no secret-input guarantee/i,
    /npm test/,
    /npm run check/,
    /npm pack --dry-run --json/,
    /active session branch/,
    /minSelections` defaults to `0`/,
  ];
  for (const requirement of requirements) assert.match(DEVELOPMENT, requirement);
  assert.ok(DEVELOPMENT.includes("ctx.ui.select()") && DEVELOPMENT.includes("ctx.ui.input()"));
});

test("manifest, license, and packaged assets stay consistent with the shipped docs and skill", () => {
  assert.deepEqual(MANIFEST.pi.skills, ["./skills"]);
  for (const asset of ["skills", "README.md", "LICENSE"]) {
    assert.ok(MANIFEST.files.includes(asset), `package files must include ${asset}`);
  }
  assert.equal(MANIFEST.license, "MIT");
  assert.match(LICENSE, /^MIT License/);
  assert.match(LICENSE, /Copyright \(c\) \d{4} Firstpick/);
  assert.ok(MANIFEST.keywords.includes("skill"));
  assert.match(README, /^# \S/, "README must start with a title");
  assert.ok(README.includes(MANIFEST.name), "README must reference the published package name");
  assert.ok(DEVELOPMENT.startsWith("# Development guide: "), "DEVELOPMENT.md must use the development guide title");
  assert.ok(DEVELOPMENT.includes(MANIFEST.engines.node.replace(">=", ">= ")), "DEVELOPMENT.md must state the supported Node engine");
  for (const peer of Object.keys(MANIFEST.peerDependencies)) {
    assert.ok(DEVELOPMENT.includes(peer), `DEVELOPMENT.md must mention peer dependency ${peer}`);
  }
});

test("skill and tool prompt guidelines make the same core promises", () => {
  const tools = [];
  questionnaireExtension({ registerTool: (tool) => tools.push(tool) });
  const guidelines = tools[0].promptGuidelines.join("\n");
  assert.ok(guidelines.includes("QUESTIONNAIRE_NEEDS_CLARIFICATION") && SKILL.includes("QUESTIONNAIRE_NEEDS_CLARIFICATION"));
  for (const promise of ["questionnaireId", "revision", "clarificationResponse", "secrets"]) {
    assert.ok(guidelines.includes(promise), `prompt guidelines must mention ${promise}`);
    assert.ok(SKILL.includes(promise), `skill must mention ${promise}`);
  }
  assert.ok(/never restart|Never start a new questionnaire/i.test(guidelines + SKILL));
});
