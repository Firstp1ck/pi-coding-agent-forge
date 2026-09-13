import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

import { validateEvidencePack } from "./evidence-state.ts";
import {
  CHECKPOINT_REQUIRED_HEADINGS,
  assertCheckpointSummary,
  canonicalCheckpointStateHash,
  checkpointArtifactPath,
  checkpointSnapshotPointerHash,
  readCheckpointMarkdown,
  readCheckpointSnapshot,
  scopeHashForCheckpoint,
  sha256,
  type CheckpointSnapshot,
} from "./checkpoint-contracts.ts";
import { checkpointCoverageManifest } from "./checkpoint-renderer.ts";
import type { ContextCheckpointSummary, ReliabilityConfig, TaskState } from "./types.ts";
import { stableStringify } from "./utils.ts";
import { inputAuthorityBlockReason } from "./input-authority.ts";

export type CheckpointValidation = {
  valid: boolean;
  reasons: string[];
  markdown?: string;
};

function validationFailure(...reasons: string[]): CheckpointValidation {
  return { valid: false, reasons: reasons.filter(Boolean).slice(0, 24) };
}

function hasHeading(markdown: string, heading: string): boolean {
  return markdown.split(/\r?\n/).some((line) => line === heading);
}

function taskOwnedPath(state: TaskState, relativePath: string): boolean {
  const task = resolve(state.cwd, ".pi", "tasks", state.task_id);
  const candidate = resolve(task, relativePath);
  return candidate === task || candidate.startsWith(`${task}/`) || candidate.startsWith(`${task}\\`);
}

function artifactPathsExist(state: TaskState, summary: ContextCheckpointSummary): string | undefined {
  if (!taskOwnedPath(state, summary.artifact_path) || !summary.snapshot_path || !taskOwnedPath(state, summary.snapshot_path)) return "Checkpoint artifact or immutable snapshot path escapes the task directory.";
  for (const relativePath of [summary.artifact_path, summary.snapshot_path, summary.request_artifact_path, summary.receipt_artifact_path, summary.restore_artifact_path]) {
    if (!relativePath) continue;
    const path = resolve(state.cwd, ".pi", "tasks", state.task_id, relativePath);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return `Checkpoint-owned artifact is missing or a symlink: ${relativePath}.`;
  }
  return undefined;
}

function evidenceProvenanceIsRequired(state: TaskState): boolean {
  return Boolean(state.task_identity.session_id || state.current_session.session_id || state.current_session.lifecycle_identity === "available");
}

/** Validates only evidence sealed inside this checkpoint, never a later mutable E<n>.json revision. */
function validateSealedEvidenceReferences(state: TaskState, snapshot: CheckpointSnapshot): string | undefined {
  const sealed = snapshot.state.sealed_evidence_packs;
  if (!Array.isArray(sealed) || sealed.length !== state.evidence_packs.length) return "Checkpoint immutable snapshot does not seal every canonical evidence revision.";
  for (let index = 0; index < sealed.length; index += 1) {
    const entry = sealed[index];
    const currentSummary = state.evidence_packs[index];
    if (!entry || stableStringify(entry.summary) !== stableStringify(currentSummary)
      || entry.summary.pack_id !== entry.pack.pack_id
      || entry.summary.task_id !== state.task_id
      || entry.summary.branch_id !== state.task_identity.branch_id
      || entry.content_sha256 !== sha256(stableStringify(entry.pack))) {
      return `Checkpoint sealed evidence revision ${currentSummary?.pack_id ?? index} does not match canonical identity or content.`;
    }
    const hasRevision = Boolean(entry.summary.revision_session_id || entry.summary.revision_receipt_entry_id);
    if ((entry.summary.revision_session_id === undefined) !== (entry.summary.revision_receipt_entry_id === undefined)) {
      return `Checkpoint sealed evidence revision ${entry.summary.pack_id} has incomplete provenance.`;
    }
    if (evidenceProvenanceIsRequired(state) && !hasRevision) return `Checkpoint sealed evidence revision ${entry.summary.pack_id} is missing its required authoritative receipt.`;
    if (hasRevision) {
      const receipt = entry.revision_receipt;
      const currentReceipt = state.current_session.evidence_revision_receipts?.find((item) => item.entry_id === entry.summary.revision_receipt_entry_id);
      if (!receipt || !currentReceipt
        || stableStringify(receipt) !== stableStringify(currentReceipt)
        || receipt.task_id !== state.task_id
        || receipt.pack_id !== entry.summary.pack_id
        || receipt.sha256 !== entry.summary.sha256
        || entry.summary.revision_session_id !== state.current_session.session_id
        || state.current_session.lifecycle_identity !== "available"
        || !state.current_session.branch_entry_ids.includes(receipt.entry_id)) {
        return `Checkpoint sealed evidence revision ${entry.summary.pack_id} has no exact current-session receipt/hash binding.`;
      }
    }
    try {
      validateEvidencePack(entry.pack);
    } catch (error) {
      return `Checkpoint sealed evidence revision ${entry.summary.pack_id} is structurally invalid: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const claim of entry.pack.claims.filter((item) => item.material && item.conflict_disposition?.disposition !== "exclude-claim")) {
      for (const reference of [...claim.support, ...claim.contradicts]) {
        const source = entry.pack.sources.find((item) => item.source_id === reference.source_id);
        if (!source || reference.passage_ids.some((passageId) => !source.passages.some((passage) => passage.passage_id === passageId))) {
          return `Checkpoint sealed material claim ${entry.summary.pack_id}:${claim.claim_id} has an unresolved evidence reference.`;
        }
      }
      if (claim.support.length === 0 && claim.contradicts.length === 0 && !claim.conflict_disposition) {
        return `Checkpoint sealed material claim ${entry.summary.pack_id}:${claim.claim_id} has no source reference or structured unsupported/conflict disposition.`;
      }
    }
  }
  return undefined;
}

function authoritativeReferencesAreCurrent(state: TaskState): string | undefined {
  if (state.current_session.lifecycle_identity !== "available") return undefined;
  const instructions = [state.authoritative_instructions.original_user_request, ...state.authoritative_instructions.corrections];
  for (const instruction of instructions) {
    if (!instruction.session_id || !instruction.session_entry_id) return "An authoritative user instruction is missing required current-session provenance.";
    if (instruction.session_id !== state.current_session.session_id || !state.current_session.branch_entry_ids.includes(instruction.session_entry_id)) {
      return "An authoritative user instruction no longer has a current-session branch reference.";
    }
  }
  return undefined;
}

function validateSnapshotPointers(snapshot: CheckpointSnapshot, summary: ContextCheckpointSummary, markdown: string): string | undefined {
  const references = markdown.matchAll(/`([^`]+)#\/([^`]+)` \(SHA-256: `([a-f0-9]{64})`\)/g);
  for (const match of references) {
    const [, snapshotPath, pointer, expectedHash] = match;
    if (snapshotPath !== summary.snapshot_path) return `Checkpoint reference points outside its immutable snapshot: ${snapshotPath}.`;
    const actualHash = checkpointSnapshotPointerHash(snapshot, pointer);
    if (!actualHash) return `Checkpoint immutable reference has no target: #/${pointer}.`;
    if (actualHash !== expectedHash) return `Checkpoint immutable reference hash does not match its target: #/${pointer}.`;
  }
  return undefined;
}

/** Validates immutable snapshot coverage and current state immediately before a potential reset. */
export function validateCheckpoint(state: TaskState, summary: ContextCheckpointSummary, config: ReliabilityConfig): CheckpointValidation {
  try {
    assertCheckpointSummary(summary);
  } catch (error) {
    return validationFailure(error instanceof Error ? error.message : String(error));
  }
  if (!summary.snapshot_path || !summary.snapshot_sha256 || !summary.candidate_next_action_sha256) return validationFailure("Checkpoint summary has no immutable snapshot or candidate next-action identity.");
  const inputBlock = inputAuthorityBlockReason(state);
  if (inputBlock) return validationFailure(inputBlock);
  if (state.pending_tool_calls.length > 0) return validationFailure("A tool call or parallel result batch is still unresolved.");
  if (!state.next_action.trim() || state.next_action.length > 300 || /[\r\n]/.test(state.next_action)) return validationFailure("The canonical next action is not one bounded executable line.");
  if (summary.canonical_state_sha256 !== canonicalCheckpointStateHash(state)) return validationFailure("Checkpoint canonical-state hash does not match current task state.");
  if (summary.scope_sha256 !== scopeHashForCheckpoint(state)) return validationFailure("Checkpoint scope hash does not match current active scope and budgets.");
  if (summary.candidate_next_action_sha256 !== sha256(state.next_action)) return validationFailure("Checkpoint candidate next action no longer matches canonical state.");
  const currentEvidence = state.evidence_packs.map((pack) => ({ pack_id: pack.pack_id, sha256: pack.sha256 }));
  if (JSON.stringify(summary.evidence_packs) !== JSON.stringify(currentEvidence)) return validationFailure("Checkpoint evidence-pack identity does not match current canonical state.");
  const authorityProblem = authoritativeReferencesAreCurrent(state);
  if (authorityProblem) return validationFailure(authorityProblem);
  const artifactProblem = artifactPathsExist(state, summary);
  if (artifactProblem) return validationFailure(artifactProblem);

  let snapshot;
  let markdown: string;
  try {
    snapshot = readCheckpointSnapshot(state, summary);
    const expected = checkpointArtifactPath(state, summary.sequence, summary.from_lane, summary.to_lane, false);
    const actual = resolve(state.cwd, ".pi", "tasks", state.task_id, summary.artifact_path);
    if (actual !== expected) return validationFailure("Checkpoint artifact path does not match its immutable sequence and lane identity.");
    markdown = readCheckpointMarkdown(state, summary, config.contextReset.maxCheckpointChars);
  } catch (error) {
    return validationFailure(error instanceof Error ? error.message : String(error));
  }
  const sealedEvidenceProblem = validateSealedEvidenceReferences(state, snapshot);
  if (sealedEvidenceProblem) return validationFailure(sealedEvidenceProblem);
  const pointerProblem = validateSnapshotPointers(snapshot, summary, markdown);
  if (pointerProblem) return validationFailure(pointerProblem);
  if (snapshot.candidate.next_action !== state.next_action || sha256(snapshot.candidate.next_action) !== summary.candidate_next_action_sha256) {
    return validationFailure("Immutable checkpoint snapshot does not carry the current canonical next action.");
  }
  if (snapshot.candidate.phase_id !== summary.phase_id || snapshot.candidate.from_lane !== summary.from_lane || snapshot.candidate.to_lane !== summary.to_lane) {
    return validationFailure("Immutable checkpoint snapshot candidate identity does not match its summary.");
  }
  const missingHeadings = CHECKPOINT_REQUIRED_HEADINGS.filter((heading) => !hasHeading(markdown, heading));
  if (missingHeadings.length) return validationFailure(`Checkpoint is missing required sections: ${missingHeadings.join(", ")}`);
  const coverage = checkpointCoverageManifest(snapshot, summary.scope_sha256);
  const coverageHash = sha256(stableStringify(coverage));
  if (!markdown.includes(summary.snapshot_path) || !markdown.includes(summary.snapshot_sha256)
    || !markdown.includes(coverageHash) || !markdown.includes(summary.canonical_state_sha256)
    || !markdown.includes(summary.artifact_path) || !markdown.includes(summary.phase_id)) {
    return validationFailure("Checkpoint immutable snapshot or coverage manifest is incomplete.");
  }
  for (const evidence of summary.evidence_packs) {
    if (!markdown.includes(`${evidence.pack_id}:${evidence.sha256}`)) return validationFailure(`Checkpoint integrity manifest omits evidence pack ${evidence.pack_id}.`);
  }
  if (summary.scope_sha256 && !markdown.includes(summary.scope_sha256)) return validationFailure("Checkpoint integrity manifest omits the active scope hash.");
  return { valid: true, reasons: [], markdown };
}
