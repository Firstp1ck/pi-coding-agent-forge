import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  MAX_EVIDENCE_CLAIMS,
  MAX_EVIDENCE_COMPACT_CHARS,
  MAX_EVIDENCE_PACKS,
  MAX_EVIDENCE_PASSAGE_CHARS,
  MAX_EVIDENCE_PASSAGES,
  MAX_EVIDENCE_PASSAGES_PER_SOURCE,
  MAX_EVIDENCE_SOURCES,
  evidenceLimits,
  toEvidenceFreshnessPolicy,
  validateReliabilityEvidenceInput,
  type EvidenceReferenceInput,
  type EvidenceSourceInput,
  type ReliabilityEvidenceInput,
} from "./evidence-contracts.ts";
import { statePathFor, taskDir } from "./paths.ts";
import { redactSensitiveText } from "./redaction.ts";
import { createDependencyEvidence, replaceDependencyEvidence } from "./dependency-evidence.ts";
import type {
  EvidenceAssessmentOutcome,
  EvidenceAssessmentSummary,
  EvidenceClaim,
  EvidenceFreshnessStatus,
  EvidencePack,
  EvidencePackSummary,
  EvidenceReference,
  EvidenceRevisionReceipt,
  EvidenceSource,
  EvidenceSourceKind,
  ReliabilityConfig,
  SessionBranchIdentity,
  TaskState,
} from "./types.ts";
import { nowIso } from "./utils.ts";

export type EvidenceAssessment = EvidenceAssessmentSummary & {
  issues: string[];
  unresolved_citation_claim_ids: string[];
  explicit_escalation_claim_ids: string[];
};

export type EvidenceActionResult = {
  action: ReliabilityEvidenceInput["action"];
  pack_id?: string;
  summary?: EvidencePackSummary;
  assessment?: EvidenceAssessment;
  full_pack?: EvidencePack;
};

/** A package-owned receipt observed in the active persisted Pi branch. */
export type EvidenceRevisionBinding = {
  session: SessionBranchIdentity;
  receipt: EvidenceRevisionReceipt;
};

const PACK_ID_PATTERN = /^E[1-9][0-9]*$/;
const SAFE_TASK_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const RELIABILITY_EVIDENCE_REVISION_ENTRY_TYPE = "reliability-evidence-revision";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function lstatIfExists(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function assertPackId(packId: string): void {
  if (!PACK_ID_PATTERN.test(packId)) throw new Error("Evidence pack IDs must be task-local generated IDs such as E1.");
}

function assertTaskSegment(taskId: string): void {
  if (!SAFE_TASK_SEGMENT.test(taskId)) throw new Error("Task identity cannot be used as a safe task-local evidence path.");
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function workspaceRoot(cwd: string): string {
  const root = realpathSync(cwd);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Evidence workspace root must be a real directory, not a symlink.");
  return root;
}

function taskPathSegments(state: TaskState, root: string): string[] {
  assertTaskSegment(state.task_id);
  const taskPath = resolve(taskDir(state.cwd, state.task_id));
  if (!pathIsWithin(root, taskPath)) throw new Error("Evidence task path escaped the workspace root.");
  const segments = relative(root, taskPath).split(/[\\/]+/).filter(Boolean);
  if (segments.length < 3 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Evidence task path is not a safe workspace-local path.");
  }
  return segments;
}

/**
 * Creates each evidence-storage ancestor only after checking every existing
 * ancestor. This prevents recursive mkdir from following a `.pi` or tasks
 * symlink outside the workspace. Read paths pass false and never create it.
 */
function checkedDirectoryChain(root: string, segments: string[], create: boolean): string | undefined {
  let current = root;
  for (const segment of segments) {
    const candidate = join(current, segment);
    if (!pathIsWithin(root, candidate)) throw new Error("Evidence storage path escaped the workspace root.");
    let stat = lstatIfExists(candidate);
    if (!stat) {
      if (!create) return undefined;
      const parentStat = lstatSync(current);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error("Evidence storage ancestor must be a real directory, not a symlink.");
      }
      mkdirSync(candidate, { mode: 0o700 });
      stat = lstatSync(candidate);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Evidence storage ancestor must be a real directory, not a symlink.");
    }
    const canonical = realpathSync(candidate);
    if (!pathIsWithin(root, canonical)) throw new Error("Evidence storage ancestor resolves outside the workspace root.");
    current = canonical;
  }
  return current;
}

function evidenceDirectory(state: TaskState, create = false): string | undefined {
  const root = workspaceRoot(state.cwd);
  return checkedDirectoryChain(root, [...taskPathSegments(state, root), "evidence"], create);
}

export function evidencePackPath(state: TaskState, packId: string, create = false): string {
  assertPackId(packId);
  const directory = evidenceDirectory(state, create);
  if (!directory) throw new Error(`Evidence directory for ${packId} does not exist.`);
  const candidate = resolve(directory, `${packId}.json`);
  if (!pathIsWithin(directory, candidate)) throw new Error("Evidence pack path escaped the task directory.");
  if (lstatIfExists(candidate)?.isSymbolicLink()) {
    throw new Error("Evidence pack path cannot be a symlink.");
  }
  return candidate;
}

function displayEvidencePath(packId: string): string {
  return `evidence/${packId}.json`;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function localLocator(locator: string, cwd: string): string {
  const normalizedInput = locator.replace(/^@/, "");
  const target = resolve(cwd, normalizedInput);
  if (!existsSync(target)) throw new Error("Local evidence locators must point to an existing regular file.");
  // This is metadata validation only. It never reads source content or grants
  // permission to read the source; later tool reads still require scope checks.
  const canonicalTarget = realpathSync(target);
  if (!statSync(canonicalTarget).isFile()) throw new Error("Local evidence locators must point to a regular file.");
  return canonicalTarget;
}

function normalizeLocator(locator: string, cwd: string): string {
  const normalizedInput = locator.replace(/^@/, "");
  try {
    const url = new URL(normalizedInput);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    if (url.username || url.password) throw new Error("credentialed URL");
    return url.toString();
  } catch (error) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalizedInput)) {
      throw new Error(`Evidence locators accept only HTTP(S) URLs or existing local regular files (${error instanceof Error ? error.message : "invalid locator"}).`);
    }
    return localLocator(normalizedInput, cwd);
  }
}

function sourceFromInput(source: EvidenceSourceInput, cwd: string): EvidenceSource {
  return {
    source_id: source.sourceId,
    title: source.title,
    locator: normalizeLocator(source.locator, cwd),
    source_kind: source.sourceKind,
    published_at: source.publishedAt,
    retrieved_at: source.retrievedAt,
    passages: source.passages.map((passage) => ({
      passage_id: passage.passageId,
      // Passage text intentionally remains byte-for-byte as submitted after validation.
      text: passage.text,
      location: passage.location,
    })),
  };
}

function referenceFromInput(reference: EvidenceReferenceInput): EvidenceReference {
  return { source_id: reference.sourceId, passage_ids: [...reference.passageIds] };
}

function sourceIdsForClaim(claim: EvidenceClaim): Set<string> {
  return new Set([...claim.support, ...claim.contradicts].map((reference) => reference.source_id));
}

function referencesResolve(pack: EvidencePack, references: EvidenceReference[]): boolean {
  const sources = new Map(pack.sources.map((source) => [source.source_id, source]));
  return references.every((reference) => {
    const source = sources.get(reference.source_id);
    if (!source || reference.passage_ids.length === 0 || !unique(reference.passage_ids)) return false;
    const passages = new Set(source.passages.map((passage) => passage.passage_id));
    return reference.passage_ids.every((passageId) => passages.has(passageId));
  });
}

function assertReferencesResolve(pack: EvidencePack, references: EvidenceReference[], field: string): void {
  if (!referencesResolve(pack, references)) throw new Error(`${field} references an unregistered source or passage.`);
}

function sourceAndPassageIdsAreUnique(pack: EvidencePack): boolean {
  const sourceIds = pack.sources.map((source) => source.source_id);
  const passageIds = pack.sources.flatMap((source) => source.passages.map((passage) => passage.passage_id));
  return unique(sourceIds) && unique(passageIds);
}

function assertPackLimits(pack: EvidencePack): void {
  const limits = pack.limits;
  if (!isSafeIntegerInRange(limits.max_sources, 1, MAX_EVIDENCE_SOURCES)
    || !isSafeIntegerInRange(limits.max_passages, 1, MAX_EVIDENCE_PASSAGES)
    || limits.max_passages_per_source !== MAX_EVIDENCE_PASSAGES_PER_SOURCE
    || !isSafeIntegerInRange(limits.max_passage_chars, 1, MAX_EVIDENCE_PASSAGE_CHARS)
    || !isSafeIntegerInRange(limits.max_claims, 1, MAX_EVIDENCE_CLAIMS)) {
    throw new Error("Evidence pack has invalid bounded limits.");
  }
  const passageCount = pack.sources.reduce((total, source) => total + source.passages.length, 0);
  if (pack.sources.length > limits.max_sources || passageCount > limits.max_passages || pack.claims.length > limits.max_claims) {
    throw new Error("Evidence pack exceeds its declared limits.");
  }
  if (pack.sources.some((source) => source.passages.length > limits.max_passages_per_source
    || source.passages.some((passage) => passage.text.length > limits.max_passage_chars))) {
    throw new Error("Evidence pack contains oversized passages.");
  }
}

type EvidenceSessionBinding = Required<Pick<EvidencePack, "session_id" | "session_anchor_entry_id">>;

function sessionBindingForMutation(state: TaskState, session: SessionBranchIdentity | undefined): EvidenceSessionBinding | undefined {
  const current = session ?? state.current_session;
  const taskSessionId = state.task_identity.session_id;
  if (current.lifecycle_identity === "unavailable") {
    throw new Error("Evidence mutation requires an available Pi session identity.");
  }
  if (!taskSessionId && !current.session_id && current.lifecycle_identity === undefined) return undefined;
  if (!current.session_id) {
    throw new Error("Evidence mutation requires an available Pi session identity.");
  }
  if (taskSessionId && current.session_id !== taskSessionId) {
    throw new Error("Evidence mutation belongs to a different Pi session.");
  }
  if (state.task_identity.session_anchor_entry_id
    && !current.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id)) {
    throw new Error("Evidence mutation is outside the task's persisted Pi branch.");
  }
  const anchor = current.branch_entry_ids.at(-1);
  if (!anchor) throw new Error("Evidence mutation requires a persisted Pi branch entry.");
  return { session_id: current.session_id, session_anchor_entry_id: anchor };
}

function sessionProvenanceRequired(state: TaskState, session = state.current_session): boolean {
  return Boolean(state.task_identity.session_id || session.session_id || session.lifecycle_identity);
}

function assertEvidenceRevisionBinding(state: TaskState, summary: EvidencePackSummary): void {
  if (!sessionProvenanceRequired(state)) return;
  const current = state.current_session;
  if (current.lifecycle_identity !== "available" || !current.session_id) {
    throw new Error(`Evidence pack ${summary.pack_id} cannot be used while Pi session identity is unavailable.`);
  }
  if (!summary.revision_session_id || !summary.revision_receipt_entry_id) {
    throw new Error(`Evidence pack ${summary.pack_id} has no finalized Pi revision receipt for its current hash.`);
  }
  if (summary.revision_session_id !== current.session_id) {
    throw new Error(`Evidence pack ${summary.pack_id} belongs to a different Pi session revision.`);
  }
  if (state.task_identity.session_id && state.task_identity.session_id !== current.session_id) {
    throw new Error(`Evidence pack ${summary.pack_id} does not match the task's Pi session.`);
  }
  if (state.task_identity.session_anchor_entry_id
    && !current.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id)) {
    throw new Error("Task identity is outside the current persisted Pi branch.");
  }
  if (!current.branch_entry_ids.includes(summary.revision_receipt_entry_id)) {
    throw new Error(`Evidence pack ${summary.pack_id} is outside the current persisted Pi branch revision.`);
  }
  const receipt = current.evidence_revision_receipts?.find((candidate) => candidate.entry_id === summary.revision_receipt_entry_id);
  if (!receipt
    || receipt.task_id !== state.task_id
    || receipt.pack_id !== summary.pack_id
    || receipt.sha256 !== summary.sha256) {
    throw new Error(`Evidence pack ${summary.pack_id} has no attributable persisted Pi receipt for its current hash.`);
  }
}

function assertPackSessionBinding(state: TaskState, pack: EvidencePack): void {
  if (!pack.session_id && !pack.session_anchor_entry_id) return;
  if (!pack.session_id || !pack.session_anchor_entry_id) throw new Error(`Evidence pack ${pack.pack_id} has incomplete Pi session provenance.`);
  const current = state.current_session;
  if (current.lifecycle_identity === "unavailable" || current.session_id !== pack.session_id) {
    throw new Error(`Evidence pack ${pack.pack_id} belongs to a different or unavailable Pi session.`);
  }
  if (!current.branch_entry_ids.includes(pack.session_anchor_entry_id)) {
    throw new Error(`Evidence pack ${pack.pack_id} is outside the current persisted Pi branch.`);
  }
}

/** Validates persisted pack structure before it can influence a completion guard. */
export function validateEvidencePack(value: unknown): EvidencePack {
  if (!isRecord(value) || value.schema_version !== 1) throw new Error("Evidence pack has an unsupported schema.");
  const pack = value as unknown as EvidencePack;
  assertPackId(pack.pack_id);
  assertTaskSegment(pack.task_id);
  if (!isNonEmptyString(pack.branch_id) || !isNonEmptyString(pack.question) || !isStringArray(pack.requirements)
    || !Array.isArray(pack.sources) || !Array.isArray(pack.claims) || (pack.dependencies !== undefined && !Array.isArray(pack.dependencies))
    || !isNonEmptyString(pack.created_at) || !isNonEmptyString(pack.updated_at)
    || (pack.session_id === undefined) !== (pack.session_anchor_entry_id === undefined)
    || (pack.session_id !== undefined && !isNonEmptyString(pack.session_id))
    || (pack.session_anchor_entry_id !== undefined && !isNonEmptyString(pack.session_anchor_entry_id))) {
    throw new Error("Evidence pack is structurally incomplete.");
  }
  validateReliabilityEvidenceInput({
    action: "start",
    question: pack.question,
    requirements: pack.requirements,
    maxSources: pack.limits?.max_sources,
    maxPassages: pack.limits?.max_passages,
    freshness: pack.freshness && { maxAgeDays: pack.freshness.max_age_days, basis: pack.freshness.basis },
  }, new Date("9999-12-31T23:59:59.999Z"));
  assertPackLimits(pack);
  for (const source of pack.sources) {
    validateReliabilityEvidenceInput({
      action: "add-source",
      packId: pack.pack_id,
      sourceId: source.source_id,
      title: source.title,
      locator: source.locator,
      sourceKind: source.source_kind,
      publishedAt: source.published_at,
      retrievedAt: source.retrieved_at,
      passages: source.passages.map((passage) => ({ passageId: passage.passage_id, text: passage.text, location: passage.location })),
    }, new Date("9999-12-31T23:59:59.999Z"));
  }
  if (!sourceAndPassageIdsAreUnique(pack)) throw new Error("Evidence pack contains duplicate source or passage IDs.");
  for (const dependency of pack.dependencies ?? []) {
    validateReliabilityEvidenceInput({
      action: "record-dependency",
      packId: pack.pack_id,
      package: dependency.package_name,
      installedVersion: dependency.installed_version,
      manifestPath: dependency.manifest_path,
      lockfilePath: dependency.lockfile_path,
      sourceKind: dependency.source_kind,
      sourceId: dependency.source_id,
      passageIds: dependency.passage_ids,
      featureFlags: dependency.feature_flags,
    });
    if (!referencesResolve(pack, [{ source_id: dependency.source_id, passage_ids: dependency.passage_ids }])) {
      throw new Error(`Dependency ${dependency.package_name} references an unregistered source or passage.`);
    }
  }
  for (const claim of pack.claims) {
    validateReliabilityEvidenceInput({
      action: "add-claim",
      packId: pack.pack_id,
      claimId: claim.claim_id,
      claim: claim.claim,
      material: claim.material,
      support: claim.support.map((reference) => ({ sourceId: reference.source_id, passageIds: reference.passage_ids })),
      contradicts: claim.contradicts.map((reference) => ({ sourceId: reference.source_id, passageIds: reference.passage_ids })),
    }, new Date("9999-12-31T23:59:59.999Z"));
    assertReferencesResolve(pack, claim.support, `Claim ${claim.claim_id} support`);
    assertReferencesResolve(pack, claim.contradicts, `Claim ${claim.claim_id} contradictions`);
    if (claim.conflict_disposition) {
      validateReliabilityEvidenceInput({
        action: "disposition-conflict",
        packId: pack.pack_id,
        claimId: claim.claim_id,
        disposition: claim.conflict_disposition.disposition,
        rationale: claim.conflict_disposition.rationale,
        preferredSourceIds: claim.conflict_disposition.preferred_source_ids,
      });
      if (claim.contradicts.length === 0) throw new Error(`Claim ${claim.claim_id} disposes a conflict that was never recorded.`);
      const availableSourceIds = sourceIdsForClaim(claim);
      if (claim.conflict_disposition.preferred_source_ids?.some((sourceId) => !availableSourceIds.has(sourceId))) {
        throw new Error(`Claim ${claim.claim_id} prefers a source not cited by the claim.`);
      }
    }
  }
  if (!unique(pack.claims.map((claim) => claim.claim_id))) throw new Error("Evidence pack contains duplicate claim IDs.");
  return pack;
}

export function isEvidencePack(value: unknown): value is EvidencePack {
  try {
    validateEvidencePack(value);
    return true;
  } catch {
    return false;
  }
}

function summarizePack(
  pack: EvidencePack,
  contentHash: string,
  assessment?: EvidenceAssessment,
  revision?: Pick<EvidencePackSummary, "revision_session_id" | "revision_receipt_entry_id">,
): EvidencePackSummary {
  return {
    pack_id: pack.pack_id,
    task_id: pack.task_id,
    branch_id: pack.branch_id,
    session_id: pack.session_id,
    session_anchor_entry_id: pack.session_anchor_entry_id,
    revision_session_id: revision?.revision_session_id,
    revision_receipt_entry_id: revision?.revision_receipt_entry_id,
    question: pack.question,
    evidence_path: displayEvidencePath(pack.pack_id),
    sha256: contentHash,
    source_count: pack.sources.length,
    passage_count: pack.sources.reduce((total, source) => total + source.passages.length, 0),
    claim_count: pack.claims.length,
    freshness: pack.freshness && { ...pack.freshness },
    assessment: assessment && {
      outcome: assessment.outcome,
      integrity_passed: assessment.integrity_passed,
      semantic_review_required: assessment.semantic_review_required,
      freshness_status: assessment.freshness_status,
      unresolved_conflict_claim_ids: [...assessment.unresolved_conflict_claim_ids],
      unsupported_material_claim_ids: [...assessment.unsupported_material_claim_ids],
      issue_count: assessment.issue_count,
      assessed_at: assessment.assessed_at,
    },
    created_at: pack.created_at,
    updated_at: pack.updated_at,
  };
}

function writePackAtomically(state: TaskState, pack: EvidencePack): string {
  const path = evidencePackPath(state, pack.pack_id, true);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(pack, null, 2)}\n`;
  const expectedHash = sha256(serialized);
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    const prepared = readFileSync(temporaryPath, "utf8");
    validateEvidencePack(JSON.parse(prepared));
    if (sha256(prepared) !== expectedHash) throw new Error("Evidence pack temporary-write verification failed.");
    renameSync(temporaryPath, path);
    const committed = readFileSync(path, "utf8");
    const reopened = validateEvidencePack(JSON.parse(committed));
    if (reopened.pack_id !== pack.pack_id || sha256(committed) !== expectedHash) {
      throw new Error("Evidence pack commit verification failed.");
    }
    return expectedHash;
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

type EvidenceTransactionJournal = {
  schema_version: 1;
  task_id: string;
  pack_id: string;
  previous_summary_sha256?: string;
  previous_pack_base64?: string;
};

export class EvidenceTransactionError extends Error {
  constructor(message: string, readonly state_committed: boolean, readonly cause?: unknown) {
    super(message);
    this.name = "EvidenceTransactionError";
  }
}

function transactionPath(state: TaskState, packId: string, create: boolean): string {
  const packPath = evidencePackPath(state, packId, create);
  const path = `${packPath}.transaction.json`;
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Evidence transaction journal cannot be a symlink.");
  return path;
}

function writeBytesAtomically(path: string, bytes: string): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, bytes, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function prepareEvidenceTransaction(state: TaskState, packId: string): EvidenceTransactionJournal {
  const packPath = evidencePackPath(state, packId, true);
  const summary = state.evidence_packs.find((candidate) => candidate.pack_id === packId);
  const existing = existsSync(packPath) ? readFileSync(packPath, "utf8") : undefined;
  if (summary && (!existing || sha256(existing) !== summary.sha256)) {
    throw new Error(`Evidence pack ${packId} cannot begin a transaction because its current hash is not authoritative.`);
  }
  if (!summary && existing) throw new Error(`Evidence pack ${packId} already exists without an authoritative task-state summary.`);
  const journal: EvidenceTransactionJournal = {
    schema_version: 1,
    task_id: state.task_id,
    pack_id: packId,
    previous_summary_sha256: summary?.sha256,
    previous_pack_base64: existing === undefined ? undefined : Buffer.from(existing, "utf8").toString("base64"),
  };
  writeBytesAtomically(transactionPath(state, packId, true), `${JSON.stringify(journal)}\n`);
  return journal;
}

function parseEvidenceTransaction(state: TaskState, packId: string): EvidenceTransactionJournal | undefined {
  const directory = evidenceDirectory(state, false);
  if (!directory) return undefined;
  const path = resolve(directory, `${packId}.json.transaction.json`);
  if (!pathIsWithin(directory, path)) throw new Error("Evidence transaction path escaped the task directory.");
  if (!existsSync(path)) return undefined;
  if (lstatSync(path).isSymbolicLink()) throw new Error("Evidence transaction journal cannot be a symlink.");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<EvidenceTransactionJournal>;
  if (value.schema_version !== 1 || value.task_id !== state.task_id || value.pack_id !== packId
    || (value.previous_summary_sha256 !== undefined && !SHA256_PATTERN.test(value.previous_summary_sha256))
    || (value.previous_pack_base64 !== undefined && typeof value.previous_pack_base64 !== "string")) {
    throw new Error(`Evidence transaction journal for ${packId} is malformed.`);
  }
  return value as EvidenceTransactionJournal;
}

function durableSummaryForPack(state: TaskState, packId: string): EvidencePackSummary | undefined {
  const path = statePathFor(state.cwd, state.task_id);
  if (!existsSync(path)) return undefined;
  try {
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { evidence_packs?: EvidencePackSummary[] };
    const summary = persisted.evidence_packs?.find((candidate) => candidate.pack_id === packId);
    return summary && typeof summary.sha256 === "string" ? summary : undefined;
  } catch {
    return undefined;
  }
}

function durableSummaryHash(state: TaskState, packId: string): string | undefined {
  return durableSummaryForPack(state, packId)?.sha256;
}

function durableSummaryMatches(state: TaskState, summary: EvidencePackSummary): boolean {
  const persisted = durableSummaryForPack(state, summary.pack_id);
  return persisted !== undefined && JSON.stringify(persisted) === JSON.stringify(summary);
}

function rollbackEvidenceTransaction(state: TaskState, packId: string, journal: EvidenceTransactionJournal): void {
  const packPath = evidencePackPath(state, packId, true);
  if (journal.previous_pack_base64 === undefined) {
    if (existsSync(packPath)) unlinkSync(packPath);
  } else {
    const previous = Buffer.from(journal.previous_pack_base64, "base64").toString("utf8");
    if (sha256(previous) !== journal.previous_summary_sha256) throw new Error(`Evidence transaction journal for ${packId} has an invalid prior hash.`);
    writeBytesAtomically(packPath, previous);
  }
  const journalPath = transactionPath(state, packId, true);
  if (existsSync(journalPath)) unlinkSync(journalPath);
}

/** Resolves a leftover transaction without creating absent evidence directories. */
export function recoverEvidenceTransaction(state: TaskState, packId: string): void {
  const journal = parseEvidenceTransaction(state, packId);
  if (!journal) return;
  const persistedHash = durableSummaryHash(state, packId);
  const packPath = evidencePackPath(state, packId, false);
  const currentHash = existsSync(packPath) ? sha256(readFileSync(packPath, "utf8")) : undefined;
  const journalPath = transactionPath(state, packId, false);
  if (persistedHash && persistedHash === currentHash) {
    unlinkSync(journalPath);
    return;
  }
  if (persistedHash !== journal.previous_summary_sha256) {
    throw new Error(`Evidence transaction for ${packId} requires recovery because persisted state and pack revisions disagree.`);
  }
  rollbackEvidenceTransaction(state, packId, journal);
}

function summaryForPack(state: TaskState, packId: string): EvidencePackSummary {
  assertPackId(packId);
  const summary = state.evidence_packs.find((candidate) => candidate.pack_id === packId);
  if (!summary) throw new Error(`Evidence pack ${packId} does not belong to this task.`);
  if (summary.task_id !== state.task_id || summary.branch_id !== state.task_identity.branch_id
    || (summary.session_id === undefined) !== (summary.session_anchor_entry_id === undefined)
    || (summary.revision_session_id === undefined) !== (summary.revision_receipt_entry_id === undefined)
    || summary.evidence_path !== displayEvidencePath(packId) || !SHA256_PATTERN.test(summary.sha256)) {
    throw new Error(`Evidence pack ${packId} has invalid task-local provenance.`);
  }
  return summary;
}

export function readEvidencePack(state: TaskState, packId: string): EvidencePack {
  recoverEvidenceTransaction(state, packId);
  const summary = summaryForPack(state, packId);
  const path = evidencePackPath(state, packId);
  if (!existsSync(path)) throw new Error(`Evidence pack ${packId} is missing from its task-local storage.`);
  const raw = readFileSync(path, "utf8");
  if (sha256(raw) !== summary.sha256) throw new Error(`Evidence pack ${packId} hash does not match task state.`);
  const pack = validateEvidencePack(JSON.parse(raw));
  if (pack.pack_id !== packId || pack.task_id !== state.task_id || pack.branch_id !== state.task_identity.branch_id
    || pack.session_id !== summary.session_id || pack.session_anchor_entry_id !== summary.session_anchor_entry_id) {
    throw new Error(`Evidence pack ${packId} belongs to another task, Pi session, or branch.`);
  }
  assertEvidenceRevisionBinding(state, summary);
  assertPackSessionBinding(state, pack);
  return pack;
}

function replaceSummary(state: TaskState, summary: EvidencePackSummary): void {
  const index = state.evidence_packs.findIndex((candidate) => candidate.pack_id === summary.pack_id);
  if (index < 0) state.evidence_packs.push(summary);
  else state.evidence_packs[index] = summary;
}

function configLimits(input: Extract<ReliabilityEvidenceInput, { action: "start" }>, config: ReliabilityConfig) {
  const maxSources = input.maxSources ?? config.retrieval.maxSources;
  const maxPassages = input.maxPassages ?? config.retrieval.maxPassages;
  if (maxSources > config.retrieval.maxSources || maxPassages > config.retrieval.maxPassages) {
    throw new Error("Evidence pack limits cannot exceed the trusted project retrieval policy.");
  }
  return evidenceLimits(maxSources, maxPassages, config.retrieval.maxPassageChars, config.retrieval.maxClaims);
}

function createPack(
  state: TaskState,
  input: Extract<ReliabilityEvidenceInput, { action: "start" }>,
  config: ReliabilityConfig,
  timestamp: string,
  session: SessionBranchIdentity | undefined,
): EvidencePack {
  if (state.evidence_packs.length >= MAX_EVIDENCE_PACKS) throw new Error(`A task can retain at most ${MAX_EVIDENCE_PACKS} evidence packs.`);
  const packId = `E${state.id_counters.next_evidence_pack}`;
  assertPackId(packId);
  const binding = sessionBindingForMutation(state, session);
  return {
    schema_version: 1,
    pack_id: packId,
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    session_id: binding?.session_id,
    session_anchor_entry_id: binding?.session_anchor_entry_id,
    question: input.question,
    requirements: input.requirements ? [...input.requirements] : [],
    limits: configLimits(input, config),
    freshness: toEvidenceFreshnessPolicy(input.freshness),
    sources: [],
    claims: [],
    dependencies: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function saveRevisedPack(state: TaskState, pack: EvidencePack, assessment?: EvidenceAssessment): EvidencePackSummary {
  validateEvidencePack(pack);
  const hash = writePackAtomically(state, pack);
  const summary = summarizePack(pack, hash, assessment);
  replaceSummary(state, summary);
  return summary;
}

function addSource(state: TaskState, pack: EvidencePack, source: EvidenceSourceInput, timestamp: string): EvidencePackSummary {
  if (pack.sources.some((candidate) => candidate.source_id === source.sourceId)) throw new Error(`Source ID ${source.sourceId} already exists in evidence pack ${pack.pack_id}.`);
  if (pack.sources.length + 1 > pack.limits.max_sources) throw new Error("Evidence pack source limit would be exceeded.");
  const existingPassageIds = new Set(pack.sources.flatMap((candidate) => candidate.passages.map((passage) => passage.passage_id)));
  if (source.passages.some((passage) => existingPassageIds.has(passage.passageId))) throw new Error("Evidence passage IDs must be unique within a pack.");
  const passageCount = pack.sources.reduce((total, candidate) => total + candidate.passages.length, 0) + source.passages.length;
  if (passageCount > pack.limits.max_passages) throw new Error("Evidence pack passage limit would be exceeded.");
  if (source.passages.some((passage) => passage.text.length > pack.limits.max_passage_chars)) throw new Error("Evidence passage exceeds this pack's configured character limit.");
  const next = structuredClone(pack);
  next.sources.push(sourceFromInput(source, state.cwd));
  next.updated_at = timestamp;
  return saveRevisedPack(state, next);
}

function addClaim(state: TaskState, pack: EvidencePack, input: Extract<ReliabilityEvidenceInput, { action: "add-claim" }>, timestamp: string): EvidencePackSummary {
  if (pack.claims.some((candidate) => candidate.claim_id === input.claimId)) throw new Error(`Claim ID ${input.claimId} already exists in evidence pack ${pack.pack_id}.`);
  if (pack.claims.length + 1 > pack.limits.max_claims) throw new Error("Evidence pack claim limit would be exceeded.");
  const support = input.support.map(referenceFromInput);
  const contradicts = (input.contradicts ?? []).map(referenceFromInput);
  assertReferencesResolve(pack, support, "Claim support");
  assertReferencesResolve(pack, contradicts, "Claim contradictions");
  const next = structuredClone(pack);
  next.claims.push({
    claim_id: input.claimId,
    claim: input.claim,
    material: input.material,
    support,
    contradicts,
  });
  next.updated_at = timestamp;
  return saveRevisedPack(state, next);
}

function recordDependency(state: TaskState, pack: EvidencePack, input: Extract<ReliabilityEvidenceInput, { action: "record-dependency" }>, timestamp: string): EvidencePackSummary {
  const dependency = createDependencyEvidence(state, pack, input, timestamp);
  const next = structuredClone(pack);
  next.dependencies ??= [];
  const index = next.dependencies.findIndex((candidate) => candidate.package_name === dependency.package_name);
  if (index >= 0) next.dependencies[index] = dependency;
  else next.dependencies.push(dependency);
  if (next.dependencies.length > 24) throw new Error("Evidence packs may retain at most 24 dependency records.");
  next.updated_at = timestamp;
  const summary = saveRevisedPack(state, next);
  replaceDependencyEvidence(state, dependency);
  return summary;
}

function dispositionConflict(state: TaskState, pack: EvidencePack, input: Extract<ReliabilityEvidenceInput, { action: "disposition-conflict" }>, timestamp: string): EvidencePackSummary {
  const claim = pack.claims.find((candidate) => candidate.claim_id === input.claimId);
  if (!claim) throw new Error(`Claim ${input.claimId} does not belong to evidence pack ${pack.pack_id}.`);
  if (claim.contradicts.length === 0) throw new Error(`Claim ${input.claimId} has no recorded conflict to disposition.`);
  const preferredSourceIds = input.preferredSourceIds ? [...input.preferredSourceIds] : undefined;
  const citedSourceIds = sourceIdsForClaim(claim);
  if (preferredSourceIds?.some((sourceId) => !citedSourceIds.has(sourceId))) {
    throw new Error("preferredSourceIds must reference sources already cited by the conflicting claim.");
  }
  const next = structuredClone(pack);
  const nextClaim = next.claims.find((candidate) => candidate.claim_id === input.claimId);
  if (!nextClaim) throw new Error("Evidence claim disappeared during conflict disposition.");
  nextClaim.conflict_disposition = {
    disposition: input.disposition,
    rationale: input.rationale,
    preferred_source_ids: preferredSourceIds,
    disposed_at: timestamp,
  };
  next.updated_at = timestamp;
  return saveRevisedPack(state, next);
}

function compactIssue(value: string): string {
  return redactSensitiveText(value).slice(0, 240);
}

function includedMaterialClaim(claim: EvidenceClaim): boolean {
  return claim.material && claim.conflict_disposition?.disposition !== "exclude-claim";
}

export function assessEvidencePack(pack: EvidencePack, clock = new Date()): EvidenceAssessment {
  const issues: string[] = [];
  const unresolvedCitationClaimIds: string[] = [];
  const unsupportedMaterialClaimIds: string[] = [];
  const unresolvedConflictClaimIds: string[] = [];
  const explicitEscalationClaimIds: string[] = [];
  let hasReportedConflict = false;

  try {
    validateEvidencePack(pack);
  } catch (error) {
    return {
      outcome: "insufficient",
      integrity_passed: false,
      semantic_review_required: true,
      freshness_status: "unknown",
      unresolved_conflict_claim_ids: [],
      unsupported_material_claim_ids: [],
      issue_count: 1,
      assessed_at: clock.toISOString(),
      issues: [compactIssue(`Evidence pack is malformed: ${error instanceof Error ? error.message : String(error)}`)],
      unresolved_citation_claim_ids: [],
      explicit_escalation_claim_ids: [],
    };
  }

  const materialClaims = pack.claims.filter(includedMaterialClaim);
  if (materialClaims.length === 0) {
    issues.push("No included material claim was recorded for the evidence pack.");
  }
  for (const claim of pack.claims) {
    const supportResolves = referencesResolve(pack, claim.support);
    const contradictionsResolve = referencesResolve(pack, claim.contradicts);
    if (!supportResolves || !contradictionsResolve) {
      unresolvedCitationClaimIds.push(claim.claim_id);
      issues.push(`Claim ${claim.claim_id} cites an unresolved source or passage.`);
    }
    if (includedMaterialClaim(claim) && (claim.support.length === 0 || !supportResolves)) {
      unsupportedMaterialClaimIds.push(claim.claim_id);
      issues.push(`Material claim ${claim.claim_id} has no resolved supporting passage.`);
    }
    if (claim.contradicts.length > 0) {
      if (!claim.conflict_disposition) {
        unresolvedConflictClaimIds.push(claim.claim_id);
        issues.push(`Claim ${claim.claim_id} has an undispositioned conflict.`);
      } else if (claim.conflict_disposition.disposition === "escalate") {
        explicitEscalationClaimIds.push(claim.claim_id);
        issues.push(`Claim ${claim.claim_id} explicitly requires escalation for its conflict.`);
      } else if (claim.conflict_disposition.disposition === "report-conflict") {
        hasReportedConflict = true;
      }
    }
  }
  if (materialClaims.length === 0) issues.push("Retrieval coverage is insufficient without an included material claim.");

  let freshnessStatus: EvidenceFreshnessStatus = "not-constrained";
  if (pack.freshness) {
    freshnessStatus = "fresh";
    const referencedSourceIds = new Set<string>();
    for (const claim of materialClaims) {
      for (const sourceId of sourceIdsForClaim(claim)) referencedSourceIds.add(sourceId);
    }
    const sourceById = new Map(pack.sources.map((source) => [source.source_id, source]));
    for (const sourceId of referencedSourceIds) {
      const source = sourceById.get(sourceId);
      const basisValue = pack.freshness.basis === "publishedAt" ? source?.published_at : source?.retrieved_at;
      if (!basisValue || !Number.isFinite(Date.parse(basisValue))) {
        if (freshnessStatus !== "stale") freshnessStatus = "unknown";
        issues.push(`Source ${sourceId} lacks the required ${pack.freshness.basis} freshness date.`);
        continue;
      }
      const ageMs = clock.getTime() - Date.parse(basisValue);
      if (ageMs < 0) {
        if (freshnessStatus !== "stale") freshnessStatus = "unknown";
        issues.push(`Source ${sourceId} has a freshness date later than the assessment clock.`);
      } else if (ageMs > pack.freshness.max_age_days * 24 * 60 * 60 * 1_000) {
        freshnessStatus = "stale";
        issues.push(`Source ${sourceId} exceeds the ${pack.freshness.max_age_days}-day freshness policy.`);
      }
    }
  }

  const integrityPassed = unresolvedCitationClaimIds.length === 0
    && unsupportedMaterialClaimIds.length === 0
    && materialClaims.length > 0;
  const outcome: EvidenceAssessmentOutcome = !integrityPassed
    ? "insufficient"
    : unresolvedConflictClaimIds.length > 0 || explicitEscalationClaimIds.length > 0 || hasReportedConflict
      ? "conflicting"
      : freshnessStatus === "fresh" || freshnessStatus === "unknown" || freshnessStatus === "stale"
        ? freshnessStatus === "fresh" ? "supported" : "partial"
        : "supported";
  return {
    outcome,
    integrity_passed: integrityPassed,
    semantic_review_required: true,
    freshness_status: freshnessStatus,
    unresolved_conflict_claim_ids: unresolvedConflictClaimIds,
    unsupported_material_claim_ids: unsupportedMaterialClaimIds,
    issue_count: issues.length,
    assessed_at: clock.toISOString(),
    issues: issues.map(compactIssue),
    unresolved_citation_claim_ids: unresolvedCitationClaimIds,
    explicit_escalation_claim_ids: explicitEscalationClaimIds,
  };
}

function assessAndPersistSummary(state: TaskState, pack: EvidencePack, assessment: EvidenceAssessment): EvidencePackSummary {
  const raw = readFileSync(evidencePackPath(state, pack.pack_id), "utf8");
  const existing = summaryForPack(state, pack.pack_id);
  const summary = summarizePack(pack, sha256(raw), assessment, existing);
  replaceSummary(state, summary);
  return summary;
}

/**
 * Applies one revalidated evidence action. The caller owns the surrounding
 * state.json save; invalid actions perform no state or pack write.
 */
export type EvidenceActionOptions = {
  now?: Date;
  session?: SessionBranchIdentity;
};

export type EvidenceTransactionOptions = EvidenceActionOptions & {
  /** Appends and re-reads a package-owned Pi receipt after the pack hash exists. */
  finalizeRevision?: (result: EvidenceActionResult) => EvidenceRevisionBinding;
};

function bindEvidenceRevision(
  state: TaskState,
  result: EvidenceActionResult,
  binding: EvidenceRevisionBinding,
): void {
  const summary = result.summary;
  if (!summary || !result.pack_id || summary.pack_id !== result.pack_id) {
    throw new Error("Evidence revision receipt requires an authoritative pack summary.");
  }
  const { receipt, session } = binding;
  if (session.lifecycle_identity !== "available" || !session.session_id) {
    throw new Error(`Evidence pack ${summary.pack_id} could not finalize its Pi revision receipt without an available session identity.`);
  }
  if (receipt.task_id !== state.task_id
    || receipt.pack_id !== summary.pack_id
    || receipt.sha256 !== summary.sha256
    || receipt.action !== result.action
    || !session.branch_entry_ids.includes(receipt.entry_id)
    || !session.evidence_revision_receipts?.some((candidate) => candidate.entry_id === receipt.entry_id
      && candidate.task_id === receipt.task_id
      && candidate.pack_id === receipt.pack_id
      && candidate.sha256 === receipt.sha256
      && candidate.action === receipt.action)) {
    throw new Error(`Evidence pack ${summary.pack_id} received an invalid finalized Pi revision receipt.`);
  }
  if (state.task_identity.session_id && state.task_identity.session_id !== session.session_id) {
    throw new Error(`Evidence pack ${summary.pack_id} cannot be committed from a different Pi session.`);
  }
  summary.revision_session_id = session.session_id;
  summary.revision_receipt_entry_id = receipt.entry_id;
  state.current_session = session;
}

export function applyReliabilityEvidenceAction(
  state: TaskState,
  input: unknown,
  config: ReliabilityConfig,
  options: EvidenceActionOptions = {},
): EvidenceActionResult {
  const clock = options.now ?? new Date();
  const action = validateReliabilityEvidenceInput(input, clock);
  const timestamp = clock.toISOString();
  if (action.action === "start") {
    const pack = createPack(state, action, config, timestamp, options.session);
    const summary = saveRevisedPack(state, pack);
    state.id_counters.next_evidence_pack += 1;
    state.active_evidence_pack_id = pack.pack_id;
    state.lane = "retrieval";
    return { action: action.action, pack_id: pack.pack_id, summary, full_pack: pack };
  }

  const pack = readEvidencePack(state, action.packId);
  if (action.action === "add-source") {
    const summary = addSource(state, pack, action.source, timestamp);
    return { action: action.action, pack_id: pack.pack_id, summary };
  }
  if (action.action === "add-claim") {
    const summary = addClaim(state, pack, action, timestamp);
    return { action: action.action, pack_id: pack.pack_id, summary };
  }
  if (action.action === "disposition-conflict") {
    const summary = dispositionConflict(state, pack, action, timestamp);
    return { action: action.action, pack_id: pack.pack_id, summary };
  }
  if (action.action === "record-dependency") {
    const summary = recordDependency(state, pack, action, timestamp);
    return { action: action.action, pack_id: pack.pack_id, summary };
  }
  const assessment = assessEvidencePack(pack, clock);
  const summary = assessAndPersistSummary(state, pack, assessment);
  return {
    action: action.action,
    pack_id: pack.pack_id,
    summary,
    assessment,
    full_pack: action.action === "get" && action.view === "full" ? pack : undefined,
  };
}

/**
 * Coordinates an evidence-pack replacement with its task-state summary. The
 * canonical E<n>.json name remains stable; a bounded journal restores the
 * prior pack when state persistence fails before commit and resolves a crash
 * on the next read without creating absent directories.
 */
export function executeReliabilityEvidenceTransaction(
  state: TaskState,
  input: unknown,
  config: ReliabilityConfig,
  commitState: (result: EvidenceActionResult) => void,
  options: EvidenceTransactionOptions = {},
): EvidenceActionResult {
  const clock = options.now ?? new Date();
  const action = validateReliabilityEvidenceInput(input, clock);
  const packId = action.action === "start" ? `E${state.id_counters.next_evidence_pack}` : action.packId;
  if (sessionProvenanceRequired(state, options.session) && !options.finalizeRevision) {
    throw new Error(`Evidence transaction for ${packId} requires a finalized Pi revision receipt.`);
  }
  recoverEvidenceTransaction(state, packId);
  const before = structuredClone(state);
  const journal = prepareEvidenceTransaction(state, packId);
  let expectedSummary: EvidencePackSummary | undefined;
  try {
    const result = applyReliabilityEvidenceAction(state, input, config, { ...options, now: clock });
    const expectedHash = result.summary?.sha256;
    if (!expectedHash) throw new Error(`Evidence action ${result.action} did not produce an authoritative summary.`);
    if (options.finalizeRevision) bindEvidenceRevision(state, result, options.finalizeRevision(result));
    expectedSummary = result.summary;
    const committedSummary = expectedSummary;
    if (!committedSummary) throw new Error(`Evidence action ${result.action} did not produce an authoritative summary.`);
    commitState(result);
    if (!durableSummaryMatches(state, committedSummary)) {
      throw new Error(`Evidence transaction for ${packId} did not persist its task-state summary.`);
    }
    const journalPath = transactionPath(state, packId, false);
    if (existsSync(journalPath)) unlinkSync(journalPath);
    return result;
  } catch (error) {
    if (expectedSummary && durableSummaryMatches(state, expectedSummary)) {
      const journalPath = transactionPath(state, packId, false);
      if (existsSync(journalPath)) unlinkSync(journalPath);
      throw new EvidenceTransactionError(
        `Evidence transaction for ${packId} committed task state before a later persistence error: ${error instanceof Error ? error.message : String(error)}`,
        true,
        error,
      );
    }
    try {
      rollbackEvidenceTransaction(state, packId, journal);
    } catch (rollbackError) {
      throw new EvidenceTransactionError(
        `Evidence transaction for ${packId} could not restore its prior pack after state persistence failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        false,
        error,
      );
    }
    Object.assign(state, before);
    throw error;
  }
}

function appendBounded(lines: string[], line: string, maxChars: number): boolean {
  const nextLength = lines.reduce((total, item) => total + item.length + 1, 0) + line.length + 1;
  if (nextLength > maxChars) return false;
  lines.push(line);
  return true;
}

export function formatEvidenceContextSummary(state: TaskState, maxChars = 1_600): string {
  const limit = Math.max(300, Math.min(MAX_EVIDENCE_COMPACT_CHARS, maxChars));
  if (state.evidence_packs.length === 0) return "Evidence: no active evidence pack.";
  const lines = ["Evidence packs:"];
  for (const summary of state.evidence_packs) {
    const assessment = summary.assessment;
    const status = assessment
      ? `${assessment.outcome}; integrity=${assessment.integrity_passed ? "ok" : "blocked"}; freshness=${assessment.freshness_status}`
      : "not assessed";
    const line = `- ${summary.pack_id}: ${redactSensitiveText(summary.question).slice(0, 180)} (${summary.source_count} sources, ${summary.passage_count} passages, ${summary.claim_count} claims; ${status})`;
    if (!appendBounded(lines, line, limit)) {
      appendBounded(lines, "- [Evidence summary truncated; inspect the active pack by ID.]", limit);
      break;
    }
  }
  if (state.active_evidence_pack_id) appendBounded(lines, `Active evidence pack: ${state.active_evidence_pack_id}`, limit);
  return lines.join("\n");
}

export function formatEvidenceActionResult(result: EvidenceActionResult, view: "compact" | "full" = "compact"): string {
  if (!result.pack_id) return "No evidence pack was changed.";
  const summary = result.summary;
  const lines = [`Evidence action ${result.action} completed for ${result.pack_id}.`];
  if (summary) {
    const assessment = summary.assessment;
    lines.push(`Sources: ${summary.source_count}; passages: ${summary.passage_count}; claims: ${summary.claim_count}.`);
    if (assessment) {
      lines.push(`Assessment: ${assessment.outcome}; citation integrity ${assessment.integrity_passed ? "passed" : "failed"}; freshness ${assessment.freshness_status}; semantic review required.`);
      if (assessment.unresolved_conflict_claim_ids.length) lines.push(`Undispositioned conflicts: ${assessment.unresolved_conflict_claim_ids.join(", ")}.`);
      if (assessment.unsupported_material_claim_ids.length) lines.push(`Unsupported material claims: ${assessment.unsupported_material_claim_ids.join(", ")}.`);
    }
  }
  if (view === "full" && result.full_pack) {
    for (const source of result.full_pack.sources) {
      if (!appendBounded(lines, `Source ${source.source_id}: ${redactSensitiveText(source.title)} — ${redactSensitiveText(source.locator)}`, MAX_EVIDENCE_COMPACT_CHARS)) break;
      for (const passage of source.passages) {
        const excerpt = redactSensitiveText(passage.text).slice(0, 600);
        if (!appendBounded(lines, `  ${passage.passage_id}${passage.location ? ` (${redactSensitiveText(passage.location)})` : ""}: ${excerpt}`, MAX_EVIDENCE_COMPACT_CHARS)) break;
      }
    }
    for (const claim of result.full_pack.claims) {
      const support = claim.support.map((reference) => `${reference.source_id}:${reference.passage_ids.join(",")}`).join("; ") || "none";
      const conflicts = claim.contradicts.map((reference) => `${reference.source_id}:${reference.passage_ids.join(",")}`).join("; ") || "none";
      const disposition = claim.conflict_disposition
        ? `${claim.conflict_disposition.disposition}: ${redactSensitiveText(claim.conflict_disposition.rationale).slice(0, 320)}`
        : "none";
      if (!appendBounded(lines, `Claim ${claim.claim_id}${claim.material ? " (material)" : ""}: ${redactSensitiveText(claim.claim).slice(0, 500)}`, MAX_EVIDENCE_COMPACT_CHARS)) break;
      if (!appendBounded(lines, `  support=${support}; conflicts=${conflicts}; disposition=${disposition}`, MAX_EVIDENCE_COMPACT_CHARS)) break;
    }
  }
  return lines.join("\n").slice(0, MAX_EVIDENCE_COMPACT_CHARS);
}
