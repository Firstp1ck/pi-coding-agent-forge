export const MAX_RESEARCH_CHARS = 18_000;
export const MAX_REVIEW_CHARS = 10_000;
export const MODEL_KEYS = ["a", "b"] as const;
export const JOB_KEYS = ["research-a", "research-b", "review-a", "review-b", "draft"] as const;
export const RECIPROCAL_REVIEW_RUBRIC = [
  "task-specific usefulness and actionable routing guidance",
  "quality, relevance, and provenance of cited evidence",
  "separation of documented or measured evidence from anecdotes",
  "counterevidence, conditions, limitations, and access gaps",
  "skill-writing suitability supported by task-specific evidence",
] as const;
export const FIXED_REFERENCE_PATHS = [
  "references/research-a.json",
  "references/research-b.json",
  "references/review-a.json",
  "references/review-b.json",
  "references/decision.json",
] as const;

export type ModelKey = (typeof MODEL_KEYS)[number];
/** Unverified comparison labels, never execution targets or capability claims. */
export type ComparisonSubject = { readonly key: ModelKey; readonly model: string };
export type ComparisonSubjects = readonly [ComparisonSubject, ComparisonSubject];
export type JobKey = (typeof JOB_KEYS)[number];
export type WorkflowStage = "research" | "review" | "writer_selection" | "draft" | "complete";
export type RunStatus = "running" | "awaiting_writer" | "error" | "cancelled" | "complete";
export type JobStage = "research" | "review" | "draft";
export type JobStatus = "ready" | "dispatching" | "pending" | "complete" | "error" | "cancelled";
export type SourceAccess = "fetched" | "snippet" | "inaccessible";
export type EvidenceClass = "documented" | "measured" | "anecdotal";
export type EvidenceTopic = "general-routing" | "skill-writing" | "cost" | "latency" | "tool-use" | "other";

export type ModelTarget = {
  key: ModelKey;
  displayName: string;
  modelAuthor: string;
  model: string;
  hostingProvider: string;
  transport: string;
  settings: Record<string, string | number | boolean | null>;
};

export type PerCallLimits = {
  timeoutMs: number;
  maxTurns: number;
  maxTokens: number;
};

export type RunLimits = {
  maxJobs: 5;
  perCall: PerCallLimits;
  expiresAt: string;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  turns?: number;
  costUsd?: number;
};

export type RuntimeComplete = {
  status: "complete";
  text: string;
  usage?: Usage;
};

export type RuntimePending = {
  status: "pending";
  taskId: string;
};

export type RuntimeOutcome = RuntimeComplete | RuntimePending;

export type WorkflowJob = {
  key: JobKey;
  requestId: string;
  target: ModelKey;
  stage: JobStage;
  prompt: string;
  limits: PerCallLimits;
  status: JobStatus;
  taskId?: string;
  result?: string;
  error?: string;
  usage?: Usage;
  dispatchedAt?: string;
  finishedAt?: string;
  cancellationAcknowledgedAt?: string;
  cancellationError?: string;
  statusError?: string;
};

export type Runtime = {
  kind: "pi" | "t3";
  preflight?(job: WorkflowJob, signal?: AbortSignal): unknown | Promise<unknown>;
  start(job: WorkflowJob, signal?: AbortSignal): Promise<RuntimeOutcome>;
  check(job: WorkflowJob, signal?: AbortSignal): Promise<RuntimeOutcome>;
  cancel(job: WorkflowJob, signal?: AbortSignal): Promise<void>;
};

export type ResearchEvidence = {
  id: string;
  url: string;
  accessedAt: string;
  sourceAccess: SourceAccess;
  evidenceClass: EvidenceClass;
  topics: EvidenceTopic[];
  /** Comparison subject key; this is not a worker capability assertion. */
  supportsTarget: ModelKey | "neither";
  title: string;
  excerptOrGap: string;
  conditions: string;
};

export type ArgumentRow = {
  id: string;
  task: string;
  claim: string;
  classification: EvidenceClass;
  evidenceIds: string[];
  support: string;
  counterevidence: string;
  conditions: string;
  recommendation: string;
  confidence: number;
};

export type SocialCoverageEntry = {
  status: "covered" | "gap";
  evidenceIds: string[];
  gap: string;
};

export type SocialCoverage = {
  x: SocialCoverageEntry;
  reddit: SocialCoverageEntry;
  other: SocialCoverageEntry & { platforms: string[] };
};

export type ResearchReport = {
  schemaVersion: 1;
  researcher: ModelTarget;
  /** Required by validation only when the run has explicit comparison subjects. */
  subjects?: ComparisonSubjects;
  subjectTargets: [ModelKey, ModelKey];
  asOfDate: string;
  taskSpecificRecommendation: string;
  arguments: ArgumentRow[];
  evidence: ResearchEvidence[];
  counterevidenceAndConditions: string[];
  confidence: number;
  socialCoverage: SocialCoverage;
  accessGaps: string[];
};

export type ReviewCorrection = {
  argumentId: string;
  issue: string;
  correction: string;
  evidenceIds: string[];
};

export type ReviewDisagreement = {
  topic: string;
  position: string;
  evidenceIds: string[];
};

export type ReviewReport = {
  schemaVersion: 1;
  reviewer: ModelTarget;
  reviewedOriginals: [ModelKey, ModelKey];
  rubric: string[];
  usefulnessVsOwn: {
    verdict: "peer_more_useful" | "own_more_useful" | "mixed" | "equivalent";
    explanation: string;
  };
  corrections: ReviewCorrection[];
  disagreements: ReviewDisagreement[];
  missingEvidence: string[];
  writerRecommendation: ModelKey | "undetermined";
  writerEvidenceIds: string[];
  confidence: number;
};

export type FrozenResearch = {
  raw: string;
  parsed: ResearchReport;
};

export type FrozenReview = {
  raw: string;
  parsed: ReviewReport;
};

export type WriterSelection = {
  target: ModelKey;
  mode: "automatic" | "user";
  rationale: string;
  evidenceIds: string[];
  selectedAt: string;
};

export type RunError = {
  code: "invalid_output" | "runtime_error" | "uncertain_dispatch" | "expired" | "invalid_state";
  message: string;
  jobKey?: JobKey;
};

export type WorkflowRun = {
  schemaVersion: 1;
  scope?: "overall";
  runId: string;
  task: string;
  asOfDate: string;
  createdAt: string;
  updatedAt: string;
  stage: WorkflowStage;
  status: RunStatus;
  targets: [ModelTarget, ModelTarget];
  /** Canonical comparison data, immutable across saved checkpoints. */
  subjects?: ComparisonSubjects;
  limits: RunLimits;
  jobs: WorkflowJob[];
  originals?: {
    frozenAt: string;
    a: FrozenResearch;
    b: FrozenResearch;
  };
  reviews?: {
    frozenAt: string;
    a: FrozenReview;
    b: FrozenReview;
  };
  writerSelection?: WriterSelection;
  skillDraft?: string;
  error?: RunError;
  cancellationReason?: string;
  cancellationErrors?: string[];
  cancelledAt?: string;
  completedAt?: string;
};

export type CreateRunInput = {
  runId: string;
  task?: string;
  asOfDate: string;
  createdAt: string;
  targets: [ModelTarget, ModelTarget];
  /** Normalize UI/tool strings with normalizeSubjects before creating a run. */
  subjects?: ComparisonSubjects;
  limits: RunLimits;
};

export type SaveCheckpoint = (run: WorkflowRun) => void | Promise<void>;
