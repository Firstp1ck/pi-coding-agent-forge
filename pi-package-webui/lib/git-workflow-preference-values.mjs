export const GIT_WORKFLOW_SETUP_VERSION = 1;
export const GIT_WORKFLOW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const GIT_WORKFLOW_LANGUAGES = ["en", "de"];
export const GIT_WORKFLOW_DEFAULT_VARIANTS = ["short", "long"];
export const GIT_WORKFLOW_SCOPE_POLICIES = ["auto", "never", "required"];
export const GIT_WORKFLOW_STAGING_POLICIES = ["review", "preserve", "all"];
export const GIT_WORKFLOW_DELIVERY_MODES = ["ask", "current", "pr-worktree"];
export const GIT_WORKFLOW_VERIFICATION_POLICIES = ["ask", "none"];
export const GIT_WORKFLOW_UNAVAILABLE_POLICIES = ["ask"];

export function supportedGitWorkflowThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  const mapping = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {};
  return GIT_WORKFLOW_THINKING_LEVELS.filter((level) => {
    if (mapping[level] === null) return false;
    if (["xhigh", "max"].includes(level)) return typeof mapping[level] === "string";
    return true;
  });
}

function cleanBoundedString(value, maxLength = 512) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function choice(value, choices, fallback) {
  const clean = cleanBoundedString(value, 64);
  return choices.includes(clean) ? clean : fallback;
}

export function defaultGitWorkflowPreferences() {
  return {
    setupVersion: 0,
    generation: {
      provider: "",
      modelId: "",
      thinkingLevel: "low",
      unavailablePolicy: "ask",
      fallback: {
        provider: "",
        modelId: "",
        thinkingLevel: "low",
      },
    },
    commit: {
      language: "en",
      defaultVariant: "short",
      scope: "auto",
    },
    stagingPolicy: "review",
    reviewProcessEnabled: true,
    deliveryMode: "ask",
    verificationPolicy: "ask",
  };
}

export function normalizeGitWorkflowPreferences(value) {
  const defaults = defaultGitWorkflowPreferences();
  const provider = cleanBoundedString(value?.generation?.provider, 160);
  const modelId = cleanBoundedString(value?.generation?.modelId, 512);
  const fallbackProvider = cleanBoundedString(value?.generation?.fallback?.provider, 160);
  const fallbackModelId = cleanBoundedString(value?.generation?.fallback?.modelId, 512);
  return {
    setupVersion: provider && modelId ? GIT_WORKFLOW_SETUP_VERSION : 0,
    generation: {
      provider,
      modelId,
      thinkingLevel: choice(value?.generation?.thinkingLevel, GIT_WORKFLOW_THINKING_LEVELS, defaults.generation.thinkingLevel),
      unavailablePolicy: choice(value?.generation?.unavailablePolicy, GIT_WORKFLOW_UNAVAILABLE_POLICIES, defaults.generation.unavailablePolicy),
      fallback: {
        provider: fallbackProvider,
        modelId: fallbackModelId,
        thinkingLevel: choice(value?.generation?.fallback?.thinkingLevel, GIT_WORKFLOW_THINKING_LEVELS, defaults.generation.fallback.thinkingLevel),
      },
    },
    commit: {
      language: choice(value?.commit?.language, GIT_WORKFLOW_LANGUAGES, defaults.commit.language),
      defaultVariant: choice(value?.commit?.defaultVariant, GIT_WORKFLOW_DEFAULT_VARIANTS, defaults.commit.defaultVariant),
      scope: choice(value?.commit?.scope, GIT_WORKFLOW_SCOPE_POLICIES, defaults.commit.scope),
    },
    stagingPolicy: choice(value?.stagingPolicy, GIT_WORKFLOW_STAGING_POLICIES, defaults.stagingPolicy),
    reviewProcessEnabled: typeof value?.reviewProcessEnabled === "boolean" ? value.reviewProcessEnabled : defaults.reviewProcessEnabled,
    deliveryMode: choice(value?.deliveryMode, GIT_WORKFLOW_DELIVERY_MODES, defaults.deliveryMode),
    verificationPolicy: choice(value?.verificationPolicy, GIT_WORKFLOW_VERIFICATION_POLICIES, defaults.verificationPolicy),
  };
}

export function mergeGitWorkflowPreferences(current, patch) {
  const base = normalizeGitWorkflowPreferences(current);
  return normalizeGitWorkflowPreferences({
    ...base,
    ...(patch || {}),
    generation: {
      ...base.generation,
      ...(patch?.generation || {}),
      fallback: { ...base.generation.fallback, ...(patch?.generation?.fallback || {}) },
    },
    commit: { ...base.commit, ...(patch?.commit || {}) },
  });
}

export function isGitWorkflowSetupComplete(preferences) {
  const normalized = normalizeGitWorkflowPreferences(preferences);
  return normalized.setupVersion === GIT_WORKFLOW_SETUP_VERSION && !!normalized.generation.provider && !!normalized.generation.modelId;
}

export function gitWorkflowPreferencesSummary(preferences) {
  const value = normalizeGitWorkflowPreferences(preferences);
  const model = isGitWorkflowSetupComplete(value) ? `${value.generation.provider}/${value.generation.modelId}` : "not configured";
  const fallback = value.generation.fallback.provider && value.generation.fallback.modelId
    ? `${value.generation.fallback.provider}/${value.generation.fallback.modelId} · ${value.generation.fallback.thinkingLevel}`
    : "disabled";
  return [
    `Model: ${model}`,
    `Thinking: ${value.generation.thinkingLevel}`,
    `Fallback: ${fallback}`,
    `Commit: ${value.commit.language} · ${value.commit.defaultVariant} · scope ${value.commit.scope}`,
    `Staging: ${value.stagingPolicy}`,
    `Review process: ${value.reviewProcessEnabled ? "enabled" : "disabled"}`,
    `Delivery: ${value.deliveryMode}`,
    `Verification: ${value.verificationPolicy}`,
  ].join("\n");
}
