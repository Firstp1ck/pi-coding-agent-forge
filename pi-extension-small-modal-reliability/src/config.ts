import type { AdvisorConfig, ContextHeaderMode, ContextResetConfig, EvaluationConfig, ModelProfile, OrchestrationMode, ReliabilityConfig, ReliabilityProfile, ReliabilityRole, ReliabilitySupervisionMode, RetrievalConfig, ScopeConfig, StructuredOutputConfig } from "./types.ts";
import { DEFAULT_ADVISOR_CONFIG, DEFAULT_CONFIG, DEFAULT_CONTEXT_RESET_CONFIG, DEFAULT_EVALUATION_CONFIG, DEFAULT_RETRIEVAL_CONFIG, DEFAULT_SCOPE_CONFIG, DEFAULT_STRUCTURED_OUTPUT_CONFIG, PROFILE_DEFAULTS } from "./types.ts";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;

export function normalizeProfile(value: unknown): ReliabilityProfile {
  return value === "strict" || value === "balanced" || value === "relaxed" ? value : DEFAULT_CONFIG.profile;
}

export function normalizeContextMode(value: unknown, fallback: ContextHeaderMode): ContextHeaderMode {
  return value === "full" || value === "compact" || value === "delta" ? value : fallback;
}

export function normalizeOrchestrationMode(value: unknown, fallback: OrchestrationMode): OrchestrationMode {
  return value === "prompt" || value === "separate-model" ? value : fallback;
}

export function normalizeSupervisionMode(value: unknown, fallback: ReliabilitySupervisionMode): ReliabilitySupervisionMode {
  return value === "adaptive" || value === "lite" || value === "supervised" ? value : fallback;
}

function normalizeRoleModels(value: unknown): Partial<Record<ReliabilityRole, string>> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const result: Partial<Record<ReliabilityRole, string>> = {};
  for (const role of ["supervisor", "worker", "verifier"] as const) {
    const model = input[role];
    if (typeof model === "string" && MODEL_ID_PATTERN.test(model.trim())) result[role] = model.trim();
  }
  return result;
}

function normalizeTools(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const tools = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
  return tools.length > 0 ? [...new Set(tools)] : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numberValue = Math.trunc(Number(value));
  return Number.isFinite(numberValue) ? Math.max(minimum, Math.min(maximum, numberValue)) : fallback;
}

function boundedCost(value: unknown, fallback: number, maximum: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, Math.min(maximum, numberValue)) : fallback;
}

function normalizeRetrievalConfig(value: unknown): RetrievalConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_RETRIEVAL_CONFIG };
  const input = value as Partial<RetrievalConfig>;
  return {
    maxSources: boundedInteger(input.maxSources, DEFAULT_RETRIEVAL_CONFIG.maxSources, 1, 12),
    maxPassages: boundedInteger(input.maxPassages, DEFAULT_RETRIEVAL_CONFIG.maxPassages, 1, 24),
    maxPassageChars: boundedInteger(input.maxPassageChars, DEFAULT_RETRIEVAL_CONFIG.maxPassageChars, 1, 2_000),
    maxClaims: boundedInteger(input.maxClaims, DEFAULT_RETRIEVAL_CONFIG.maxClaims, 1, 30),
    requireMaterialClaimCitations: input.requireMaterialClaimCitations !== false,
    requireConflictDisposition: input.requireConflictDisposition !== false,
  };
}

function normalizeScopeConfig(value: unknown): ScopeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_SCOPE_CONFIG };
  const input = value as Partial<ScopeConfig>;
  return {
    maxToolCalls: boundedInteger(input.maxToolCalls, DEFAULT_SCOPE_CONFIG.maxToolCalls, 1, 500),
    maxErrors: boundedInteger(input.maxErrors, DEFAULT_SCOPE_CONFIG.maxErrors, 1, 100),
    maxIterations: boundedInteger(input.maxIterations, DEFAULT_SCOPE_CONFIG.maxIterations, 1, 500),
    approvalTtlMs: boundedInteger(input.approvalTtlMs, DEFAULT_SCOPE_CONFIG.approvalTtlMs, 1_000, 60 * 60 * 1_000),
    phaseToolFocus: input.phaseToolFocus === true,
  };
}

function normalizeStructuredOutputConfig(value: unknown): StructuredOutputConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_STRUCTURED_OUTPUT_CONFIG };
  const input = value as Partial<StructuredOutputConfig>;
  return {
    maxCandidateChars: boundedInteger(input.maxCandidateChars, DEFAULT_STRUCTURED_OUTPUT_CONFIG.maxCandidateChars, 1_000, 50_000),
    maxSchemaChars: boundedInteger(input.maxSchemaChars, DEFAULT_STRUCTURED_OUTPUT_CONFIG.maxSchemaChars, 1_000, 32_000),
    maxCandidatesPerTask: boundedInteger(input.maxCandidatesPerTask, DEFAULT_STRUCTURED_OUTPUT_CONFIG.maxCandidatesPerTask, 1, 3),
  };
}

function normalizeContextResetConfig(value: unknown): ContextResetConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CONTEXT_RESET_CONFIG };
  const input = value as Partial<ContextResetConfig>;
  const contextUsageRatio = Number(input.contextUsageRatio);
  const hardContextUsageRatio = Number(input.hardContextUsageRatio);
  return {
    mode: input.mode === "off" ? "off" : "automatic",
    phaseBoundaries: input.phaseBoundaries !== false,
    eligibleTransientTokens: boundedInteger(input.eligibleTransientTokens, DEFAULT_CONTEXT_RESET_CONFIG.eligibleTransientTokens, 1_000, 200_000),
    contextUsageRatio: Number.isFinite(contextUsageRatio) ? Math.max(0.05, Math.min(0.95, contextUsageRatio)) : DEFAULT_CONTEXT_RESET_CONFIG.contextUsageRatio,
    hardContextUsageRatio: Number.isFinite(hardContextUsageRatio) ? Math.max(0.10, Math.min(0.99, hardContextUsageRatio)) : DEFAULT_CONTEXT_RESET_CONFIG.hardContextUsageRatio,
    cooldownTurns: boundedInteger(input.cooldownTurns, DEFAULT_CONTEXT_RESET_CONFIG.cooldownTurns, 0, 100),
    maxAutomaticResetsPerPhase: boundedInteger(input.maxAutomaticResetsPerPhase, DEFAULT_CONTEXT_RESET_CONFIG.maxAutomaticResetsPerPhase, 1, 5),
    maxCheckpointChars: boundedInteger(input.maxCheckpointChars, DEFAULT_CONTEXT_RESET_CONFIG.maxCheckpointChars, 4_000, 100_000),
    maxContinuationSeedChars: boundedInteger(input.maxContinuationSeedChars, DEFAULT_CONTEXT_RESET_CONFIG.maxContinuationSeedChars, 2_000, 100_000),
    adapterTimeoutMs: boundedInteger(input.adapterTimeoutMs, DEFAULT_CONTEXT_RESET_CONFIG.adapterTimeoutMs, 100, 60_000),
    unsupportedTransport: input.unsupportedTransport === "retain-context" ? "retain-context" : "checkpoint-only",
    expireUnusedApprovals: input.expireUnusedApprovals !== false,
  };
}

function normalizeLiveModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const models = value
    .filter((model): model is string => typeof model === "string")
    .map((model) => model.trim())
    .filter((model) => MODEL_ID_PATTERN.test(model))
    .slice(0, 12);
  return [...new Set(models)];
}

function normalizeEvaluationConfig(value: unknown): EvaluationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_EVALUATION_CONFIG };
  const input = value as Partial<EvaluationConfig>;
  return {
    liveModels: normalizeLiveModels(input.liveModels),
    timeoutMs: boundedInteger(input.timeoutMs, DEFAULT_EVALUATION_CONFIG.timeoutMs, 1_000, 10 * 60 * 1_000),
    maxCases: boundedInteger(input.maxCases, DEFAULT_EVALUATION_CONFIG.maxCases, 1, 50),
  };
}

function normalizeAdvisorConfig(value: unknown): AdvisorConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_ADVISOR_CONFIG };
  const input = value as Partial<AdvisorConfig>;
  const exactModel = typeof input.exactModel === "string" && MODEL_ID_PATTERN.test(input.exactModel.trim()) ? input.exactModel.trim() : undefined;
  const dataScope = input.dataScope === "diagnostic-summary" ? input.dataScope : undefined;
  const maxCalls = boundedInteger(input.maxCalls, DEFAULT_ADVISOR_CONFIG.maxCalls, 0, 10);
  const maxRuntimeMs = boundedInteger(input.maxRuntimeMs, DEFAULT_ADVISOR_CONFIG.maxRuntimeMs, 100, 10 * 60 * 1_000);
  const maxOutputChars = boundedInteger(input.maxOutputChars, DEFAULT_ADVISOR_CONFIG.maxOutputChars, 256, 100_000);
  const maxTotalTokens = boundedInteger(input.maxTotalTokens, DEFAULT_ADVISOR_CONFIG.maxTotalTokens, 0, 100_000);
  const maxTotalCostUsd = boundedCost(input.maxTotalCostUsd, DEFAULT_ADVISOR_CONFIG.maxTotalCostUsd, 10_000);
  const automatic = input.automatic === true
    && Boolean(exactModel && dataScope && maxCalls > 0 && maxTotalTokens > 0 && maxTotalCostUsd > 0);
  return { automatic, exactModel, dataScope, maxCalls, maxRuntimeMs, maxOutputChars, maxTotalTokens, maxTotalCostUsd };
}

function normalizeModelProfiles(value: unknown, defaults: Pick<ReliabilityConfig, "contextBudgetChars" | "scope" | "maxRecoveryAttempts">): ModelProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: ModelProfile[] = [];
  for (const item of value.slice(0, 12)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const input = item as Partial<ModelProfile>;
    const model = typeof input.model === "string" ? input.model.trim() : undefined;
    if (!model || !MODEL_ID_PATTERN.test(model) || profiles.some((profile) => profile.model === model)) continue;
    const provenance = typeof input.evidence_provenance === "string" && input.evidence_provenance.trim().length > 0 && input.evidence_provenance.length <= 300
      ? input.evidence_provenance.trim()
      : undefined;
    // Config alone cannot prove an independent split/dataset/case/report chain.
    // Held-out labels are accepted only from the host-produced derivation path.
    const validation = "unvalidated";
    profiles.push({
      model,
      validation,
      ...(provenance ? { evidence_provenance: provenance } : {}),
      // Profiles only narrow conservative defaults; an unvalidated override cannot expand authority.
      context_budget_chars: boundedInteger(input.context_budget_chars, defaults.contextBudgetChars, 1_800, defaults.contextBudgetChars),
      max_tool_calls: boundedInteger(input.max_tool_calls, defaults.scope.maxToolCalls, 1, defaults.scope.maxToolCalls),
      max_recovery_attempts: boundedInteger(input.max_recovery_attempts, defaults.maxRecoveryAttempts, 1, defaults.maxRecoveryAttempts),
    });
  }
  return profiles;
}

export function automaticAdvisorIsAuthorized(config: AdvisorConfig): boolean {
  return config.automatic
    && Boolean(config.exactModel && config.dataScope && config.maxCalls > 0 && config.maxTotalTokens > 0 && config.maxTotalCostUsd > 0);
}

function invalidEnumWarning(key: string, value: unknown, allowed: readonly string[], fallback: string): string | undefined {
  if (value === undefined || allowed.includes(value as string)) return undefined;
  return `Ignored invalid .pi/reliability.json '${key}' value; using '${fallback}'.`;
}

/** Reports policy-affecting enum fallbacks so a project configuration cannot weaken controls silently. */
export function configNormalizationWarnings(input: Partial<ReliabilityConfig>): string[] {
  const warnings = [
    invalidEnumWarning("profile", input.profile, ["strict", "balanced", "relaxed"], DEFAULT_CONFIG.profile),
    invalidEnumWarning("contextMode", input.contextMode, ["full", "compact", "delta"], PROFILE_DEFAULTS[normalizeProfile(input.profile)].contextMode),
    invalidEnumWarning("orchestrationMode", input.orchestrationMode, ["prompt", "separate-model"], PROFILE_DEFAULTS[normalizeProfile(input.profile)].orchestrationMode),
    invalidEnumWarning("supervisionMode", input.supervisionMode, ["adaptive", "lite", "supervised"], PROFILE_DEFAULTS[normalizeProfile(input.profile)].supervisionMode),
  ];
  const contextReset = input.contextReset;
  if (contextReset && typeof contextReset === "object" && !Array.isArray(contextReset)) {
    const values = contextReset as Record<string, unknown>;
    warnings.push(
      invalidEnumWarning("contextReset.mode", values.mode, ["off", "automatic"], "automatic"),
      invalidEnumWarning("contextReset.unsupportedTransport", values.unsupportedTransport, ["checkpoint-only", "retain-context"], "checkpoint-only"),
    );
  }
  const advisor = input.advisor;
  if (advisor && typeof advisor === "object" && !Array.isArray(advisor)) {
    warnings.push(invalidEnumWarning("advisor.dataScope", (advisor as Record<string, unknown>).dataScope, ["diagnostic-summary"], "disabled"));
  }
  return warnings.filter((warning): warning is string => Boolean(warning));
}

export function normalizeConfig(input: Partial<ReliabilityConfig>): ReliabilityConfig {
  const profile = normalizeProfile(input.profile);
  const profileDefaults = PROFILE_DEFAULTS[profile];
  const maxRepeatedActionSource = input.maxRepeatedAction ?? profileDefaults.maxRepeatedAction;
  const maxRecoveryAttemptsSource = input.maxRecoveryAttempts ?? profileDefaults.maxRecoveryAttempts;
  const maxRecoveryActionsSource = input.maxRecoveryActions ?? profileDefaults.maxRecoveryActions;
  const maxRecoveryElapsedSource = input.maxRecoveryElapsedMs ?? profileDefaults.maxRecoveryElapsedMs;
  const contextBudgetSource = input.contextBudgetChars ?? profileDefaults.contextBudgetChars;
  const rawLogMaxSource = input.rawLogMaxChars ?? profileDefaults.rawLogMaxChars;
  const orchestrationOutputSource = input.orchestrationMaxOutputChars ?? profileDefaults.orchestrationMaxOutputChars;
  return {
    ...DEFAULT_CONFIG,
    ...profileDefaults,
    ...input,
    profile,
    retrieval: normalizeRetrievalConfig(input.retrieval),
    scope: normalizeScopeConfig(input.scope),
    structuredOutput: normalizeStructuredOutputConfig(input.structuredOutput),
    contextReset: normalizeContextResetConfig(input.contextReset),
    evaluation: normalizeEvaluationConfig(input.evaluation),
    advisor: normalizeAdvisorConfig(input.advisor),
    modelProfiles: normalizeModelProfiles(input.modelProfiles, profileDefaults),
    contextMode: normalizeContextMode(input.contextMode, profileDefaults.contextMode),
    supervisionMode: normalizeSupervisionMode(input.supervisionMode, profileDefaults.supervisionMode),
    storeRawToolLogs: input.storeRawToolLogs === true,
    maxRepeatedAction: Math.max(2, Math.min(10, Math.trunc(Number(maxRepeatedActionSource) || profileDefaults.maxRepeatedAction))),
    maxRecoveryAttempts: Math.max(1, Math.min(5, Math.trunc(Number(maxRecoveryAttemptsSource) || profileDefaults.maxRecoveryAttempts))),
    maxRecoveryActions: Math.max(2, Math.min(20, Math.trunc(Number(maxRecoveryActionsSource) || profileDefaults.maxRecoveryActions))),
    maxRecoveryElapsedMs: Math.max(1_000, Math.min(60 * 60 * 1000, Math.trunc(Number(maxRecoveryElapsedSource) || profileDefaults.maxRecoveryElapsedMs))),
    contextBudgetChars: Math.max(1800, Math.min(20000, Math.trunc(Number(contextBudgetSource) || profileDefaults.contextBudgetChars))),
    rawLogMaxChars: Math.max(1000, Math.min(500000, Math.trunc(Number(rawLogMaxSource) || profileDefaults.rawLogMaxChars))),
    orchestrationMode: normalizeOrchestrationMode(input.orchestrationMode, profileDefaults.orchestrationMode),
    orchestrationModels: normalizeRoleModels(input.orchestrationModels),
    orchestrationTools: normalizeTools(input.orchestrationTools, profileDefaults.orchestrationTools),
    orchestrationMaxOutputChars: Math.max(256, Math.min(100000, Math.trunc(Number(orchestrationOutputSource) || profileDefaults.orchestrationMaxOutputChars))),
    orchestrationTimeoutMs: boundedInteger(input.orchestrationTimeoutMs, profileDefaults.orchestrationTimeoutMs, 100, 10 * 60 * 1_000),
    orchestrationMaxStdoutChars: boundedInteger(input.orchestrationMaxStdoutChars, profileDefaults.orchestrationMaxStdoutChars, 1_024, 1_000_000),
    orchestrationMaxStderrChars: boundedInteger(input.orchestrationMaxStderrChars, profileDefaults.orchestrationMaxStderrChars, 1_024, 1_000_000),
    orchestrationMaxLineChars: boundedInteger(input.orchestrationMaxLineChars, profileDefaults.orchestrationMaxLineChars, 256, 100_000),
    orchestrationMaxTotalOutputChars: boundedInteger(input.orchestrationMaxTotalOutputChars, profileDefaults.orchestrationMaxTotalOutputChars, 1_024, 1_000_000),
    orchestrationMaxTotalTokens: boundedInteger(input.orchestrationMaxTotalTokens, profileDefaults.orchestrationMaxTotalTokens, 1, 1_000_000),
    orchestrationMaxTotalCostUsd: boundedCost(input.orchestrationMaxTotalCostUsd, profileDefaults.orchestrationMaxTotalCostUsd, 10_000),
  };
}
