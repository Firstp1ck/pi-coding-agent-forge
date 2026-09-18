import {
  isIsoTimestamp,
  isReadEvidence,
  isSha256,
  normalizeRanges,
  rangesContain,
  sha256,
  targetLines,
  type EvidenceSource,
  type LineRange,
  type ReadEvidence,
  type ReviewManifest,
  type SnapshotTarget,
} from "./core.ts";

export const DEFAULT_READ_EVIDENCE_LIMITS = {
  maxOutputLines: 2_000,
  maxOutputBytes: 50 * 1024,
} as const;

export type ReadEvidenceLimits = {
  maxOutputLines?: number;
  maxOutputBytes?: number;
};

type ResolvedReadEvidenceLimits = {
  maxOutputLines: number;
  maxOutputBytes: number;
};

export type ReadObservation = {
  source: EvidenceSource;
  targetId: string;
  version: string;
  sha256: string;
  requestedRange: LineRange;
  returnedRange: LineRange;
  lines: string[];
  outcome: "success" | "failed" | "cancelled";
  /** False means a native truncation or malformed result ended inside a line. */
  completeLines: boolean;
  /** A truncated result can earn only its independently verified complete lines. */
  truncated: boolean;
  observedAt: string;
};

export type EvidenceFinalization =
  | { accepted: true; evidence: ReadEvidence }
  | { accepted: false; reason: string };

export type TrackedSnapshotRead = {
  targetId: string;
  version: string;
  sha256: string;
  range: LineRange;
  lines: string[];
  text: string;
};

function limitsWithDefaults(input: ReadEvidenceLimits = {}): ResolvedReadEvidenceLimits {
  const result = { ...DEFAULT_READ_EVIDENCE_LIMITS, ...input };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}

function targetFor(manifest: ReviewManifest, targetId: string): SnapshotTarget | undefined {
  return manifest.targets.find((target) => target.id === targetId);
}

function validRange(value: LineRange): boolean {
  return Number.isInteger(value.start) && Number.isInteger(value.end) && value.start >= 1 && value.end >= value.start;
}

/**
 * Turn one finalized native/tracked tool observation into evidence. Every byte
 * and every line is matched to the immutable snapshot before any range counts.
 */
export function finalizeReadObservation(
  manifest: ReviewManifest,
  observation: ReadObservation,
  inputLimits: ReadEvidenceLimits = {},
): EvidenceFinalization {
  const limits = limitsWithDefaults(inputLimits);
  if (observation.outcome !== "success") return { accepted: false, reason: `Read ${observation.outcome}; no coverage was granted.` };
  if (typeof observation.completeLines !== "boolean" || typeof observation.truncated !== "boolean" || !observation.completeLines) {
    return { accepted: false, reason: "Read ended with a partial or malformed line; no coverage was granted." };
  }
  if (observation.source !== "native-read" && observation.source !== "tracked-read") return { accepted: false, reason: "Unknown read evidence source." };
  if (!validRange(observation.requestedRange) || !validRange(observation.returnedRange)) return { accepted: false, reason: "Read ranges are malformed." };
  if (!rangesContain([observation.requestedRange], observation.returnedRange)) return { accepted: false, reason: "Returned range is outside the requested range." };
  if (!isIsoTimestamp(observation.observedAt)) return { accepted: false, reason: "Read observation timestamp is invalid." };
  if (!Array.isArray(observation.lines) || observation.lines.length > limits.maxOutputLines || !observation.lines.every((line) => typeof line === "string" && !line.includes("\n"))) {
    return { accepted: false, reason: "Read result has malformed or excessive output lines." };
  }
  const returned = observation.lines.join("\n");
  if (Buffer.byteLength(returned, "utf8") > limits.maxOutputBytes) return { accepted: false, reason: "Read result exceeds the output byte limit." };

  const target = targetFor(manifest, observation.targetId);
  if (!target || (target.disposition !== "reviewable" && target.disposition !== "empty")) return { accepted: false, reason: "Read target is not reviewable frozen text." };
  if (target.version !== observation.version || target.sha256 !== observation.sha256 || !isSha256(observation.sha256)) {
    return { accepted: false, reason: "Read target identity does not match the frozen snapshot." };
  }
  if (!rangesContain(target.requiredRanges, observation.returnedRange)) return { accepted: false, reason: "Read range is not required by the manifest." };
  if (observation.returnedRange.end > target.lineCount || observation.lines.length !== observation.returnedRange.end - observation.returnedRange.start + 1) {
    return { accepted: false, reason: "Returned line count is outside the frozen target." };
  }

  const expected = targetLines(target).slice(observation.returnedRange.start - 1, observation.returnedRange.end);
  if (expected.length !== observation.lines.length || expected.some((line, index) => line !== observation.lines[index])) {
    return { accepted: false, reason: "Returned content does not exactly match frozen snapshot lines." };
  }
  const evidence: ReadEvidence = {
    targetId: target.id,
    version: target.version,
    sha256: target.sha256!,
    range: { ...observation.returnedRange },
    source: observation.source,
    returnedSha256: sha256(returned),
    returnedByteLength: Buffer.byteLength(returned, "utf8"),
    observedAt: observation.observedAt,
  };
  if (!isReadEvidence(evidence, manifest)) return { accepted: false, reason: "Final evidence failed immutable manifest validation." };
  return { accepted: true, evidence };
}

/**
 * The fallback reader exposes only an exact bounded range from frozen bytes.
 * W2 can present this result as a dedicated tracked tool without filesystem I/O.
 */
export function readTrackedSnapshot(
  manifest: ReviewManifest,
  input: { targetId: string; range: LineRange },
  inputLimits: ReadEvidenceLimits = {},
): TrackedSnapshotRead {
  const limits = limitsWithDefaults(inputLimits);
  const target = targetFor(manifest, input.targetId);
  if (!target || (target.disposition !== "reviewable" && target.disposition !== "empty")) throw new Error("Tracked read target is not reviewable frozen text.");
  if (!validRange(input.range) || !rangesContain(target.requiredRanges, input.range)) throw new Error("Tracked read range is not required by the manifest.");
  const lines = targetLines(target).slice(input.range.start - 1, input.range.end);
  const text = lines.join("\n");
  if (lines.length !== input.range.end - input.range.start + 1 || lines.length > limits.maxOutputLines || Buffer.byteLength(text, "utf8") > limits.maxOutputBytes) {
    throw new Error("Tracked read range exceeds output limits.");
  }
  return { targetId: target.id, version: target.version, sha256: target.sha256!, range: { ...input.range }, lines, text };
}

/** Union is recomputed from strict evidence rather than trusting a model counter. */
export function evidenceCoverageRanges(manifest: ReviewManifest, targetId: string, evidence: readonly ReadEvidence[]): LineRange[] {
  const target = targetFor(manifest, targetId);
  if (!target || (target.disposition !== "reviewable" && target.disposition !== "empty")) return [];
  return normalizeRanges(evidence.filter((item) => item.targetId === targetId && isReadEvidence(item, manifest)).map((item) => item.range), target.lineCount);
}
