import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  gitMessageArtifactPairReadiness,
  readStableGitMessageArtifactPair,
} from "../git-message-artifacts.mjs";
import {
  isGitWorkflowSetupComplete,
  readGitWorkflowPreferences,
  supportedGitWorkflowThinkingLevels,
} from "../git-workflow-preferences.mjs";

export function createGitGenerationService({
  getGitRoot,
  gitMutations,
  makeHttpError,
  sanitizeError,
  safeRpcData,
  currentSessionState,
  availableGitWorkflowModels,
  stateIsBusyForSettings,
  markTabWorking,
  markTabIdle,
  broadcastTabEvent,
  sendSseToClient,
  statusRpcTimeoutMs,
}) {
  const {
    assertExpectedStagedContentHash,
    gitWorkflowMessageCwd,
    commitMessagePaths,
    readGitWorkflowBranchName,
    readGitWorkflowPrDescription,
  } = gitMutations;

  function gitWorkflowGenerationProfileArgument(profile) {
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      provider: profile.provider,
      modelId: profile.modelId,
      thinkingLevel: profile.thinkingLevel,
    }), "utf8").toString("base64url");
    return `--firstpick-webui-generation-profile=${payload}`;
  }

  function gitWorkflowGenerationPrompt(kind, preferences, commandName, profile) {
    const generationProfile = gitWorkflowGenerationProfileArgument(profile);
    switch (kind) {
      case "commit":
        return `/${commandName} ${preferences.commit.language} ${preferences.commit.scope} ${generationProfile}`;
      case "branch":
        return `/${commandName} ${generationProfile}`;
      case "pr":
        return `/${commandName} ${preferences.commit.language} ${generationProfile}`;
      default:
        throw makeHttpError(400, "generation kind must be commit, branch, or pr");
    }
  }

  function guidedGitNativeCommandBase(kind) {
    if (kind === "commit") return "git-staged-msg";
    if (kind === "branch") return "git-branch-name";
    if (kind === "pr") return "pr";
    throw makeHttpError(400, "generation kind must be commit, branch, or pr");
  }

  async function resolveGuidedGitNativeCommand(tab, kind) {
    const baseName = guidedGitNativeCommandBase(kind);
    const response = await safeRpcData(tab, { type: "get_commands" }, statusRpcTimeoutMs);
    const commands = Array.isArray(response.data?.commands) ? response.data.commands : [];
    const command = commands.find((candidate) => candidate?.source === "extension" && candidate?.name === baseName)
      || commands.find((candidate) => candidate?.source === "extension" && String(candidate?.name || "").replace(/:\d+$/, "") === baseName);
    if (!response.ok || !command) {
      throw makeHttpError(409, `Guided Git requires the /${baseName} extension command in this Pi tab. Same-named prompt templates are not used.`);
    }
    return String(command.name);
  }

  const GUIDED_GIT_PROVIDER_FAILURE_MARKER = "FIRSTPICK_GUIDED_GIT_PROVIDER_FAILURE";
  const GUIDED_GIT_NATIVE_COMMAND_ERROR_GRACE_MS = 500;

  function boundedGitWorkflowGenerationError(message, fallback = "Guided Git generation failed") {
    const text = typeof message === "string" ? message : fallback;
    return text.replace(/[\r\n]+/g, " ").trim().slice(0, 240) || fallback;
  }

  function isGuidedGitProviderGenerationFailure(error) {
    return String(error?.message || error || "").includes(GUIDED_GIT_PROVIDER_FAILURE_MARKER);
  }

  function guidedGitNativeCommandErrorFromEvent(record, event) {
    const commandName = String(record?.nativeCommandName || "");
    if (event?.type !== "extension_error" || event.event !== "command" || !commandName || event.extensionPath !== `command:${commandName}`) return null;
    const error = new Error(String(event.error || `/${commandName} failed`));
    error.guidedGitProviderGenerationFailure = isGuidedGitProviderGenerationFailure(error);
    return error;
  }

  function gitWorkflowGenerationCancellationError() {
    const error = makeHttpError(409, "Guided Git generation was cancelled");
    error.code = "GIT_WORKFLOW_CANCELLED";
    return error;
  }

  function assertGitWorkflowGenerationOwnership(tab, record) {
    if (tab.gitWorkflowGeneration !== record) throw new Error("Guided Git generation is no longer active");
    if (record.cancelled) throw gitWorkflowGenerationCancellationError();
  }

  function attachGitWorkflowGenerationError(error, record) {
    if (!error || typeof error !== "object" || !record?.generationId || !record.fallbackStarted || record.cancelled || record.processLost) return error;
    error.gitWorkflowGeneration = {
      generationId: record.generationId,
      kind: record.kind,
      fallbackUsed: record.fallbackStarted === true,
      generation: publicGitWorkflowGenerationProfile(record.fallbackStarted && record.fallback ? record.fallback : record.primary),
      primaryGeneration: publicGitWorkflowGenerationProfile(record.primary),
    };
    return error;
  }

  function gitWorkflowGenerationProfile(provider, modelId, thinkingLevel, models) {
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId) || null;
    return { provider, modelId, thinkingLevel, model };
  }

  function publicGitWorkflowGenerationProfile(profile) {
    return {
      provider: String(profile?.provider || ""),
      modelId: String(profile?.modelId || ""),
      thinkingLevel: String(profile?.thinkingLevel || ""),
    };
  }

  async function createGitWorkflowArtifactGeneration(tab, generationId, kind) {
    const createdAt = Date.now();
    if (kind === "commit") {
      // Keep generation dispatch compatible with tabs whose cwd has not become
      // a repository yet; staging boundaries still verify the real Git root.
      const root = await getGitRoot(tab.cwd).catch(() => path.resolve(tab.cwd));
      const cwd = gitWorkflowMessageCwd(root, tab.cwd);
      return {
        id: generationId,
        kind,
        root,
        cwd,
        createdAt,
        baseline: await readStableGitMessageArtifactPair(commitMessagePaths(cwd)),
        terminal: false,
        successful: false,
      };
    }
    const baseline = kind === "branch"
      ? await readGitWorkflowBranchName(tab.cwd).catch(() => null)
      : await readGitWorkflowPrDescription(tab.cwd).catch(() => null);
    return { id: generationId, kind, cwd: path.resolve(tab.cwd), createdAt, baseline, terminal: false, successful: false };
  }

  async function assertGuidedGitNativeArtifactUpdated(tab, record) {
    const generation = record.artifactGeneration;
    if (!generation) throw new Error("Guided Git generation has no artifact correlation record");
    if (generation.kind === "commit") {
      const pair = await readStableGitMessageArtifactPair(commitMessagePaths(generation.cwd));
      const readiness = gitMessageArtifactPairReadiness(generation.baseline, pair);
      if (!readiness.ready) throw new Error(readiness.reason || "Native commit generation did not update both message artifacts");
      return;
    }
    const current = generation.kind === "branch"
      ? await readGitWorkflowBranchName(tab.cwd)
      : await readGitWorkflowPrDescription(tab.cwd);
    if (generation.baseline
      && current.path === generation.baseline.path
      && current.mtimeMs === generation.baseline.mtimeMs
      && current.ctimeMs === generation.baseline.ctimeMs
      && current.ino === generation.baseline.ino) {
      throw new Error(`Native ${generation.kind} generation did not update its correlated artifact`);
    }
  }

  function emitGitWorkflowFallbackLifecycle(tab, record, phase) {
    const event = {
      type: `webui_git_workflow_generation_fallback_${phase}`,
      tabId: tab.id,
      tabTitle: tab.title,
      generationId: record.generationId,
      kind: record.kind,
      generation: publicGitWorkflowGenerationProfile(record.fallback),
      primaryGeneration: publicGitWorkflowGenerationProfile(record.primary),
      ...(phase === "started"
        ? { reason: boundedGitWorkflowGenerationError("The primary Git-writing model ended with an error.") }
        : { error: boundedGitWorkflowGenerationError("The fallback Git-writing model ended with an error.") }),
    };
    const lifecycle = tab.gitWorkflowFallbackLifecycle;
    if (lifecycle?.generationId === record.generationId) {
      lifecycle.events = [...lifecycle.events.filter((item) => item.type !== event.type), event].slice(-2);
    }
    broadcastTabEvent(tab, event);
  }

  function replayGitWorkflowFallbackLifecycle(tab, client) {
    const lifecycle = tab.gitWorkflowFallbackLifecycle;
    for (const event of lifecycle?.events || []) sendSseToClient(client, { ...event, replayed: true });
  }

  async function finishGitWorkflowGeneration(tab, record, { successful }) {
    if (tab.gitWorkflowGeneration !== record || record.finishing) return;
    record.finishing = true;
    const artifactGeneration = record.artifactGeneration;
    if (artifactGeneration && tab.gitWorkflowArtifactGeneration === artifactGeneration) {
      artifactGeneration.terminal = true;
      artifactGeneration.successful = successful === true && !record.cancelled;
    }
    if (!successful && record.messageGeneration && tab.gitWorkflowMessageGeneration?.id === record.messageGeneration.id) {
      tab.gitWorkflowMessageGeneration = record.previousMessageGeneration;
    }
    markTabIdle(tab);
    if (tab.gitWorkflowGeneration === record) tab.gitWorkflowGeneration = null;
  }

  async function dispatchGitWorkflowGenerationAttempt(tab, record, profile, attempt) {
    assertGitWorkflowGenerationOwnership(tab, record);
    if (!tab.rpc?.isRunning?.()) throw new Error("Pi RPC process is not running");
    if (!profile.model) throw new Error(`Configured ${attempt} Git-writing model is unavailable: ${profile.provider}/${profile.modelId}`);
    if (!supportedGitWorkflowThinkingLevels(profile.model).includes(profile.thinkingLevel)) {
      throw new Error(`Configured ${attempt} thinking level ${profile.thinkingLevel} is unavailable for ${profile.provider}/${profile.modelId}`);
    }

    record.attempt = attempt;
    record.attemptRunStarted = false;
    record.promptAccepted = false;
    record.pendingSettlement = null;
    record.nativeCommandError = null;
    record.message = gitWorkflowGenerationPrompt(record.kind, record.preferences, record.nativeCommandName, profile);

    assertGitWorkflowGenerationOwnership(tab, record);
    markTabWorking(tab);
    const response = await tab.rpc.send({ type: "prompt", message: record.message });
    assertGitWorkflowGenerationOwnership(tab, record);
    if (response.success === false) {
      const error = new Error(response.error || "Guided Git generation prompt was rejected");
      error.guidedGitProviderGenerationFailure = isGuidedGitProviderGenerationFailure(response.error);
      throw error;
    }
    if (record.nativeCommandError) throw record.nativeCommandError;
    record.promptAccepted = true;
    const pendingSettlement = record.pendingSettlement;
    if (pendingSettlement?.attempt === attempt) {
      record.pendingSettlement = null;
      void settleGitWorkflowGeneration(tab, record, pendingSettlement);
    }
    const result = {
      accepted: true,
      kind: record.kind,
      message: record.message,
      generationId: record.generationId,
      generation: publicGitWorkflowGenerationProfile(profile),
      fallbackUsed: attempt === "fallback",
      primaryGeneration: publicGitWorkflowGenerationProfile(record.primary),
    };
    if (record.nativeGeneration) {
      try {
        await assertGuidedGitNativeArtifactUpdated(tab, record);
      } catch (artifactError) {
        assertGitWorkflowGenerationOwnership(tab, record);
        if (!record.nativeCommandError) await delay(GUIDED_GIT_NATIVE_COMMAND_ERROR_GRACE_MS);
        assertGitWorkflowGenerationOwnership(tab, record);
        if (record.nativeCommandError) throw record.nativeCommandError;
        throw artifactError;
      }
      assertGitWorkflowGenerationOwnership(tab, record);
      await finishGitWorkflowGeneration(tab, record, { successful: true });
    }
    return result;
  }

  async function startGitWorkflowFallback(tab, record, primaryError) {
    if (tab.gitWorkflowGeneration !== record || record.fallbackStarted || !record.fallback) return null;
    if (record.cancelled || !tab.rpc?.isRunning?.() || primaryError?.guidedGitProviderGenerationFailure !== true) return null;
    record.fallbackStarted = true;
    record.attempt = "fallback";
    record.attemptRunStarted = false;
    record.promptAccepted = false;
    console.error(`[guided-git] primary generation ${record.generationId} failed; starting fallback: ${sanitizeError(primaryError)}`);
    emitGitWorkflowFallbackLifecycle(tab, record, "started");
    try {
      return await dispatchGitWorkflowGenerationAttempt(tab, record, record.fallback, "fallback");
    } catch (error) {
      if (!record.cancelled && tab.gitWorkflowGeneration === record) {
        console.error(`[guided-git] fallback generation ${record.generationId} failed: ${sanitizeError(error)}`);
        emitGitWorkflowFallbackLifecycle(tab, record, "failed");
      }
      await finishGitWorkflowGeneration(tab, record, { successful: false });
      throw error;
    }
  }

  async function settleGitWorkflowGeneration(tab, record, { failed, cancelled }) {
    if (tab.gitWorkflowGeneration !== record || record.finishing) return;
    if (cancelled) record.cancelled = true;
    if (record.attempt === "primary" && failed && !record.cancelled && record.fallback) {
      try {
        const result = await startGitWorkflowFallback(tab, record, "The primary Git-writing model ended with an error");
        if (result) return;
      } catch {
        // startGitWorkflowFallback emitted the bounded terminal lifecycle event.
        return;
      }
    }
    if (record.attempt === "fallback" && failed) {
      emitGitWorkflowFallbackLifecycle(tab, record, "failed");
    }
    await finishGitWorkflowGeneration(tab, record, { successful: !failed && !record.cancelled });
  }

  function consumeGitWorkflowGenerationEvent(tab, event, { finalError = false } = {}) {
    const record = tab.gitWorkflowGeneration;
    if (!record || record.finishing) return;
    const nativeCommandError = guidedGitNativeCommandErrorFromEvent(record, event);
    if (nativeCommandError) {
      record.nativeCommandError = nativeCommandError;
      return;
    }
    if ((event?.type === "agent_end" || event?.type === "agent_settled") && event.aborted === true) record.cancelled = true;
    if (event?.type === "agent_start") {
      record.attemptRunStarted = true;
      return;
    }
    if (event?.type !== "agent_settled" || !record.attemptRunStarted) return;
    record.attemptRunStarted = false;
    const settlement = { attempt: record.attempt, failed: finalError, cancelled: record.cancelled };
    if (!record.promptAccepted) {
      record.pendingSettlement = settlement;
      return;
    }
    void settleGitWorkflowGeneration(tab, record, settlement);
  }

  async function startGitWorkflowGeneration(tab, body = {}) {
    if (tab.gitWorkflowGeneration) throw makeHttpError(409, "A guided Git generation request is already active in this tab");
    const kind = String(body.kind || "").trim();
    if (!new Set(["commit", "branch", "pr"]).has(kind)) throw makeHttpError(400, "generation kind must be commit, branch, or pr");

    // Reserve the tab synchronously before the first await. All preflight and
    // profile transitions retain this exact object as their ownership token.
    const record = {
      generationId: randomUUID(),
      kind,
      message: "",
      preferences: null,
      previousMessageGeneration: tab.gitWorkflowMessageGeneration || null,
      messageGeneration: null,
      artifactGeneration: null,
      primary: null,
      fallback: null,
      fallbackStarted: false,
      cancelled: false,
      finishing: false,
      attempt: "primary",
      attemptRunStarted: false,
      promptAccepted: false,
      pendingSettlement: null,
      nativeCommandName: "",
      nativeCommandError: null,
      nativeGeneration: true,
    };
    tab.gitWorkflowGeneration = record;
    tab.gitWorkflowFallbackLifecycle = { generationId: record.generationId, kind, events: [] };

    try {
      // Browser state is untrusted. When it claims an approved content token,
      // verify the exact current index again at this server action boundary.
      await assertExpectedStagedContentHash(tab, body);
      assertGitWorkflowGenerationOwnership(tab, record);
      const preferences = await readGitWorkflowPreferences();
      assertGitWorkflowGenerationOwnership(tab, record);
      if (!isGitWorkflowSetupComplete(preferences)) throw makeHttpError(409, "Run /git-workflow-setup or open Guided Git Setup before generating Git text");
      record.preferences = preferences;
      const nativeCommandName = await resolveGuidedGitNativeCommand(tab, kind);
      assertGitWorkflowGenerationOwnership(tab, record);
      record.nativeCommandName = nativeCommandName;

      const state = await currentSessionState(tab);
      assertGitWorkflowGenerationOwnership(tab, record);
      if (stateIsBusyForSettings(state)) throw makeHttpError(409, "Wait for the current agent run to finish before generating Git text");
      const models = await availableGitWorkflowModels(tab);
      assertGitWorkflowGenerationOwnership(tab, record);
      record.primary = gitWorkflowGenerationProfile(
        preferences.generation.provider,
        preferences.generation.modelId,
        preferences.generation.thinkingLevel,
        models,
      );
      const fallbackConfigured = !!preferences.generation.fallback?.provider
        && !!preferences.generation.fallback?.modelId
        && (preferences.generation.fallback.provider !== preferences.generation.provider
          || preferences.generation.fallback.modelId !== preferences.generation.modelId);
      record.fallback = fallbackConfigured
        ? gitWorkflowGenerationProfile(
            preferences.generation.fallback.provider,
            preferences.generation.fallback.modelId,
            preferences.generation.fallback.thinkingLevel,
            models,
          )
        : null;

      record.artifactGeneration = await createGitWorkflowArtifactGeneration(tab, record.generationId, kind);
      record.messageGeneration = kind === "commit" ? record.artifactGeneration : null;
      assertGitWorkflowGenerationOwnership(tab, record);
      tab.gitWorkflowArtifactGeneration = record.artifactGeneration;
      if (record.messageGeneration) tab.gitWorkflowMessageGeneration = record.messageGeneration;

      try {
        return await dispatchGitWorkflowGenerationAttempt(tab, record, record.primary, "primary");
      } catch (primaryError) {
        if (tab.gitWorkflowGeneration === record) markTabIdle(tab);
        if (record.fallback && !record.cancelled && tab.rpc?.isRunning?.() && primaryError?.guidedGitProviderGenerationFailure === true) {
          try {
            const fallbackResult = await startGitWorkflowFallback(tab, record, primaryError);
            if (fallbackResult) return fallbackResult;
          } catch (fallbackError) {
            throw attachGitWorkflowGenerationError(fallbackError, record);
          }
        }
        await finishGitWorkflowGeneration(tab, record, { successful: false });
        throw attachGitWorkflowGenerationError(primaryError, record);
      }
    } catch (error) {
      if (tab.gitWorkflowGeneration === record && !record.finishing) {
        await finishGitWorkflowGeneration(tab, record, { successful: false });
      }
      throw error;
    }
  }

  function cancelGitWorkflowGeneration(tab) {
    const generation = tab?.gitWorkflowGeneration || null;
    if (generation) generation.cancelled = true;
    return !!generation;
  }

  function loseGitWorkflowGeneration(tab) {
    if (tab.gitWorkflowGeneration) tab.gitWorkflowGeneration.processLost = true;
    if (tab.gitWorkflowArtifactGeneration) {
      tab.gitWorkflowArtifactGeneration.terminal = true;
      tab.gitWorkflowArtifactGeneration.successful = false;
    }
    tab.gitWorkflowGeneration = null;
    tab.gitWorkflowMessageGeneration = null;
  }

  return {
    startGitWorkflowGeneration,
    consumeGitWorkflowGenerationEvent,
    replayGitWorkflowFallbackLifecycle,
    cancelGitWorkflowGeneration,
    loseGitWorkflowGeneration,
  };
}
