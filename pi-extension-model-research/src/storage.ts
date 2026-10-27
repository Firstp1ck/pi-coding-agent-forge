import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { FIXED_REFERENCE_PATHS, type WorkflowRun } from "./types.ts";
import { studyScope } from "./scope.ts";
import { escapeSubjectLabel } from "./subjects.ts";
import { usageSummarySection, validateRun, validateSkillDraft } from "./validation.ts";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_RECORD_BYTES = 4_500_000;
const DEFAULT_MAX_LIST_ENTRIES = 1_000;
const LOCK_TOKEN = Symbol("model-research-run-lock");

export type RunEnvelope = {
  schemaVersion: 1;
  owner: string;
  projectRoot: string;
  runtimeKind: "pi" | "t3";
  run: WorkflowRun;
};

export type DraftExportResult = {
  outputDir: string;
  skillName: string;
  created: boolean;
  files: string[];
};

export type RunLock = {
  readonly runId: string;
  readonly path: string;
  readonly [LOCK_TOKEN]: symbol;
  release(): Promise<void>;
};

export type RunStore = {
  readonly root: string;
  readonly owner: string;
  readonly projectRoot: string;
  readonly runtimeKind: "pi" | "t3";
  create(run: WorkflowRun): Promise<RunEnvelope>;
  read(runId: string): Promise<RunEnvelope>;
  save(envelope: RunEnvelope, lock: RunLock): Promise<void>;
  list(limit?: number): Promise<RunEnvelope[]>;
  acquireRunLock(runId: string): Promise<RunLock>;
  withRunLock<T>(runId: string, action: (lock: RunLock) => Promise<T>): Promise<T>;
  exportDraft(runId: string, lock: RunLock): Promise<DraftExportResult>;
};

export type CreateRunStoreOptions = {
  root: string;
  owner: string;
  projectRoot: string;
  runtimeKind: "pi" | "t3";
  maxRecordBytes?: number;
  maxListEntries?: number;
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateRunId(runId: string): string {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(runId)) throw new Error("Invalid run ID");
  return runId;
}

function validateOwner(owner: string): string {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 256 || owner.includes("\0")) throw new Error("Invalid storage owner");
  return owner;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} must contain exactly ${wanted.join(", ")}`);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function immutableRunState(run: WorkflowRun): Record<string, unknown> {
  return {
    schemaVersion: run.schemaVersion,
    scope: run.scope,
    runId: run.runId,
    task: run.task,
    asOfDate: run.asOfDate,
    createdAt: run.createdAt,
    targets: run.targets,
    subjects: run.subjects,
    limits: run.limits,
  };
}

function assertMonotonic(previous: WorkflowRun, next: WorkflowRun): void {
  if (stable(immutableRunState(previous)) !== stable(immutableRunState(next))) throw new Error("Run identity or configuration is immutable");
  const previousJobs = new Map(previous.jobs.map((job) => [job.key, job]));
  for (const nextJob of next.jobs) {
    const old = previousJobs.get(nextJob.key);
    if (!old) continue;
    for (const key of ["requestId", "target", "stage", "prompt", "limits"] as const) {
      if (stable(old[key]) !== stable(nextJob[key])) throw new Error(`Job ${nextJob.key} ${key} is immutable`);
    }
    if (old.taskId !== undefined && nextJob.taskId !== old.taskId) throw new Error(`Job ${nextJob.key} taskId is immutable once assigned`);
    if (old.status === "complete" && (nextJob.status !== "complete" || nextJob.result !== old.result)) throw new Error(`Completed job ${nextJob.key} output is immutable`);
  }
  if (previous.originals !== undefined && stable(previous.originals) !== stable(next.originals)) throw new Error("Frozen original outputs are immutable");
  if (previous.reviews !== undefined && stable(previous.reviews) !== stable(next.reviews)) throw new Error("Frozen review outputs are immutable");
  if (previous.writerSelection !== undefined && stable(previous.writerSelection) !== stable(next.writerSelection)) throw new Error("Writer selection is immutable once recorded");
  if (previous.skillDraft !== undefined && previous.skillDraft !== next.skillDraft) throw new Error("Skill draft is immutable once recorded");
}

async function existingDirectory(path: string, label: string, requirePrivate = true): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory, not a symlink or other file`);
  if (requirePrivate && (info.mode & 0o077) !== 0) throw new Error(`${label} permissions must not grant group or world access`);
}

async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await existingDirectory(path, label);
}

async function safeRead(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing non-regular record file ${path}`);
  if (info.size > maxBytes) throw new Error(`Record exceeds ${maxBytes} bytes`);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) throw new Error(`Record exceeds ${maxBytes} bytes or changed during read`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicReplace(path: string, content: string, maxBytes: number): Promise<void> {
  if (byteLength(content) > maxBytes) throw new Error(`Serialized record exceeds ${maxBytes} bytes`);
  const directory = resolve(path, "..");
  await existingDirectory(directory, "run directory");
  const temporary = join(directory, `.record-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeExclusive(temporary, content);
    try {
      const current = await lstat(path);
      if (current.isSymbolicLink() || !current.isFile()) throw new Error("Refusing to replace a symlink or non-file record");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function envelopeValue(value: unknown, expected: { owner: string; projectRoot: string; runtimeKind: "pi" | "t3" }): RunEnvelope {
  const envelope = plainRecord(value, "record envelope");
  exactKeys(envelope, ["schemaVersion", "owner", "projectRoot", "runtimeKind", "run"], "record envelope");
  if (envelope.schemaVersion !== 1) throw new Error("record envelope schemaVersion must equal 1");
  if (envelope.owner !== expected.owner) throw new Error("record owner does not match this store");
  if (envelope.projectRoot !== expected.projectRoot) throw new Error("record project root does not match this store");
  if (envelope.runtimeKind !== expected.runtimeKind) throw new Error("record runtime kind does not match this store");
  const run = validateRun(envelope.run);
  return { schemaVersion: 1, owner: expected.owner, projectRoot: expected.projectRoot, runtimeKind: expected.runtimeKind, run };
}

function parseSkillName(skillDraft: string): string {
  const match = skillDraft.match(/^---\n[\s\S]*?^name:\s+([a-z0-9]+(?:-[a-z0-9]+)*)\s*$[\s\S]*?^---\n/m);
  if (!match || match[1].length > 64) throw new Error("Validated skill draft has no safe skill name");
  return match[1];
}

function markdown(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\[\]])/g, "\\$1").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function comparisonMarkdown(run: WorkflowRun): string {
  if (!run.originals || !run.reviews || !run.writerSelection) throw new Error("Draft export requires frozen originals, reviews, and a writer decision");
  const lines = [
    "# Model research comparison",
    "",
    `Evidence as of **${markdown(run.asOfDate)}** for: ${markdown(run.scope === "overall" ? studyScope(run.task) : run.task)}`,
    "",
    "Structural validation preserves these model outputs; it does not independently verify their factual claims or URLs.",
    "",
    ...(run.subjects ? [
      "## Compared subjects", "",
      "These are unverified user-supplied labels, not proof of existence, availability, or capability. They are not execution targets. Evidence subject keys A/B refer to this list.", "",
      "| Subject | Requested model label |", "|---|---|",
      ...run.subjects.map(subject => `| ${subject.key.toUpperCase()} | ${escapeSubjectLabel(subject.model)} |`), "",
      "## Research workers", "",
      "These configured workers produced the reports and reviews; their identities and settings do not describe the compared subjects.", "",
    ] : ["## Compared models", ""]),
    `| ${run.subjects ? "Worker" : "Target"} | Author | Exact model | Hosting / transport | Settings |`, "|---|---|---|---|---|",
    ...run.targets.map(target => `| ${target.key.toUpperCase()} | ${markdown(target.modelAuthor)} | ${markdown(target.model)} | ${markdown(`${target.hostingProvider} / ${target.transport}`)} | ${markdown(JSON.stringify(target.settings))} |`), "",
    "## Research arguments",
    "",
    "| Report | Task | Claim / classification | Evidence URL, access, class, and conditions | Support | Counterevidence | Conditions | Recommendation | Confidence |",
    "|---|---|---|---|---|---|---|---|---:|",
  ];
  for (const key of ["a", "b"] as const) {
    const report = run.originals[key].parsed;
    const evidence = new Map(report.evidence.map((entry) => [entry.id, entry]));
    for (const argument of report.arguments) {
      const sources = argument.evidenceIds.map((id) => {
        const source = evidence.get(id);
        return source ? `${id}: ${source.title}; ${source.url} (accessed ${source.accessedAt}; ${source.sourceAccess}; ${source.evidenceClass}; ${source.conditions}); ${source.excerptOrGap}` : `${id}: missing`;
      }).join("; ");
      lines.push(`| ${key.toUpperCase()} | ${markdown(argument.task)} | ${markdown(argument.claim)} (${markdown(argument.classification)}) | ${markdown(sources)} | ${markdown(argument.support)} | ${markdown(argument.counterevidence)} | ${markdown(argument.conditions)} | ${markdown(argument.recommendation)} | ${argument.confidence} |`);
    }
  }
  lines.push("", "## Reciprocal review", "", "| Reviewer | Usefulness versus own report | Missing evidence | Disagreements | Writer recommendation | Confidence |", "|---|---|---|---|---|---:|");
  for (const key of ["a", "b"] as const) {
    const review = run.reviews[key].parsed;
    const disagreements = review.disagreements.map((item) => `${item.topic}: ${item.position} [${item.evidenceIds.join(", ") || "no cited evidence"}]`).join("; ") || "None recorded";
    lines.push(`| ${key.toUpperCase()} | ${markdown(`${review.usefulnessVsOwn.verdict}: ${review.usefulnessVsOwn.explanation}`)} | ${markdown(review.missingEvidence.join("; ") || "None recorded")} | ${markdown(disagreements)} | ${markdown(`${review.writerRecommendation} [${review.writerEvidenceIds.join(", ") || "no qualifying evidence"}]`)} | ${review.confidence} |`);
  }
  lines.push("", "## Decision", "", `Selected ${run.subjects ? "research worker" : "target"} **${run.writerSelection.target.toUpperCase()}** by **${run.writerSelection.mode}** decision.`, "", markdown(run.writerSelection.rationale), "", `Evidence IDs: ${run.writerSelection.evidenceIds.map(markdown).join(", ") || "none"}`, "");
  if (run.scope === "overall" && run.skillDraft) lines.push(usageSummarySection(run.skillDraft));
  return lines.join("\n");
}

function exportFiles(run: WorkflowRun): Map<string, string> {
  if (!run.skillDraft || !run.originals || !run.reviews || !run.writerSelection) throw new Error("Run is not complete enough to export a draft");
  validateSkillDraft(run.skillDraft, run.asOfDate, run.subjects ?? run.targets, run.scope === "overall", run.subjects ? run.targets : undefined);
  const files = new Map<string, string>([
    ["SKILL.md", run.skillDraft],
    [FIXED_REFERENCE_PATHS[0], run.originals.a.raw],
    [FIXED_REFERENCE_PATHS[1], run.originals.b.raw],
    [FIXED_REFERENCE_PATHS[2], run.reviews.a.raw],
    [FIXED_REFERENCE_PATHS[3], run.reviews.b.raw],
    [FIXED_REFERENCE_PATHS[4], `${JSON.stringify(run.writerSelection, null, 2)}\n`],
    ["comparison.md", comparisonMarkdown(run)],
  ]);
  return files;
}

async function walkRelative(root: string, current = "", output: string[] = []): Promise<string[]> {
  if (output.length > 32) throw new Error("Draft export contains too many entries");
  const directory = current ? join(root, current) : root;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = current ? join(current, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Draft export must not contain symlinks");
    if (entry.isDirectory()) await walkRelative(root, relative, output);
    else if (entry.isFile()) output.push(relative.split(sep).join("/"));
    else throw new Error("Draft export contains a non-regular entry");
  }
  return output;
}

async function inspectExistingExport(outputDir: string, files: Map<string, string>): Promise<void> {
  await existingDirectory(outputDir, "draft output directory");
  const actual = (await walkRelative(outputDir)).sort();
  const expected = [...files.keys()].sort();
  if (stable(actual) !== stable(expected)) throw new Error("Existing draft export is partial or contains unexpected files");
  for (const [relative, content] of files) {
    const actualContent = await safeRead(join(outputDir, relative), Math.max(byteLength(content), 1) + 1);
    if (actualContent !== content) throw new Error(`Existing draft export differs at ${relative}`);
  }
}

export async function createRunStore(options: CreateRunStoreOptions): Promise<RunStore> {
  const owner = validateOwner(options.owner);
  if (!isAbsolute(options.root) || !isAbsolute(options.projectRoot)) throw new Error("Storage and project roots must be absolute paths");
  const projectRoot = await realpath(options.projectRoot);
  await existingDirectory(projectRoot, "project root", false);
  const root = resolve(options.root);
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1_024) throw new Error("maxRecordBytes is invalid");
  if (!Number.isSafeInteger(maxListEntries) || maxListEntries < 1 || maxListEntries > 10_000) throw new Error("maxListEntries is invalid");
  if (options.runtimeKind !== "pi" && options.runtimeKind !== "t3") throw new Error("runtimeKind must be pi or t3");

  await ensurePrivateDirectory(root, "storage root");
  const runsPath = join(root, "runs");
  const locksPath = join(root, "locks");
  await ensurePrivateDirectory(runsPath, "runs directory");
  await ensurePrivateDirectory(locksPath, "locks directory");

  const liveLocks = new Set<RunLock>();
  async function assertLayout(): Promise<void> {
    await existingDirectory(root, "storage root");
    await existingDirectory(runsPath, "runs directory");
    await existingDirectory(locksPath, "locks directory");
    if (await realpath(root) !== root) throw new Error("Storage root must have a canonical non-symlink path");
  }
  await assertLayout();
  const expected = { owner, projectRoot, runtimeKind: options.runtimeKind } as const;
  const recordPath = (runId: string) => join(runsPath, validateRunId(runId), "record.json");

  async function read(runId: string): Promise<RunEnvelope> {
    await assertLayout();
    const validId = validateRunId(runId);
    const runDir = join(runsPath, validId);
    await existingDirectory(runDir, "run directory");
    const raw = await safeRead(recordPath(validId), maxRecordBytes);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`Malformed run record: ${error instanceof Error ? error.message : String(error)}`); }
    const envelope = envelopeValue(parsed, expected);
    if (envelope.run.runId !== validId) throw new Error("Record run ID does not match its directory");
    return envelope;
  }

  async function create(runValue: WorkflowRun): Promise<RunEnvelope> {
    await assertLayout();
    const run = validateRun(runValue);
    const validId = validateRunId(run.runId);
    const runDir = join(runsPath, validId);
    const envelope: RunEnvelope = { schemaVersion: 1, owner, projectRoot, runtimeKind: options.runtimeKind, run: structuredClone(run) };
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (byteLength(serialized) > maxRecordBytes) throw new Error(`Serialized record exceeds ${maxRecordBytes} bytes`);
    let createdDirectory = false;
    try {
      await mkdir(runDir, { mode: PRIVATE_DIR_MODE });
      createdDirectory = true;
      await writeExclusive(recordPath(validId), serialized);
      await syncDirectory(runDir);
      await syncDirectory(runsPath);
    } catch (error) {
      if (createdDirectory) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return envelope;
  }

  function assertLock(lock: RunLock, runId: string): void {
    if (!lock || !liveLocks.has(lock) || lock[LOCK_TOKEN] !== LOCK_TOKEN || lock.runId !== runId || lock.path !== join(locksPath, `${runId}.lock`)) throw new Error("A live matching run lock is required");
  }

  async function acquireRunLock(runId: string): Promise<RunLock> {
    await assertLayout();
    const validId = validateRunId(runId);
    const path = join(locksPath, `${validId}.lock`);
    const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Run ${validId} is locked; stale locks are never stolen automatically`);
      throw error;
    });
    const initial = await handle.stat();
    await handle.writeFile(`${JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    let released = false;
    const lock: RunLock = {
      runId: validId,
      path,
      [LOCK_TOKEN]: LOCK_TOKEN,
      async release() {
        if (released) return;
        released = true;
        liveLocks.delete(lock);
        await handle.close();
        const current = await lstat(path).catch(() => undefined);
        if (!current || current.isSymbolicLink() || !current.isFile() || current.ino !== initial.ino || current.dev !== initial.dev) {
          throw new Error(`Lock ${path} changed before release; refusing to remove it`);
        }
        await unlink(path);
      },
    };
    liveLocks.add(lock);
    return lock;
  }

  async function save(envelopeInput: RunEnvelope, lock: RunLock): Promise<void> {
    const envelope = envelopeValue(envelopeInput, expected);
    assertLock(lock, envelope.run.runId);
    const previous = await read(envelope.run.runId);
    assertMonotonic(previous.run, envelope.run);
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    await atomicReplace(recordPath(envelope.run.runId), serialized, maxRecordBytes);
  }

  async function list(limit = 100): Promise<RunEnvelope[]> {
    await assertLayout();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxListEntries) throw new Error(`List limit must be 1 through ${maxListEntries}`);
    const entries = await readdir(runsPath, { withFileTypes: true });
    if (entries.length > maxListEntries) throw new Error(`Run directory exceeds bounded listing size ${maxListEntries}`);
    const names = entries.map((entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Unexpected non-directory entry in run storage: ${entry.name}`);
      return validateRunId(entry.name);
    }).sort().slice(0, limit);
    const envelopes: RunEnvelope[] = [];
    for (const name of names) envelopes.push(await read(name));
    return envelopes;
  }

  async function withRunLock<T>(runId: string, action: (lock: RunLock) => Promise<T>): Promise<T> {
    const lock = await acquireRunLock(runId);
    let actionError: unknown;
    let failed = false;
    try { return await action(lock); } catch (error) { failed = true; actionError = error; throw error; }
    finally {
      try { await lock.release(); } catch (releaseError) {
        if (failed) throw new AggregateError([actionError, releaseError], `Operation failed: ${actionError instanceof Error ? actionError.message : String(actionError)}; lock cleanup also failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
        throw releaseError;
      }
    }
  }

  async function exportDraft(runId: string, lock: RunLock): Promise<DraftExportResult> {
    const validId = validateRunId(runId);
    assertLock(lock, validId);
    const envelope = await read(validId);
    if (envelope.run.status !== "complete") throw new Error("Only a complete run can be exported");
    const files = exportFiles(envelope.run);
    const skillName = parseSkillName(envelope.run.skillDraft!);
    const draftRoot = join(runsPath, validId, "draft");
    await ensurePrivateDirectory(draftRoot, "draft root");
    const outputDir = join(draftRoot, skillName);
    try {
      const info = await lstat(outputDir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Draft output path is not a real directory");
      await inspectExistingExport(outputDir, files);
      return { outputDir, skillName, created: false, files: [...files.keys()] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const stage = join(draftRoot, `.export-${skillName}-${randomBytes(8).toString("hex")}`);
    await mkdir(stage, { mode: PRIVATE_DIR_MODE });
    try {
      await mkdir(join(stage, "references"), { mode: PRIVATE_DIR_MODE });
      for (const [relative, content] of files) await writeExclusive(join(stage, relative), content);
      await syncDirectory(join(stage, "references"));
      await syncDirectory(stage);
      await rename(stage, outputDir);
      await syncDirectory(draftRoot);
      return { outputDir, skillName, created: true, files: [...files.keys()] };
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        await inspectExistingExport(outputDir, files);
        return { outputDir, skillName, created: false, files: [...files.keys()] };
      }
      throw error;
    }
  }

  return { root, owner, projectRoot, runtimeKind: options.runtimeKind, create, read, save, list, acquireRunLock, withRunLock, exportDraft };
}
