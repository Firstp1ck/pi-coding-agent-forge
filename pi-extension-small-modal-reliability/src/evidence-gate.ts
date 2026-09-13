import { assessEvidencePack, readEvidencePack, type EvidenceAssessment } from "./evidence-state.ts";
import type { CompletionDecision, TaskState } from "./types.ts";

export type CompletionRequirementEvaluation = {
  decision: CompletionDecision;
  reasons: string[];
  evidence_refs: string[];
};

const MAX_GATE_REASONS = 24;

function boundedReasons(reasons: string[]): string[] {
  return reasons.slice(0, MAX_GATE_REASONS);
}

function decisionFromAssessment(packId: string, assessment: EvidenceAssessment): CompletionRequirementEvaluation {
  const evidenceRefs = [packId];
  if (!assessment.integrity_passed) {
    return {
      decision: "fail",
      reasons: assessment.issues.length > 0
        ? assessment.issues
        : ["Retrieval evidence lacks required citation integrity or material claim coverage."],
      evidence_refs: evidenceRefs,
    };
  }
  if (assessment.unresolved_conflict_claim_ids.length > 0 || assessment.explicit_escalation_claim_ids.length > 0) {
    return {
      decision: "escalate",
      reasons: assessment.issues.length > 0
        ? assessment.issues
        : ["Retrieval evidence contains a conflict that requires escalation."],
      evidence_refs: evidenceRefs,
    };
  }
  if (assessment.freshness_status === "stale" || assessment.freshness_status === "unknown") {
    return {
      decision: "escalate",
      reasons: assessment.issues.length > 0
        ? assessment.issues
        : ["Retrieval evidence does not satisfy its explicit freshness policy."],
      evidence_refs: evidenceRefs,
    };
  }
  return {
    decision: "pass",
    reasons: [
      `Evidence pack ${packId} has resolved citations and declared material coverage.`,
      "Citation integrity does not establish semantic truth; semantic review remains required.",
    ],
    evidence_refs: evidenceRefs,
  };
}

/**
 * A mandatory completion requirement for retrieval work. Every retained pack
 * participates: beginning a later pack cannot silently supersede unresolved
 * material claims or conflicts in an earlier pack.
 */
export function evaluateRetrievalEvidenceRequirement(
  state: TaskState,
  options: { now?: Date } = {},
): CompletionRequirementEvaluation | undefined {
  if (state.lane !== "retrieval" && state.evidence_packs.length === 0) return undefined;
  if (state.evidence_packs.length === 0) {
    return {
      decision: "fail",
      reasons: ["Retrieval work has no evidence pack."],
      evidence_refs: [],
    };
  }

  const refs: string[] = [];
  const failures: string[] = [];
  const escalations: string[] = [];
  for (const summary of state.evidence_packs) {
    refs.push(summary.pack_id);
    try {
      const pack = readEvidencePack(state, summary.pack_id);
      const evaluation = decisionFromAssessment(pack.pack_id, assessEvidencePack(pack, options.now));
      const prefixed = evaluation.reasons.map((reason) => `[${pack.pack_id}] ${reason}`);
      if (evaluation.decision === "fail") failures.push(...prefixed);
      else if (evaluation.decision === "escalate") escalations.push(...prefixed);
    } catch (error) {
      failures.push(`[${summary.pack_id}] Retrieval evidence is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    return { decision: "fail", reasons: boundedReasons(failures), evidence_refs: refs };
  }
  if (escalations.length > 0) {
    return { decision: "escalate", reasons: boundedReasons(escalations), evidence_refs: refs };
  }
  return {
    decision: "pass",
    reasons: [
      `All ${refs.length} retained evidence pack${refs.length === 1 ? "" : "s"} have resolved citations and declared material coverage.`,
      "Citation integrity does not establish semantic truth; semantic review remains required.",
    ],
    evidence_refs: refs,
  };
}
