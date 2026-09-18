import { createHash } from "node:crypto";

export const REVIEW_STATE_VERSION = 1 as const;
export const DEFAULT_MAX_TARGETS = 500;
export const DEFAULT_MAX_EVIDENCE = 10_000;
export const DEFAULT_MAX_REVIEWER_CONTEXT_BYTES = 2 * 1024 * 1024;

const HASH = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ReviewCoreError extends Error {}

export type LineRange = { start: number; end: number };
export type TargetDisposition = "reviewable" | "empty" | "metadata" | "excluded" | "blocked";
export type EvidenceSource = "native-read" | "tracked-read";
export type ReviewPhase = "frozen" | "reviewing" | "paused" | "reporting" | "complete" | "cancelled" | "failed";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type SnapshotTarget = {
  id: string;
  path: string;
  /** A Git object ID or a SHA-256 snapshot identity; it never names a moving ref. */
  version: string;
  disposition: TargetDisposition;
  reason?: string;
  sha256?: string;
  contentBase64?: string;
  byteLength?: number;
  lineCount: number;
  requiredRanges: LineRange[];
};

export type ReviewManifest = {
  reviewId: string;
  projectRoot: string;
  createdAt: string;
  targets: SnapshotTarget[];
};

export type ReadEvidence = {
  targetId: string;
  version: string;
  sha256: string;
  range: LineRange;
  source: EvidenceSource;
  returnedSha256: string;
  returnedByteLength: number;
  observedAt: string;
};

export type ReviewFinding = {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  targetId?: string;
  line?: number;
  evidence?: string;
};

export type ReviewReportDigest = {
  jsonSha256: string;
  markdownSha256: string;
  generatedAt: string;
};

export type ReviewState = {
  schemaVersion: typeof REVIEW_STATE_VERSION;
  reviewId: string;
  ownerSessionId: string;
  createdAt: string;
  updatedAt: string;
  phase: ReviewPhase;
  manifest: ReviewManifest;
  evidence: ReadEvidence[];
  findings: ReviewFinding[];
  reviewerContext: unknown[];
  continuation: {
    attempts: number;
    turnsUsed: number;
    noProgressCompletions: number;
  };
  report?: ReviewReportDigest;
  failureReason?: string;
};

export type CoverageStatus = "covered" | "pending" | "blocked" | "excluded" | "empty" | "metadata";
export type TargetCoverage = {
  target: SnapshotTarget;
  coveredRanges: LineRange[];
  pendingRanges: LineRange[];
  status: CoverageStatus;
};

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

export function isImmutableVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return false;
  const source = value.slice(0, separator);
  const identity = value.slice(separator + 1);
  return (source === "sha256" && HASH.test(identity))
    || (source === "git" && GIT_OBJECT.test(identity))
    || (source === "metadata" && HASH.test(identity));
}

export function isReviewId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export function isCanonicalPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function range(start: number, end: number): LineRange {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new ReviewCoreError("Line ranges are 1-based inclusive ranges.");
  }
  return { start, end };
}

/** Merge duplicate, overlapping, and adjacent 1-based inclusive ranges. */
export function normalizeRanges(ranges: readonly LineRange[], lineCount?: number): LineRange[] {
  const normalized = ranges.map(({ start, end }) => range(start, end));
  if (lineCount !== undefined && (!Number.isInteger(lineCount) || lineCount < 0)) {
    throw new ReviewCoreError("Line count must be a non-negative integer.");
  }
  for (const item of normalized) {
    if (lineCount !== undefined && item.end > lineCount) {
      throw new ReviewCoreError("A required range is outside the frozen snapshot.");
    }
  }
  normalized.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: LineRange[] = [];
  for (const item of normalized) {
    const previous = merged.at(-1);
    if (previous && item.start <= previous.end + 1) previous.end = Math.max(previous.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}

export function subtractRanges(required: readonly LineRange[], covered: readonly LineRange[]): LineRange[] {
  const pending: LineRange[] = [];
  const normalizedCovered = normalizeRanges(covered);
  for (const wanted of normalizeRanges(required)) {
    let cursor = wanted.start;
    for (const have of normalizedCovered) {
      if (have.end < cursor) continue;
      if (have.start > wanted.end) break;
      if (have.start > cursor) pending.push({ start: cursor, end: Math.min(wanted.end, have.start - 1) });
      cursor = Math.max(cursor, have.end + 1);
      if (cursor > wanted.end) break;
    }
    if (cursor <= wanted.end) pending.push({ start: cursor, end: wanted.end });
  }
  return pending;
}

export function rangesContain(outer: readonly LineRange[], inner: LineRange): boolean {
  return normalizeRanges(outer).some((candidate) => candidate.start <= inner.start && candidate.end >= inner.end);
}

/** Split text into complete source lines; a final newline does not invent an empty line. */
export function completeLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

export function decodeUtf8Strict(bytes: Buffer): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("UTF-8 round trip mismatch");
    return text;
  } catch {
    throw new ReviewCoreError("Snapshot content is not valid UTF-8.");
  }
}

export function targetIdFor(path: string, version: string): string {
  if (!isCanonicalPath(path)) throw new ReviewCoreError("Target path is not a canonical project-relative path.");
  if (!isImmutableVersion(version)) throw new ReviewCoreError("Target version is not immutable.");
  return sha256(`firstpick/pi-extension-review/target/v1\0${path}\0${version}`);
}

/** Verify that a content-bearing target names exactly its frozen bytes. */
export function assertVersionMatchesBytes(version: string, bytes: Buffer): void {
  if (!isImmutableVersion(version)) throw new ReviewCoreError("Target version is not immutable.");
  const [source, identity] = version.split(":", 2);
  if (source === "sha256") {
    if (sha256(bytes) !== identity) throw new ReviewCoreError("SHA-256 snapshot version does not match frozen content.");
    return;
  }
  if (source === "git") {
    const algorithm = identity.length === 40 ? "sha1" : "sha256";
    const object = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, "utf8"), bytes]);
    if (createHash(algorithm).update(object).digest("hex") !== identity) throw new ReviewCoreError("Git blob version does not match frozen content.");
    return;
  }
  throw new ReviewCoreError("Metadata versions cannot name reviewable frozen content.");
}

export function createTextTarget(input: {
  path: string;
  version: string;
  bytes: Buffer;
  requiredRanges?: readonly LineRange[];
}): SnapshotTarget {
  const { path, version, bytes } = input;
  if (!isCanonicalPath(path)) throw new ReviewCoreError("Target path is not a canonical project-relative path.");
  assertVersionMatchesBytes(version, bytes);
  const text = decodeUtf8Strict(bytes);
  if (bytes.includes(0)) throw new ReviewCoreError("NUL-containing content is not reviewable text.");
  const lines = completeLines(text);
  const requiredRanges = normalizeRanges(input.requiredRanges ?? (lines.length ? [{ start: 1, end: lines.length }] : []), lines.length);
  return {
    id: targetIdFor(path, version),
    path,
    version,
    disposition: lines.length === 0 ? "empty" : "reviewable",
    sha256: sha256(bytes),
    contentBase64: bytes.toString("base64"),
    byteLength: bytes.length,
    lineCount: lines.length,
    requiredRanges,
  };
}

export function createNonTextTarget(input: {
  path: string;
  version: string;
  disposition: Exclude<TargetDisposition, "reviewable" | "empty">;
  reason: string;
  sha256?: string;
  byteLength?: number;
}): SnapshotTarget {
  if (!isCanonicalPath(input.path)) throw new ReviewCoreError("Target path is not a canonical project-relative path.");
  if (!isImmutableVersion(input.version)) throw new ReviewCoreError("Target version is not immutable.");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1_000) {
    throw new ReviewCoreError("Non-text targets need a bounded visible reason.");
  }
  if (input.sha256 !== undefined && !isSha256(input.sha256)) throw new ReviewCoreError("Target hash must be a SHA-256 digest.");
  if (input.version.startsWith("sha256:") && input.sha256 !== undefined && input.version.slice("sha256:".length) !== input.sha256) {
    throw new ReviewCoreError("SHA-256 snapshot version does not match frozen content.");
  }
  if (input.byteLength !== undefined && (!Number.isInteger(input.byteLength) || input.byteLength < 0)) {
    throw new ReviewCoreError("Target byte length must be a non-negative integer.");
  }
  return {
    id: targetIdFor(input.path, input.version),
    path: input.path,
    version: input.version,
    disposition: input.disposition,
    reason: input.reason,
    sha256: input.sha256,
    byteLength: input.byteLength,
    lineCount: 0,
    requiredRanges: [],
  };
}

function isLineRange(value: unknown, lineCount?: number): value is LineRange {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["start", "end"])) return false;
  const candidate = value as Partial<LineRange>;
  return Number.isInteger(candidate.start) && Number.isInteger(candidate.end)
    && candidate.start! >= 1 && candidate.end! >= candidate.start!
    && (lineCount === undefined || candidate.end! <= lineCount);
}

function canonicalRanges(value: unknown, lineCount: number): value is LineRange[] {
  if (!Array.isArray(value) || !value.every((item) => isLineRange(item, lineCount))) return false;
  try {
    const normalized = normalizeRanges(value, lineCount);
    return normalized.length === value.length && normalized.every((item, index) => item.start === value[index].start && item.end === value[index].end);
  } catch {
    return false;
  }
}

export function targetBytes(target: SnapshotTarget): Buffer {
  if (target.disposition !== "reviewable" && target.disposition !== "empty") {
    throw new ReviewCoreError("The target does not contain reviewable frozen text.");
  }
  if (typeof target.contentBase64 !== "string" || !isSha256(target.sha256)) {
    throw new ReviewCoreError("Reviewable target has no validated snapshot content.");
  }
  const bytes = Buffer.from(target.contentBase64, "base64");
  if (bytes.toString("base64") !== target.contentBase64 || sha256(bytes) !== target.sha256) {
    throw new ReviewCoreError("Frozen target content does not match its recorded hash.");
  }
  return bytes;
}

export function targetLines(target: SnapshotTarget): string[] {
  return completeLines(decodeUtf8Strict(targetBytes(target)));
}

export function isSnapshotTarget(value: unknown): value is SnapshotTarget {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "path", "version", "disposition", "reason", "sha256", "contentBase64", "byteLength", "lineCount", "requiredRanges"])) return false;
  const target = value as Partial<SnapshotTarget>;
  if (!isSha256(target.id) || !isCanonicalPath(target.path) || !isImmutableVersion(target.version)) return false;
  if (!["reviewable", "empty", "metadata", "excluded", "blocked"].includes(String(target.disposition))) return false;
  if (target.id !== targetIdFor(target.path, target.version)) return false;
  const lineCount = target.lineCount;
  if (!Number.isInteger(lineCount) || lineCount === undefined || lineCount < 0 || !canonicalRanges(target.requiredRanges, lineCount)) return false;
  if (target.reason !== undefined && (typeof target.reason !== "string" || !target.reason.trim() || target.reason.length > 1_000)) return false;
  if (target.byteLength !== undefined && (!Number.isInteger(target.byteLength) || target.byteLength < 0)) return false;

  if (target.disposition === "reviewable" || target.disposition === "empty") {
    if (!isSha256(target.sha256) || typeof target.contentBase64 !== "string" || target.byteLength === undefined) return false;
    try {
      const bytes = targetBytes(target as SnapshotTarget);
      assertVersionMatchesBytes(target.version!, bytes);
      if (bytes.includes(0)) return false;
      const lines = targetLines(target as SnapshotTarget);
      const expectedDisposition: TargetDisposition = lines.length === 0 ? "empty" : "reviewable";
      return target.byteLength === bytes.length
        && target.lineCount === lines.length
        && target.disposition === expectedDisposition
        && (target.disposition === "empty" ? target.requiredRanges!.length === 0 : true);
    } catch {
      return false;
    }
  }
  return target.reason !== undefined
    && target.contentBase64 === undefined
    && target.lineCount === 0
    && target.requiredRanges!.length === 0
    && (target.sha256 === undefined || isSha256(target.sha256));
}

export function createManifest(input: {
  reviewId: string;
  projectRoot: string;
  createdAt: string;
  targets: readonly SnapshotTarget[];
}): ReviewManifest {
  if (!isReviewId(input.reviewId)) throw new ReviewCoreError("Review ID has unsafe characters.");
  if (typeof input.projectRoot !== "string" || input.projectRoot.length === 0) throw new ReviewCoreError("Project root is required.");
  if (!isIsoTimestamp(input.createdAt)) throw new ReviewCoreError("Manifest creation time is invalid.");
  if (input.targets.length > DEFAULT_MAX_TARGETS) throw new ReviewCoreError("Review has too many targets.");
  const ids = new Set<string>();
  for (const target of input.targets) {
    if (!isSnapshotTarget(target)) throw new ReviewCoreError("Manifest contains an invalid target.");
    if (ids.has(target.id)) throw new ReviewCoreError("Manifest contains duplicate target identities.");
    ids.add(target.id);
  }
  return { reviewId: input.reviewId, projectRoot: input.projectRoot, createdAt: input.createdAt, targets: input.targets.map((target) => ({ ...target, requiredRanges: target.requiredRanges.map((item) => ({ ...item })) })) };
}

export function isReviewManifest(value: unknown): value is ReviewManifest {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["reviewId", "projectRoot", "createdAt", "targets"])) return false;
  const manifest = value as Partial<ReviewManifest>;
  if (!isReviewId(manifest.reviewId) || typeof manifest.projectRoot !== "string" || !manifest.projectRoot || !isIsoTimestamp(manifest.createdAt)) return false;
  if (!Array.isArray(manifest.targets) || manifest.targets.length > DEFAULT_MAX_TARGETS || !manifest.targets.every(isSnapshotTarget)) return false;
  return new Set(manifest.targets.map((target) => target.id)).size === manifest.targets.length;
}

function evidenceKey(evidence: ReadEvidence): string {
  return `${evidence.targetId}\0${evidence.range.start}:${evidence.range.end}\0${evidence.source}\0${evidence.returnedSha256}`;
}

export function isReadEvidence(value: unknown, manifest?: ReviewManifest): value is ReadEvidence {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["targetId", "version", "sha256", "range", "source", "returnedSha256", "returnedByteLength", "observedAt"])) return false;
  const evidence = value as Partial<ReadEvidence>;
  if (!isSha256(evidence.targetId) || !isImmutableVersion(evidence.version) || !isSha256(evidence.sha256)
    || !isLineRange(evidence.range) || !["native-read", "tracked-read"].includes(String(evidence.source))
    || !isSha256(evidence.returnedSha256) || !Number.isInteger(evidence.returnedByteLength) || evidence.returnedByteLength === undefined || evidence.returnedByteLength < 0
    || !isIsoTimestamp(evidence.observedAt)) return false;
  if (!manifest) return true;
  const target = manifest.targets.find((item) => item.id === evidence.targetId);
  if (!target || (target.disposition !== "reviewable" && target.disposition !== "empty") || target.version !== evidence.version || target.sha256 !== evidence.sha256) return false;
  if (!rangesContain(target.requiredRanges, evidence.range)) return false;
  try {
    const lines = targetLines(target).slice(evidence.range.start - 1, evidence.range.end);
    const returned = lines.join("\n");
    return sha256(returned) === evidence.returnedSha256 && Buffer.byteLength(returned, "utf8") === evidence.returnedByteLength;
  } catch {
    return false;
  }
}

export function coverageFor(manifest: ReviewManifest, evidence: readonly ReadEvidence[]): TargetCoverage[] {
  return manifest.targets.map((target) => {
    if (target.disposition === "blocked") return { target, coveredRanges: [], pendingRanges: [], status: "blocked" };
    if (target.disposition === "excluded") return { target, coveredRanges: [], pendingRanges: [], status: "excluded" };
    if (target.disposition === "metadata") return { target, coveredRanges: [], pendingRanges: [], status: "metadata" };
    if (target.disposition === "empty") return { target, coveredRanges: [], pendingRanges: [], status: "empty" };
    const coveredRanges = normalizeRanges(evidence.filter((item) => item.targetId === target.id && isReadEvidence(item, manifest)).map((item) => item.range), target.lineCount);
    const pendingRanges = subtractRanges(target.requiredRanges, coveredRanges);
    return { target, coveredRanges, pendingRanges, status: pendingRanges.length === 0 ? "covered" : "pending" };
  });
}

/** Coverage readiness never treats exclusions as read content or blocked targets as complete. */
export function reviewReadyForReport(manifest: ReviewManifest, evidence: readonly ReadEvidence[]): boolean {
  return coverageFor(manifest, evidence).every((item) => item.status !== "pending" && item.status !== "blocked");
}

export function createReviewState(input: {
  manifest: ReviewManifest;
  ownerSessionId: string;
  createdAt?: string;
}): ReviewState {
  if (!isReviewManifest(input.manifest)) throw new ReviewCoreError("Cannot create state for an invalid manifest.");
  if (!isReviewId(input.ownerSessionId)) throw new ReviewCoreError("Owner session ID has unsafe characters.");
  const createdAt = input.createdAt ?? input.manifest.createdAt;
  if (!isIsoTimestamp(createdAt) || createdAt !== input.manifest.createdAt) {
    throw new ReviewCoreError("State and manifest must share a valid creation time.");
  }
  return {
    schemaVersion: REVIEW_STATE_VERSION,
    reviewId: input.manifest.reviewId,
    ownerSessionId: input.ownerSessionId,
    createdAt,
    updatedAt: createdAt,
    phase: "frozen",
    manifest: input.manifest,
    evidence: [],
    findings: [],
    reviewerContext: [],
    continuation: { attempts: 0, turnsUsed: 0, noProgressCompletions: 0 },
  };
}

function validJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 30 || value === null || typeof value === "string" || typeof value === "boolean") return depth <= 30;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => validJsonValue(item, depth + 1));
  if (isPlainObject(value)) return Object.keys(value).length <= 10_000 && Object.values(value).every((item) => validJsonValue(item, depth + 1));
  return false;
}

function validFinding(value: unknown, manifest: ReviewManifest): value is ReviewFinding {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "severity", "title", "detail", "targetId", "line", "evidence"])) return false;
  const finding = value as Partial<ReviewFinding>;
  if (!isReviewId(finding.id) || !["critical", "high", "medium", "low", "info"].includes(String(finding.severity))
    || typeof finding.title !== "string" || !finding.title.trim() || finding.title.length > 500
    || typeof finding.detail !== "string" || !finding.detail.trim() || finding.detail.length > 20_000
    || (finding.evidence !== undefined && (typeof finding.evidence !== "string" || finding.evidence.length > 20_000))) return false;
  if (finding.targetId === undefined) return finding.line === undefined;
  const target = manifest.targets.find((item) => item.id === finding.targetId);
  return Boolean(target) && (finding.line === undefined || (Number.isInteger(finding.line) && finding.line! >= 1 && finding.line! <= target!.lineCount));
}

function validReport(value: unknown): value is ReviewReportDigest {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["jsonSha256", "markdownSha256", "generatedAt"])) return false;
  const report = value as Partial<ReviewReportDigest>;
  return isSha256(report.jsonSha256) && isSha256(report.markdownSha256) && isIsoTimestamp(report.generatedAt);
}

export function isReviewState(value: unknown): value is ReviewState {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["schemaVersion", "reviewId", "ownerSessionId", "createdAt", "updatedAt", "phase", "manifest", "evidence", "findings", "reviewerContext", "continuation", "report", "failureReason"])) return false;
  const state = value as Partial<ReviewState>;
  if (state.schemaVersion !== REVIEW_STATE_VERSION || !isReviewId(state.reviewId) || !isReviewId(state.ownerSessionId)
    || !isIsoTimestamp(state.createdAt) || !isIsoTimestamp(state.updatedAt) || Date.parse(state.createdAt) > Date.parse(state.updatedAt)
    || !["frozen", "reviewing", "paused", "reporting", "complete", "cancelled", "failed"].includes(String(state.phase))
    || !isReviewManifest(state.manifest) || state.manifest.reviewId !== state.reviewId || state.manifest.createdAt !== state.createdAt) return false;
  const manifest = state.manifest;
  if (!Array.isArray(state.evidence) || state.evidence.length > DEFAULT_MAX_EVIDENCE || !state.evidence.every((item) => isReadEvidence(item, manifest))
    || !Array.isArray(state.findings) || state.findings.length > 10_000 || !state.findings.every((item) => validFinding(item, manifest))
    || !Array.isArray(state.reviewerContext) || !state.reviewerContext.every((item) => validJsonValue(item))) return false;
  try {
    if (Buffer.byteLength(JSON.stringify(state.reviewerContext), "utf8") > DEFAULT_MAX_REVIEWER_CONTEXT_BYTES) return false;
  } catch {
    return false;
  }
  const evidenceKeys = new Set(state.evidence.map(evidenceKey));
  if (evidenceKeys.size !== state.evidence.length) return false;
  const findingIds = new Set(state.findings.map((item) => item.id));
  if (findingIds.size !== state.findings.length) return false;
  const continuation = state.continuation;
  if (!isPlainObject(continuation) || !hasOnlyKeys(continuation, ["attempts", "turnsUsed", "noProgressCompletions"])
    || ![continuation.attempts, continuation.turnsUsed, continuation.noProgressCompletions].every((item) => Number.isInteger(item) && item >= 0 && item <= 1_000_000)) return false;
  if (state.report !== undefined && !validReport(state.report)) return false;
  if (state.failureReason !== undefined && (typeof state.failureReason !== "string" || !state.failureReason.trim() || state.failureReason.length > 2_000)) return false;
  if ((state.phase === "reporting" || state.phase === "complete") && !reviewReadyForReport(state.manifest, state.evidence)) return false;
  if (state.phase === "complete" && state.report === undefined) return false;
  if (state.phase !== "failed" && state.failureReason !== undefined) return false;
  return true;
}

function update(state: ReviewState, at: string, change: Partial<ReviewState>): ReviewState {
  if (!isReviewState(state)) throw new ReviewCoreError("Cannot transition an invalid review state.");
  if (!isIsoTimestamp(at) || Date.parse(at) < Date.parse(state.updatedAt)) throw new ReviewCoreError("State time cannot move backwards.");
  const next = { ...state, ...change, updatedAt: at } as ReviewState;
  if (!isReviewState(next)) throw new ReviewCoreError("Invalid review state transition.");
  return next;
}

export function startAttempt(state: ReviewState, at: string): ReviewState {
  if (state.phase !== "frozen" && state.phase !== "paused") throw new ReviewCoreError("Only frozen or paused reviews can start an attempt.");
  return update(state, at, { phase: "reviewing", continuation: { ...state.continuation, attempts: state.continuation.attempts + 1 } });
}

export function recordAttemptCompletion(state: ReviewState, input: { turns: number; madeProgress: boolean; pause?: boolean }, at: string): ReviewState {
  if (state.phase !== "reviewing") throw new ReviewCoreError("Only a running review can finish an attempt.");
  if (!Number.isInteger(input.turns) || input.turns < 0) throw new ReviewCoreError("Attempt turn count must be a non-negative integer.");
  const continuation = {
    attempts: state.continuation.attempts,
    turnsUsed: state.continuation.turnsUsed + input.turns,
    noProgressCompletions: input.madeProgress ? 0 : state.continuation.noProgressCompletions + 1,
  };
  return update(state, at, { continuation, phase: input.pause === false ? "reviewing" : "paused" });
}

export function appendEvidence(state: ReviewState, evidence: ReadEvidence, at: string): ReviewState {
  if (state.phase !== "reviewing" && state.phase !== "paused") throw new ReviewCoreError("Evidence can only be added to an active or paused review.");
  if (!isReadEvidence(evidence, state.manifest)) throw new ReviewCoreError("Refusing unverified read evidence.");
  if (state.evidence.length >= DEFAULT_MAX_EVIDENCE) throw new ReviewCoreError("Read evidence limit reached.");
  if (state.evidence.some((item) => evidenceKey(item) === evidenceKey(evidence))) return state;
  return update(state, at, { evidence: [...state.evidence, evidence] });
}

/** Add frozen-snapshot context requirements without changing versions, bytes, or existing requirements. */
export function addRequiredRanges(state: ReviewState, targetId: string, ranges: readonly LineRange[], at: string): ReviewState {
  if (state.phase !== "frozen" && state.phase !== "reviewing" && state.phase !== "paused") {
    throw new ReviewCoreError("Context requirements can only expand an unfinished review.");
  }
  const index = state.manifest.targets.findIndex((target) => target.id === targetId);
  if (index < 0) throw new ReviewCoreError("Context target is not in the frozen manifest.");
  const target = state.manifest.targets[index];
  if (target.disposition !== "reviewable") throw new ReviewCoreError("Only reviewable text targets can gain context requirements.");
  const requiredRanges = normalizeRanges([...target.requiredRanges, ...ranges], target.lineCount);
  if (requiredRanges.length === target.requiredRanges.length && requiredRanges.every((item, itemIndex) => item.start === target.requiredRanges[itemIndex].start && item.end === target.requiredRanges[itemIndex].end)) {
    return state;
  }
  const targets = state.manifest.targets.map((item, itemIndex) => itemIndex === index ? { ...item, requiredRanges } : item);
  const manifest = createManifest({ ...state.manifest, targets });
  return update(state, at, { manifest });
}

export function replaceReviewerContext(state: ReviewState, reviewerContext: unknown[], at: string): ReviewState {
  if (!Array.isArray(reviewerContext) || !reviewerContext.every((item) => validJsonValue(item))) throw new ReviewCoreError("Reviewer context must be JSON data.");
  if (Buffer.byteLength(JSON.stringify(reviewerContext), "utf8") > DEFAULT_MAX_REVIEWER_CONTEXT_BYTES) {
    throw new ReviewCoreError("Reviewer context exceeds the persistence limit.");
  }
  return update(state, at, { reviewerContext });
}

export function replaceFindings(state: ReviewState, findings: ReviewFinding[], at: string): ReviewState {
  if (!Array.isArray(findings) || !findings.every((item) => validFinding(item, state.manifest))) throw new ReviewCoreError("Findings do not match the frozen manifest.");
  if (new Set(findings.map((item) => item.id)).size !== findings.length) throw new ReviewCoreError("Finding IDs must be unique.");
  return update(state, at, { findings });
}

export function beginReport(state: ReviewState, at: string): ReviewState {
  if (state.phase !== "reviewing" && state.phase !== "paused") throw new ReviewCoreError("Only an active review can enter report generation.");
  if (!reviewReadyForReport(state.manifest, state.evidence)) throw new ReviewCoreError("Pending or blocked targets prevent report generation.");
  return update(state, at, { phase: "reporting" });
}

export function completeReview(state: ReviewState, report: ReviewReportDigest, at: string): ReviewState {
  if (state.phase !== "reporting" || !validReport(report)) throw new ReviewCoreError("A validated final report is required before completion.");
  return update(state, at, { phase: "complete", report });
}

export function pauseReview(state: ReviewState, at: string): ReviewState {
  if (state.phase !== "reviewing") throw new ReviewCoreError("Only a running review can be paused.");
  return update(state, at, { phase: "paused" });
}

export function cancelReview(state: ReviewState, at: string): ReviewState {
  if (state.phase === "complete" || state.phase === "cancelled") throw new ReviewCoreError("Terminal review cannot be cancelled.");
  return update(state, at, { phase: "cancelled" });
}

export function failReview(state: ReviewState, reason: string, at: string): ReviewState {
  if (state.phase === "complete" || state.phase === "cancelled") throw new ReviewCoreError("Terminal review cannot be failed.");
  return update(state, at, { phase: "failed", failureReason: reason });
}

/** Stable JSON keeps persisted report artifacts and their hashes reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) throw new ReviewCoreError("Canonical JSON accepts only JSON values.");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
