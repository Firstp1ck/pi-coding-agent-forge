import type { EvidenceFreshnessPolicy, EvidenceLimits, EvidenceSourceKind } from "./types.ts";
import { redactSensitiveText } from "./redaction.ts";
import { validateDependencyEvidenceInput, type DependencyEvidenceInput } from "./dependency-evidence.ts";

export const MAX_EVIDENCE_PACKS = 12;
export const MAX_EVIDENCE_SOURCES = 12;
export const MAX_EVIDENCE_PASSAGES = 24;
export const MAX_EVIDENCE_PASSAGES_PER_SOURCE = 4;
export const MAX_EVIDENCE_PASSAGE_CHARS = 2_000;
export const MAX_EVIDENCE_CLAIMS = 30;
export const MAX_EVIDENCE_COMPACT_CHARS = 8_000;

export type EvidenceSourceInput = {
  sourceId: string;
  title: string;
  locator: string;
  sourceKind: EvidenceSourceKind;
  publishedAt?: string;
  retrievedAt: string;
  passages: Array<{ passageId: string; text: string; location?: string }>;
};

export type EvidenceReferenceInput = {
  sourceId: string;
  passageIds: string[];
};

export type ReliabilityEvidenceInput =
  | {
      action: "start";
      question: string;
      requirements?: string[];
      maxSources?: number;
      maxPassages?: number;
      freshness?: { maxAgeDays: number; basis: "publishedAt" | "retrievedAt" };
    }
  | { action: "add-source"; packId: string; source: EvidenceSourceInput }
  | {
      action: "add-claim";
      packId: string;
      claimId: string;
      claim: string;
      material: boolean;
      support: EvidenceReferenceInput[];
      contradicts?: EvidenceReferenceInput[];
    }
  | {
      action: "disposition-conflict";
      packId: string;
      claimId: string;
      disposition: "prefer-source" | "report-conflict" | "exclude-claim" | "escalate";
      rationale: string;
      preferredSourceIds?: string[];
    }
  | ({ action: "record-dependency"; packId: string } & DependencyEvidenceInput)
  | { action: "assess" | "get"; packId: string; view?: "compact" | "full" };

export type EvidenceStartInput = Extract<ReliabilityEvidenceInput, { action: "start" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported reliability_evidence field '${key}'.`);
  }
}

function requireString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxChars) {
    throw new Error(`${field} must be a non-empty string of at most ${maxChars} characters.`);
  }
  if (redactSensitiveText(value) !== value) {
    throw new Error(`${field} contains detectable credential material and cannot be persisted as evidence.`);
  }
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  const identifier = requireString(value, field, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(identifier)) {
    throw new Error(`${field} must use letters, numbers, underscores, or hyphens and start with a letter.`);
  }
  return identifier;
}

function requireInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function requireStringArray(value: unknown, field: string, maxItems: number, maxItemChars: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must contain at most ${maxItems} strings.`);
  const result = value.map((item, index) => requireString(item, `${field}[${index}]`, maxItemChars));
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates.`);
  return result;
}

function timestamp(value: unknown, field: string, now: Date): string {
  const text = requireString(value, field, 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO-8601 timestamp.`);
  if (parsed > now.getTime()) throw new Error(`${field} cannot be in the future.`);
  return text;
}

function parseFreshness(value: unknown): EvidenceStartInput["freshness"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("freshness must be an object when supplied.");
  assertAllowedKeys(value, ["maxAgeDays", "basis"]);
  const maxAgeDays = requireInteger(value.maxAgeDays, "freshness.maxAgeDays", 1, 36_500);
  if (value.basis !== "publishedAt" && value.basis !== "retrievedAt") {
    throw new Error("freshness.basis must be publishedAt or retrievedAt.");
  }
  return { maxAgeDays, basis: value.basis };
}

function parseReference(value: unknown, field: string): EvidenceReferenceInput {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  assertAllowedKeys(value, ["sourceId", "passageIds"]);
  return {
    sourceId: requireIdentifier(value.sourceId, `${field}.sourceId`),
    passageIds: requireStringArray(value.passageIds, `${field}.passageIds`, MAX_EVIDENCE_PASSAGES_PER_SOURCE, 64),
  };
}

function parseReferences(value: unknown, field: string): EvidenceReferenceInput[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_SOURCES) {
    throw new Error(`${field} must contain at most ${MAX_EVIDENCE_SOURCES} source references.`);
  }
  const references = value.map((item, index) => parseReference(item, `${field}[${index}]`));
  if (new Set(references.map((item) => item.sourceId)).size !== references.length) {
    throw new Error(`${field} must reference each source at most once.`);
  }
  return references;
}

function parseSource(value: unknown, now: Date): EvidenceSourceInput {
  if (!isRecord(value)) throw new Error("source must be an object.");
  assertAllowedKeys(value, ["sourceId", "title", "locator", "sourceKind", "publishedAt", "retrievedAt", "passages"]);
  const sourceKind = value.sourceKind;
  if (sourceKind !== "local-file" && sourceKind !== "official-doc" && sourceKind !== "primary" && sourceKind !== "peer-reviewed" && sourceKind !== "web" && sourceKind !== "community") {
    throw new Error("source.sourceKind is not supported.");
  }
  if (!Array.isArray(value.passages) || value.passages.length === 0 || value.passages.length > MAX_EVIDENCE_PASSAGES_PER_SOURCE) {
    throw new Error(`source.passages must contain one through ${MAX_EVIDENCE_PASSAGES_PER_SOURCE} passages.`);
  }
  const passages = value.passages.map((passage, index) => {
    if (!isRecord(passage)) throw new Error(`source.passages[${index}] must be an object.`);
    assertAllowedKeys(passage, ["passageId", "text", "location"]);
    return {
      passageId: requireIdentifier(passage.passageId, `source.passages[${index}].passageId`),
      // Exact submitted passage text is preserved; do not trim, redact, or normalize it here.
      text: requireString(passage.text, `source.passages[${index}].text`, MAX_EVIDENCE_PASSAGE_CHARS),
      location: passage.location === undefined ? undefined : requireString(passage.location, `source.passages[${index}].location`, 300),
    };
  });
  if (new Set(passages.map((passage) => passage.passageId)).size !== passages.length) {
    throw new Error("source.passages must not contain duplicate passage IDs.");
  }
  const retrievedAt = timestamp(value.retrievedAt, "source.retrievedAt", now);
  const publishedAt = value.publishedAt === undefined ? undefined : timestamp(value.publishedAt, "source.publishedAt", now);
  if (publishedAt && Date.parse(publishedAt) > Date.parse(retrievedAt)) {
    throw new Error("source.publishedAt cannot be later than source.retrievedAt.");
  }
  return {
    sourceId: requireIdentifier(value.sourceId, "source.sourceId"),
    title: requireString(value.title, "source.title", 300),
    locator: requireString(value.locator, "source.locator", 2_048),
    sourceKind,
    publishedAt,
    retrievedAt,
    passages,
  };
}

export function toEvidenceFreshnessPolicy(freshness: EvidenceStartInput["freshness"]): EvidenceFreshnessPolicy | undefined {
  return freshness && { max_age_days: freshness.maxAgeDays, basis: freshness.basis };
}

export function evidenceLimits(maxSources: number, maxPassages: number, maxPassageChars: number, maxClaims: number): EvidenceLimits {
  return {
    max_sources: maxSources,
    max_passages: maxPassages,
    max_passages_per_source: MAX_EVIDENCE_PASSAGES_PER_SOURCE,
    max_passage_chars: maxPassageChars,
    max_claims: maxClaims,
  };
}

/** Revalidates every model-facing action before any evidence pack mutation. */
export function validateReliabilityEvidenceInput(input: unknown, now = new Date()): ReliabilityEvidenceInput {
  if (!isRecord(input) || typeof input.action !== "string") throw new Error("reliability_evidence requires an action object.");
  switch (input.action) {
    case "start": {
      assertAllowedKeys(input, ["action", "question", "requirements", "maxSources", "maxPassages", "freshness"]);
      const requirements = input.requirements === undefined
        ? undefined
        : requireStringArray(input.requirements, "requirements", 12, 600);
      return {
        action: "start",
        question: requireString(input.question, "question", 2_000),
        requirements,
        maxSources: input.maxSources === undefined ? undefined : requireInteger(input.maxSources, "maxSources", 1, MAX_EVIDENCE_SOURCES),
        maxPassages: input.maxPassages === undefined ? undefined : requireInteger(input.maxPassages, "maxPassages", 1, MAX_EVIDENCE_PASSAGES),
        freshness: parseFreshness(input.freshness),
      };
    }
    case "add-source":
      assertAllowedKeys(input, ["action", "packId", "sourceId", "title", "locator", "sourceKind", "publishedAt", "retrievedAt", "passages"]);
      return {
        action: "add-source",
        packId: requireIdentifier(input.packId, "packId"),
        source: parseSource({
          sourceId: input.sourceId,
          title: input.title,
          locator: input.locator,
          sourceKind: input.sourceKind,
          publishedAt: input.publishedAt,
          retrievedAt: input.retrievedAt,
          passages: input.passages,
        }, now),
      };
    case "add-claim":
      assertAllowedKeys(input, ["action", "packId", "claimId", "claim", "material", "support", "contradicts"]);
      if (typeof input.material !== "boolean") throw new Error("material must be a boolean.");
      return {
        action: "add-claim",
        packId: requireIdentifier(input.packId, "packId"),
        claimId: requireIdentifier(input.claimId, "claimId"),
        claim: requireString(input.claim, "claim", 2_000),
        material: input.material,
        support: parseReferences(input.support, "support"),
        contradicts: input.contradicts === undefined ? [] : parseReferences(input.contradicts, "contradicts"),
      };
    case "disposition-conflict": {
      assertAllowedKeys(input, ["action", "packId", "claimId", "disposition", "rationale", "preferredSourceIds"]);
      if (input.disposition !== "prefer-source" && input.disposition !== "report-conflict" && input.disposition !== "exclude-claim" && input.disposition !== "escalate") {
        throw new Error("disposition is not supported.");
      }
      const preferredSourceIds = input.preferredSourceIds === undefined
        ? undefined
        : requireStringArray(input.preferredSourceIds, "preferredSourceIds", MAX_EVIDENCE_SOURCES, 64).map((id) => requireIdentifier(id, "preferredSourceIds item"));
      if (input.disposition === "prefer-source" && (!preferredSourceIds || preferredSourceIds.length === 0)) {
        throw new Error("prefer-source requires preferredSourceIds.");
      }
      return {
        action: "disposition-conflict",
        packId: requireIdentifier(input.packId, "packId"),
        claimId: requireIdentifier(input.claimId, "claimId"),
        disposition: input.disposition,
        rationale: requireString(input.rationale, "rationale", 2_000),
        preferredSourceIds,
      };
    }
    case "record-dependency": {
      const dependency = validateDependencyEvidenceInput(input);
      return {
        action: "record-dependency",
        packId: requireIdentifier(input.packId, "packId"),
        ...dependency,
      };
    }
    case "assess":
    case "get": {
      assertAllowedKeys(input, ["action", "packId", "view"]);
      if (input.view !== undefined && input.view !== "compact" && input.view !== "full") throw new Error("view must be compact or full.");
      return { action: input.action, packId: requireIdentifier(input.packId, "packId"), view: input.view };
    }
    default:
      throw new Error(`Unsupported reliability_evidence action '${input.action}'.`);
  }
}
