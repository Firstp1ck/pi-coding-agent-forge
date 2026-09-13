import { StringEnum } from "@earendil-works/pi-ai";

export type TaskStatus = "planning" | "executing" | "blocked" | "verifying" | "complete" | "failed";
export type StepStatus = "pending" | "in_progress" | "complete" | "blocked" | "skipped";
export type ToolStatus = "called" | "success" | "error" | "blocked";
export type VerificationStatus = "passed" | "failed" | "unknown";
export type ReliabilityProfile = "strict" | "balanced" | "relaxed";
export type ContextHeaderMode = "full" | "compact" | "delta";
export type OrchestrationMode = "prompt" | "separate-model";
export type ReliabilitySupervisionMode = "adaptive" | "lite" | "supervised";
export type ReliabilityRole = "supervisor" | "worker" | "verifier";
export type AdvisorDataScope = "diagnostic-summary";
export type AdvisorTrigger = "observed-failure" | "evidence-conflict" | "repair-exhausted";
export type AdvisorAdviceStatus = "applied" | "rejected";
export type WorkflowLane = "retrieval" | "agentic" | "coding" | "structured-output" | "general";
export type ReliabilityGateName = "retrieval" | "agentic" | "coding" | "structured-output" | "final";
export type StructuredOutputFormat = "json" | "csv" | "enum" | "bounded-string" | "markdown-checklist";
export type StructuredOutputSemanticMode = "structural-only" | "human-review-required";
export type CriterionEvidenceKind = "behavior" | "validation" | "artifact" | "user-attestation";
export type ExecutionOutcome = "success" | "error" | "cancelled" | "blocked" | "unknown";
export type HostExecutionProvenance = "pi-builtin-bash" | "host-tool" | "unknown";
export type VerificationProvenance = "runtime" | "user" | "model" | "legacy";
export type CompletionDecision = "pass" | "fail" | "escalate";
export type EvidenceSourceKind = "local-file" | "official-doc" | "primary" | "peer-reviewed" | "web" | "community";
export type EvidenceAssessmentOutcome = "supported" | "partial" | "conflicting" | "insufficient";
export type EvidenceFreshnessStatus = "not-constrained" | "fresh" | "stale" | "unknown";
export type EvidenceRevisionAction = "start" | "add-source" | "add-claim" | "disposition-conflict" | "record-dependency" | "assess" | "get";
export type DependencyEvidenceSourceKind = "installed-source" | "installed-types" | "official-versioned-docs" | "official-tag";
export type DependencyEvidenceStatus = "verified" | "unknown";
export type CodingBoundaryStatus = "pending" | "captured" | "missing";
export type CodingChangeKind = "added" | "modified" | "deleted";
export const CODING_REVIEW_KINDS = ["test-integrity", "security", "local-only"] as const;
export type CodingReviewKind = typeof CODING_REVIEW_KINDS[number];
export type ScopeExternalSideEffects = "forbidden" | "approval-required" | "pre-approved";
export type ScopeAuthority = "model" | "user-command" | "native-confirmation";
export type ScopeApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed";
export type ContextTargetLane = WorkflowLane | "planning" | "review" | "final";
export type ContextCheckpointTrigger = "phase-boundary" | "context-pressure" | "manual-retry";
export type ContextCheckpointStatus = "written" | "validated" | "reset-complete" | "checkpoint-only" | "invalid" | "recovery-required";
export type ContextResetStatus = "idle" | "queued" | "rendering" | "validated" | "resetting" | "verifying" | "complete" | "skipped" | "failed" | "paused";

export type EvidenceRevisionReceipt = {
  entry_id: string;
  task_id: string;
  pack_id: string;
  sha256: string;
  action: EvidenceRevisionAction;
};

/** Native receipt binding a user-confirmed declarative output contract. */
export type OutputContractReceipt = {
  entry_id: string;
  task_id: string;
  contract_id: string;
  /** Hash of the inspected contract file bytes. */
  contract_sha256: string;
  /** Hash of the parsed canonical declarative definition. */
  definition_sha256: string;
  contract_path: string;
  receipt_hash: string;
};

/** Native receipt binding a deterministic validator result to one candidate. */
export type OutputValidationReceipt = {
  entry_id: string;
  task_id: string;
  validation_id: string;
  contract_id: string;
  contract_sha256: string;
  candidate_sha256: string;
  result_sha256: string;
  receipt_hash: string;
};

/** Native receipt for a user decision on one exact escalation or candidate. */
export type QualityGateResolutionReceipt = {
  entry_id: string;
  task_id: string;
  resolution_id: string;
  target_kind: "escalation" | "semantic-review";
  target_id: string;
  contract_id?: string;
  candidate_sha256?: string;
  decision: "approved" | "rejected";
  receipt_hash: string;
};

export type ExecutionScope = {
  scope_id: string;
  lane: WorkflowLane;
  allowed_tools: string[];
  allowed_read_paths: string[];
  allowed_write_paths: string[];
  forbidden_paths: string[];
  max_tool_calls: number;
  max_errors: number;
  max_iterations: number;
  external_side_effects: ScopeExternalSideEffects;
  validation_commands: string[];
  stop_conditions: string[];
  escalation_conditions: string[];
  authority: ScopeAuthority;
  /** Exact persisted native-confirmation receipt for mutating authority. */
  authority_session_id?: string;
  authority_entry_id?: string;
  authority_scope_change_id?: string;
  authority_receipt_hash?: string;
  created_at: string;
  updated_at: string;
};

export type ScopeChangeRequest = {
  id: string;
  requested_scope: ExecutionScope;
  requested_at: string;
  status: "pending" | "approved" | "rejected";
  resolved_at?: string;
  resolved_by?: "user-command" | "native-confirmation";
};

export type ApprovalRequest = {
  id: string;
  task_id: string;
  branch_id: string;
  tool_name: string;
  requested_normalized_effect: string;
  description: string;
  reversible: boolean;
  scope_hash: string;
  status: ScopeApprovalStatus;
  requested_at: string;
  approved_at?: string;
  approved_by?: "user-command" | "native-confirmation";
  expires_at?: string;
  consumed_at?: string;
  rejected_at?: string;
  session_id?: string;
  session_anchor_entry_id?: string;
  /** Hash of the exact persisted native approval receipt payload. */
  approval_receipt_hash?: string;
};

export type ScopeUsage = {
  tool_calls_used: number;
  blocked_tool_calls: number;
  errors_used: number;
  /** Counts preflight tool-call batches (agent turns), never individual results. */
  iterations_used: number;
  active_iteration_batch_id?: string;
  last_block_reason?: string;
  /** Exact blocked effect eligible for an attributable native approval disposition. */
  last_block_tool?: string;
  last_block_normalized_effect?: string;
  last_block_scope_hash?: string;
};

export type ScopeReadSpan = {
  start_line: number;
  end_line: number;
  content_sha256: string;
};

export type ScopeFreshRead = {
  path: string;
  workspace_revision: string;
  observed_at: string;
  /** Exact successful read receipt and target bytes that made this write eligible. */
  receipt_id?: string;
  tool_call_id?: string;
  content_sha256?: string;
  content_bytes?: number;
  /** A whole-file host read, bounded below the guard's inspectable-size limit. */
  full_coverage?: boolean;
  /** A bounded actual line range available only for targeted edit matching. */
  inspected_span?: ScopeReadSpan;
  session_id?: string;
  session_anchor_entry_id?: string;
};

export type ScopeState = {
  initial_scope?: ExecutionScope;
  active_scope?: ExecutionScope;
  authoritative_scope?: ExecutionScope;
  pending_scope_changes: ScopeChangeRequest[];
  approvals: ApprovalRequest[];
  usage: ScopeUsage;
  fresh_reads: ScopeFreshRead[];
  violations: string[];
  tool_focus_lane?: WorkflowLane;
};

export type PlanStepScope = {
  allowed_tools: string[];
  allowed_read_paths: string[];
  allowed_write_paths: string[];
};

export type PlanExitCondition = {
  kind: "observed-tool-result" | "criteria-passed" | "artifact-produced";
  description: string;
  criterion_ids?: string[];
  artifact_refs?: string[];
};

export type PlanStep = {
  step_id: string;
  title: string;
  description: string;
  status: StepStatus;
  depends_on: string[];
  expected_output: string;
  verification: string;
  /** Empty only in lite plans; executable microplans require at least one. */
  exit_conditions: PlanExitCondition[];
  allowed_scope?: PlanStepScope;
  /** Actual host receipts used to satisfy the current executable exit. */
  exit_evidence_receipt_ids: string[];
  /** Exact produced artifacts referenced by the current executable exit. */
  exit_evidence_artifact_refs: string[];
  /** Hash of the immutable exit contract satisfied by this completed microplan step. */
  exit_evidence_contract_hash?: string;
};

export type WorkspaceRevision = {
  digest: string;
  inventory_complete: boolean;
  observed_at: string;
  file_count: number;
  directory_count: number;
  total_bytes: number;
  git_head?: string;
  git_branch?: string;
  reason?: string;
};

export type ScopeAuthorizationReceipt = {
  entry_id: string;
  task_id: string;
  scope_change_id: string;
  scope_hash: string;
  receipt_hash: string;
};

export type ScopeApprovalReceipt = {
  entry_id: string;
  task_id: string;
  approval_id: string;
  scope_hash: string;
  normalized_effect_hash: string;
  receipt_hash: string;
};

export type ReadTargetObservation = {
  path: string;
  /** SHA-256 of the complete bounded target at read preflight. */
  content_sha256: string;
  content_bytes: number;
  full_coverage: boolean;
  /** Actual inspected line span for a bounded partial read. */
  inspected_span?: ScopeReadSpan;
};

export type SessionBranchIdentity = {
  session_id?: string;
  branch_entry_ids: string[];
  /** Package-owned revision receipts observed in the current persisted branch. */
  evidence_revision_receipts?: EvidenceRevisionReceipt[];
  input_authority_receipts?: Array<{ entry_id: string; task_id: string; origin: "user-command" | "native-confirmation"; text_sha256: string }>;
  output_contract_receipts?: OutputContractReceipt[];
  output_validation_receipts?: OutputValidationReceipt[];
  quality_gate_resolution_receipts?: QualityGateResolutionReceipt[];
  scope_authorization_receipts?: ScopeAuthorizationReceipt[];
  scope_approval_receipts?: ScopeApprovalReceipt[];
  /** Installed lifecycle identity was unavailable; runtime evidence must fail closed. */
  lifecycle_identity?: "available" | "unavailable";
  observed_at: string;
};

export type TaskIdentity = {
  task_id: string;
  branch_id: string;
  created_workspace_revision: string;
  session_id?: string;
  session_anchor_entry_id?: string;
};

export type ToolHistoryItem = {
  timestamp: string;
  tool_call_id?: string;
  batch_id?: string;
  step_id?: string;
  tool: string;
  arguments_hash: string;
  arguments_preview: string;
  status: ToolStatus;
  summary?: string;
  raw_log_path?: string;
  workspace_revision_before?: string;
  workspace_revision_after?: string;
  failure_signature?: string;
};

export type VerificationRecord = {
  criterion: string;
  criterion_id?: string;
  status: VerificationStatus;
  evidence: string;
  remaining_work: string;
  source: "harness" | "model" | "user" | "runtime" | "legacy";
  updated_at: string;
};

export type Criterion = {
  id: string;
  requirement: string;
  expected_evidence: CriterionEvidenceKind;
  required: boolean;
  /** User criteria remain distinct from bounded host safety-review criteria. */
  origin?: "user" | "host-coding-review";
};

export type TrustedCheckMapping = {
  id: string;
  criterion_id: string;
  operation: string;
  command?: string;
  created_by: "host" | "user-command";
  created_at: string;
};

export type PendingToolCall = {
  tool_call_id: string;
  batch_id: string;
  operation: string;
  started_at: string;
  workspace_revision_before: string;
  input_hash: string;
  host_provenance: HostExecutionProvenance;
  /** Stable pre-execution observations for bounded full-file reads only. */
  read_targets?: ReadTargetObservation[];
  session_id?: string;
  session_anchor_entry_id?: string;
};

export type ExecutionReceipt = {
  id: string;
  task_id: string;
  branch_id: string;
  batch_id: string;
  tool_call_id?: string;
  /** Canonical current plan step captured before the host operation started. */
  step_id?: string;
  operation: string;
  command?: string;
  input_hash: string;
  outcome: ExecutionOutcome;
  execution_observed: boolean;
  host_provenance: HostExecutionProvenance;
  exit_code?: number;
  cwd: string;
  workspace_revision_before: string;
  workspace_revision_after: string;
  criterion_ids: string[];
  /** Host parser outcome for this exact check, independent of the native process exit. */
  validation_status?: VerificationStatus;
  artifact_refs: string[];
  /** Normalized host-observed target resources, including fetch URLs. */
  resource_refs: string[];
  /** Pre-execution observations carried from the exact matched pending call. */
  read_targets?: ReadTargetObservation[];
  batch_settled: boolean;
  session_id?: string;
  /** The persisted SessionManager toolResult entry, never the preflight call entry. */
  session_anchor_entry_id?: string;
  /** The event outcome that must match the persisted toolResult before anchoring. */
  result_is_error?: boolean;
  started_at: string;
  finished_at: string;
};

export type CriterionResult = {
  criterion_id: string;
  status: VerificationStatus;
  receipt_ids: string[];
  checked_workspace_revision: string;
  fresh: boolean;
  provenance: VerificationProvenance;
  recorded_at: string;
  evidence: string;
  remaining_work: string;
  attestation_id?: string;
  session_id?: string;
  session_anchor_entry_id?: string;
};

export type ModelVerificationClaim = {
  criterion_id?: string;
  criterion_text?: string;
  status: VerificationStatus;
  evidence: string;
  remaining_work: string;
  recorded_at: string;
};

export type CompletionGateRecord = {
  id: string;
  source: "verify-tool" | "worker-result" | "progress-tool" | "agent-end" | "plan-mode" | "message-end" | "explicit" | "gate-tool";
  decision: CompletionDecision;
  reasons: string[];
  checked_workspace_revision: string;
  created_at: string;
};

export type RecoveryEpisode = {
  step_id?: string;
  workspace_revision: string;
  failure_signature: string;
  attempts: number;
  actions: number;
  started_at: string;
  last_attempt_at: string;
};

export type RecoveryState = {
  total_attempts: number;
  total_actions: number;
  episodes: RecoveryEpisode[];
};

export type DurableIdCounters = {
  next_advisor_advice: number;
  next_criterion: number;
  next_mapping: number;
  next_receipt: number;
  next_gate: number;
  next_evidence_pack: number;
  next_scope: number;
  next_scope_change: number;
  next_approval: number;
  next_output_contract: number;
  next_output_validation: number;
  next_quality_gate_claim: number;
  next_quality_gate_escalation: number;
  next_quality_gate_assessment: number;
  next_quality_gate_resolution: number;
  next_checkpoint: number;
};

export type EvidenceFreshnessPolicy = {
  max_age_days: number;
  basis: "publishedAt" | "retrievedAt";
};

export type EvidencePassage = {
  passage_id: string;
  text: string;
  location?: string;
};

export type EvidenceSource = {
  source_id: string;
  title: string;
  locator: string;
  source_kind: EvidenceSourceKind;
  published_at?: string;
  retrieved_at: string;
  passages: EvidencePassage[];
};

export type EvidenceReference = {
  source_id: string;
  passage_ids: string[];
};

export type EvidenceConflictDisposition = {
  disposition: "prefer-source" | "report-conflict" | "exclude-claim" | "escalate";
  rationale: string;
  preferred_source_ids?: string[];
  disposed_at: string;
};

export type EvidenceClaim = {
  claim_id: string;
  claim: string;
  material: boolean;
  support: EvidenceReference[];
  contradicts: EvidenceReference[];
  conflict_disposition?: EvidenceConflictDisposition;
};

export type EvidenceLimits = {
  max_sources: number;
  max_passages: number;
  max_passages_per_source: number;
  max_passage_chars: number;
  max_claims: number;
};

export type JsonSchemaSubset = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchemaSubset>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaSubset;
  enum?: Array<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type StructuredOutputContractDefinition =
  | { format: "json"; semantic: StructuredOutputSemanticMode; schema: JsonSchemaSubset }
  | { format: "csv"; semantic: StructuredOutputSemanticMode; columns: string[]; hasHeader: boolean; minRows: number; maxRows: number }
  | { format: "enum"; semantic: StructuredOutputSemanticMode; values: string[] }
  | { format: "bounded-string"; semantic: StructuredOutputSemanticMode; minLength: number; maxLength: number }
  | { format: "markdown-checklist"; semantic: StructuredOutputSemanticMode; items: Array<{ text: string; checked: boolean }>; allowExtraItems: boolean };

export type StructuredOutputContract = {
  schema_version: 1;
  contract_id: string;
  task_id: string;
  branch_id: string;
  contract_path: string;
  /** Hash of the inspected contract file bytes. */
  contract_sha256: string;
  /** Canonical parsed definition fingerprint, independent of JSON whitespace/key order. */
  definition_sha256: string;
  definition: StructuredOutputContractDefinition;
  created_at: string;
  session_id?: string;
  session_anchor_entry_id?: string;
  receipt_hash?: string;
};

export type StructuredOutputValidation = {
  id: string;
  task_id: string;
  branch_id: string;
  contract_id: string;
  contract_sha256: string;
  candidate_sha256: string;
  result_sha256: string;
  validator_version: "structured-output-v1";
  candidate_chars: number;
  attempt: number;
  syntax_valid: boolean;
  schema_valid: boolean;
  /** Structural-only contracts are not semantic proof; human-reviewed results are attested. */
  semantic_check_state: "not-required" | "review-required" | "attested";
  semantic_checks_passed: boolean;
  human_review_required: boolean;
  decision: CompletionDecision;
  reasons: string[];
  validated_at: string;
  session_id?: string;
  session_anchor_entry_id?: string;
  receipt_hash?: string;
  superseded_by_contract_id?: string;
};

export type StructuredOutputState = {
  contracts: StructuredOutputContract[];
  active_contract_id?: string;
  validations: StructuredOutputValidation[];
  /** Counted when validation begins, even if later receipt persistence fails. */
  total_candidates_used: number;
  final_candidate_contract_id?: string;
  final_candidate_sha256?: string;
};

export type QualityGateClaim = {
  id: string;
  gate: ReliabilityGateName;
  criterion_id: string;
  status: VerificationStatus;
  evidence: string;
  artifact_refs: string[];
  recorded_at: string;
};

export type QualityGateEscalation = {
  id: string;
  reason: string;
  decision_needed: string;
  evidence_refs: string[];
  recorded_at: string;
  status: "pending" | "approved" | "rejected";
  resolved_at?: string;
  resolution_id?: string;
};

export type QualityGateResolution = {
  id: string;
  target_kind: "escalation" | "semantic-review";
  target_id: string;
  contract_id?: string;
  candidate_sha256?: string;
  decision: "approved" | "rejected";
  task_id: string;
  branch_id: string;
  resolved_at: string;
  session_id: string;
  session_anchor_entry_id: string;
  receipt_hash: string;
};

export type QualityGateAssessment = {
  id: string;
  gate: ReliabilityGateName;
  decision: CompletionDecision;
  reasons: string[];
  failed_criteria: string[];
  unknown_criteria: string[];
  unresolved_conflicts: string[];
  scope_violations: string[];
  approval_requests: string[];
  evidence_refs: string[];
  assessed_at: string;
};

export type QualityGateState = {
  claims: QualityGateClaim[];
  escalations: QualityGateEscalation[];
  resolutions: QualityGateResolution[];
  assessments: QualityGateAssessment[];
};

/** Records advisory delivery without treating advice as task authority or evidence. */
export type AdvisorUsage = {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unknown_usage_calls: number;
};

export type AdvisorAdviceRecord = {
  id: string;
  source: "manual-orchestration" | "automatic";
  status: AdvisorAdviceStatus;
  /** Distinguishes an unavailable/no-call disposition from an attempted provider call. */
  attempted: boolean;
  reason: string;
  advice_sha256?: string;
  model?: string;
  trigger?: AdvisorTrigger;
  trigger_identity?: string;
  reservation_id?: string;
  usage?: { input_tokens: number; output_tokens: number; cost_usd: number };
  recorded_at: string;
};

/** Durable pre-dispatch reservation for one automatic data-only advisor attempt. */
export type AdvisorReservation = {
  id: string;
  task_id: string;
  session_id?: string;
  branch_id: string;
  trigger: AdvisorTrigger;
  trigger_identity: string;
  model: string;
  reserved_input_tokens: number;
  reserved_output_tokens: number;
  reserved_cost_usd: number;
  created_at: string;
};

export type AdvisorState = {
  records: AdvisorAdviceRecord[];
  /** Incremented at reservation time, before an asynchronous provider call. */
  automatic_calls_used: number;
  /** Actual finite provider usage from settled attempts only. */
  automatic_usage: AdvisorUsage;
  /** Capacity held before dispatch; retained across reload when an attempt cannot be reconciled. */
  automatic_reservations: AdvisorReservation[];
  /** Attempted trigger identities, including rejected/cancelled attempts, to prevent replay. */
  automatic_trigger_ids: string[];
  last_trigger?: AdvisorTrigger;
};

export type CodingBoundaryFile = {
  path: string;
  sha256: string;
  bytes: number;
};

export type CodingChange = {
  path: string;
  kind: CodingChangeKind;
  before_sha256?: string;
  after_sha256?: string;
};

export type CodingReviewDisposition = {
  kind: CodingReviewKind;
  diff_hash: string;
  /** Superseded records retain the prior exact-diff review history but cannot satisfy a new diff. */
  status: "pending" | "attested" | "superseded";
  criterion_id: string;
  attestation_id?: string;
  session_id?: string;
  session_anchor_entry_id?: string;
  superseded_at?: string;
};

export type CodingRepairCycle = {
  /** First successful mutation after a failed validation starts one repair cycle. */
  started_by_receipt_id: string;
  mutation_receipt_ids: string[];
  started_at: string;
  /** The next trusted validation closes this cycle; only a failure permits another cycle. */
  closed_by_receipt_id?: string;
  outcome?: "failed" | "passed";
  closed_at?: string;
};

/** A durable interval starts at an initial failed validation and permits at most two repair cycles. */
export type CodingRepairInterval = {
  failure_receipt_id: string;
  failure_revision: string;
  step_id?: string;
  cycles?: CodingRepairCycle[];
  /** Legacy v2 shape accepted on reload and normalized to a single cycle when touched. */
  repair_receipt_ids?: string[];
  opened_at: string;
  closed_by_receipt_id?: string;
  closed_at?: string;
};

/** Host-owned task boundary; models cannot mint or replace its baseline. */
export type CodingBoundary = {
  status: CodingBoundaryStatus;
  task_id: string;
  branch_id: string;
  baseline_path?: "coding-baseline.json";
  baseline_sha256?: string;
  baseline_workspace_revision?: string;
  scope_id?: string;
  scope_hash?: string;
  allowed_write_paths: string[];
  captured_at?: string;
  reason?: string;
  review_dispositions?: CodingReviewDisposition[];
  repair_intervals?: CodingRepairInterval[];
};

export type DependencyEvidence = {
  pack_id: string;
  package_name: string;
  installed_version: string;
  manifest_path: string;
  lockfile_path?: string;
  source_kind: DependencyEvidenceSourceKind;
  source_id: string;
  passage_ids: string[];
  feature_flags: string[];
  status: DependencyEvidenceStatus;
  reasons: string[];
  manifest_receipt_id?: string;
  lockfile_receipt_id?: string;
  /** Exact hash of the selected evidence-pack source and passage content. */
  source_content_sha256?: string;
  /** Current host receipt that observed the source locator or its bounded parser result. */
  source_receipt_id?: string;
  recorded_at: string;
};

export type EvidencePack = {
  schema_version: 1;
  pack_id: string;
  task_id: string;
  branch_id: string;
  /** Pi session provenance is required when the task has an available session identity. */
  session_id?: string;
  /** A persisted SessionManager branch entry that existed when this revision was recorded. */
  session_anchor_entry_id?: string;
  question: string;
  requirements: string[];
  limits: EvidenceLimits;
  freshness?: EvidenceFreshnessPolicy;
  sources: EvidenceSource[];
  claims: EvidenceClaim[];
  dependencies: DependencyEvidence[];
  created_at: string;
  updated_at: string;
};

export type EvidenceAssessmentSummary = {
  outcome: EvidenceAssessmentOutcome;
  integrity_passed: boolean;
  semantic_review_required: boolean;
  freshness_status: EvidenceFreshnessStatus;
  unresolved_conflict_claim_ids: string[];
  unsupported_material_claim_ids: string[];
  issue_count: number;
  assessed_at: string;
};

export type EvidencePackSummary = {
  pack_id: string;
  task_id: string;
  branch_id: string;
  session_id?: string;
  session_anchor_entry_id?: string;
  /** Session that persisted the append-only receipt for this exact SHA-256 revision. */
  revision_session_id?: string;
  /** Persisted package-owned custom entry that binds this exact SHA-256 revision. */
  revision_receipt_entry_id?: string;
  question: string;
  evidence_path: string;
  sha256: string;
  source_count: number;
  passage_count: number;
  claim_count: number;
  freshness?: EvidenceFreshnessPolicy;
  assessment?: EvidenceAssessmentSummary;
  created_at: string;
  updated_at: string;
};

export type RetrievalConfig = {
  maxSources: number;
  maxPassages: number;
  maxPassageChars: number;
  maxClaims: number;
  requireMaterialClaimCitations: boolean;
  requireConflictDisposition: boolean;
};

export type ScopeConfig = {
  maxToolCalls: number;
  maxErrors: number;
  maxIterations: number;
  approvalTtlMs: number;
  phaseToolFocus: boolean;
};

export type StructuredOutputConfig = {
  maxCandidateChars: number;
  maxSchemaChars: number;
  maxCandidatesPerTask: number;
};

export type EvaluationConfig = {
  liveModels: string[];
  timeoutMs: number;
  maxCases: number;
};

/** A bounded per-model policy derived from held-out host-oracle results or labeled unvalidated. */
export type ModelProfile = {
  model: string;
  validation: "held-out" | "unvalidated";
  evidence_provenance?: string;
  context_budget_chars: number;
  max_tool_calls: number;
  max_recovery_attempts: number;
};

/** Automatic advice is disabled unless every authorization and resource field is user-configured. */
export type AdvisorConfig = {
  automatic: boolean;
  exactModel?: string;
  dataScope?: AdvisorDataScope;
  maxCalls: number;
  maxRuntimeMs: number;
  maxOutputChars: number;
  maxTotalTokens: number;
  maxTotalCostUsd: number;
};

export type StateMigration = {
  source_schema_version: 1 | 2;
  backup_pending: boolean;
  backup_path?: string;
  migrated_at?: string;
  /** Persists until the migration audit event has been durably appended. */
  event_pending?: boolean;
};

export type TaskStateV1 = {
  schema_version: 1;
  task_id: string;
  created_at: string;
  updated_at: string;
  cwd: string;
  session_file?: string;
  status: TaskStatus;
  user_goal: string;
  normalized_goal: string;
  success_criteria: string[];
  constraints: string[];
  current_phase: string;
  current_step_id: string;
  plan: PlanStep[];
  completed_steps: string[];
  blocked_steps: string[];
  known_facts: string[];
  open_questions: string[];
  decisions: string[];
  tool_history: ToolHistoryItem[];
  files_touched: string[];
  read_files: string[];
  modified_files: string[];
  errors: string[];
  loop_warnings: string[];
  verification: VerificationRecord[];
  next_action: string;
  final_answer_requirements: string[];
  counters: {
    context_injections: number;
    model_responses: number;
    tool_calls: number;
    repeated_action_limit: number;
  };
};

export type TaskStateV2 = Omit<TaskStateV1, "schema_version" | "counters"> & {
  schema_version: 2;
  lane: WorkflowLane;
  /** Provider-visible continuity epoch. It changes only after a verified reset receipt. */
  context_epoch: number;
  context_checkpoints: ContextCheckpointSummary[];
  active_checkpoint_id?: string;
  context_reset: ContextResetState;
  evidence_packs: EvidencePackSummary[];
  active_evidence_pack_id?: string;
  structured_output: StructuredOutputState;
  quality_gate: QualityGateState;
  advisor_state: AdvisorState;
  /** Dependency/API records are hash-bound to their containing evidence packs. */
  dependency_evidence: DependencyEvidence[];
  /** Immutable baseline and exact-diff safety review state for coding tasks. */
  coding_boundary: CodingBoundary;
  scope_state: ScopeState;
  criteria: Criterion[];
  trusted_check_mappings: TrustedCheckMapping[];
  execution_receipts: ExecutionReceipt[];
  criterion_results: CriterionResult[];
  model_verification_claims: ModelVerificationClaim[];
  completion_gates: CompletionGateRecord[];
  task_identity: TaskIdentity;
  workspace_revision: WorkspaceRevision;
  pending_tool_calls: PendingToolCall[];
  current_session: SessionBranchIdentity;
  recovery: RecoveryState;
  id_counters: DurableIdCounters;
  retired_criterion_ids: string[];
  /** Unconfirmed text is kept only in live memory; persisted observations contain no raw text. */
  input_pause?: { observation_id: string; text_sha256: string; session_id?: string; branch_anchor_entry_id?: string };
  authoritative_instructions: AuthoritativeInstructions;
  working_context: WorkingContext;
  migration: StateMigration;
  counters: TaskStateV1["counters"] & {
    blocked_calls: number;
    errors_used: number;
    iterations_used: number;
  };
};

/** The only mutable task format written by this package. */
export type TaskState = TaskStateV2;

export type ContextResetConfig = {
  mode: "automatic" | "off";
  phaseBoundaries: boolean;
  eligibleTransientTokens: number;
  contextUsageRatio: number;
  hardContextUsageRatio: number;
  cooldownTurns: number;
  maxAutomaticResetsPerPhase: number;
  maxCheckpointChars: number;
  maxContinuationSeedChars: number;
  /** Upper bound for one discover, reset, or restore adapter stage. */
  adapterTimeoutMs: number;
  unsupportedTransport: "checkpoint-only" | "retain-context";
  expireUnusedApprovals: boolean;
};

export type ReliabilityConfig = {
  enabled: boolean;
  retrieval: RetrievalConfig;
  scope: ScopeConfig;
  structuredOutput: StructuredOutputConfig;
  contextReset: ContextResetConfig;
  evaluation: EvaluationConfig;
  advisor: AdvisorConfig;
  modelProfiles: ModelProfile[];
  profile: ReliabilityProfile;
  requirePlan: boolean;
  requireVerification: boolean;
  maxRepeatedAction: number;
  maxRecoveryAttempts: number;
  maxRecoveryActions: number;
  maxRecoveryElapsedMs: number;
  scratchpadEnabled: boolean;
  contextBudgetChars: number;
  contextMode: ContextHeaderMode;
  supervisionMode: ReliabilitySupervisionMode;
  progressWidget: boolean;
  storeRawToolLogs: boolean;
  rawLogMaxChars: number;
  orchestrationMode: OrchestrationMode;
  orchestrationModels: Partial<Record<ReliabilityRole, string>>;
  orchestrationTools: string[];
  orchestrationMaxOutputChars: number;
  orchestrationTimeoutMs: number;
  orchestrationMaxStdoutChars: number;
  orchestrationMaxStderrChars: number;
  orchestrationMaxLineChars: number;
  orchestrationMaxTotalOutputChars: number;
  orchestrationMaxTotalTokens: number;
  orchestrationMaxTotalCostUsd: number;
};

export type VerificationCommandSuggestion = {
  command: string;
  label: string;
  reason: string;
};

export type TaskSummary = {
  task_id: string;
  status: TaskStatus;
  goal: string;
  updated_at: string;
  current_step_id: string;
  progress: string;
  archived: boolean;
};

export type ParsedVerificationResult = {
  command: string;
  framework: string;
  status: VerificationStatus;
  summary: string;
  failure_excerpt?: string;
  counts?: {
    passed?: number;
    failed?: number;
    errors?: number;
    warnings?: number;
  };
};

export type CompletionGateResult = {
  triggered: boolean;
  strict: boolean;
  failed: number;
  unknown: number;
  decision: CompletionDecision;
  reasons: string[];
  message: string;
  verification: VerificationRecord[];
};

export type WorkingContextEntry = {
  text: string;
  recorded_at: string;
  evidence_refs: string[];
};

export type AuthoritativeInstruction = {
  text: string;
  origin: "interactive" | "rpc" | "user-command" | "native-confirmation";
  recorded_at: string;
  session_id?: string;
  session_entry_id?: string;
};

export type AuthoritativeInstructions = {
  original_user_request: AuthoritativeInstruction;
  corrections: AuthoritativeInstruction[];
};

export type WorkingContext = {
  observations: WorkingContextEntry[];
  claims: WorkingContextEntry[];
  hypotheses: WorkingContextEntry[];
};

export type ContextSnapshot = {
  goal: string;
  currentStepId: string;
  planStatuses: string;
  completedSteps: string;
  blockedSteps: string;
  latestFacts: string;
  latestErrors: string;
  latestWarnings: string;
  verificationStatuses: string;
  evidenceSummary: string;
  scopeSummary: string;
  nextAction: string;
  filesTouched: string;
};

export type ContextHeaderResult = {
  header: string;
  snapshot: ContextSnapshot;
};

export type ContextCheckpointSummary = {
  checkpoint_id: string;
  sequence: number;
  schema_version: 1;
  from_lane: WorkflowLane;
  to_lane: ContextTargetLane;
  phase_id: string;
  artifact_path: string;
  artifact_sha256: string;
  canonical_state_sha256: string;
  scope_sha256?: string;
  evidence_packs: Array<{ pack_id: string; sha256: string }>;
  context_epoch_before: number;
  context_epoch_after?: number;
  trigger: ContextCheckpointTrigger;
  status: ContextCheckpointStatus;
  created_at: string;
  reset_receipt_hash?: string;
  provider_visible_manifest_sha256?: string;
  session_id?: string;
  session_anchor_entry_id?: string;
  /** Immutable task-local canonical snapshot for this exact checkpoint. */
  snapshot_path?: string;
  snapshot_sha256?: string;
  candidate_next_action_sha256?: string;
  request_artifact_path?: string;
  request_artifact_sha256?: string;
  receipt_artifact_path?: string;
  receipt_artifact_sha256?: string;
  restore_artifact_path?: string;
  restore_artifact_sha256?: string;
};

export type ContextResetCandidate = {
  from_lane: WorkflowLane;
  to_lane: ContextTargetLane;
  phase_id: string;
  trigger: ContextCheckpointTrigger;
  next_action: string;
  gate_decision: CompletionDecision;
  estimated_transient_tokens?: number;
  context_usage_ratio?: number;
  /** A lifecycle-recorded boundary, never merely a non-empty phase string. */
  stable_boundary_id?: string;
  turn_index: number;
};

export type ContextResetState = {
  status: ContextResetStatus;
  auto_enabled: boolean;
  turn_index: number;
  phase_id?: string;
  last_attempt_at?: string;
  last_reason?: string;
  cooldown_until_turn?: number;
  repair_attempts: number;
  mutation_blocked: boolean;
  /** Stronger than status: only a verified explicit recovery can release it. */
  freeze_reason?: string;
  freeze_request_id?: string;
  stable_boundary_id?: string;
  pending_candidate?: ContextResetCandidate;
};

export type ContextCuratorCapability = {
  schema_version: 1;
  adapter_id: string;
  provider_id: string;
  transport_id: string;
  session_id: string;
  branch_anchor_entry_id: string;
  can_reset_provider_continuation: boolean;
  can_restore_previous_epoch: boolean;
  transport_proof: "real-provider-reset-v1" | "simulated" | "unsupported";
  integration_origin: "trusted-host" | "event-bus" | "test";
};

export type ContextResetRequest = {
  schema_version: 1;
  request_id: string;
  task_id: string;
  checkpoint_id: string;
  session_id: string;
  branch_anchor_entry_id: string;
  from_epoch: number;
  to_epoch: number;
  from_lane: WorkflowLane;
  to_lane: ContextTargetLane;
  phase_id: string;
  checkpoint_path: string;
  checkpoint_sha256: string;
  snapshot_path: string;
  snapshot_sha256: string;
  canonical_state_sha256: string;
  scope_sha256?: string;
  evidence_packs: Array<{ pack_id: string; sha256: string }>;
  unresolved_decision_count: number;
  next_action_sha256: string;
  continuation_seed_sha256: string;
  continuation_seed: string;
  /** Exact observed provider-visible continuation manifest expected after reset. */
  continuation_manifest: string;
  continuation_manifest_sha256: string;
};

export type ContextResetReceipt = {
  schema_version: 1;
  outcome: "checkpoint-only" | "reset-complete" | "recovery-required";
  request_id: string;
  task_id: string;
  checkpoint_id: string;
  session_id: string;
  branch_anchor_entry_id: string;
  from_epoch: number;
  to_epoch: number;
  from_lane: WorkflowLane;
  to_lane: ContextTargetLane;
  phase_id: string;
  checkpoint_sha256: string;
  canonical_state_sha256: string;
  scope_sha256?: string;
  evidence_packs: Array<{ pack_id: string; sha256: string }>;
  unresolved_decision_count: number;
  next_action_sha256: string;
  continuation_seed_sha256: string;
  continuation_manifest_sha256: string;
  /** Content observed from the provider/transport, rehashed by the coordinator. */
  provider_visible_manifest?: string;
  provider_visible_manifest_sha256?: string;
  reason?: string;
};

export type PersistedExtensionState = {
  enabled: boolean;
  taskId?: string;
  taskDir?: string;
  updatedAt: string;
};

export const CUSTOM_STATE_TYPE = "reliability-harness-state";
export const STATUS_KEY = "reliability";
export const WIDGET_KEY = "reliability-harness";
export const DEFAULT_CONTEXT_BUDGET_CHARS = 6000;
export const MAX_HISTORY = 80;
export const MAX_FACTS = 40;
export const MAX_ERRORS = 30;
export const DEFAULT_RAW_LOG_MAX_CHARS = 50_000;
export const DEFAULT_ORCHESTRATION_MAX_OUTPUT_CHARS = 50_000;
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  maxSources: 12,
  maxPassages: 24,
  maxPassageChars: 2_000,
  maxClaims: 30,
  requireMaterialClaimCitations: true,
  requireConflictDisposition: true,
};

export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
  maxToolCalls: 48,
  maxErrors: 3,
  maxIterations: 24,
  approvalTtlMs: 5 * 60 * 1_000,
  phaseToolFocus: false,
};

export const DEFAULT_STRUCTURED_OUTPUT_CONFIG: StructuredOutputConfig = {
  maxCandidateChars: 50_000,
  maxSchemaChars: 32_000,
  maxCandidatesPerTask: 3,
};

export const DEFAULT_EVALUATION_CONFIG: EvaluationConfig = {
  liveModels: [],
  timeoutMs: 120_000,
  maxCases: 50,
};

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  automatic: false,
  exactModel: undefined,
  dataScope: undefined,
  maxCalls: 0,
  maxRuntimeMs: 30_000,
  maxOutputChars: 8_000,
  maxTotalTokens: 0,
  maxTotalCostUsd: 0,
};

export const DEFAULT_CONTEXT_RESET_CONFIG: ContextResetConfig = {
  mode: "automatic",
  phaseBoundaries: true,
  eligibleTransientTokens: 12_000,
  contextUsageRatio: 0.35,
  hardContextUsageRatio: 0.70,
  cooldownTurns: 4,
  maxAutomaticResetsPerPhase: 1,
  maxCheckpointChars: 24_000,
  maxContinuationSeedChars: 16_000,
  adapterTimeoutMs: 5_000,
  unsupportedTransport: "checkpoint-only",
  expireUnusedApprovals: true,
};

const ORCHESTRATION_RESOURCE_DEFAULTS = {
  orchestrationTimeoutMs: 30_000,
  orchestrationMaxStdoutChars: 100_000,
  orchestrationMaxStderrChars: 40_000,
  orchestrationMaxLineChars: 16_000,
  orchestrationMaxTotalOutputChars: 100_000,
  orchestrationMaxTotalTokens: 16_384,
  orchestrationMaxTotalCostUsd: 10,
};

export const PROFILE_DEFAULTS: Record<ReliabilityProfile, Omit<ReliabilityConfig, "enabled" | "profile">> = {
  strict: {
    retrieval: DEFAULT_RETRIEVAL_CONFIG,
    scope: DEFAULT_SCOPE_CONFIG,
    structuredOutput: DEFAULT_STRUCTURED_OUTPUT_CONFIG,
    contextReset: DEFAULT_CONTEXT_RESET_CONFIG,
    evaluation: DEFAULT_EVALUATION_CONFIG,
    advisor: DEFAULT_ADVISOR_CONFIG,
    modelProfiles: [],
    requirePlan: true,
    requireVerification: true,
    maxRepeatedAction: 2,
    maxRecoveryAttempts: 2,
    maxRecoveryActions: 6,
    maxRecoveryElapsedMs: 10 * 60 * 1000,
    scratchpadEnabled: true,
    contextBudgetChars: DEFAULT_CONTEXT_BUDGET_CHARS,
    contextMode: "full",
    supervisionMode: "supervised",
    progressWidget: true,
    storeRawToolLogs: false,
    rawLogMaxChars: DEFAULT_RAW_LOG_MAX_CHARS,
    orchestrationMode: "prompt",
    orchestrationModels: {},
    orchestrationTools: ["read", "grep", "find", "ls"],
    orchestrationMaxOutputChars: DEFAULT_ORCHESTRATION_MAX_OUTPUT_CHARS,
    ...ORCHESTRATION_RESOURCE_DEFAULTS,
  },
  balanced: {
    retrieval: DEFAULT_RETRIEVAL_CONFIG,
    scope: DEFAULT_SCOPE_CONFIG,
    structuredOutput: DEFAULT_STRUCTURED_OUTPUT_CONFIG,
    contextReset: DEFAULT_CONTEXT_RESET_CONFIG,
    evaluation: DEFAULT_EVALUATION_CONFIG,
    advisor: DEFAULT_ADVISOR_CONFIG,
    modelProfiles: [],
    requirePlan: true,
    requireVerification: true,
    maxRepeatedAction: 3,
    maxRecoveryAttempts: 2,
    maxRecoveryActions: 6,
    maxRecoveryElapsedMs: 10 * 60 * 1000,
    scratchpadEnabled: true,
    contextBudgetChars: DEFAULT_CONTEXT_BUDGET_CHARS,
    contextMode: "compact",
    supervisionMode: "adaptive",
    progressWidget: true,
    storeRawToolLogs: false,
    rawLogMaxChars: DEFAULT_RAW_LOG_MAX_CHARS,
    orchestrationMode: "prompt",
    orchestrationModels: {},
    orchestrationTools: ["read", "grep", "find", "ls"],
    orchestrationMaxOutputChars: DEFAULT_ORCHESTRATION_MAX_OUTPUT_CHARS,
    ...ORCHESTRATION_RESOURCE_DEFAULTS,
  },
  relaxed: {
    retrieval: DEFAULT_RETRIEVAL_CONFIG,
    scope: DEFAULT_SCOPE_CONFIG,
    structuredOutput: DEFAULT_STRUCTURED_OUTPUT_CONFIG,
    contextReset: DEFAULT_CONTEXT_RESET_CONFIG,
    evaluation: DEFAULT_EVALUATION_CONFIG,
    advisor: DEFAULT_ADVISOR_CONFIG,
    modelProfiles: [],
    requirePlan: false,
    requireVerification: false,
    maxRepeatedAction: 5,
    maxRecoveryAttempts: 3,
    maxRecoveryActions: 8,
    maxRecoveryElapsedMs: 15 * 60 * 1000,
    scratchpadEnabled: true,
    contextBudgetChars: DEFAULT_CONTEXT_BUDGET_CHARS,
    contextMode: "delta",
    supervisionMode: "lite",
    progressWidget: true,
    storeRawToolLogs: false,
    rawLogMaxChars: DEFAULT_RAW_LOG_MAX_CHARS,
    orchestrationMode: "prompt",
    orchestrationModels: {},
    orchestrationTools: ["read", "grep", "find", "ls"],
    orchestrationMaxOutputChars: DEFAULT_ORCHESTRATION_MAX_OUTPUT_CHARS,
    ...ORCHESTRATION_RESOURCE_DEFAULTS,
  },
};

export const DEFAULT_CONFIG: ReliabilityConfig = {
  enabled: false,
  profile: "balanced",
  ...PROFILE_DEFAULTS.balanced,
};

export const StepStatusSchema = StringEnum(["pending", "in_progress", "complete", "blocked", "skipped"] as const);
export const TaskStatusSchema = StringEnum(["planning", "executing", "blocked", "verifying", "complete", "failed"] as const);
export const VerificationStatusSchema = StringEnum(["passed", "failed", "unknown"] as const);
export const OrchestrationModeSchema = StringEnum(["prompt", "separate-model"] as const);
