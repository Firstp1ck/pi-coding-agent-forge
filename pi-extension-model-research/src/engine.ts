import {
  type CreateRunInput,
  type FrozenReview,
  type FrozenResearch,
  type JobKey,
  type ModelKey,
  type ResearchEvidence,
  type Runtime,
  type RuntimeOutcome,
  type SaveCheckpoint,
  type WorkflowJob,
  type WorkflowRun,
  type WriterSelection,
} from "./types.ts";
import {
  buildDraftPrompt,
  buildResearchPrompt,
  buildReviewPrompt,
  evidenceRegister,
  modelForKey,
} from "./prompts.ts";
import { OVERALL_RESEARCH_TASK } from "./scope.ts";
import { validateSubjects } from "./subjects.ts";
import {
  ValidationError,
  parseResearchReport,
  parseReviewReport,
  validateRun,
  validateSkillDraft,
  validateTargets,
} from "./validation.ts";

function now(): string {
  return new Date().toISOString();
}

function update(run: WorkflowRun, timestamp = now()): void {
  run.updatedAt = timestamp;
}

function newJob(run: WorkflowRun, key: JobKey, target: ModelKey, prompt: string): WorkflowJob {
  return {
    key,
    requestId: `${run.runId}:${key}`,
    target,
    stage: key.startsWith("research") ? "research" : key.startsWith("review") ? "review" : "draft",
    prompt,
    limits: { ...run.limits.perCall },
    status: "ready",
  };
}

export function createRun(input: CreateRunInput): WorkflowRun {
  const targets = validateTargets(input.targets);
  const run: WorkflowRun = {
    schemaVersion: 1,
    scope: "overall",
    runId: input.runId,
    task: input.task?.trim() || OVERALL_RESEARCH_TASK,
    asOfDate: input.asOfDate,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    stage: "research",
    status: "running",
    targets: structuredClone(targets),
    ...(input.subjects === undefined ? {} : { subjects: structuredClone(validateSubjects(input.subjects)) }),
    limits: {
      maxJobs: input.limits.maxJobs,
      perCall: { ...input.limits.perCall },
      expiresAt: input.limits.expiresAt,
    },
    jobs: [],
  };
  run.jobs.push(
    newJob(run, "research-a", "a", buildResearchPrompt(targets[0], targets, run.task, run.asOfDate, run.subjects)),
    newJob(run, "research-b", "b", buildResearchPrompt(targets[1], targets, run.task, run.asOfDate, run.subjects)),
  );
  return validateRun(run);
}

function job(run: WorkflowRun, key: JobKey): WorkflowJob {
  const found = run.jobs.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Missing workflow job ${key}`);
  return found;
}

function currentJobs(run: WorkflowRun): WorkflowJob[] {
  if (run.stage === "research") return [job(run, "research-a"), job(run, "research-b")];
  if (run.stage === "review") return [job(run, "review-a"), job(run, "review-b")];
  if (run.stage === "draft") return [job(run, "draft")];
  return [];
}

function reports(run: WorkflowRun): { a: FrozenResearch; b: FrozenResearch } {
  if (!run.originals) throw new Error("Frozen originals are unavailable");
  return { a: run.originals.a, b: run.originals.b };
}

function reviewOutputs(run: WorkflowRun): { a: FrozenReview; b: FrozenReview } {
  if (!run.reviews) throw new Error("Frozen reviews are unavailable");
  return { a: run.reviews.a, b: run.reviews.b };
}

function markJobError(run: WorkflowRun, current: WorkflowJob, code: "invalid_output" | "runtime_error", message: string): void {
  current.status = "error";
  current.statusError = undefined;
  current.error = message.slice(0, 10_000);
  current.finishedAt = now();
  update(run, current.finishedAt);
  run.error = { code, message: message.slice(0, 10_000), jobKey: current.key };
}

function parseCompletedOutput(run: WorkflowRun, current: WorkflowJob, text: string): void {
  const target = modelForKey(run.targets, current.target);
  if (current.stage === "research") {
    const report = parseResearchReport(text, target, run.targets, run.subjects);
    if (report.asOfDate !== run.asOfDate) throw new ValidationError(`research output.asOfDate: must match run asOfDate ${run.asOfDate}`);
  } else if (current.stage === "review") {
    const frozen = reports(run);
    parseReviewReport(text, target, run.targets, { a: frozen.a.parsed, b: frozen.b.parsed }, run.subjects);
  } else {
    validateSkillDraft(text, run.asOfDate, run.subjects ?? run.targets, run.scope === "overall", run.subjects ? run.targets : undefined);
  }
}

async function applyOutcome(run: WorkflowRun, current: WorkflowJob, outcome: RuntimeOutcome, saveCheckpoint: SaveCheckpoint): Promise<void> {
  if (!outcome || (outcome.status !== "complete" && outcome.status !== "pending")) {
    markJobError(run, current, "runtime_error", "Runtime returned an invalid outcome");
    await saveCheckpoint(run);
    return;
  }
  if (outcome.status === "pending") {
    if (!outcome.taskId || typeof outcome.taskId !== "string") {
      markJobError(run, current, "runtime_error", "Runtime returned pending without a task ID");
    } else if (current.taskId && current.taskId !== outcome.taskId) {
      markJobError(run, current, "runtime_error", "Runtime changed the task ID for a pending job");
    } else {
      current.status = "pending";
      current.taskId = outcome.taskId;
      update(run);
    }
    await saveCheckpoint(run);
    return;
  }

  current.result = outcome.text;
  current.usage = outcome.usage;
  try {
    parseCompletedOutput(run, current, outcome.text);
    current.status = "complete";
    current.finishedAt = now();
    update(run, current.finishedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markJobError(run, current, error instanceof ValidationError ? "invalid_output" : "runtime_error", message);
  }
  await saveCheckpoint(run);
}

async function checkPending(
  run: WorkflowRun,
  current: WorkflowJob,
  runtime: Runtime,
  saveCheckpoint: SaveCheckpoint,
  signal?: AbortSignal,
): Promise<void> {
  await saveCheckpoint(run);
  try {
    const outcome = await runtime.check(current, signal);
    current.statusError = undefined;
    await applyOutcome(run, current, outcome, saveCheckpoint);
  } catch (error) {
    if (signal?.aborted) return;
    const message = `Runtime check failed: ${error instanceof Error ? error.message : String(error)}`;
    if (error && typeof error === "object" && "retryableStatus" in error && error.retryableStatus === true) {
      current.statusError = message.slice(0, 8_000);
      update(run);
      await saveCheckpoint(run);
      return;
    }
    if (error && typeof error === "object" && "usage" in error) current.usage = (error as { usage: WorkflowJob["usage"] }).usage;
    markJobError(run, current, "runtime_error", message);
    await saveCheckpoint(run);
  }
}

async function startReady(
  run: WorkflowRun,
  current: WorkflowJob,
  runtime: Runtime,
  saveCheckpoint: SaveCheckpoint,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await runtime.preflight?.(current, signal);
  } catch (error) {
    if (signal?.aborted) return;
    markJobError(run, current, "runtime_error", `Preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    run.status = "error";
    await saveCheckpoint(run);
    return;
  }
  if (signal?.aborted) return;
  current.status = "dispatching";
  current.dispatchedAt = now();
  update(run, current.dispatchedAt);
  await saveCheckpoint(run);
  try {
    const outcome = await runtime.start(current, signal);
    await applyOutcome(run, current, outcome, saveCheckpoint);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error && typeof error === "object" && "usage" in error) current.usage = (error as { usage: WorkflowJob["usage"] }).usage;
    if (runtime.kind === "pi") {
      markJobError(run, current, "runtime_error", detail);
    } else if (error && typeof error === "object" && "taskId" in error && typeof error.taskId === "string" && error.taskId.length > 0 && error.taskId.length <= 2_000) {
      current.taskId = error.taskId;
      markJobError(run, current, "runtime_error", `Dispatch rejected after creating task ${current.taskId}: ${detail}`);
    } else {
      run.error = { code: "uncertain_dispatch", message: `Dispatch outcome is uncertain: ${detail}`, jobKey: current.key };
    }
    run.status = "error";
    update(run);
    await saveCheckpoint(run);
  }
}

function stageFailure(run: WorkflowRun, jobs: WorkflowJob[]): boolean {
  const failed = jobs.find((candidate) => candidate.status === "error");
  if (!failed) return false;
  run.status = "error";
  run.error ??= { code: "runtime_error", message: failed.error ?? `Job ${failed.key} failed`, jobKey: failed.key };
  update(run);
  return true;
}

function freezeOriginals(run: WorkflowRun): void {
  const a = job(run, "research-a");
  const b = job(run, "research-b");
  if (!a.result || !b.result) throw new Error("Research results are incomplete");
  const parsedA = parseResearchReport(a.result, run.targets[0], run.targets, run.subjects);
  const parsedB = parseResearchReport(b.result, run.targets[1], run.targets, run.subjects);
  const ids = [...parsedA.evidence, ...parsedB.evidence].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new ValidationError("Evidence IDs collide across the frozen originals");
  const frozenAt = now();
  run.originals = {
    frozenAt,
    a: { raw: a.result, parsed: parsedA },
    b: { raw: b.result, parsed: parsedB },
  };
  const originals = { a: a.result, b: b.result };
  const evidence = evidenceRegister({ a: parsedA, b: parsedB });
  run.jobs.push(
    newJob(run, "review-a", "a", buildReviewPrompt(run.targets[0], originals, evidence, run.scope === "overall", run.subjects)),
    newJob(run, "review-b", "b", buildReviewPrompt(run.targets[1], originals, evidence, run.scope === "overall", run.subjects)),
  );
  run.stage = "review";
  update(run, frozenAt);
}

function freezeReviews(run: WorkflowRun): void {
  const originals = reports(run);
  const a = job(run, "review-a");
  const b = job(run, "review-b");
  if (!a.result || !b.result) throw new Error("Review results are incomplete");
  const frozenAt = now();
  run.reviews = {
    frozenAt,
    a: { raw: a.result, parsed: parseReviewReport(a.result, run.targets[0], run.targets, { a: originals.a.parsed, b: originals.b.parsed }, run.subjects) },
    b: { raw: b.result, parsed: parseReviewReport(b.result, run.targets[1], run.targets, { a: originals.a.parsed, b: originals.b.parsed }, run.subjects) },
  };
  run.stage = "writer_selection";
  update(run, frozenAt);
}

function qualifyingEvidence(evidence: ResearchEvidence, target: ModelKey): boolean {
  return evidence.sourceAccess === "fetched"
    && evidence.evidenceClass !== "anecdotal"
    && evidence.topics.includes("skill-writing")
    && evidence.supportsTarget === target;
}

export function automaticWriterSelection(run: WorkflowRun): WriterSelection | undefined {
  if (run.subjects !== undefined) return undefined;
  if (!run.originals || !run.reviews) return undefined;
  const reviewA = run.reviews.a.parsed;
  const reviewB = run.reviews.b.parsed;
  if (reviewA.writerRecommendation === "undetermined" || reviewA.writerRecommendation !== reviewB.writerRecommendation) return undefined;
  const target = reviewA.writerRecommendation;
  const register = new Map(
    [...run.originals.a.parsed.evidence, ...run.originals.b.parsed.evidence].map((entry) => [entry.id, entry]),
  );
  const qualifyingA = reviewA.writerEvidenceIds.filter((id) => {
    const evidence = register.get(id);
    return evidence ? qualifyingEvidence(evidence, target) : false;
  });
  const qualifyingB = reviewB.writerEvidenceIds.filter((id) => {
    const evidence = register.get(id);
    return evidence ? qualifyingEvidence(evidence, target) : false;
  });
  if (qualifyingA.length === 0 || qualifyingB.length === 0) return undefined;
  const evidenceIds = [...new Set([...qualifyingA, ...qualifyingB])];
  return {
    target,
    mode: "automatic",
    rationale: `Both reciprocal reviews recommend target ${target} and each cites fetched, non-anecdotal, skill-writing-specific evidence supporting that target. Agreement alone was not treated as validation.`,
    evidenceIds,
    selectedAt: now(),
  };
}

function addDraftJob(run: WorkflowRun): void {
  if (!run.writerSelection || !run.originals || !run.reviews) throw new Error("Draft prerequisites are incomplete");
  if (run.jobs.some((candidate) => candidate.key === "draft")) throw new Error("Draft job already exists");
  if (run.jobs.length >= run.limits.maxJobs) throw new Error("Job limit reached");
  const target = modelForKey(run.targets, run.writerSelection.target);
  const prompt = buildDraftPrompt(
    target,
    { a: run.originals.a.raw, b: run.originals.b.raw },
    { a: run.reviews.a.raw, b: run.reviews.b.raw },
    run.writerSelection,
    run.task,
    run.asOfDate,
    run.scope === "overall",
    run.subjects,
  );
  run.jobs.push(newJob(run, "draft", target.key, prompt));
  run.stage = "draft";
  run.status = "running";
  update(run);
}

export function chooseWriter(
  run: WorkflowRun,
  target: ModelKey,
  rationale = run.subjects ? "Explicit user choice of a configured research worker; evidence about the comparison subjects cannot select the writer." : "Explicit user choice after reciprocal reviews were inconclusive.",
  selectedAt = now(),
): WorkflowRun {
  validateRun(run);
  if (run.status !== "awaiting_writer" || run.stage !== "writer_selection" || !run.reviews || run.writerSelection) {
    throw new Error("Writer can be chosen only while awaiting an explicit writer choice");
  }
  if (target !== "a" && target !== "b") throw new Error("Writer target must be a or b");
  if (!rationale.trim()) throw new Error("Writer-selection rationale must not be empty");
  run.writerSelection = { target, mode: "user", rationale, evidenceIds: [], selectedAt };
  addDraftJob(run);
  return validateRun(run);
}

async function markExpired(run: WorkflowRun, runtime: Runtime, saveCheckpoint: SaveCheckpoint): Promise<WorkflowRun> {
  await cancelRun(run, runtime, saveCheckpoint, `Run expired at ${run.limits.expiresAt}`);
  run.error = { code: "expired", message: `Run expired at ${run.limits.expiresAt}` };
  update(run);
  await saveCheckpoint(run);
  return run;
}

export async function cancelRun(
  run: WorkflowRun,
  runtime: Runtime,
  saveCheckpoint: SaveCheckpoint,
  reason = "Cancelled by user",
  _signal?: AbortSignal,
): Promise<WorkflowRun> {
  validateRun(run);
  if (run.status === "complete") return run;
  const cancelledAt = run.cancelledAt ?? now();
  run.status = "cancelled";
  run.cancellationReason ??= reason;
  run.cancelledAt = cancelledAt;
  update(run);
  await saveCheckpoint(run);

  for (const current of run.jobs) {
    if (current.status === "complete" || current.cancellationAcknowledgedAt) continue;
    current.cancellationError = undefined;
    current.statusError = undefined;
    try {
      if (runtime.kind === "t3" && current.status === "dispatching" && !current.taskId) {
        throw new Error("Unknown external dispatch: no task ID is available; inspect T3 before manual recovery");
      }
      if (current.taskId || current.status === "dispatching") {
        // Undefined would inherit the aborted parent signal in Pi's nested-tool context.
        const cleanup = new AbortController();
        const timer = setTimeout(() => cleanup.abort(new Error("Cancellation cleanup timed out")), 10_000);
        try { await runtime.cancel(current, cleanup.signal); }
        finally { clearTimeout(timer); cleanup.abort(); }
      }
      current.cancellationAcknowledgedAt = now();
      if (current.status !== "error") current.status = "cancelled";
      current.finishedAt ??= now();
    } catch (error) {
      current.cancellationError = (error instanceof Error ? error.message : String(error)).slice(0, 8_000);
    }
    run.cancellationErrors = run.jobs.filter(item => item.cancellationError).map(item => `${item.key}: ${item.cancellationError}`);
    update(run);
    await saveCheckpoint(run);
  }
  return validateRun(run);
}

export async function advanceRun(
  run: WorkflowRun,
  runtime: Runtime,
  saveCheckpoint: SaveCheckpoint,
  signal?: AbortSignal,
): Promise<WorkflowRun> {
  validateRun(run);
  if (run.status === "complete" || run.status === "cancelled" || run.status === "awaiting_writer") return run;
  if (signal?.aborted) return cancelRun(run, runtime, saveCheckpoint, "Cancelled by abort signal", signal);
  if (Date.now() >= Date.parse(run.limits.expiresAt)) return markExpired(run, runtime, saveCheckpoint);

  const uncertain = run.jobs.find((candidate) => candidate.status === "dispatching");
  if (uncertain) {
    run.status = "error";
    run.error = {
      code: "uncertain_dispatch",
      message: `Job ${uncertain.key} was persisted as dispatching without a task ID; refusing duplicate dispatch`,
      jobKey: uncertain.key,
    };
    update(run);
    await saveCheckpoint(run);
    return validateRun(run);
  }
  if (run.status === "error") return run;

  while (run.status === "running") {
    if (signal?.aborted) return cancelRun(run, runtime, saveCheckpoint, "Cancelled by abort signal", signal);
    if (Date.now() >= Date.parse(run.limits.expiresAt)) return markExpired(run, runtime, saveCheckpoint);
    const jobs = currentJobs(run);

    for (const current of jobs.filter((candidate) => candidate.status === "pending")) {
      if (Date.now() >= Date.parse(run.limits.expiresAt)) return markExpired(run, runtime, saveCheckpoint);
      await checkPending(run, current, runtime, saveCheckpoint, signal);
      if (signal?.aborted) return cancelRun(run, runtime, saveCheckpoint, "Cancelled by abort signal");
    }
    for (const current of jobs.filter((candidate) => candidate.status === "ready")) {
      if (signal?.aborted) return cancelRun(run, runtime, saveCheckpoint, "Cancelled by abort signal", signal);
      if (Date.now() >= Date.parse(run.limits.expiresAt)) return markExpired(run, runtime, saveCheckpoint);
      await startReady(run, current, runtime, saveCheckpoint, signal);
      if (signal?.aborted) return cancelRun(run, runtime, saveCheckpoint, "Cancelled by abort signal");
      if (run.status !== "running") break;
    }

    if (run.status !== "running") return validateRun(run);
    if (stageFailure(run, jobs)) {
      await saveCheckpoint(run);
      return validateRun(run);
    }
    if (jobs.some((candidate) => candidate.status === "pending" || candidate.status === "dispatching")) return validateRun(run);
    if (!jobs.every((candidate) => candidate.status === "complete")) {
      run.status = "error";
      run.error = { code: "invalid_state", message: `Stage ${run.stage} has no runnable jobs` };
      update(run);
      await saveCheckpoint(run);
      return validateRun(run);
    }

    if (run.stage === "research") {
      try {
        freezeOriginals(run);
      } catch (error) {
        run.status = "error";
        run.error = { code: "invalid_output", message: error instanceof Error ? error.message : String(error) };
        update(run);
        await saveCheckpoint(run);
        return validateRun(run);
      }
      await saveCheckpoint(run);
      continue;
    }

    if (run.stage === "review") {
      freezeReviews(run);
      const selection = automaticWriterSelection(run);
      if (!selection) {
        run.status = "awaiting_writer";
        update(run);
        await saveCheckpoint(run);
        return validateRun(run);
      }
      run.writerSelection = selection;
      addDraftJob(run);
      await saveCheckpoint(run);
      continue;
    }

    if (run.stage === "draft") {
      const draft = job(run, "draft");
      run.skillDraft = validateSkillDraft(draft.result!, run.asOfDate, run.subjects ?? run.targets, run.scope === "overall", run.subjects ? run.targets : undefined);
      run.stage = "complete";
      run.status = "complete";
      run.completedAt = now();
      update(run, run.completedAt);
      await saveCheckpoint(run);
      return validateRun(run);
    }

    return validateRun(run);
  }
  return validateRun(run);
}
