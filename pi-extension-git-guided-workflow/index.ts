import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  getAgentDir,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  GuidedGitError,
  captureBoundStagedState,
  classifyPostCommitHead,
  discoverPushDestination,
  parseGeneratedOutput,
  planPush,
  planStageAll,
  preflightRepository,
  prepareCommitPlan,
  readHeadOid,
  readRemotes,
  runGit,
  sanitizeDiagnostic,
  validateManualCommitMessage,
  type CommitBinding,
  type PushDestination,
  type RepositoryState,
} from "./src/core.ts";
import {
  BRANCH_OUTPUT_MAX_TOKENS,
  COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS,
  COMMIT_GENERATION_CAPTURE_MAX_BYTES,
  COMMIT_GENERATION_DIRECT_MAX_BYTES,
  COMMIT_OUTPUT_MAX_TOKENS,
  PR_OUTPUT_MAX_TOKENS,
  acquireBranchGenerationContext,
  acquirePrGenerationContext,
  acquireStagedGenerationContext,
  buildBranchModelRequest,
  buildCommitChunkAnalysisModelRequest,
  buildCommitCorrectionModelRequest,
  buildCommitModelRequest,
  buildCommitSynthesisModelRequest,
  buildPrModelRequest,
  parseBranchGenerationArgs,
  parseBranchOutput,
  parseCommitChunkSummaryOutput,
  parseCommitGenerationArgs,
  parseNativeCommitOutput,
  parsePrGenerationArgs,
  parsePrOutput,
  partitionStagedDiff,
  writeBranchArtifact,
  writeCommitArtifacts,
  writePrArtifact,
  type CommitChunkSummary,
  type CommitGenerationArgs,
  type NativeModelRequest,
  type StagedGenerationContext,
} from "./src/native-generation.ts";
import { deriveSingleFileCommitDefault, readCommitMessageFilePreview } from "./src/message-files.ts";
import {
  createGuidedGitPreferencesStore,
  supportedGuidedGitThinkingLevels,
  validateGuidedGitPreferences,
  type GuidedGitGenerationProfile,
  type GuidedGitPreferences,
} from "./src/preferences.ts";
import {
  executeRepositoryInitialization,
  executeRepositoryPublication,
  executeStarterFileStaging,
  executeStarterFiles,
  planRepositoryInitialization,
  planRepositoryPublication,
  planStarterFiles,
  type StarterFilePath,
} from "./src/repository-setup.ts";
import {
  GUIDED_GIT_OVERLAY_OPTIONS,
  progressText,
  GenerationOverlay,
  showActionScreen,
  showCommitEditor,
  showConfirmationOverlay,
  showSetupOverlay,
  type Action,
  type SetupModelChoice,
  type StageName,
} from "./src/tui.ts";

export { GUIDED_GIT_OVERLAY_OPTIONS, progressText, showActionScreen } from "./src/tui.ts";

export const COMMAND_NAME = "git-guided-workflow";
export const SETUP_COMMAND_NAME = "git-guided-workflow-setup";
export const COMMIT_GENERATION_COMMAND_NAME = "git-staged-msg";
export const BRANCH_GENERATION_COMMAND_NAME = "git-branch-name";
export const PR_GENERATION_COMMAND_NAME = "pr";
export const WEBUI_START_STATUS_KEY = "git-guided-workflow:webui-start";
export const WEBUI_START_PAYLOAD_TYPE = "firstpick.pi-extension-git-guided-workflow.start";
export const WEBUI_START_PAYLOAD_VERSION = 1;
export type WebuiStartPayload = {
  type: typeof WEBUI_START_PAYLOAD_TYPE;
  version: typeof WEBUI_START_PAYLOAD_VERSION;
  action: "start";
  requestId: string;
};
const COMMIT_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000;
type ActiveWorkflow = { cancelled: boolean; generationController?: AbortController };

function errorMessage(error: unknown): string {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof GuidedGitError && error.code === code;
}

function assertCurrent(active: ActiveWorkflow): void {
  if (active.cancelled) throw new GuidedGitError("WORKFLOW_CANCELLED", "The workflow session ended");
}

function abortError(): GuidedGitError {
  return new GuidedGitError("GENERATION_CANCELLED", "Generation was cancelled");
}

const NATIVE_GENERATION_PROVIDER_FAILURE_MARKER = "FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE";
const WEBUI_GENERATION_PROFILE_ARGUMENT_PREFIX = "--firstpick-webui-generation-profile=";
const NATIVE_GENERATION_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const nativeCompletionSettlements = new WeakMap<AbortSignal, Promise<void>>();

type NativeGenerationThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type NativeGenerationModel = NonNullable<ExtensionCommandContext["model"]>;
type NativeGenerationTarget = {
  model: NativeGenerationModel;
  thinkingLevel: NativeGenerationThinkingLevel;
  isolated: boolean;
};
type NativeGenerationInvocation = { publicArgs: string; target: NativeGenerationTarget };

function resolveNativeGenerationInvocation(ctx: ExtensionCommandContext, rawArgs: string): NativeGenerationInvocation {
  const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/u) : [];
  const profileIndexes = args.flatMap((arg, index) => arg.startsWith(WEBUI_GENERATION_PROFILE_ARGUMENT_PREFIX) ? [index] : []);
  if (profileIndexes.length === 0) {
    if (!ctx.model) throw new GuidedGitError("NO_ACTIVE_MODEL", "This generation command requires an active model");
    const thinkingLevel = NATIVE_GENERATION_THINKING_LEVELS.has(String(ctx.thinkingLevel))
      ? ctx.thinkingLevel as NativeGenerationThinkingLevel
      : "off";
    return { publicArgs: rawArgs, target: { model: ctx.model, thinkingLevel, isolated: false } };
  }
  if (ctx.mode !== "rpc" || profileIndexes.length !== 1 || profileIndexes[0] !== args.length - 1) {
    throw new GuidedGitError("INVALID_ARGUMENTS", "The WebUI generation profile is invalid");
  }
  const token = args.at(-1)!.slice(WEBUI_GENERATION_PROFILE_ARGUMENT_PREFIX.length);
  if (!token || token.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new GuidedGitError("INVALID_ARGUMENTS", "The WebUI generation profile is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new GuidedGitError("INVALID_ARGUMENTS", "The WebUI generation profile is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["modelId", "provider", "thinkingLevel", "version"])) {
    throw new GuidedGitError("INVALID_ARGUMENTS", "The WebUI generation profile is invalid");
  }
  const profile = value as { version?: unknown; provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
  const provider = typeof profile.provider === "string" ? profile.provider.trim() : "";
  const modelId = typeof profile.modelId === "string" ? profile.modelId.trim() : "";
  const thinkingLevel = typeof profile.thinkingLevel === "string" ? profile.thinkingLevel : "";
  if (profile.version !== 1 || !provider || provider.length > 160 || !modelId || modelId.length > 512
    || !NATIVE_GENERATION_THINKING_LEVELS.has(thinkingLevel)) {
    throw new GuidedGitError("INVALID_ARGUMENTS", "The WebUI generation profile is invalid");
  }
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) throw new GuidedGitError("MODEL_UNAVAILABLE", `Configured Git-writing model is unavailable: ${provider}/${modelId}`);
  if (!supportedGuidedGitThinkingLevels(model).includes(thinkingLevel as NativeGenerationThinkingLevel)) {
    throw new GuidedGitError("MODEL_UNAVAILABLE", `Configured thinking level ${thinkingLevel} is unavailable for ${provider}/${modelId}`);
  }
  return {
    publicArgs: args.slice(0, -1).join(" "),
    target: { model, thinkingLevel: thinkingLevel as NativeGenerationThinkingLevel, isolated: true },
  };
}

async function raceNativeGenerationAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener();
  }
}

async function completeIsolatedNativeRequest(
  ctx: ExtensionCommandContext,
  target: NativeGenerationTarget,
  request: NativeModelRequest,
  signal: AbortSignal,
  maxTokens: number,
) {
  const provider = ctx.modelRegistry.getProvider(target.model.provider);
  if (!provider) throw new GuidedGitError("MODEL_GENERATION_FAILED", `Provider is unavailable: ${target.model.provider}`);
  const auth = await raceNativeGenerationAbort(ctx.modelRegistry.getApiKeyAndHeaders(target.model), signal);
  if (!auth.ok) throw new GuidedGitError("MODEL_GENERATION_FAILED", auth.error);
  if (signal.aborted) throw abortError();
  const model = auth.baseUrl ? { ...target.model, baseUrl: auth.baseUrl } : target.model;
  const stream = provider.streamSimple(model, request, {
    signal,
    maxTokens,
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    ...(model.reasoning && target.thinkingLevel !== "off" ? { reasoning: target.thinkingLevel } : {}),
  });
  return await stream.result();
}

async function completeNativeRequest(
  ctx: ExtensionCommandContext,
  target: NativeGenerationTarget,
  request: NativeModelRequest,
  signal: AbortSignal,
  maxTokens: number,
): Promise<string> {
  if (signal.aborted) throw abortError();
  const completion = Promise.resolve().then(() => target.isolated
    ? completeIsolatedNativeRequest(ctx, target, request, signal, maxTokens)
    : ctx.modelRegistry.complete(target.model, request, { signal, maxTokens }));
  nativeCompletionSettlements.set(signal, completion.then(() => {}, () => {}));
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    const response = await Promise.race([completion, aborted]);
    if (signal.aborted || response.stopReason === "aborted") throw abortError();
    if (response.stopReason === "error") {
      throw new GuidedGitError("MODEL_GENERATION_FAILED", errorMessage(response.errorMessage || "The generation model returned an error"));
    }
    return response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  } catch (error) {
    if (signal.aborted || isCode(error, "GENERATION_CANCELLED")) throw abortError();
    if (isCode(error, "MODEL_GENERATION_FAILED")) throw error;
    throw new GuidedGitError("MODEL_GENERATION_FAILED", errorMessage(error));
  } finally {
    removeAbortListener();
  }
}

function assertNativeGenerationSurface(ctx: ExtensionCommandContext, commandName: string, target: NativeGenerationTarget): void {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    throw new GuidedGitError("UNSUPPORTED_SURFACE", `/${commandName} is available only in Pi's interactive TUI or a compatible WebUI RPC session`);
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    throw new GuidedGitError("SESSION_BUSY", `/${commandName} requires an idle Pi session with no queued messages`);
  }
  if (!target.model) throw new GuidedGitError("NO_ACTIVE_MODEL", `/${commandName} requires a generation model`);
}

export function createWebuiStartPayload(): WebuiStartPayload {
  return {
    type: WEBUI_START_PAYLOAD_TYPE,
    version: WEBUI_START_PAYLOAD_VERSION,
    action: "start",
    requestId: randomUUID(),
  };
}

function requestWebuiStart(ctx: ExtensionCommandContext): void {
  const payload = JSON.stringify(createWebuiStartPayload());
  try {
    ctx.ui.setStatus(WEBUI_START_STATUS_KEY, payload);
  } catch (error) {
    try { ctx.ui.setStatus(WEBUI_START_STATUS_KEY, undefined); } catch {}
    ctx.ui.notify(`Guided Git activation could not be requested in WebUI: ${errorMessage(error)} No Git command was run.`, "error");
    return;
  }
  try {
    ctx.ui.setStatus(WEBUI_START_STATUS_KEY, undefined);
  } catch (error) {
    ctx.ui.notify(`Guided Git activation was requested in WebUI, but its transient status could not be cleared: ${errorMessage(error)} WebUI ignores replayed requests. Do not retry automatically.`, "warning");
    return;
  }
  ctx.ui.notify("Requested the Guided Git workflow in WebUI.", "info");
}

function confirmationValue(value: string, maxChars = 1_000): string {
  return sanitizeDiagnostic(value, maxChars).replace(/[\r\n]+/gu, " ");
}

function statusSummary(state: RepositoryState): string {
  const { staged, unstaged, untracked, conflicted } = state.status;
  return `Branch ${state.branch} · staged ${staged} · unstaged ${unstaged} · untracked ${untracked} · conflicted ${conflicted}`;
}

function stagedPreview(state: RepositoryState): string {
  const staged = state.status.entries.filter((entry) => entry.staged);
  const shown = staged.slice(0, 8).map((entry) => `• ${confirmationValue(entry.displayPath)}`);
  if (staged.length > shown.length) shown.push(`• … and ${staged.length - shown.length} more`);
  return shown.length ? shown.join("\n") : "• staged paths are bound by the captured index fingerprint";
}

async function finishScreen(ctx: ExtensionCommandContext, stage: StageName, message: string): Promise<void> {
  await showActionScreen(ctx, stage, "Workflow finished", message, [{ value: "finish", label: "Finish" }]);
}

async function executePlan(root: string, args: readonly string[], timeoutMs: number) {
  return await runGit(root, args, { timeoutMs, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 128 * 1024 });
}

async function chooseStage(
  ctx: ExtensionCommandContext,
  active: ActiveWorkflow,
  preferences: GuidedGitPreferences,
): Promise<{ state: RepositoryState; fingerprint: string } | null> {
  while (true) {
    assertCurrent(active);
    const state = await preflightRepository(ctx.cwd);
    const hasOtherChanges = state.status.unstaged + state.status.untracked > 0;
    const preserve = { value: "continue", label: "Use current staged changes", description: "Keep the current index exactly as staged" };
    const stageAll = { value: "stage-all", label: "Stage all changes", description: "Run git add --all after confirmation" };
    const actions: Action[] = [];
    if (preferences.staging === "all" && hasOtherChanges) actions.push(stageAll);
    if (state.status.staged > 0) actions.push(preserve);
    if (preferences.staging !== "all" && hasOtherChanges) actions.push(stageAll);
    actions.push({ value: "finish", label: "Finish", description: "Leave the repository unchanged from this point" });
    const choice = await showActionScreen(ctx, "Stage", "Choose staged content", `${state.root}\n${statusSummary(state)}`, actions);
    assertCurrent(active);
    if (!choice || choice === "finish") return null;
    if (choice === "stage-all") {
      const { staged, unstaged, untracked, conflicted } = state.status;
      const confirmed = await showConfirmationOverlay(
        ctx,
        "Stage",
        "Stage all repository changes?",
        `Repository: ${confirmationValue(state.root)}\nBranch: ${confirmationValue(state.branch)}\nStaged: ${staged}\nUnstaged: ${unstaged}\nUntracked: ${untracked}\nConflicted: ${conflicted}\n\nThis runs: git add --all --`,
        "Stage all changes",
      );
      assertCurrent(active);
      if (!confirmed) continue;
      const refreshed = await preflightRepository(ctx.cwd);
      const countsChanged = (["staged", "unstaged", "untracked", "conflicted"] as const)
        .some((key) => refreshed.status[key] !== state.status[key]);
      if (refreshed.root !== state.root || refreshed.branch !== state.branch || countsChanged) {
        ctx.ui.notify("Repository status changed after confirmation. Returning to Stage for a fresh summary before staging.", "warning");
        continue;
      }
      const plan = planStageAll();
      const result = await executePlan(refreshed.root, plan.args, 30_000);
      if (result.exitCode !== 0 || result.timedOut) throw new GuidedGitError("STAGE_ALL_FAILED", errorMessage(result.stderr));
      continue;
    }
    try {
      return await captureBoundStagedState(ctx.cwd);
    } catch (error) {
      if (isCode(error, "NOTHING_STAGED") || isCode(error, "STAGED_STATE_CHANGED")) {
        ctx.ui.notify(`${errorMessage(error)} Returning to Stage for a fresh summary.`, "warning");
        continue;
      }
      throw error;
    }
  }
}

async function completeChunkedCommit(
  ctx: ExtensionCommandContext,
  target: NativeGenerationTarget,
  context: StagedGenerationContext,
  args: CommitGenerationArgs,
  signal: AbortSignal,
  commandName: string,
): Promise<{ output: string; summaries: CommitChunkSummary[] }> {
  const chunks = partitionStagedDiff(context);
  const summaries: CommitChunkSummary[] = [];
  ctx.ui.notify(`/${commandName} will use ${chunks.length + 1} model requests for this large staged diff: ${chunks.length} sequential chunk analyses, then one final synthesis.`, "info");
  for (const chunk of chunks) {
    const chunkOutput = await completeNativeRequest(ctx, target, buildCommitChunkAnalysisModelRequest(context, chunk), signal, COMMIT_CHUNK_SUMMARY_OUTPUT_MAX_TOKENS);
    summaries.push(parseCommitChunkSummaryOutput(chunkOutput, chunk));
  }
  ctx.ui.notify(`/${commandName} analyzed ${summaries.length}/${chunks.length} chunks; synthesizing the final commit message from the retained summaries.`, "info");
  const output = await completeNativeRequest(ctx, target, buildCommitSynthesisModelRequest(context, args, summaries), signal, COMMIT_OUTPUT_MAX_TOKENS);
  return { output, summaries };
}

type GenerationResult = { kind: "success"; output: string } | { kind: "cancelled" } | { kind: "failure"; message: string };
type WorkflowGenerationConfig = {
  primary: NativeGenerationTarget;
  fallback?: NativeGenerationTarget;
  commit: GuidedGitPreferences["commit"];
};

function targetFromProfile(ctx: ExtensionCommandContext, profile: GuidedGitGenerationProfile, label: string): NativeGenerationTarget {
  const model = ctx.modelRegistry.find(profile.provider, profile.modelId);
  if (!model) throw new GuidedGitError("MODEL_UNAVAILABLE", `${label} generation model is unavailable: ${profile.provider}/${profile.modelId}`);
  if (!supportedGuidedGitThinkingLevels(model).includes(profile.thinkingLevel)) {
    throw new GuidedGitError("MODEL_UNAVAILABLE", `${label} reasoning effort ${profile.thinkingLevel} is unavailable for ${profile.provider}/${profile.modelId}`);
  }
  return { model, thinkingLevel: profile.thinkingLevel, isolated: true };
}

function resolveWorkflowGeneration(ctx: ExtensionCommandContext, preferences: GuidedGitPreferences): WorkflowGenerationConfig | null {
  if (!preferences.generation.primary) {
    if (!ctx.model) return null;
    return { primary: resolveNativeGenerationInvocation(ctx, "").target, commit: preferences.commit };
  }
  const primary = targetFromProfile(ctx, preferences.generation.primary, "Primary");
  const fallback = preferences.generation.fallback
    ? targetFromProfile(ctx, preferences.generation.fallback, "Fallback")
    : undefined;
  return { primary, fallback, commit: preferences.commit };
}

function generationTargetName(target: NativeGenerationTarget): string {
  return `${target.model.provider}/${target.model.id} (${target.thinkingLevel})`;
}

async function generateWithTarget(
  ctx: ExtensionCommandContext,
  target: NativeGenerationTarget,
  snapshot: StagedGenerationContext,
  preferences: GuidedGitPreferences["commit"],
  signal: AbortSignal,
): Promise<string> {
  const args = { language: preferences.language, scope: preferences.scope };
  if (snapshot.byteLength <= COMMIT_GENERATION_DIRECT_MAX_BYTES) {
    return await completeNativeRequest(ctx, target, buildCommitModelRequest(snapshot, args), signal, COMMIT_OUTPUT_MAX_TOKENS);
  }
  return (await completeChunkedCommit(ctx, target, snapshot, args, signal, COMMAND_NAME)).output;
}

async function generateMessages(
  ctx: ExtensionCommandContext,
  active: ActiveWorkflow,
  snapshot: StagedGenerationContext,
  config: WorkflowGenerationConfig,
): Promise<GenerationResult> {
  const controller = new AbortController();
  active.generationController = controller;
  try {
    return await ctx.ui.custom<GenerationResult>((tui, theme, _keybindings, done) => {
      const primaryName = generationTargetName(config.primary);
      const fallbackNotice = config.fallback
        ? ` One eligible provider failure retries once with ${generationTargetName(config.fallback)} and resends the same evidence.`
        : " No fallback is configured.";
      const loader = new GenerationOverlay(
        tui,
        theme,
        `Generating with ${primaryName}.${fallbackNotice} Esc cancels.`,
      );
      let settled = false;
      const onControllerAbort = () => finish({ kind: "cancelled" });
      const finish = (result: GenerationResult) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onControllerAbort);
        done(result);
      };
      controller.signal.addEventListener("abort", onControllerAbort, { once: true });
      loader.onAbort = () => controller.abort();
      const signal = AbortSignal.any([loader.signal, controller.signal]);
      const generation = generateWithTarget(ctx, config.primary, snapshot, config.commit, signal).catch(async (error) => {
        if (!config.fallback || signal.aborted || !isCode(error, "MODEL_GENERATION_FAILED")) throw error;
        ctx.ui.notify(`Primary provider ${config.primary.model.provider} failed. Retrying once with ${generationTargetName(config.fallback)}; the same staged evidence is sent to that provider.`, "warning");
        return await generateWithTarget(ctx, config.fallback, snapshot, config.commit, signal);
      });
      generation.then((output) => finish(signal.aborted
        ? { kind: "cancelled" }
        : { kind: "success", output }))
        .catch((error) => finish(signal.aborted || isCode(error, "GENERATION_CANCELLED")
          ? { kind: "cancelled" }
          : { kind: "failure", message: errorMessage(error) }));
      return loader;
    }, { overlay: true, overlayOptions: GUIDED_GIT_OVERLAY_OPTIONS });
  } finally {
    if (active.generationController === controller) active.generationController = undefined;
  }
}

async function editMessage(ctx: ExtensionCommandContext, prefill: string): Promise<string | null> {
  const edited = await showCommitEditor(ctx, prefill);
  if (edited === null) return null;
  try {
    return validateManualCommitMessage(edited);
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
    return null;
  }
}

async function chooseMessage(
  ctx: ExtensionCommandContext,
  active: ActiveWorkflow,
  state: RepositoryState,
  fingerprint: string,
  preferences: GuidedGitPreferences,
  generation: WorkflowGenerationConfig | null,
  generationUnavailableNotice?: string,
): Promise<string | null> {
  let current: string | undefined;
  let artifacts = null;
  try { artifacts = await readCommitMessageFilePreview(state.root); }
  catch (error) { ctx.ui.notify(`Commit artifacts cannot be reused: ${errorMessage(error)} Manual entry remains available.`, "warning"); }
  let automaticDefault = null;
  try { automaticDefault = deriveSingleFileCommitDefault(state.status); }
  catch (error) { ctx.ui.notify(`${errorMessage(error)} Manual entry remains available.`, "warning"); }
  while (true) {
    assertCurrent(active);
    const actions: Action[] = [];
    if (current) actions.push({ value: "continue", label: "Use selected message", description: current.split("\n", 1)[0] });
    if (generation) actions.push({ value: "generate", label: "Generate short and long candidates", description: `Sends the complete staged diff to ${generationTargetName(generation.primary)}` });
    actions.push({ value: "manual", label: current ? "Edit message" : "Write message manually", description: "Uses Pi's native editor; no model is required" });
    if (automaticDefault) actions.push({ value: "default", label: `Use deterministic default: ${automaticDefault.message}`, description: "Available only for one unambiguous staged file with no extra changes" });
    if (artifacts) {
      const variants = preferences.commit.defaultVariant === "short" ? [artifacts.short, artifacts.long] : [artifacts.long, artifacts.short];
      for (const artifact of variants) actions.push({
        value: `artifact:${artifact.variant}`,
        label: `Reuse ${artifact.variant} artifact`,
        description: `${artifact.relativePath}; freshness for this index is unverified`,
      });
    }
    actions.push({ value: "back", label: "Back to Stage" });
    actions.push({ value: "finish", label: "Finish" });
    const choice = await showActionScreen(
      ctx,
      "Message",
      "Choose a commit message",
      `${statusSummary(state)}${generationUnavailableNotice ? `\n${generationUnavailableNotice}` : ""}${current ? `\nSelected: ${current}` : ""}${artifacts ? "\nSaved artifacts are old candidates until the commit rebinds the selected text to the current index." : ""}`,
      actions,
    );
    assertCurrent(active);
    if (!choice || choice === "finish") return null;
    if (choice === "back") throw new GuidedGitError("RETURN_TO_STAGE", "Return to Stage");
    if (choice === "continue" && current) return current;
    if (choice === "default" && automaticDefault) { current = automaticDefault.message; continue; }
    if (choice === "artifact:short" && artifacts) { current = artifacts.short.message; continue; }
    if (choice === "artifact:long" && artifacts) { current = artifacts.long.message; continue; }
    if (choice === "manual") {
      const edited = await editMessage(ctx, current ?? "");
      assertCurrent(active);
      if (edited) current = edited;
      continue;
    }
    if (choice === "generate" && generation) {
      let snapshot: StagedGenerationContext;
      try {
        snapshot = await acquireStagedGenerationContext(state.root, { maxBytes: COMMIT_GENERATION_CAPTURE_MAX_BYTES });
        if (snapshot.fingerprint !== fingerprint) throw new GuidedGitError("STAGED_STATE_CHANGED", "Staged changes changed before generation");
      } catch (error) {
        if (isCode(error, "GENERATION_INPUT_TOO_LARGE") || isCode(error, "GENERATION_INPUT_ENCODING")) {
          ctx.ui.notify(`${errorMessage(error)} Manual entry is still available.`, "warning");
          continue;
        }
        if (isCode(error, "STAGED_STATE_CHANGED") || isCode(error, "NOTHING_STAGED")) {
          ctx.ui.notify("Staged content changed before generation. Returning to Stage.", "warning");
          throw new GuidedGitError("RETURN_TO_STAGE", "Return to Stage");
        }
        throw error;
      }
      const generated = await generateMessages(ctx, active, snapshot, generation);
      assertCurrent(active);
      if (generated.kind === "cancelled") {
        ctx.ui.notify("Message generation cancelled. Manual entry is still available.", "info");
        continue;
      }
      if (generated.kind === "failure") {
        ctx.ui.notify(`Message generation failed: ${generated.message}. Manual entry is still available.`, "error");
        continue;
      }
      let candidates;
      try { candidates = parseGeneratedOutput(generated.output); }
      catch (error) {
        ctx.ui.notify(`Generated output was rejected: ${errorMessage(error)}. Manual entry is still available.`, "error");
        continue;
      }
      const first = preferences.commit.defaultVariant;
      const second = first === "short" ? "long" : "short";
      const candidateChoice = await showActionScreen(ctx, "Message", "Generated candidates", `Short:\n${candidates.short}\n\nLong:\n${candidates.long}`, [
        { value: first, label: `Use ${first} candidate` },
        { value: second, label: `Use ${second} candidate` },
        { value: "edit-short", label: "Edit short candidate" },
        { value: "edit-long", label: "Edit long candidate" },
        { value: "back", label: "Back" },
        { value: "finish", label: "Finish" },
      ]);
      assertCurrent(active);
      if (!candidateChoice || candidateChoice === "back") continue;
      if (candidateChoice === "finish") return null;
      if (candidateChoice === "short") current = candidates.short;
      if (candidateChoice === "long") current = candidates.long;
      if (candidateChoice === "edit-short" || candidateChoice === "edit-long") {
        const edited = await editMessage(ctx, candidateChoice === "edit-short" ? candidates.short : candidates.long);
        assertCurrent(active);
        if (edited) current = edited;
      }
    }
  }
}

type CommitResult = { kind: "created"; oid: string } | { kind: "stage" } | { kind: "finish" };

async function commitStage(
  ctx: ExtensionCommandContext,
  active: ActiveWorkflow,
  state: RepositoryState,
  fingerprint: string,
  initialMessage: string,
  preferences: GuidedGitPreferences,
): Promise<CommitResult> {
  let message = initialMessage;
  const binding: CommitBinding = { root: state.root, branch: state.branch, headOid: state.headOid, fingerprint };
  if (preferences.verification === "ask") {
    const reminder = await showActionScreen(ctx, "Commit", "Verification reminder", "This workflow did not run checks. Review your own verification status before committing.", [
      { value: "continue", label: "Continue to commit review" },
      { value: "stage", label: "Back to Stage" },
      { value: "finish", label: "Finish" },
    ]);
    if (reminder === "stage") return { kind: "stage" };
    if (reminder !== "continue") return { kind: "finish" };
  }
  while (true) {
    const choice = await showActionScreen(ctx, "Commit", "Review commit", `Message (exact):\n${message}\n\nStaged summary:\n${stagedPreview(state)}`, [
      { value: "commit", label: "Commit staged changes", description: "Normal Git hooks and signing remain enabled" },
      { value: "edit", label: "Edit message" },
      { value: "stage", label: "Back to Stage" },
      { value: "finish", label: "Finish" },
    ]);
    assertCurrent(active);
    if (!choice || choice === "finish") return { kind: "finish" };
    if (choice === "stage") return { kind: "stage" };
    if (choice === "edit") {
      const edited = await editMessage(ctx, message);
      assertCurrent(active);
      if (edited) message = edited;
      continue;
    }
    const confirmed = await showConfirmationOverlay(
      ctx,
      "Commit",
      "Create this Git commit?",
      `Repository: ${confirmationValue(state.root)}\nBranch: ${confirmationValue(state.branch)}\n\nExact message:\n${message}\n\nStaged summary:\n${stagedPreview(state)}\n\nGit hooks and signing will run.`,
      "Create commit",
    );
    assertCurrent(active);
    if (!confirmed) continue;
    let plan;
    try {
      plan = await prepareCommitPlan(ctx.cwd, binding, message);
    } catch (error) {
      if (["STAGED_STATE_CHANGED", "HEAD_CHANGED", "BRANCH_CHANGED", "REPOSITORY_CHANGED", "OPERATION_IN_PROGRESS", "UNRESOLVED_CONFLICTS"].some((code) => isCode(error, code))) {
        ctx.ui.notify("Repository or staged content changed. Returning to Stage without committing.", "warning");
        return { kind: "stage" };
      }
      throw error;
    }
    let outcome: "success" | "failure" | "timeout" = "failure";
    let diagnostic = "";
    try {
      const result = await executePlan(state.root, plan.args, COMMIT_TIMEOUT_MS);
      outcome = result.exitCode === 0 && !result.timedOut ? "success" : result.timedOut ? "timeout" : "failure";
      diagnostic = errorMessage(result.stderr.length ? result.stderr : result.stdout);
    } catch (error) {
      if (isCode(error, "GIT_TERMINATION_UNCONFIRMED")) {
        await finishScreen(ctx, "Commit", `Commit result is uncertain because direct-child termination could not be confirmed: ${errorMessage(error)}\nDo not retry automatically. Verify the repository externally.`);
        return { kind: "finish" };
      }
      outcome = isCode(error, "GIT_TIMEOUT") ? "timeout" : "failure";
      diagnostic = errorMessage(error);
    }
    let after: string | null;
    try { after = await readHeadOid(state.root); }
    catch (error) {
      await finishScreen(ctx, "Commit", `Commit result is uncertain because HEAD could not be inspected: ${errorMessage(error)}\nDo not retry automatically. Verify the repository externally.`);
      return { kind: "finish" };
    }
    const classification = classifyPostCommitHead(binding.headOid, after, outcome);
    if (classification.classification === "head-advanced" && classification.commitOid) {
      if (outcome !== "success") ctx.ui.notify("The commit command reported a problem, but HEAD advanced. The created commit was preserved and will not be retried.", "warning");
      else ctx.ui.notify(`Created commit ${classification.commitOid}.`, "info");
      return { kind: "created", oid: classification.commitOid };
    }
    if (classification.classification === "not-created") {
      ctx.ui.notify(`No commit was created${diagnostic ? `: ${diagnostic}` : "."} Nothing was retried automatically.`, outcome === "timeout" ? "warning" : "error");
      continue;
    }
    await finishScreen(ctx, "Commit", `Commit result is uncertain. HEAD did not provide a safe success/failure classification.${diagnostic ? `\n${diagnostic}` : ""}\nDo not retry automatically; verify the repository externally.`);
    return { kind: "finish" };
  }
}

async function listRemotes(root: string): Promise<string[]> {
  return await readRemotes(root);
}

async function publishRepository(
  ctx: ExtensionCommandContext,
  active: ActiveWorkflow,
  state: RepositoryState,
): Promise<void> {
  const visibilityChoice = await showActionScreen(ctx, "Push", "Publish a new GitHub repository", "No remote exists. Visibility has no default; choose it explicitly or cancel.", [
    { value: "cancel", label: "Cancel publication", description: "Keep the repository local" },
    { value: "public", label: "Public" },
    { value: "private", label: "Private" },
  ]);
  assertCurrent(active);
  if (visibilityChoice !== "public" && visibilityChoice !== "private") return;
  const plan = await planRepositoryPublication(state.root, visibilityChoice);
  const exactTarget = `${plan.host}/${plan.account}/${plan.repositoryName}`;
  const confirmed = await showConfirmationOverlay(
    ctx,
    "Push",
    "Create and push this GitHub repository?",
    `Host: ${plan.host}\nAccount: ${plan.account}\nRepository: ${plan.repositoryName}\nExact target: ${exactTarget}\nVisibility: ${plan.visibility}\nBranch: ${confirmationValue(plan.branch)}\nHEAD: ${plan.headOid}\n\nCommand: gh ${plan.args.map((arg) => confirmationValue(arg)).join(" ")}\n\nA partial result is uncertain and will not be retried or cleaned up automatically.`,
    "Publish once",
  );
  assertCurrent(active);
  if (!confirmed) return;
  const outcome = await executeRepositoryPublication(plan, { assertCurrent: () => assertCurrent(active) });
  if (outcome.status === "published") {
    await finishScreen(ctx, "Push", `Published ${exactTarget} and pushed ${plan.headOid}.`);
  } else {
    await finishScreen(ctx, "Push", `Publication result is uncertain: ${outcome.diagnostic}\nDo not retry automatically. Inspect GitHub and local remotes first.`);
  }
}

async function resolvePushDestination(
  ctx: ExtensionCommandContext,
  active: ActiveWorkflow,
  root: string,
  branch: string,
  oid: string,
): Promise<{ destination: PushDestination; selectedRemote?: string } | null> {
  let selectedRemote: string | undefined;
  while (true) {
    const head = await readHeadOid(root);
    try {
      return {
        destination: await discoverPushDestination(root, { branch, createdCommitOid: oid, currentHeadOid: head, selectedRemote }),
        selectedRemote,
      };
    } catch (error) {
      if (!isCode(error, "REMOTE_SELECTION_REQUIRED")) {
        await finishScreen(ctx, "Push", `Push is unavailable: ${errorMessage(error)}\nThe created commit remains local.`);
        return null;
      }
      const remotes = await listRemotes(root);
      const choice = await showActionScreen(ctx, "Push", "Select a push remote", `Commit: ${oid}\nBranch: ${branch}\nA remote will not be chosen silently.`, [
        ...remotes.map((remote) => ({ value: `remote:${remote}`, label: remote, description: `Push ${oid}:refs/heads/${branch}` })),
        { value: "finish", label: "Finish without pushing" },
      ]);
      assertCurrent(active);
      if (!choice || choice === "finish") return null;
      selectedRemote = choice.slice("remote:".length);
    }
  }
}

async function pushStage(
  ctx: ExtensionCommandContext,
  active: ActiveWorkflow,
  state: RepositoryState,
  createdOid: string,
): Promise<void> {
  while (true) {
    if ((await readRemotes(state.root)).length === 0) {
      const choice = await showActionScreen(ctx, "Push", "No Git remote configured", `Repository: ${confirmationValue(state.root)}\nBranch: ${confirmationValue(state.branch)}\nHEAD: ${createdOid}`, [
        { value: "finish", label: "Finish without publishing" },
        { value: "publish", label: "Publish a new GitHub repository", description: "Requires authenticated system gh and explicit visibility" },
      ]);
      if (choice === "publish") await publishRepository(ctx, active, state);
      return;
    }
    const resolved = await resolvePushDestination(ctx, active, state.root, state.branch, createdOid);
    if (!resolved) return;
    const { destination, selectedRemote } = resolved;
    const choice = await showActionScreen(ctx, "Push", "Review push", `Commit: ${createdOid}\nRemote: ${destination.remote}\nBranch: ${destination.branch}\nRefspec: ${destination.refspec}`, [
      { value: "push", label: "Push commit", description: "No force option and no automatic retry" },
      { value: "finish", label: "Finish without pushing" },
    ]);
    assertCurrent(active);
    if (!choice || choice === "finish") return;
    const safeOid = confirmationValue(createdOid);
    const safeRemote = confirmationValue(destination.remote);
    const safeBranch = confirmationValue(destination.branch);
    const safeRefspec = confirmationValue(destination.refspec);
    const confirmed = await showConfirmationOverlay(
      ctx,
      "Push",
      "Push this exact commit?",
      `Commit: ${safeOid}\nRemote: ${safeRemote}\nBranch: ${safeBranch}\nRefspec: ${safeRefspec}\n\nCommand: git push -- ${safeRemote} ${safeRefspec}\n\nNo force option will be used.`,
      "Push exact commit",
    );
    assertCurrent(active);
    if (!confirmed) return await finishScreen(ctx, "Push", "Push cancelled. The created commit remains local.");
    const currentHead = await readHeadOid(state.root);
    let verifiedDestination: PushDestination;
    try {
      const refreshed = await preflightRepository(ctx.cwd);
      if (refreshed.root !== state.root || refreshed.branch !== state.branch || refreshed.headOid !== createdOid) {
        throw new GuidedGitError("STALE_PUSH_HEAD", "Repository root, branch, or HEAD changed after confirmation");
      }
      verifiedDestination = await discoverPushDestination(state.root, {
        branch: state.branch,
        createdCommitOid: createdOid,
        currentHeadOid: currentHead,
        selectedRemote,
      });
    } catch (error) {
      await finishScreen(ctx, "Push", `Push blocked because repository state changed: ${errorMessage(error)}\nThe created commit remains local.`);
      return;
    }
    if (
      verifiedDestination.remote !== destination.remote
      || verifiedDestination.branch !== destination.branch
      || verifiedDestination.refspec !== destination.refspec
    ) {
      ctx.ui.notify("Push destination changed after confirmation. No push was attempted. Review the refreshed destination and confirm again to continue.", "warning");
      continue;
    }
    const plan = planPush(verifiedDestination, createdOid, currentHead);
    try {
      const result = await executePlan(state.root, plan.args, PUSH_TIMEOUT_MS);
      if (result.exitCode === 0 && !result.timedOut) {
        await finishScreen(ctx, "Push", `Pushed ${createdOid}\nRemote: ${verifiedDestination.remote}\nBranch: ${verifiedDestination.branch}\nRefspec: ${verifiedDestination.refspec}`);
        return;
      }
      await finishScreen(ctx, "Push", `Push result is uncertain: ${errorMessage(result.stderr.length ? result.stderr : result.stdout)}\nThe remote may have received the commit. Do not retry automatically; verify the remote externally.`);
    } catch (error) {
      await finishScreen(ctx, "Push", `Push result is uncertain: ${errorMessage(error)}\nThe remote may have received the commit. Do not retry automatically; verify the remote externally.`);
    }
    return;
  }
}

function availableSetupModelChoices(ctx: ExtensionCommandContext): SetupModelChoice[] {
  const scoped = Array.isArray(ctx.scopedModels) && ctx.scopedModels.length > 0
    ? ctx.scopedModels.map((entry) => entry.model)
    : (ctx.modelRegistry.getAvailable?.() ?? []);
  const unique = new Map<string, SetupModelChoice>();
  for (const model of scoped) {
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string") continue;
    if (ctx.modelRegistry.hasConfiguredAuth && !ctx.modelRegistry.hasConfiguredAuth(model)) continue;
    const key = `${model.provider}\u0000${model.id}`;
    unique.set(key, { key, provider: model.provider, modelId: model.id, label: `${model.provider}/${model.id}`, model });
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

async function chooseWorkflowEntry(
  ctx: ExtensionCommandContext,
  preferences: GuidedGitPreferences,
): Promise<{ entry: "initialize"; state: null } | { entry: "stage" | "message" | "commit" | "push"; state: RepositoryState } | null> {
  let state: RepositoryState;
  try { state = await preflightRepository(ctx.cwd); }
  catch (error) {
    if (!isCode(error, "NOT_REPOSITORY")) throw error;
    const choice = await showActionScreen(ctx, "Initialize", "Start Guided Git", `${confirmationValue(ctx.cwd)} is not inside a Git repository.`, [
      { value: "finish", label: "Finish", description: "Leave this directory unchanged" },
      { value: "initialize", label: "Initialize repository", description: "Create a new repository on main after confirmation" },
    ]);
    return choice === "initialize" ? { entry: "initialize", state: null } : null;
  }
  const entries = ["stage", "message", "commit", "push"] as const;
  const ordered = [preferences.defaultEntry, ...entries.filter((entry) => entry !== preferences.defaultEntry)];
  const choice = await showActionScreen(ctx, "Stage", "Start Guided Git", `${state.root}\n${statusSummary(state)}\nChoose a direct entry. Every later mutation still performs fresh safety checks.`, [
    ...ordered.map((entry) => ({
      value: entry,
      label: entry[0]!.toUpperCase() + entry.slice(1),
      description: entry === "push" ? "Bind and review the current immutable HEAD" : entry === "stage" ? "Review or change the index" : "Requires staged changes and message review",
    })),
    { value: "finish", label: "Finish" },
  ]);
  return entries.includes(choice as typeof entries[number])
    ? { entry: choice as typeof entries[number], state }
    : null;
}

async function initializeRepositoryFlow(
  ctx: ExtensionCommandContext,
  active: ActiveWorkflow,
): Promise<{ state: RepositoryState; fingerprint: string } | null> {
  const plan = await planRepositoryInitialization(ctx.cwd);
  const confirmed = await showConfirmationOverlay(ctx, "Initialize", "Initialize this directory?", `Directory: ${confirmationValue(plan.root)}\nInitial branch: main\nCommand: git init --initial-branch=main --`, "Initialize repository");
  assertCurrent(active);
  if (!confirmed) return null;
  await executeRepositoryInitialization(plan, runGit, { assertCurrent: () => assertCurrent(active) });
  assertCurrent(active);
  const starters = await planStarterFiles(plan.root);
  assertCurrent(active);
  const creatable = starters.entries.filter((entry) => entry.status === "create").map((entry) => entry.relativePath);
  if (creatable.length === 0) {
    await finishScreen(ctx, "Initialize", "Repository initialized on main. Existing or blocked starter paths were preserved; nothing was staged.");
    return null;
  }
  const choice = await showActionScreen(ctx, "Initialize", "Prepare starter files", starters.entries.map((entry) => `${entry.relativePath}: ${entry.status}${entry.reason ? ` · ${entry.reason}` : ""}`).join("\n"), [
    { value: "skip", label: "Skip starter files", description: "Keep the empty repository" },
    ...(creatable.length === 2 ? [{ value: "both", label: "Create README.md and .gitignore" }] : []),
    ...creatable.map((relativePath) => ({ value: relativePath, label: `Create ${relativePath}` })),
  ]);
  assertCurrent(active);
  if (!choice || choice === "skip") return null;
  const selected = (choice === "both" ? creatable : [choice]) as StarterFilePath[];
  const createConfirmed = await showConfirmationOverlay(ctx, "Initialize", "Create selected starter files?", selected.map((file) => `Create ${file} without overwriting or following symlinks`).join("\n"), "Create starter files");
  assertCurrent(active);
  if (!createConfirmed) return null;
  const written = await executeStarterFiles(starters, selected, runGit, { assertCurrent: () => assertCurrent(active) });
  assertCurrent(active);
  const stageConfirmed = await showConfirmationOverlay(ctx, "Stage", "Stage these starter files?", `${selected.join("\n")}\n\nOnly these paths will be passed to git add.`, "Stage starter files");
  assertCurrent(active);
  if (!stageConfirmed) return null;
  await executeStarterFileStaging(written, selected, runGit, { assertCurrent: () => assertCurrent(active) });
  assertCurrent(active);
  return await captureBoundStagedState(plan.root);
}

async function stagedEntry(ctx: ExtensionCommandContext, state?: RepositoryState): Promise<{ state: RepositoryState; fingerprint: string }> {
  const captured = await captureBoundStagedState(ctx.cwd);
  if (state && captured.state.root !== state.root) throw new GuidedGitError("REPOSITORY_CHANGED", "The repository root changed before direct entry");
  return captured;
}

export default function gitGuidedWorkflow(pi: ExtensionAPI): void {
  let activeWorkflow: ActiveWorkflow | undefined;
  let activeNativeGeneration: { commandName: string; controller: AbortController } | undefined;
  const preferencesStore = async () => createGuidedGitPreferencesStore(await realpath(getAgentDir()).catch(() => getAgentDir()), withFileMutationQueue);

  async function runNativeGeneration(
    commandName: string,
    ctx: ExtensionCommandContext,
    target: NativeGenerationTarget,
    work: (signal: AbortSignal) => Promise<string[]>,
  ): Promise<void> {
    try {
      assertNativeGenerationSurface(ctx, commandName, target);
      if (activeNativeGeneration) {
        throw new GuidedGitError("GENERATION_BUSY", `/${activeNativeGeneration.commandName} generation is already active`);
      }
      const controller = new AbortController();
      activeNativeGeneration = { commandName, controller };
      const provider = sanitizeDiagnostic(String(target.model.provider || "generation model provider"), 200);
      const model = sanitizeDiagnostic(String(target.model.id || "generation model"), 200);
      const modelRole = target.isolated ? "configured generation model" : "active model";
      ctx.ui.notify(`/${commandName} sends the required bounded repository content directly to ${provider} using ${model} as its ${modelRole}. No parent-agent tools or prompt template are used.`, "info");
      try {
        let paths: string[];
        if (ctx.mode === "tui") {
          const result = await ctx.ui.custom<{ paths?: string[]; error?: unknown }>((tui, theme, _keybindings, done) => {
            const loader = new GenerationOverlay(
              tui,
              theme,
              `Generating with ${modelRole} ${model} for /${commandName}. Repository content is sent to ${provider}. Esc cancels.`,
            );
            let settled = false;
            const finish = (value: { paths?: string[]; error?: unknown }) => {
              if (settled) return;
              settled = true;
              done(value);
            };
            loader.onAbort = () => controller.abort();
            work(controller.signal)
              .then((value) => finish({ paths: value }))
              .catch((error) => finish({ error }));
            return loader;
          }, { overlay: true, overlayOptions: GUIDED_GIT_OVERLAY_OPTIONS });
          if (result.error) throw result.error;
          paths = result.paths ?? [];
        } else {
          paths = await work(controller.signal);
        }
        ctx.ui.notify(`/${commandName} completed: ${paths.map((item) => sanitizeDiagnostic(item, 500)).join(", ")}`, "info");
      } finally {
        controller.abort();
        const completionSettlement = nativeCompletionSettlements.get(controller.signal);
        if (activeNativeGeneration?.controller === controller) {
          if (completionSettlement) {
            void completionSettlement.finally(() => {
              nativeCompletionSettlements.delete(controller.signal);
              if (activeNativeGeneration?.controller === controller) activeNativeGeneration = undefined;
            });
          } else {
            activeNativeGeneration = undefined;
          }
        }
      }
    } catch (error) {
      const cancelled = isCode(error, "GENERATION_CANCELLED");
      ctx.ui.notify(`/${commandName} ${cancelled ? "cancelled" : "failed"}: ${errorMessage(error)}. No stale success was reported.`, cancelled ? "info" : "error");
      if (ctx.mode === "rpc") {
        if (isCode(error, "MODEL_GENERATION_FAILED")) {
          throw new Error(`${NATIVE_GENERATION_PROVIDER_FAILURE_MARKER}: active model generation failed`);
        }
        throw new Error(errorMessage(error));
      }
    }
  }

  pi.on("session_shutdown", async () => {
    activeNativeGeneration?.controller.abort();
    if (!activeWorkflow) return;
    activeWorkflow.cancelled = true;
    activeWorkflow.generationController?.abort();
  });

  pi.registerCommand(SETUP_COMMAND_NAME, {
    description: "Configure the native Guided Git workflow without changing the active Pi model",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(`/${SETUP_COMMAND_NAME} requires Pi's native TUI. No settings were changed.`, "error");
        return;
      }
      if (args.trim() || !ctx.isIdle() || ctx.hasPendingMessages() || activeWorkflow || activeNativeGeneration) {
        ctx.ui.notify(`/${SETUP_COMMAND_NAME} requires no arguments and an idle session with no Guided Git operation. No settings were changed.`, "warning");
        return;
      }
      try {
        const store = await preferencesStore();
        const snapshot = await store.load();
        const edited = await showSetupOverlay(ctx, snapshot.preferences, availableSetupModelChoices(ctx));
        if (!edited) {
          ctx.ui.notify("Guided Git setup cancelled. No settings were changed.", "info");
          return;
        }
        const validated = validateGuidedGitPreferences(edited);
        if (validated.generation.primary) targetFromProfile(ctx, validated.generation.primary, "Primary");
        if (validated.generation.fallback) targetFromProfile(ctx, validated.generation.fallback, "Fallback");
        const saved = await store.save(snapshot, validated);
        ctx.ui.notify(`Saved native Guided Git settings to ${saved.path}. The active Pi model and reasoning effort were not changed.`, "info");
      } catch (error) {
        ctx.ui.notify(`Guided Git setup stopped: ${errorMessage(error)} No settings were changed by this attempt.`, "error");
      }
    },
  });

  pi.registerCommand(COMMIT_GENERATION_COMMAND_NAME, {
    description: "Generate validated staged Conventional Commit artifacts with the active model",
    handler: async (rawArgs, ctx) => {
      let args;
      let invocation;
      try {
        invocation = resolveNativeGenerationInvocation(ctx, rawArgs);
        args = parseCommitGenerationArgs(invocation.publicArgs);
      }
      catch (error) { ctx.ui.notify(errorMessage(error), "error"); return; }
      await runNativeGeneration(COMMIT_GENERATION_COMMAND_NAME, ctx, invocation.target, async (signal) => {
        const context = await acquireStagedGenerationContext(ctx.cwd, { signal, maxBytes: COMMIT_GENERATION_CAPTURE_MAX_BYTES });
        let summaries: CommitChunkSummary[] | undefined;
        let output: string;
        if (context.byteLength <= COMMIT_GENERATION_DIRECT_MAX_BYTES) {
          output = await completeNativeRequest(ctx, invocation.target, buildCommitModelRequest(context, args), signal, COMMIT_OUTPUT_MAX_TOKENS);
        } else {
          ({ output, summaries } = await completeChunkedCommit(ctx, invocation.target, context, args, signal, COMMIT_GENERATION_COMMAND_NAME));
        }
        let generated: { short: string; long: string };
        try {
          generated = parseNativeCommitOutput(output, args.scope);
        } catch (error) {
          if (!(error instanceof GuidedGitError)) throw error;
          ctx.ui.notify(`/${COMMIT_GENERATION_COMMAND_NAME} received invalid output (${error.code}); sending one final correction request to the same model using the retained evidence.`, "warning");
          const evidence = summaries
            ? { kind: "summaries" as const, context, summaries }
            : context;
          const correctedOutput = await completeNativeRequest(ctx, invocation.target, buildCommitCorrectionModelRequest(evidence, args, {
            code: error.code,
            message: errorMessage(error),
            previousOutput: output,
          }), signal, COMMIT_OUTPUT_MAX_TOKENS);
          generated = parseNativeCommitOutput(correctedOutput, args.scope);
        }
        return (await writeCommitArtifacts(context, generated, { signal, scopePolicy: args.scope, queue: withFileMutationQueue })).paths;
      });
    },
  });

  pi.registerCommand(BRANCH_GENERATION_COMMAND_NAME, {
    description: "Generate a validated staged branch-name artifact with the active model",
    handler: async (rawArgs, ctx) => {
      let invocation;
      try {
        invocation = resolveNativeGenerationInvocation(ctx, rawArgs);
        parseBranchGenerationArgs(invocation.publicArgs);
      }
      catch (error) { ctx.ui.notify(errorMessage(error), "error"); return; }
      await runNativeGeneration(BRANCH_GENERATION_COMMAND_NAME, ctx, invocation.target, async (signal) => {
        const context = await acquireBranchGenerationContext(ctx.cwd, { signal });
        const output = await completeNativeRequest(ctx, invocation.target, buildBranchModelRequest(context), signal, BRANCH_OUTPUT_MAX_TOKENS);
        const branch = parseBranchOutput(output);
        return (await writeBranchArtifact(context, branch, { signal, queue: withFileMutationQueue })).paths;
      });
    },
  });

  pi.registerCommand(PR_GENERATION_COMMAND_NAME, {
    description: "Generate a validated pull-request description artifact with the active model",
    handler: async (rawArgs, ctx) => {
      let args;
      let invocation;
      try {
        invocation = resolveNativeGenerationInvocation(ctx, rawArgs);
        args = parsePrGenerationArgs(invocation.publicArgs);
      }
      catch (error) { ctx.ui.notify(errorMessage(error), "error"); return; }
      await runNativeGeneration(PR_GENERATION_COMMAND_NAME, ctx, invocation.target, async (signal) => {
        const context = await acquirePrGenerationContext(ctx.cwd, { signal });
        const output = await completeNativeRequest(ctx, invocation.target, buildPrModelRequest(context, args), signal, PR_OUTPUT_MAX_TOKENS);
        const body = parsePrOutput(output);
        return (await writePrArtifact(context, body, { signal, queue: withFileMutationQueue })).paths;
      });
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Guide staged changes through commit and push in Pi's TUI or request Guided Git in WebUI",
    handler: async (args, ctx) => {
      const supportedSurface = ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc");
      if (!supportedSurface) {
        ctx.ui.notify("/git-guided-workflow is available only in Pi's interactive TUI or a compatible WebUI RPC session. No Git command was run or WebUI workflow requested.", "error");
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("/git-guided-workflow accepts no arguments. No Git command was run or WebUI workflow requested.", "error");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("/git-guided-workflow requires an idle Pi session with no queued messages. No Git command was run or WebUI workflow requested.", "warning");
        return;
      }
      if (ctx.mode === "rpc") {
        requestWebuiStart(ctx);
        return;
      }
      if (activeWorkflow) {
        ctx.ui.notify("A guided Git workflow is already active. No second workflow was started.", "warning");
        return;
      }
      const active: ActiveWorkflow = { cancelled: false };
      activeWorkflow = active;
      try {
        const preferenceSnapshot = await (await preferencesStore()).load();
        const preferences = preferenceSnapshot.preferences;
        let generation: WorkflowGenerationConfig | null = null;
        let generationUnavailableNotice: string | undefined;
        try {
          generation = resolveWorkflowGeneration(ctx, preferences);
        } catch (error) {
          if (!isCode(error, "MODEL_UNAVAILABLE")) throw error;
          generationUnavailableNotice = `Configured generation is unavailable: ${errorMessage(error)} Manual, saved-artifact, deterministic, initialization, and push flows remain available; the active model was not substituted.`;
          ctx.ui.notify(generationUnavailableNotice, "warning");
        }
        const entry = await chooseWorkflowEntry(ctx, preferences);
        if (!entry) return;
        if (entry.entry === "push") {
          if (!entry.state.headOid) throw new GuidedGitError("MISSING_HEAD", "Push requires an existing HEAD commit");
          await pushStage(ctx, active, entry.state, entry.state.headOid);
          return;
        }
        let staged = entry.entry === "initialize"
          ? await initializeRepositoryFlow(ctx, active)
          : entry.entry === "stage"
            ? await chooseStage(ctx, active, preferences)
            : await stagedEntry(ctx, entry.state);
        while (staged) {
          let message: string | null;
          try { message = await chooseMessage(ctx, active, staged.state, staged.fingerprint, preferences, generation, generationUnavailableNotice); }
          catch (error) {
            if (isCode(error, "RETURN_TO_STAGE")) {
              staged = await chooseStage(ctx, active, preferences);
              continue;
            }
            throw error;
          }
          if (!message) return;
          const committed = await commitStage(ctx, active, staged.state, staged.fingerprint, message, preferences);
          if (committed.kind === "stage") {
            staged = await chooseStage(ctx, active, preferences);
            continue;
          }
          if (committed.kind === "finish") return;
          await pushStage(ctx, active, staged.state, committed.oid);
          return;
        }
      } catch (error) {
        if (!isCode(error, "WORKFLOW_CANCELLED")) ctx.ui.notify(`Guided Git workflow stopped: ${errorMessage(error)}`, "error");
      } finally {
        active.generationController?.abort();
        if (activeWorkflow === active) activeWorkflow = undefined;
      }
    },
  });
}
