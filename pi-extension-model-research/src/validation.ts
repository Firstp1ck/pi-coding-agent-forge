import {
  FIXED_REFERENCE_PATHS,
  MAX_RESEARCH_CHARS,
  MAX_REVIEW_CHARS,
  JOB_KEYS,
  MODEL_KEYS,
  RECIPROCAL_REVIEW_RUBRIC,
  type ArgumentRow,
  type ComparisonSubjects,
  type ModelKey,
  type ModelTarget,
  type ResearchEvidence,
  type ResearchReport,
  type ReviewReport,
  type RunLimits,
  type Usage,
  type WorkflowJob,
  type WorkflowRun,
} from "./types.ts";

import { INCONCLUSIVE_MODEL_CHOICES, MODEL_USAGE_TASKS, USAGE_SUMMARY_HEADER, USAGE_SUMMARY_HEADING } from "./scope.ts";
import { escapeSubjectLabel, subjectChoiceLabels, validateSubjects } from "./subjects.ts";

const MAX_RUN_BYTES = 4_000_000;
const MAX_RAW_OUTPUT = 500_000;
const MAX_PROMPT = 1_500_000;
const MAX_SHORT = 2_000;
const MAX_LONG = 20_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ID = /^[a-z][a-z0-9-]{0,79}$/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`);
}

function subjectTuple(value: unknown, path: string): ComparisonSubjects {
  try { return validateSubjects(value); }
  catch (error) { fail(path, error instanceof Error ? error.message : String(error)); }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], path: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path, `unexpected key ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(path, `missing key ${key}`);
  }
}

function stringValue(value: unknown, path: string, max = MAX_SHORT, allowEmpty = false): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if ((!allowEmpty && value.trim().length === 0) || value.length > max || value.includes("\0")) {
    fail(path, `must be ${allowEmpty ? "at most" : "between 1 and"} ${max} characters and contain no NUL`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(path, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `must be an integer from ${min} through ${max}`);
  }
  return value as number;
}

function finiteNumber(value: unknown, path: string, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) fail(path, `must be a finite number >= ${min}`);
  return value;
}

function list(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `must contain ${min} through ${max} items`);
  return value;
}

function stringList(value: unknown, path: string, min = 0, max = 50): string[] {
  const values = list(value, path, min, max).map((entry, index) => stringValue(entry, `${path}[${index}]`, MAX_LONG));
  if (new Set(values).size !== values.length) fail(path, "must not contain duplicates");
  return values;
}

function isoDate(value: unknown, path: string): string {
  const result = stringValue(value, path, 10);
  if (!DATE.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) fail(path, "must be a valid YYYY-MM-DD date");
  return result;
}

function isoDateTime(value: unknown, path: string): string {
  const result = stringValue(value, path, 30);
  if (!DATE_TIME.test(result) || Number.isNaN(Date.parse(result))) fail(path, "must be a UTC ISO timestamp");
  return result;
}

function optionalDateTime(value: unknown, path: string): void {
  if (value !== undefined) isoDateTime(value, path);
}

function validateIdentitySettings(value: unknown, path: string): Record<string, string | number | boolean | null> {
  const settings = record(value, path);
  if (Object.keys(settings).length > 32) fail(path, "must contain at most 32 settings");
  for (const [key, setting] of Object.entries(settings)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key)) fail(`${path}.${key}`, "has an invalid setting name");
    if (setting !== null && typeof setting !== "string" && typeof setting !== "boolean" && (typeof setting !== "number" || !Number.isFinite(setting))) {
      fail(`${path}.${key}`, "must be a finite scalar or null");
    }
    if (typeof setting === "string") stringValue(setting, `${path}.${key}`, MAX_SHORT, true);
  }
  return settings as Record<string, string | number | boolean | null>;
}

export function validateModelTarget(value: unknown, path = "target"): ModelTarget {
  const target = record(value, path);
  exactKeys(target, ["key", "displayName", "modelAuthor", "model", "hostingProvider", "transport", "settings"], [], path);
  const key = enumValue(target.key, MODEL_KEYS, `${path}.key`);
  stringValue(target.displayName, `${path}.displayName`);
  stringValue(target.modelAuthor, `${path}.modelAuthor`);
  stringValue(target.model, `${path}.model`);
  stringValue(target.hostingProvider, `${path}.hostingProvider`);
  stringValue(target.transport, `${path}.transport`);
  validateIdentitySettings(target.settings, `${path}.settings`);
  if (JSON.stringify(target).length > 4_000) fail(path, "identity metadata must fit within 4000 characters");
  return target as ModelTarget;
}

function stableScalarRecord(value: Record<string, string | number | boolean | null>): string {
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
}

function sameTarget(actual: ModelTarget, expected: ModelTarget): boolean {
  return actual.key === expected.key
    && actual.displayName === expected.displayName
    && actual.modelAuthor === expected.modelAuthor
    && actual.model === expected.model
    && actual.hostingProvider === expected.hostingProvider
    && actual.transport === expected.transport
    && stableScalarRecord(actual.settings) === stableScalarRecord(expected.settings);
}

export function validateTargets(value: unknown): [ModelTarget, ModelTarget] {
  const entries = list(value, "targets", 2, 2);
  const targets = entries.map((entry, index) => validateModelTarget(entry, `targets[${index}]`)) as [ModelTarget, ModelTarget];
  if (targets[0].key !== "a" || targets[1].key !== "b") fail("targets", "must be ordered as keys a then b");
  const familyA = targets[0].modelAuthor.trim().toLocaleLowerCase("en-US");
  const familyB = targets[1].modelAuthor.trim().toLocaleLowerCase("en-US");
  if (familyA === familyB) fail("targets", "model-author families must differ");
  return targets;
}

function validateLimits(value: unknown, path = "limits"): RunLimits {
  const limits = record(value, path);
  exactKeys(limits, ["maxJobs", "perCall", "expiresAt"], [], path);
  if (limits.maxJobs !== 5) fail(`${path}.maxJobs`, "must be exactly 5");
  const perCall = record(limits.perCall, `${path}.perCall`);
  exactKeys(perCall, ["timeoutMs", "maxTurns", "maxTokens"], [], `${path}.perCall`);
  integer(perCall.timeoutMs, `${path}.perCall.timeoutMs`, 1_000, 3_600_000);
  integer(perCall.maxTurns, `${path}.perCall.maxTurns`, 1, 100);
  integer(perCall.maxTokens, `${path}.perCall.maxTokens`, 1, 1_000_000);
  isoDateTime(limits.expiresAt, `${path}.expiresAt`);
  return limits as RunLimits;
}

function validateUsage(value: unknown, path: string): Usage {
  const usage = record(value, path);
  exactKeys(usage, [], ["inputTokens", "outputTokens", "totalTokens", "turns", "costUsd"], path);
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "turns"] as const) {
    if (usage[key] !== undefined) integer(usage[key], `${path}.${key}`, 0, Number.MAX_SAFE_INTEGER);
  }
  if (usage.costUsd !== undefined) finiteNumber(usage.costUsd, `${path}.costUsd`);
  return usage as Usage;
}

function validateEvidence(value: unknown, path: string): ResearchEvidence {
  const evidence = record(value, path);
  exactKeys(evidence, ["id", "url", "accessedAt", "sourceAccess", "evidenceClass", "topics", "supportsTarget", "title", "excerptOrGap", "conditions"], [], path);
  const id = stringValue(evidence.id, `${path}.id`, 80);
  if (!ID.test(id)) fail(`${path}.id`, "must be a lowercase stable ID");
  const url = stringValue(evidence.url, `${path}.url`, MAX_SHORT);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${path}.url`, "must be an absolute URL");
  }
  if (parsed!.protocol !== "http:" && parsed!.protocol !== "https:") fail(`${path}.url`, "must use HTTP(S)");
  if (parsed!.username || parsed!.password) fail(`${path}.url`, "must not contain credentials");
  isoDate(evidence.accessedAt, `${path}.accessedAt`);
  enumValue(evidence.sourceAccess, ["fetched", "snippet", "inaccessible"] as const, `${path}.sourceAccess`);
  enumValue(evidence.evidenceClass, ["documented", "measured", "anecdotal"] as const, `${path}.evidenceClass`);
  const topics = list(evidence.topics, `${path}.topics`, 1, 6).map((topic, index) => enumValue(topic, ["general-routing", "skill-writing", "cost", "latency", "tool-use", "other"] as const, `${path}.topics[${index}]`));
  if (new Set(topics).size !== topics.length) fail(`${path}.topics`, "must not contain duplicates");
  enumValue(evidence.supportsTarget, ["a", "b", "neither"] as const, `${path}.supportsTarget`);
  stringValue(evidence.title, `${path}.title`, MAX_SHORT);
  stringValue(evidence.excerptOrGap, `${path}.excerptOrGap`, MAX_LONG);
  stringValue(evidence.conditions, `${path}.conditions`, MAX_LONG);
  return evidence as ResearchEvidence;
}

function validateArgument(value: unknown, path: string): ArgumentRow {
  const argument = record(value, path);
  exactKeys(argument, ["id", "task", "claim", "classification", "evidenceIds", "support", "counterevidence", "conditions", "recommendation", "confidence"], [], path);
  const id = stringValue(argument.id, `${path}.id`, 80);
  if (!ID.test(id)) fail(`${path}.id`, "must be a lowercase stable ID");
  stringValue(argument.task, `${path}.task`, MAX_LONG);
  stringValue(argument.claim, `${path}.claim`, MAX_LONG);
  enumValue(argument.classification, ["documented", "measured", "anecdotal"] as const, `${path}.classification`);
  stringList(argument.evidenceIds, `${path}.evidenceIds`, 1, 30);
  stringValue(argument.support, `${path}.support`, MAX_LONG);
  stringValue(argument.counterevidence, `${path}.counterevidence`, MAX_LONG);
  stringValue(argument.conditions, `${path}.conditions`, MAX_LONG);
  stringValue(argument.recommendation, `${path}.recommendation`, MAX_LONG);
  integer(argument.confidence, `${path}.confidence`, 0, 100);
  return argument as ArgumentRow;
}

function validateCoverageEntry(value: unknown, path: string, validEvidence: Set<string>, other = false): void {
  const coverage = record(value, path);
  exactKeys(coverage, ["status", "evidenceIds", "gap", ...(other ? ["platforms"] : [])], [], path);
  const status = enumValue(coverage.status, ["covered", "gap"] as const, `${path}.status`);
  const ids = stringList(coverage.evidenceIds, `${path}.evidenceIds`, status === "covered" ? 1 : 0, 50);
  for (const id of ids) if (!validEvidence.has(id)) fail(`${path}.evidenceIds`, `references unknown evidence ${id}`);
  const gap = stringValue(coverage.gap, `${path}.gap`, MAX_LONG, status === "covered");
  if (status === "gap" && gap.trim().length === 0) fail(`${path}.gap`, "must explain the access gap");
  if (other) {
    const platforms = stringList(coverage.platforms, `${path}.platforms`, status === "covered" ? 1 : 0, 20);
    if (status === "gap" && platforms.length > 0) fail(`${path}.platforms`, "must be empty when other social coverage is a gap");
  }
}

function validateResearchReportValue(value: unknown, expectedResearcher: ModelTarget, targets: [ModelTarget, ModelTarget], path: string, expectedSubjects?: ComparisonSubjects): ResearchReport {
  const report = record(value, path);
  exactKeys(report, ["schemaVersion", "researcher", "subjectTargets", "asOfDate", "taskSpecificRecommendation", "arguments", "evidence", "counterevidenceAndConditions", "confidence", "socialCoverage", "accessGaps", ...(expectedSubjects ? ["subjects"] : [])], [], path);
  if (expectedSubjects) {
    subjectTuple(expectedSubjects, "expected subjects");
    const actualSubjects = subjectTuple(report.subjects, `${path}.subjects`);
    if (actualSubjects.some((subject, index) => subject.key !== expectedSubjects[index].key || subject.model !== expectedSubjects[index].model)) {
      fail(`${path}.subjects`, "must exactly match the run comparison subjects");
    }
  }
  if (report.schemaVersion !== 1) fail(`${path}.schemaVersion`, "must equal 1");
  const researcher = validateModelTarget(report.researcher, `${path}.researcher`);
  if (!sameTarget(researcher, expectedResearcher)) fail(`${path}.researcher`, "must exactly match the selected target");
  const subjects = list(report.subjectTargets, `${path}.subjectTargets`, 2, 2);
  if (subjects[0] !== targets[0].key || subjects[1] !== targets[1].key) fail(`${path}.subjectTargets`, "must contain a then b");
  const reportDate = isoDate(report.asOfDate, `${path}.asOfDate`);
  stringValue(report.taskSpecificRecommendation, `${path}.taskSpecificRecommendation`, MAX_LONG);
  const evidence = list(report.evidence, `${path}.evidence`, 1, 100).map((entry, index) => validateEvidence(entry, `${path}.evidence[${index}]`));
  for (const entry of evidence) {
    if (entry.accessedAt > reportDate) fail(`${path}.evidence`, `evidence ${entry.id} is dated after the report as-of date`);
  }
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  if (evidenceIds.size !== evidence.length) fail(`${path}.evidence`, "evidence IDs must be unique");
  for (const id of evidenceIds) if (!id.startsWith(`${expectedResearcher.key}-`)) fail(`${path}.evidence`, `evidence ID ${id} must use the researcher prefix`);
  const argumentsList = list(report.arguments, `${path}.arguments`, 1, 50).map((entry, index) => validateArgument(entry, `${path}.arguments[${index}]`));
  const argumentIds = new Set(argumentsList.map((entry) => entry.id));
  if (argumentIds.size !== argumentsList.length) fail(`${path}.arguments`, "argument IDs must be unique");
  for (const argument of argumentsList) {
    if (!argument.id.startsWith(`${expectedResearcher.key}-`)) fail(`${path}.arguments`, `argument ID ${argument.id} must use the researcher prefix`);
    for (const id of argument.evidenceIds) if (!evidenceIds.has(id)) fail(`${path}.arguments`, `argument ${argument.id} references unknown evidence ${id}`);
  }
  stringList(report.counterevidenceAndConditions, `${path}.counterevidenceAndConditions`, 1, 50);
  integer(report.confidence, `${path}.confidence`, 0, 100);
  const coverage = record(report.socialCoverage, `${path}.socialCoverage`);
  exactKeys(coverage, ["x", "reddit", "other"], [], `${path}.socialCoverage`);
  validateCoverageEntry(coverage.x, `${path}.socialCoverage.x`, evidenceIds);
  validateCoverageEntry(coverage.reddit, `${path}.socialCoverage.reddit`, evidenceIds);
  validateCoverageEntry(coverage.other, `${path}.socialCoverage.other`, evidenceIds, true);
  stringList(report.accessGaps, `${path}.accessGaps`, 0, 50);
  return report as ResearchReport;
}

export function parseResearchReport(raw: string, expectedResearcher: ModelTarget, targets: [ModelTarget, ModelTarget], subjects?: ComparisonSubjects): ResearchReport {
  stringValue(raw, "research output", MAX_RESEARCH_CHARS);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail("research output", `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateResearchReportValue(value, expectedResearcher, targets, "research output", subjects);
}

function validateReviewReportValue(
  value: unknown,
  expectedReviewer: ModelTarget,
  targets: [ModelTarget, ModelTarget],
  reports: { a: ResearchReport; b: ResearchReport },
  path: string,
  subjects?: ComparisonSubjects,
): ReviewReport {
  const review = record(value, path);
  exactKeys(review, ["schemaVersion", "reviewer", "reviewedOriginals", "rubric", "usefulnessVsOwn", "corrections", "disagreements", "missingEvidence", "writerRecommendation", "writerEvidenceIds", "confidence"], [], path);
  if (review.schemaVersion !== 1) fail(`${path}.schemaVersion`, "must equal 1");
  const reviewer = validateModelTarget(review.reviewer, `${path}.reviewer`);
  if (!sameTarget(reviewer, expectedReviewer)) fail(`${path}.reviewer`, "must exactly match the selected target");
  const originals = list(review.reviewedOriginals, `${path}.reviewedOriginals`, 2, 2);
  if (originals[0] !== "a" || originals[1] !== "b") fail(`${path}.reviewedOriginals`, "must contain a then b");
  const rubric = stringList(review.rubric, `${path}.rubric`, RECIPROCAL_REVIEW_RUBRIC.length, RECIPROCAL_REVIEW_RUBRIC.length);
  if (rubric.some((entry, index) => entry !== RECIPROCAL_REVIEW_RUBRIC[index])) fail(`${path}.rubric`, "must exactly match the common rubric");
  const usefulness = record(review.usefulnessVsOwn, `${path}.usefulnessVsOwn`);
  exactKeys(usefulness, ["verdict", "explanation"], [], `${path}.usefulnessVsOwn`);
  enumValue(usefulness.verdict, ["peer_more_useful", "own_more_useful", "mixed", "equivalent"] as const, `${path}.usefulnessVsOwn.verdict`);
  stringValue(usefulness.explanation, `${path}.usefulnessVsOwn.explanation`, MAX_LONG);

  const evidenceIds = new Set([...reports.a.evidence, ...reports.b.evidence].map((entry) => entry.id));
  const argumentIds = new Set([...reports.a.arguments, ...reports.b.arguments].map((entry) => entry.id));
  if (evidenceIds.size !== reports.a.evidence.length + reports.b.evidence.length) fail(path, "original reports have colliding evidence IDs");

  const corrections = list(review.corrections, `${path}.corrections`, 0, 50);
  for (let index = 0; index < corrections.length; index += 1) {
    const correction = record(corrections[index], `${path}.corrections[${index}]`);
    exactKeys(correction, ["argumentId", "issue", "correction", "evidenceIds"], [], `${path}.corrections[${index}]`);
    const argumentId = stringValue(correction.argumentId, `${path}.corrections[${index}].argumentId`, 80);
    if (!argumentIds.has(argumentId)) fail(`${path}.corrections[${index}].argumentId`, "must reference an original argument");
    stringValue(correction.issue, `${path}.corrections[${index}].issue`, MAX_LONG);
    stringValue(correction.correction, `${path}.corrections[${index}].correction`, MAX_LONG);
    const ids = stringList(correction.evidenceIds, `${path}.corrections[${index}].evidenceIds`, 0, 50);
    for (const id of ids) if (!evidenceIds.has(id)) fail(`${path}.corrections[${index}].evidenceIds`, `references unknown evidence ${id}`);
  }

  const disagreements = list(review.disagreements, `${path}.disagreements`, 0, 50);
  for (let index = 0; index < disagreements.length; index += 1) {
    const disagreement = record(disagreements[index], `${path}.disagreements[${index}]`);
    exactKeys(disagreement, ["topic", "position", "evidenceIds"], [], `${path}.disagreements[${index}]`);
    stringValue(disagreement.topic, `${path}.disagreements[${index}].topic`, MAX_LONG);
    stringValue(disagreement.position, `${path}.disagreements[${index}].position`, MAX_LONG);
    const ids = stringList(disagreement.evidenceIds, `${path}.disagreements[${index}].evidenceIds`, 0, 50);
    for (const id of ids) if (!evidenceIds.has(id)) fail(`${path}.disagreements[${index}].evidenceIds`, `references unknown evidence ${id}`);
  }
  stringList(review.missingEvidence, `${path}.missingEvidence`, 0, 50);
  const recommendation = enumValue(review.writerRecommendation, ["a", "b", "undetermined"] as const, `${path}.writerRecommendation`);
  if (subjects && recommendation !== "undetermined") fail(`${path}.writerRecommendation`, "must be undetermined when comparing explicit subjects; subject evidence cannot select a research worker");
  const writerEvidenceIds = stringList(review.writerEvidenceIds, `${path}.writerEvidenceIds`, recommendation === "undetermined" ? 0 : 1, 50);
  if (recommendation === "undetermined" && writerEvidenceIds.length > 0) fail(`${path}.writerEvidenceIds`, "must be empty for an undetermined recommendation");
  for (const id of writerEvidenceIds) if (!evidenceIds.has(id)) fail(`${path}.writerEvidenceIds`, `references unknown evidence ${id}`);
  integer(review.confidence, `${path}.confidence`, 0, 100);
  return review as ReviewReport;
}

export function parseReviewReport(
  raw: string,
  expectedReviewer: ModelTarget,
  targets: [ModelTarget, ModelTarget],
  reports: { a: ResearchReport; b: ResearchReport },
  subjects?: ComparisonSubjects,
): ReviewReport {
  stringValue(raw, "review output", MAX_REVIEW_CHARS);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail("review output", `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateReviewReportValue(value, expectedReviewer, targets, reports, "review output", subjects);
}

export function usageSummarySection(raw: string): string {
  const marker = `\n${USAGE_SUMMARY_HEADING}\n`;
  const start = raw.indexOf(marker);
  if (start < 0 || raw.indexOf(marker, start + marker.length) >= 0) fail("skill draft", `must contain exactly one final ${USAGE_SUMMARY_HEADING} section`);
  return raw.slice(start + 1).trimEnd() + "\n";
}

function validateUsageSummary(raw: string, targets?: ComparisonSubjects | [ModelTarget, ModelTarget], subjects?: ComparisonSubjects): void {
  const lines = usageSummarySection(raw).split("\n").slice(1).filter(line => line.trim());
  if (lines.length !== MODEL_USAGE_TASKS.length + 2) fail("skill draft usage summary", "must end with only a table covering every task family exactly once");
  const cells = (line: string): string[] => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) fail("skill draft usage summary", "must use pipe-delimited table rows");
    const result: string[] = [];
    let cell = "";
    const content = trimmed.slice(1, -1);
    for (let index = 0; index < content.length; index += 1) {
      const char = content[index];
      if (char === "\\" && content[index + 1] !== undefined) cell += char + content[++index];
      else if (char === "|") { result.push(cell.trim()); cell = ""; }
      else cell += char;
    }
    result.push(cell.trim());
    return result;
  };
  if (JSON.stringify(cells(lines[0])) !== JSON.stringify(cells(USAGE_SUMMARY_HEADER))) fail("skill draft usage summary", "must use the required table columns");
  const divider = cells(lines[1]);
  if (divider.length !== 5 || divider.some(cell => !/^:?-{3,}:?$/.test(cell))) fail("skill draft usage summary", "must include a valid table separator");
  const remaining = new Set<string>(MODEL_USAGE_TASKS);
  const choices = new Set<string>([...INCONCLUSIVE_MODEL_CHOICES, ...(subjects ? subjectChoiceLabels(subjects) : (targets ?? []).flatMap(target => [target.model, escapeSubjectLabel(target.model), target.model.replace(/\|/g, "\\|")]))]);
  for (const line of lines.slice(2)) {
    const row = cells(line);
    if (row.length !== 5 || row.some(cell => !cell)) fail("skill draft usage summary", "must provide five nonempty cells per task family");
    if (!remaining.delete(row[0])) fail("skill draft usage summary", `unknown or duplicate task family ${row[0]}`);
    if (targets && !choices.has(row[1])) fail("skill draft usage summary", `Use must name an exact compared model or ${INCONCLUSIVE_MODEL_CHOICES.join(", ")}`);
    if (!/^(?:100|[1-9]?\d)\/100$/.test(row[4])) fail("skill draft usage summary", "confidence must be an integer from 0 through 100 formatted as N/100");
  }
}

function containsModelLabel(text: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}._-])${escaped}(?=$|[^\\p{L}\\p{N}._-]|\\.(?![\\p{L}\\p{N}_-]))`, "u").test(text);
}

function validateSubjectRouting(body: string, subjects: ComparisonSubjects, workers: [ModelTarget, ModelTarget], requireUsageSummary: boolean): void {
  const heading = /(?:^|\n)## Routing guidance[ \t]*\n/.exec(body);
  if (!heading) fail("skill draft", "must have a Routing guidance section");
  const rest = body.slice(heading.index + heading[0].length);
  const end = rest.search(/^## /m);
  let routing = (end < 0 ? rest : rest.slice(0, end)) + (requireUsageSummary ? usageSummarySection(body) : "");
  routing = routing.toLocaleLowerCase("en-US");
  const labels = subjects.flatMap(subject => [subject.model, escapeSubjectLabel(subject.model)]).sort((a, b) => b.length - a.length);
  for (const label of labels) routing = routing.split(label.toLocaleLowerCase("en-US")).join(" ");
  for (const worker of workers) {
    if ([worker.model, escapeSubjectLabel(worker.model)].some(label => containsModelLabel(routing, label.toLocaleLowerCase("en-US")))) {
      fail("skill draft routing guidance", `must not reference research worker ${worker.model} instead of comparison subjects`);
    }
  }
}

export function validateSkillDraft(raw: string, asOfDate: string, targets?: ComparisonSubjects | [ModelTarget, ModelTarget], requireUsageSummary = false, workers?: [ModelTarget, ModelTarget]): string {
  stringValue(raw, "skill draft", 300_000);
  if (raw.startsWith("```")) fail("skill draft", "must not be wrapped in a code fence");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) fail("skill draft", "must start with portable YAML frontmatter");
  const lines = match[1].split("\n");
  const fields = new Map<string, string>();
  for (const line of lines) {
    const field = line.match(/^([a-z][a-z0-9-]*):\s+(.+)$/);
    if (!field) fail("skill draft frontmatter", `unsupported line ${JSON.stringify(line)}`);
    if (fields.has(field[1])) fail("skill draft frontmatter", `duplicate field ${field[1]}`);
    fields.set(field[1], field[2].trim());
  }
  if (fields.size !== 2 || !fields.has("name") || !fields.has("description")) fail("skill draft frontmatter", "must contain only name and description");
  const name = fields.get("name")!;
  let description = fields.get("description")!;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || /^(?:null|true|false|yes|no|on|off|y|n)$/i.test(name) || Number.isFinite(Number(name))) fail("skill draft frontmatter.name", "must be lowercase hyphenated non-scalar YAML text and at most 64 characters");
  if (description.startsWith('"')) {
    try { description = JSON.parse(description); } catch { fail("skill draft frontmatter.description", "quoted descriptions must be JSON-compatible strings"); }
  } else if (/[:]\s|\s#|^[!&*{}[\],#|>@`'"%?\-]/.test(description) || /^(?:null|true|false|yes|no|on|off|y|n|~|[+-]?\.(?:inf|nan))$/i.test(description) || /^[+]?(?:\d|\.\d)/.test(description)) {
    fail("skill draft frontmatter.description", "unsafe YAML plain scalar; use a JSON-quoted string");
  }
  if (typeof description !== "string" || description.length === 0 || description.length > 1024 || /[\r\n]/.test(description)) fail("skill draft frontmatter.description", "must be a portable single-line description");
  const body = raw.slice(match[0].length);
  if (body.length < 300) fail("skill draft", "body is too short to contain useful bounded guidance");
  for (const heading of ["## Routing guidance", "## Limits and uncertainty", "## Refresh triggers", "## Supporting evidence"]) {
    if (!body.includes(heading)) fail("skill draft", `missing required heading ${heading}`);
  }
  if (!body.includes(asOfDate)) fail("skill draft", `must state evidence as-of date ${asOfDate}`);
  const subjects = targets && !("hostingProvider" in targets[0]) ? subjectTuple(targets, "skill draft subjects") : undefined;
  for (const target of targets ?? []) {
    const identified = subjects ? containsModelLabel(body, escapeSubjectLabel(target.model)) : body.includes(target.model) || body.includes(escapeSubjectLabel(target.model));
    if (!identified) fail("skill draft", `must identify exact model ${target.model}`);
  }
  for (const path of FIXED_REFERENCE_PATHS) {
    if (!body.includes(`](${path})`)) fail("skill draft", `missing fixed reference link ${path}`);
  }
  for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)]*)\)/g)) {
    if (!(FIXED_REFERENCE_PATHS as readonly string[]).includes(match[1])) fail("skill draft", `unsupported link destination ${match[1]}`);
  }
  if (/^\s*\[[^\]]+\]:/m.test(body) || /<(?:a|img|script|iframe|link|object)\b/i.test(body)) fail("skill draft", "reference-style links and active HTML are unsupported");
  if (requireUsageSummary) validateUsageSummary(body, targets, subjects);
  if (subjects && workers) validateSubjectRouting(body, subjects, workers, requireUsageSummary);
  return raw;
}

function validateJob(value: unknown, run: WorkflowRun, path: string): WorkflowJob {
  const job = record(value, path);
  exactKeys(job, ["key", "requestId", "target", "stage", "prompt", "limits", "status"], ["taskId", "result", "error", "usage", "dispatchedAt", "finishedAt", "cancellationAcknowledgedAt", "cancellationError", "statusError"], path);
  const key = enumValue(job.key, JOB_KEYS, `${path}.key`);
  if (job.requestId !== `${run.runId}:${key}`) fail(`${path}.requestId`, "must be the stable run-specific request ID");
  const expectedTarget: ModelKey = key.endsWith("-a") ? "a" : key.endsWith("-b") ? "b" : run.writerSelection?.target ?? "a";
  if (job.target !== expectedTarget) fail(`${path}.target`, `must be ${expectedTarget}`);
  const expectedStage = key.startsWith("research") ? "research" : key.startsWith("review") ? "review" : "draft";
  if (job.stage !== expectedStage) fail(`${path}.stage`, `must be ${expectedStage}`);
  stringValue(job.prompt, `${path}.prompt`, MAX_PROMPT);
  const limits = validateLimits({ maxJobs: 5, perCall: job.limits, expiresAt: run.limits.expiresAt }, `${path}._limits`).perCall;
  if (JSON.stringify(limits) !== JSON.stringify(run.limits.perCall)) fail(`${path}.limits`, "must match run per-call limits");
  const status = enumValue(job.status, ["ready", "dispatching", "pending", "complete", "error", "cancelled"] as const, `${path}.status`);
  if (status === "pending") stringValue(job.taskId, `${path}.taskId`, MAX_SHORT);
  else if ((status === "complete" || status === "error" || status === "cancelled") && job.taskId !== undefined) stringValue(job.taskId, `${path}.taskId`, MAX_SHORT);
  else if (job.taskId !== undefined) fail(`${path}.taskId`, "is allowed only for a pending or settled external job");
  if (status === "complete") stringValue(job.result, `${path}.result`, MAX_RAW_OUTPUT);
  else if (job.result !== undefined && status !== "error") fail(`${path}.result`, "is allowed only for complete or malformed-output error jobs");
  if (status === "error") stringValue(job.error, `${path}.error`, MAX_LONG);
  else if (job.error !== undefined) fail(`${path}.error`, "is allowed only for an error job");
  if (job.usage !== undefined) validateUsage(job.usage, `${path}.usage`);
  optionalDateTime(job.dispatchedAt, `${path}.dispatchedAt`);
  optionalDateTime(job.finishedAt, `${path}.finishedAt`);
  optionalDateTime(job.cancellationAcknowledgedAt, `${path}.cancellationAcknowledgedAt`);
  if (job.cancellationError !== undefined) stringValue(job.cancellationError, `${path}.cancellationError`, MAX_LONG);
  if (job.statusError !== undefined) stringValue(job.statusError, `${path}.statusError`, MAX_LONG);
  return job as WorkflowJob;
}

export function validateRun(value: unknown): WorkflowRun {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    fail("run", `must be serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (serialized === undefined || serialized.length > MAX_RUN_BYTES) fail("run", `serialized form must be at most ${MAX_RUN_BYTES} bytes`);
  const run = record(value, "run");
  exactKeys(run, ["schemaVersion", "runId", "task", "asOfDate", "createdAt", "updatedAt", "stage", "status", "targets", "limits", "jobs"], ["scope", "subjects", "originals", "reviews", "writerSelection", "skillDraft", "error", "cancellationReason", "cancellationErrors", "cancelledAt", "completedAt"], "run");
  if (run.schemaVersion !== 1) fail("run.schemaVersion", "must equal 1");
  if (run.scope !== undefined) enumValue(run.scope, ["overall"] as const, "run.scope");
  const runId = stringValue(run.runId, "run.runId", 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId)) fail("run.runId", "must be a stable portable identifier");
  stringValue(run.task, "run.task", MAX_LONG);
  const asOfDate = isoDate(run.asOfDate, "run.asOfDate");
  isoDateTime(run.createdAt, "run.createdAt");
  isoDateTime(run.updatedAt, "run.updatedAt");
  enumValue(run.stage, ["research", "review", "writer_selection", "draft", "complete"] as const, "run.stage");
  const status = enumValue(run.status, ["running", "awaiting_writer", "error", "cancelled", "complete"] as const, "run.status");
  const targets = validateTargets(run.targets);
  const subjects = run.subjects === undefined ? undefined : subjectTuple(run.subjects, "run.subjects");
  const limits = validateLimits(run.limits);
  if (Date.parse(limits.expiresAt) <= Date.parse(run.createdAt as string)) fail("run.limits.expiresAt", "must be later than createdAt");

  const typedRun = run as WorkflowRun;
  const jobs = list(run.jobs, "run.jobs", 2, 5).map((job, index) => validateJob(job, typedRun, `run.jobs[${index}]`));
  if (new Set(jobs.map((job) => job.key)).size !== jobs.length) fail("run.jobs", "job keys must be unique");
  for (const required of ["research-a", "research-b"]) if (!jobs.some((job) => job.key === required)) fail("run.jobs", `missing ${required}`);

  let reports: { a: ResearchReport; b: ResearchReport } | undefined;
  if (run.originals !== undefined) {
    const originals = record(run.originals, "run.originals");
    exactKeys(originals, ["frozenAt", "a", "b"], [], "run.originals");
    isoDateTime(originals.frozenAt, "run.originals.frozenAt");
    const frozen: Partial<Record<ModelKey, { raw: string; parsed: ResearchReport }>> = {};
    for (const key of MODEL_KEYS) {
      const item = record(originals[key], `run.originals.${key}`);
      exactKeys(item, ["raw", "parsed"], [], `run.originals.${key}`);
      const raw = stringValue(item.raw, `run.originals.${key}.raw`, MAX_RESEARCH_CHARS);
      const parsed = validateResearchReportValue(item.parsed, targets[key === "a" ? 0 : 1], targets, `run.originals.${key}.parsed`, subjects);
      if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(parsed)) fail(`run.originals.${key}`, "parsed data must match the frozen raw output");
      if (parsed.asOfDate !== run.asOfDate) fail(`run.originals.${key}.parsed.asOfDate`, "must match run asOfDate");
      const job = jobs.find((candidate) => candidate.key === `research-${key}`);
      if (!job || job.status !== "complete" || job.result !== raw) fail(`run.originals.${key}`, "must exactly match the completed research job result");
      frozen[key] = { raw, parsed };
    }
    reports = { a: frozen.a!.parsed, b: frozen.b!.parsed };
    const allIds = [...reports.a.evidence, ...reports.b.evidence].map((entry) => entry.id);
    if (new Set(allIds).size !== allIds.length) fail("run.originals", "evidence IDs must be unique across both reports");
    for (const required of ["review-a", "review-b"]) if (!jobs.some((job) => job.key === required)) fail("run.jobs", `missing ${required} after originals are frozen`);
  }

  if (run.reviews !== undefined) {
    if (!reports) fail("run.reviews", "requires frozen originals");
    const reviews = record(run.reviews, "run.reviews");
    exactKeys(reviews, ["frozenAt", "a", "b"], [], "run.reviews");
    isoDateTime(reviews.frozenAt, "run.reviews.frozenAt");
    for (const key of MODEL_KEYS) {
      const item = record(reviews[key], `run.reviews.${key}`);
      exactKeys(item, ["raw", "parsed"], [], `run.reviews.${key}`);
      const raw = stringValue(item.raw, `run.reviews.${key}.raw`, MAX_REVIEW_CHARS);
      validateReviewReportValue(item.parsed, targets[key === "a" ? 0 : 1], targets, reports!, `run.reviews.${key}.parsed`, subjects);
      if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(item.parsed)) fail(`run.reviews.${key}`, "parsed data must match the frozen raw output");
      const job = jobs.find((candidate) => candidate.key === `review-${key}`);
      if (!job || job.status !== "complete" || job.result !== raw) fail(`run.reviews.${key}`, "must exactly match the completed review job result");
    }
  }

  if (run.writerSelection !== undefined) {
    const selection = record(run.writerSelection, "run.writerSelection");
    exactKeys(selection, ["target", "mode", "rationale", "evidenceIds", "selectedAt"], [], "run.writerSelection");
    enumValue(selection.target, MODEL_KEYS, "run.writerSelection.target");
    enumValue(selection.mode, ["automatic", "user"] as const, "run.writerSelection.mode");
    if (subjects && selection.mode === "automatic") fail("run.writerSelection.mode", "automatic writer selection is disabled for explicit comparison subjects");
    stringValue(selection.rationale, "run.writerSelection.rationale", MAX_LONG);
    const evidenceIds = stringList(selection.evidenceIds, "run.writerSelection.evidenceIds", 0, 100);
    if (reports) {
      const known = new Set([...reports.a.evidence, ...reports.b.evidence].map((entry) => entry.id));
      for (const id of evidenceIds) if (!known.has(id)) fail("run.writerSelection.evidenceIds", `references unknown evidence ${id}`);
    }
    isoDateTime(selection.selectedAt, "run.writerSelection.selectedAt");
    if (!jobs.some((job) => job.key === "draft")) fail("run.jobs", "missing draft after writer selection");
  }

  if (run.skillDraft !== undefined) validateSkillDraft(stringValue(run.skillDraft, "run.skillDraft", 300_000), asOfDate, subjects ?? targets, run.scope === "overall", subjects ? targets : undefined);
  if (run.error !== undefined) {
    const error = record(run.error, "run.error");
    exactKeys(error, ["code", "message"], ["jobKey"], "run.error");
    enumValue(error.code, ["invalid_output", "runtime_error", "uncertain_dispatch", "expired", "invalid_state"] as const, "run.error.code");
    stringValue(error.message, "run.error.message", MAX_LONG);
    if (error.jobKey !== undefined) enumValue(error.jobKey, JOB_KEYS, "run.error.jobKey");
  }
  if (run.cancellationReason !== undefined) stringValue(run.cancellationReason, "run.cancellationReason", MAX_LONG);
  if (run.cancellationErrors !== undefined) stringList(run.cancellationErrors, "run.cancellationErrors", 0, 10);
  optionalDateTime(run.cancelledAt, "run.cancelledAt");
  optionalDateTime(run.completedAt, "run.completedAt");

  if (status === "awaiting_writer" && (!run.reviews || run.writerSelection)) fail("run.status", "awaiting_writer requires reviews and no writer selection");
  if (status === "error" && !run.error) fail("run.status", "error status requires error details");
  if (status === "cancelled" && (!run.cancelledAt || !run.cancellationReason)) fail("run.status", "cancelled status requires time and reason");
  if (status === "complete" && (!run.skillDraft || !run.completedAt || run.stage !== "complete")) fail("run.status", "complete status requires a validated skill draft and completion time");
  if (run.stage === "review" && !run.originals) fail("run.stage", "review stage requires frozen originals");
  if ((run.stage === "writer_selection" || run.stage === "draft" || run.stage === "complete") && !run.reviews) fail("run.stage", "requires frozen reviews");
  if ((run.stage === "draft" || run.stage === "complete") && !run.writerSelection) fail("run.stage", "requires writer selection");
  return typedRun;
}
