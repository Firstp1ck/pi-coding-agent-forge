export const NATURAL_CONVERSATION_FEATURE_ID = "naturalConversation";

const NATURAL_CONVERSATION_STATUS_KEY = "natural-conversation";
const NATURAL_CONVERSATION_COMMAND_NAMES = ["talk", "voice", "conversation"];

export function createConversationModeService({
  packageName,
  optionalFeaturePackageStatus,
  getCommandData,
  extensionStatusMap,
  stripAnsi,
  makeHttpError,
  sanitizeError,
  safeRpcData,
  stateIsBusyForSettings,
  setThinkingLevelForTab,
  requestTimeoutMs,
  statusRpcTimeoutMs,
}) {
  function naturalConversationStatusState(statusText) {
    const text = stripAnsi(statusText).replace(/\s+/g, " ").trim();
    if (!text) return { enabled: false, uiState: "off", statusText: "" };
    const match = text.match(/voice\s*:\s*([a-z0-9_-]+)/i);
    return { enabled: true, uiState: (match?.[1] || "listening").toLowerCase(), statusText: text };
  }

  function naturalConversationModeSnapshot(tab, patch = {}) {
    const previous = tab?.conversationMode && typeof tab.conversationMode === "object" ? tab.conversationMode : {};
    const status = naturalConversationStatusState(extensionStatusMap(tab).get(NATURAL_CONVERSATION_STATUS_KEY) || previous.statusText || "");
    const enabled = patch.enabled ?? status.enabled ?? previous.enabled ?? false;
    const uiState = patch.uiState || (enabled ? status.uiState || previous.uiState || "listening" : "off");
    return {
      featureId: NATURAL_CONVERSATION_FEATURE_ID,
      available: patch.available ?? previous.available ?? false,
      enabled,
      uiState,
      statusText: patch.statusText ?? status.statusText ?? previous.statusText ?? "",
      allowedTools: Array.isArray(patch.allowedTools) ? patch.allowedTools : Array.isArray(previous.allowedTools) ? previous.allowedTools : ["read", "grep", "find", "ls"],
      provider: patch.provider || previous.provider || "browser-shell",
      startedAt: patch.startedAt ?? previous.startedAt ?? null,
      packageInstalled: patch.packageInstalled ?? previous.packageInstalled ?? false,
      loadedCommands: Array.isArray(patch.loadedCommands) ? patch.loadedCommands : Array.isArray(previous.loadedCommands) ? previous.loadedCommands : [],
      updatedAt: patch.updatedAt || previous.updatedAt || new Date().toISOString(),
    };
  }

  function resetNaturalConversationMode(tab) {
    if (!tab) return;
    tab.conversationMode = naturalConversationModeSnapshot(tab, { available: false, enabled: false, uiState: "off", statusText: "", loadedCommands: [] });
  }

  function rememberNaturalConversationStatusEvent(tab, event) {
    if (event?.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== NATURAL_CONVERSATION_STATUS_KEY) return;
    const status = naturalConversationStatusState(event.statusText || "");
    tab.conversationMode = naturalConversationModeSnapshot(tab, {
      ...status,
      available: true,
      loadedCommands: tab?.conversationMode?.loadedCommands?.length ? tab.conversationMode.loadedCommands : ["talk"],
    });
  }

  function isNaturalConversationActive(tab) {
    return naturalConversationModeSnapshot(tab).enabled === true;
  }

  function naturalConversationCommandBaseName(name) {
    return String(name || "").trim().toLowerCase().replace(/:\d+$/, "");
  }

  function naturalConversationSlashCommandName(message) {
    const match = String(message || "").trim().match(/^\/([^\s]+)/);
    return match ? naturalConversationCommandBaseName(match[1]) : "";
  }

  function isNaturalConversationSlashCommand(message) {
    return NATURAL_CONVERSATION_COMMAND_NAMES.includes(naturalConversationSlashCommandName(message));
  }

  function blockNaturalConversationAction(action) {
    throw makeHttpError(409, `Natural Conversation Mode is active; ${action}. Leave the mode first with /talk off.`);
  }

  function ensureNaturalConversationRouteAllowed(tab, action) {
    if (isNaturalConversationActive(tab)) blockNaturalConversationAction(action);
  }

  async function ensureNaturalConversationPromptSafety(tab, command) {
    if (!isNaturalConversationActive(tab) || !["prompt", "steer", "follow_up"].includes(command?.type)) return null;
    tab.pendingThinkingLevel = undefined;
    const stateResult = await safeRpcData(tab, { type: "get_state" }, statusRpcTimeoutMs);
    if (stateResult.ok && stateIsBusyForSettings(stateResult.data)) return null;
    const response = await setThinkingLevelForTab(tab, "off", { allowPending: false });
    return response?.success === false ? response : null;
  }

  function enforceNaturalConversationCommandAllowed(tab, command) {
    if (!isNaturalConversationActive(tab)) return;
    if (command?.type === "set_thinking_level") {
      if (command.level !== "off") blockNaturalConversationAction("thinking is forced off");
      return;
    }
    if (!["prompt", "steer", "follow_up", "abort", "abort_bash"].includes(command?.type)) {
      blockNaturalConversationAction(`${command?.type || "this action"} is blocked`);
    }
    if (command?.type === "prompt" && naturalConversationSlashCommandName(command.message) && !isNaturalConversationSlashCommand(command.message)) {
      blockNaturalConversationAction("slash commands are blocked from the Web UI shell");
    }
  }

  function naturalConversationLoadedCommandNames(commands = []) {
    const names = [];
    const seen = new Set();
    for (const command of commands || []) {
      const baseName = naturalConversationCommandBaseName(command?.name || command?.invokeName || "");
      if (!NATURAL_CONVERSATION_COMMAND_NAMES.includes(baseName) || seen.has(baseName)) continue;
      seen.add(baseName);
      names.push(baseName);
    }
    return names;
  }

  function rememberNaturalConversationCommands(tab, commands = []) {
    const loadedCommands = naturalConversationLoadedCommandNames(commands);
    const available = loadedCommands.length > 0;
    tab.conversationMode = naturalConversationModeSnapshot(tab, {
      available,
      enabled: available ? undefined : false,
      uiState: available ? undefined : "off",
      statusText: available ? undefined : "",
      loadedCommands,
    });
    return tab.conversationMode;
  }

  async function naturalConversationPackageStatus() {
    try {
      return await optionalFeaturePackageStatus(NATURAL_CONVERSATION_FEATURE_ID);
    } catch (error) {
      return { featureId: NATURAL_CONVERSATION_FEATURE_ID, packageName, installed: false, error: sanitizeError(error) };
    }
  }

  async function naturalConversationFeatureData(tab, { refreshCommands = true } = {}) {
    let commandData = null;
    let commandError = "";
    if (refreshCommands) {
      try {
        commandData = await getCommandData(tab, { annotateSkills: false });
      } catch (error) {
        commandError = sanitizeError(error);
        rememberNaturalConversationCommands(tab, []);
      }
    }
    const packageStatus = await naturalConversationPackageStatus();
    tab.conversationMode = naturalConversationModeSnapshot(tab, { packageInstalled: packageStatus.installed === true });
    const mode = naturalConversationModeSnapshot(tab);
    const available = mode.available === true;
    return {
      featureId: NATURAL_CONVERSATION_FEATURE_ID,
      packageName,
      available,
      packageInstalled: packageStatus.installed === true,
      packageStatus,
      commands: mode.loadedCommands,
      mode,
      rpcRunning: commandData?.rpcRunning !== false && !commandError,
      unavailableReason: available
        ? ""
        : packageStatus.installed
          ? "Natural Conversation package is installed, but /talk is not loaded in the active Pi tab. Reload the tab or enable the package extension."
          : "Natural Conversation package is not installed or not visible from the Web UI package root.",
      error: commandError || undefined,
    };
  }

  async function setNaturalConversationMode(tab, body = {}) {
    const desired = body.enabled === true;
    const feature = await naturalConversationFeatureData(tab);
    if (!feature.available) throw makeHttpError(404, feature.unavailableReason);
    const commandName = feature.commands.find((name) => name === "talk") || feature.commands[0] || "talk";
    const response = await tab.rpc.send({ type: "prompt", message: `/${commandName} ${desired ? "on" : "off"}` }, requestTimeoutMs);
    if (response.success === false) throw makeHttpError(400, response.error || `Failed to ${desired ? "enable" : "disable"} Natural Conversation Mode`);
    tab.conversationMode = naturalConversationModeSnapshot(tab, {
      available: true,
      enabled: desired,
      uiState: desired ? "listening" : "off",
      statusText: desired ? `Voice: listening` : "",
      loadedCommands: feature.commands,
      packageInstalled: feature.packageInstalled,
      startedAt: desired ? naturalConversationModeSnapshot(tab).startedAt || new Date().toISOString() : null,
    });
    if (desired) {
      tab.pendingThinkingLevel = undefined;
      await setThinkingLevelForTab(tab, "off", { allowPending: false }).catch(() => null);
    }
    return { ...(await naturalConversationFeatureData(tab, { refreshCommands: false })), response };
  }

  return {
    naturalConversationStatusState,
    naturalConversationModeSnapshot,
    resetNaturalConversationMode,
    rememberNaturalConversationStatusEvent,
    isNaturalConversationActive,
    naturalConversationCommandBaseName,
    naturalConversationSlashCommandName,
    isNaturalConversationSlashCommand,
    blockNaturalConversationAction,
    ensureNaturalConversationRouteAllowed,
    ensureNaturalConversationPromptSafety,
    enforceNaturalConversationCommandAllowed,
    naturalConversationLoadedCommandNames,
    rememberNaturalConversationCommands,
    naturalConversationPackageStatus,
    naturalConversationFeatureData,
    setNaturalConversationMode,
  };
}
