import { codexSpeedModeFromIntent, codexSpeedModeFromStatus } from "../../public/codex-speed-mode.mjs";

// Codex subscription Fast mode is owned by the optional @firstpick/pi-extension-codex-fast-mode
// package. The Web UI never inspects ChatGPT credentials or request payloads; it only mirrors the
// extension-published status key and drives the package-owned /fast-mode command over RPC.
const CODEX_FAST_MODE_FEATURE_ID = "codexFastMode";
const CODEX_FAST_MODE_STATUS_KEY = "codex-fast-mode";
const CODEX_FAST_MODE_COMMAND_NAME = "fast-mode";
const CODEX_FAST_MODE_PROVIDER = "openai-codex";
const CODEX_FAST_MODE_STATUS_TIMEOUT_MS = 1000;
const CODEX_FAST_MODE_CREDIT_NOTICE = "Fast mode increases Codex usage; current rates depend on the model and billing plan. Ultrafast requires GPT-6 Astra and Pro $500 or eligible Enterprise/Edu access, using 8x Standard included usage or 6x purchased-credit/pay-as-you-go usage. Workspace terms may differ. Only subscription-backed openai-codex requests are changed; upstream eligibility stays authoritative.";

/** Create the Codex speed adapter; the caller owns tab state, routes and lifecycle resets. */
export function createCodexFastModeService({
  packageName,
  optionalFeaturePackageStatus,
  getCommandData,
  currentSessionState,
  tabHasActiveOutput,
  extensionStatusMap,
  stripAnsi,
  makeHttpError,
  sanitizeError,
  sleepMs,
  requestTimeoutMs,
}) {
  function codexFastModeCommandBaseName(name) {
    return String(name || "").trim().toLowerCase().replace(/:\d+$/, "");
  }

  // Only exact extension-published preferences are authoritative, not RPC command success.
  function codexFastModeStatusState(statusText) {
    const mode = codexSpeedModeFromStatus(stripAnsi(statusText));
    return { known: mode !== null, enabled: mode !== null && mode !== "normal", mode };
  }

  function codexFastModeSnapshot(tab, patch = {}) {
    const previous = tab?.codexFastMode && typeof tab.codexFastMode === "object" ? tab.codexFastMode : {};
    const status = codexFastModeStatusState(extensionStatusMap(tab).get(CODEX_FAST_MODE_STATUS_KEY) || "");
    const mode = patch.mode ?? (status.known ? status.mode : previous.mode ?? null);
    const known = mode !== null && (patch.statusKnown ?? (status.known || previous.statusKnown === true));
    return {
      featureId: CODEX_FAST_MODE_FEATURE_ID,
      mode,
      enabled: mode !== null && mode !== "normal",
      statusKnown: known,
      updatedAt: patch.updatedAt || new Date().toISOString(),
    };
  }

  function resetCodexFastMode(tab) {
    if (!tab) return;
    tab.codexFastMode = null;
    tab.codexFastModeCommandName = "";
  }

  async function codexFastModePackageStatus() {
    try {
      return await optionalFeaturePackageStatus(CODEX_FAST_MODE_FEATURE_ID);
    } catch (error) {
      return { featureId: CODEX_FAST_MODE_FEATURE_ID, packageName, installed: false, error: sanitizeError(error) };
    }
  }

  async function codexFastModeCommandState(tab, { refreshCommands = true } = {}) {
    if (!refreshCommands) return { commandName: String(tab?.codexFastModeCommandName || ""), rpcRunning: true, error: "" };
    try {
      const data = await getCommandData(tab, { annotateSkills: false });
      const match = (data.commands || []).find((command) => codexFastModeCommandBaseName(command?.name) === CODEX_FAST_MODE_COMMAND_NAME);
      tab.codexFastModeCommandName = match?.name ? String(match.name) : "";
      return { commandName: tab.codexFastModeCommandName, rpcRunning: data.rpcRunning !== false, error: data.error || "" };
    } catch (error) {
      tab.codexFastModeCommandName = "";
      return { commandName: "", rpcRunning: false, error: sanitizeError(error) };
    }
  }

  async function codexFastModeFeatureData(tab, { refreshCommands = true } = {}) {
    const packageStatus = await codexFastModePackageStatus();
    const command = await codexFastModeCommandState(tab, { refreshCommands });
    const state = await currentSessionState(tab).catch(() => tab?.lastState || {});
    const model = state?.model?.provider && state?.model?.id
      ? { provider: String(state.model.provider), id: String(state.model.id), api: String(state.model.api || "") }
      : null;
    const mode = codexFastModeSnapshot(tab);
    tab.codexFastMode = mode;
    const available = !!command.commandName;
    return {
      featureId: CODEX_FAST_MODE_FEATURE_ID,
      packageName,
      available,
      packageInstalled: packageStatus.installed === true,
      packageStatus,
      commandName: command.commandName,
      enabled: mode.enabled,
      mode: mode.mode,
      statusKnown: mode.statusKnown,
      busy: tabHasActiveOutput(tab),
      model,
      modelEligible: model?.provider === CODEX_FAST_MODE_PROVIDER,
      ultrafastModelEligible: model?.provider === CODEX_FAST_MODE_PROVIDER && model.api === "openai-codex-responses" && model.id === "gpt-6-astra",
      creditNotice: CODEX_FAST_MODE_CREDIT_NOTICE,
      rpcRunning: command.rpcRunning,
      unavailableReason: available
        ? ""
        : packageStatus.installed
          ? "Codex Fast mode package is installed, but /fast-mode is not loaded in the active Pi tab. Reload the tab or enable the package extension."
          : "Codex Fast mode package is not installed or not visible from the Web UI package root.",
      error: command.error || undefined,
    };
  }

  async function waitForCodexFastModeStatus(tab, desired) {
    const deadline = Date.now() + CODEX_FAST_MODE_STATUS_TIMEOUT_MS;
    do {
      const snapshot = codexFastModeSnapshot(tab);
      if (snapshot.statusKnown && snapshot.mode === desired) {
        tab.codexFastMode = snapshot;
        return snapshot;
      }
      if (Date.now() >= deadline) break;
      await sleepMs(25);
    } while (true);
    const label = desired === "normal" ? "off" : desired === "fast" ? "on" : "ultrafast";
    throw makeHttpError(409, `Codex Fast mode did not confirm ${label}. The extension may be outdated, or the session may have become busy; inspect /fast-mode status and retry when idle.`);
  }

  async function setCodexFastMode(tab, body = {}) {
    let desired;
    try {
      desired = codexSpeedModeFromIntent(body);
    } catch (error) {
      throw makeHttpError(400, error.message);
    }
    const feature = await codexFastModeFeatureData(tab);
    if (!feature.available) throw makeHttpError(404, feature.unavailableReason);
    // A mid-turn tier change would produce a mixed-tier tool loop, so mutations are rejected while
    // the tab is working. Reading status stays available.
    if (feature.busy) throw makeHttpError(409, "This tab is busy; Codex Fast mode cannot change during a running turn. Wait for the turn to finish, then retry.");
    if (desired === "ultrafast" && !feature.ultrafastModelEligible) throw makeHttpError(400, "Select GPT-6 Astra through the subscription-backed openai-codex provider before enabling Ultrafast.");
    const argument = desired === "normal" ? "off" : desired === "fast" ? "on" : "ultrafast";
    const response = await tab.rpc.send({ type: "prompt", message: `/${feature.commandName} ${argument}` }, requestTimeoutMs);
    if (response.success === false) throw makeHttpError(400, response.error || `Failed to select Codex speed ${desired}`);
    // RPC success only means the extension command returned. Require its authoritative status event
    // to confirm the requested state so a busy-transition rejection cannot become false success.
    await waitForCodexFastModeStatus(tab, desired);
    return { ...(await codexFastModeFeatureData(tab, { refreshCommands: false })), requested: Object.hasOwn(body, "mode") ? desired : body.enabled };
  }

  return {
    codexFastModeCommandBaseName,
    codexFastModeStatusState,
    codexFastModeSnapshot,
    resetCodexFastMode,
    codexFastModePackageStatus,
    codexFastModeCommandState,
    codexFastModeFeatureData,
    waitForCodexFastModeStatus,
    setCodexFastMode,
  };
}
