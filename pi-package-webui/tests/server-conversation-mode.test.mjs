import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import * as conversationMode from "../lib/server/conversation-mode.mjs";
import { OPTIONAL_FEATURE_BY_ID } from "../lib/optional-feature-catalog.mjs";

const { createConversationModeService, NATURAL_CONVERSATION_FEATURE_ID } = conversationMode;
const packageName = OPTIONAL_FEATURE_BY_ID.get(NATURAL_CONVERSATION_FEATURE_ID).packageName;
const requestTimeoutMs = 731;
const statusRpcTimeoutMs = 127;
const serviceNames = [
  "naturalConversationStatusState", "naturalConversationModeSnapshot", "resetNaturalConversationMode",
  "rememberNaturalConversationStatusEvent", "isNaturalConversationActive", "naturalConversationCommandBaseName",
  "naturalConversationSlashCommandName", "isNaturalConversationSlashCommand", "blockNaturalConversationAction",
  "ensureNaturalConversationRouteAllowed", "ensureNaturalConversationPromptSafety", "enforceNaturalConversationCommandAllowed",
  "naturalConversationLoadedCommandNames", "rememberNaturalConversationCommands", "naturalConversationPackageStatus",
  "naturalConversationFeatureData", "setNaturalConversationMode",
];

function fixture(options = {}) {
  const calls = [];
  const packageStatus = { featureId: NATURAL_CONVERSATION_FEATURE_ID, packageName, installed: options.installed ?? false };
  const response = options.response ?? { success: true, data: { accepted: true } };
  const tab = {
    id: "tab-a",
    extensionStatuses: new Map(),
    pendingThinkingLevel: "high",
    rpc: {
      async send(command, timeout) {
        calls.push(["rpc", command, timeout]);
        if (options.rpcError) throw options.rpcError;
        return response;
      },
    },
  };
  let service;
  service = createConversationModeService({
    packageName,
    async optionalFeaturePackageStatus(featureId) {
      calls.push(["package", featureId]);
      if (options.packageError) throw options.packageError;
      return packageStatus;
    },
    async getCommandData(target, commandOptions) {
      calls.push(["commands", target, commandOptions]);
      if (options.commandError) throw options.commandError;
      const commands = options.commands ?? [];
      service.rememberNaturalConversationCommands(target, commands);
      return { commands, rpcRunning: options.rpcRunning ?? true };
    },
    extensionStatusMap: (target) => target.extensionStatuses,
    stripAnsi: (value) => stripVTControlCharacters(String(value ?? "")),
    makeHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    sanitizeError: (error) => `sanitized: ${error.message}`,
    async safeRpcData(target, command, timeout) {
      calls.push(["state", target, command, timeout]);
      if (options.stateError) throw options.stateError;
      return options.stateResult ?? { ok: true, data: {} };
    },
    stateIsBusyForSettings: (state) => !!(state?.isStreaming || state?.isCompacting),
    async setThinkingLevelForTab(target, level, thinkingOptions) {
      calls.push(["thinking", target, level, thinkingOptions]);
      if (options.thinkingError) throw options.thinkingError;
      return options.thinkingResponse ?? { success: true };
    },
    requestTimeoutMs,
    statusRpcTimeoutMs,
  });
  return { service, tab, calls, packageStatus, response };
}

function statusEvent(service, tab, statusText) {
  // The parent records extension status before notifying this service.
  if (statusText) tab.extensionStatuses.set("natural-conversation", statusText);
  else tab.extensionStatuses.delete("natural-conversation");
  service.rememberNaturalConversationStatusEvent(tab, {
    type: "extension_ui_request", method: "setStatus", statusKey: "natural-conversation", statusText,
  });
}

function httpError(statusCode, message) {
  return (error) => error.statusCode === statusCode && error.message === message;
}

const blockedMessage = (action) => `Natural Conversation Mode is active; ${action}. Leave the mode first with /talk off.`;

test("factory exports the C1 contract and defers every dependency until use", { timeout: 1_000 }, async () => {
  assert.deepEqual(Object.keys(conversationMode).sort(), ["NATURAL_CONVERSATION_FEATURE_ID", "createConversationModeService"]);
  assert.equal(NATURAL_CONVERSATION_FEATURE_ID, "naturalConversation");
  const { service, calls } = fixture();
  assert.deepEqual(Object.keys(service).sort(), [...serviceNames].sort());
  assert.deepEqual(calls, []);
  let discovery;
  const lateService = createConversationModeService({
    getCommandData: (...args) => discovery(...args),
    optionalFeaturePackageStatus: async () => ({ installed: false }),
    extensionStatusMap: (tab) => tab.extensionStatuses,
    stripAnsi: String,
  });
  const tab = { extensionStatuses: new Map() };
  discovery = async (target, options) => {
    assert.equal(target, tab);
    assert.deepEqual(options, { annotateSkills: false });
    lateService.rememberNaturalConversationCommands(target, [{ name: "talk" }]);
    return { rpcRunning: true };
  };
  assert.equal((await lateService.naturalConversationFeatureData(tab)).available, true);
});

test("status parsing preserves ANSI stripping, whitespace, arbitrary status and voice states", () => {
  const { service } = fixture();
  for (const [input, expected] of [
    [undefined, { enabled: false, uiState: "off", statusText: "" }],
    [" \n\t ", { enabled: false, uiState: "off", statusText: "" }],
    ["\u001b[32mVoice: SPEAKING\u001b[0m\n ready", { enabled: true, uiState: "speaking", statusText: "Voice: SPEAKING ready" }],
    ["connected", { enabled: true, uiState: "listening", statusText: "connected" }],
    ["Voice : waiting_2-test", { enabled: true, uiState: "waiting_2-test", statusText: "Voice : waiting_2-test" }],
  ]) assert.deepEqual(service.naturalConversationStatusState(input), expected);
});

test("snapshots retain real tab metadata and prefer extension status over previous status", () => {
  const { service, tab } = fixture();
  const snapshot = service.naturalConversationModeSnapshot(tab, { updatedAt: "fixed" });
  assert.deepEqual(snapshot, {
    featureId: NATURAL_CONVERSATION_FEATURE_ID, available: false, enabled: false, uiState: "off", statusText: "",
    allowedTools: ["read", "grep", "find", "ls"], provider: "browser-shell", startedAt: null,
    packageInstalled: false, loadedCommands: [], updatedAt: "fixed",
  });
  assert.equal(tab.conversationMode, undefined);
  tab.conversationMode = { ...snapshot, enabled: true };
  assert.equal(service.isNaturalConversationActive(tab), false, "the enabled field alone does not replace status semantics");
  tab.conversationMode = { ...snapshot, statusText: "Voice: listening", provider: "custom", startedAt: "start", allowedTools: ["read"], loadedCommands: ["voice"] };
  tab.extensionStatuses.set("natural-conversation", "Voice: speaking");
  assert.deepEqual(service.naturalConversationModeSnapshot(tab), { ...tab.conversationMode, enabled: true, uiState: "speaking", statusText: "Voice: speaking" });
  assert.deepEqual(service.naturalConversationModeSnapshot(tab, { enabled: false, allowedTools: [], loadedCommands: [], provider: "override", startedAt: null }), {
    ...tab.conversationMode, enabled: false, uiState: "off", statusText: "Voice: speaking", allowedTools: [], loadedCommands: [], provider: "override",
  });
});

test("status events, command discovery and reset mutate the supplied tab only", () => {
  const { service, tab } = fixture();
  for (const event of [null, {}, { type: "extension_ui_request", method: "notify", statusKey: "natural-conversation" },
    { type: "extension_ui_request", method: "setStatus", statusKey: "another" }]) {
    service.rememberNaturalConversationStatusEvent(tab, event);
    assert.equal(tab.conversationMode, undefined);
  }
  statusEvent(service, tab, "Voice: listening");
  assert.equal(tab.conversationMode.available, true);
  assert.deepEqual(tab.conversationMode.loadedCommands, ["talk"]);
  assert.equal(service.isNaturalConversationActive(tab), true);
  service.rememberNaturalConversationCommands(tab, [{ name: "voice:2" }]);
  statusEvent(service, tab, "Voice: speaking");
  assert.deepEqual(tab.conversationMode.loadedCommands, ["voice"]);
  statusEvent(service, tab, "");
  assert.equal(service.isNaturalConversationActive(tab), false);
  assert.equal(tab.conversationMode.available, true);
  tab.conversationMode.packageInstalled = true;
  tab.extensionStatuses.clear();
  service.resetNaturalConversationMode(tab);
  assert.equal(tab.conversationMode.available, false);
  assert.equal(tab.conversationMode.enabled, false);
  assert.equal(tab.conversationMode.uiState, "off");
  assert.equal(tab.conversationMode.statusText, "");
  assert.equal(tab.conversationMode.packageInstalled, true);
  assert.deepEqual(tab.conversationMode.loadedCommands, []);
  assert.equal(service.isNaturalConversationActive({ extensionStatuses: new Map() }), false);
  assert.equal(service.resetNaturalConversationMode(null), undefined);
});

test("command names normalize numeric suffixes and deduplicate in discovery order", () => {
  const { service } = fixture();
  assert.deepEqual(service.naturalConversationLoadedCommandNames([
    null, {}, { name: " Talk:12 " }, { name: "talk" }, { invokeName: "VOICE:2" },
    { name: "conversation:0" }, { name: "voice:abc" }, { name: "other", invokeName: "talk" },
    { name: "/talk" }, { name: "talk:1:2" },
  ]), ["talk", "voice", "conversation"]);
  assert.deepEqual(service.naturalConversationLoadedCommandNames(null), []);
  assert.deepEqual(service.naturalConversationLoadedCommandNames(), []);
  for (const [input, expected] of [[" Talk:12 ", "talk"], ["voice:abc", "voice:abc"], ["talk:1:2", "talk:1"], [null, ""]]) {
    assert.equal(service.naturalConversationCommandBaseName(input), expected);
  }
  for (const name of ["talk", "voice", "conversation"]) {
    assert.equal(service.naturalConversationSlashCommandName(` /${name.toUpperCase()}:42 off`), name);
    assert.equal(service.isNaturalConversationSlashCommand(` /${name}:42 off`), true);
  }
  for (const message of ["talk", "/talk:abc", "/talking", "/voice:1:2", "/", "", null]) {
    assert.equal(service.isNaturalConversationSlashCommand(message), false);
  }
});

for (const installed of [false, true]) {
  for (const loaded of [false, true]) {
    for (const active of [false, true]) {
      test(`feature data: installed=${installed}, loaded=${loaded}, status=${active}`, { timeout: 1_000 }, async () => {
        const { service, tab, calls, packageStatus } = fixture({ installed, commands: loaded ? [{ name: "voice:3" }] : [] });
        if (active) statusEvent(service, tab, "Voice: speaking");
        const data = await service.naturalConversationFeatureData(tab);
        assert.equal(data.featureId, NATURAL_CONVERSATION_FEATURE_ID);
        assert.equal(data.packageName, packageName);
        assert.equal(data.packageStatus, packageStatus);
        assert.equal(data.available, loaded);
        assert.equal(data.packageInstalled, installed);
        assert.deepEqual(data.commands, loaded ? ["voice"] : []);
        assert.equal(data.mode.available, loaded);
        assert.equal(data.mode.enabled, active);
        assert.equal(data.rpcRunning, true);
        assert.equal(data.error, undefined);
        assert.equal(data.unavailableReason, loaded ? "" : installed
          ? "Natural Conversation package is installed, but /talk is not loaded in the active Pi tab. Reload the tab or enable the package extension."
          : "Natural Conversation package is not installed or not visible from the Web UI package root.");
        assert.deepEqual(calls, [["commands", tab, { annotateSkills: false }], ["package", NATURAL_CONVERSATION_FEATURE_ID]]);
      });
    }
  }
}

test("package and command failures keep their distinct payloads and sanitized errors", { timeout: 1_000 }, async () => {
  const { service, tab, calls } = fixture({ packageError: new Error("package failed"), commandError: new Error("commands failed") });
  service.rememberNaturalConversationCommands(tab, [{ name: "talk" }]);
  const data = await service.naturalConversationFeatureData(tab);
  assert.deepEqual(data.packageStatus, { featureId: NATURAL_CONVERSATION_FEATURE_ID, packageName, installed: false, error: "sanitized: package failed" });
  assert.equal(data.error, "sanitized: commands failed");
  assert.equal(data.rpcRunning, false);
  assert.equal(data.available, false);
  assert.deepEqual(tab.conversationMode.loadedCommands, []);
  calls.length = 0;
  const cached = await service.naturalConversationFeatureData(tab, { refreshCommands: false });
  assert.equal(cached.rpcRunning, true, "no refresh retains the existing optimistic RPC indicator");
  assert.equal(cached.error, undefined);
  assert.deepEqual(calls, [["package", NATURAL_CONVERSATION_FEATURE_ID]]);
  const stopped = fixture({ rpcRunning: false });
  assert.equal((await stopped.service.naturalConversationFeatureData(stopped.tab)).rpcRunning, false);
});

test("active command and route guards preserve the exact allowlist and errors", () => {
  const { service, tab } = fixture();
  assert.doesNotThrow(() => service.ensureNaturalConversationRouteAllowed(tab, "file deletion is blocked"));
  assert.doesNotThrow(() => service.enforceNaturalConversationCommandAllowed(tab, { type: "bash" }));
  statusEvent(service, tab, "Voice: listening");
  assert.throws(() => service.ensureNaturalConversationRouteAllowed(tab, "file deletion is blocked"), httpError(409, blockedMessage("file deletion is blocked")));
  for (const command of [
    { type: "prompt", message: "hello" }, { type: "prompt", message: "/" },
    ...["talk", "voice", "conversation"].map((name) => ({ type: "prompt", message: ` /${name.toUpperCase()}:2 off` })),
    { type: "steer", message: "/bash retained existing policy" }, { type: "follow_up", message: "/other" },
    { type: "abort" }, { type: "abort_bash" }, { type: "set_thinking_level", level: "off" },
  ]) assert.doesNotThrow(() => service.enforceNaturalConversationCommandAllowed(tab, command));
  for (const type of ["get_state", "get_commands", "set_model", "bash", "new_session", "set_config", "unknown", "", undefined]) {
    assert.throws(() => service.enforceNaturalConversationCommandAllowed(tab, { type }), httpError(409, blockedMessage(`${type || "this action"} is blocked`)));
  }
  assert.throws(() => service.enforceNaturalConversationCommandAllowed(tab, null), httpError(409, blockedMessage("this action is blocked")));
  for (const level of ["high", "OFF", "", undefined]) {
    assert.throws(() => service.enforceNaturalConversationCommandAllowed(tab, { type: "set_thinking_level", level }), httpError(409, blockedMessage("thinking is forced off")));
  }
  for (const message of ["/bash hi", "/talking off", "/talk:abc off", "/talk:2:3 off"]) {
    assert.throws(() => service.enforceNaturalConversationCommandAllowed(tab, { type: "prompt", message }), httpError(409, blockedMessage("slash commands are blocked from the Web UI shell")));
  }
});

for (const type of ["prompt", "steer", "follow_up"]) {
  test(`${type} clears pending thinking and forces off when idle or state is unavailable`, { timeout: 1_000 }, async () => {
    for (const stateResult of [{ ok: true, data: {} }, { ok: false, error: "unavailable" }]) {
      const { service, tab, calls } = fixture({ stateResult });
      statusEvent(service, tab, "Voice: listening");
      assert.equal(await service.ensureNaturalConversationPromptSafety(tab, { type }), null);
      assert.equal(tab.pendingThinkingLevel, undefined);
      assert.deepEqual(calls, [
        ["state", tab, { type: "get_state" }, statusRpcTimeoutMs],
        ["thinking", tab, "off", { allowPending: false }],
      ]);
    }
  });
  test(`${type} skips thinking mutation while streaming or compacting`, { timeout: 1_000 }, async () => {
    for (const data of [{ isStreaming: true }, { isCompacting: true }]) {
      const { service, tab, calls } = fixture({ stateResult: { ok: true, data } });
      statusEvent(service, tab, "Voice: listening");
      assert.equal(await service.ensureNaturalConversationPromptSafety(tab, { type }), null);
      assert.equal(tab.pendingThinkingLevel, undefined);
      assert.deepEqual(calls, [["state", tab, { type: "get_state" }, statusRpcTimeoutMs]]);
    }
  });
}

test("prompt safety is inert outside mode or prompt commands and preserves failure responses", { timeout: 1_000 }, async () => {
  const inactive = fixture();
  assert.equal(await inactive.service.ensureNaturalConversationPromptSafety(inactive.tab, { type: "prompt" }), null);
  assert.equal(inactive.tab.pendingThinkingLevel, "high");
  assert.deepEqual(inactive.calls, []);
  statusEvent(inactive.service, inactive.tab, "Voice: listening");
  for (const command of [null, { type: "abort" }, { type: "abort_bash" }, { type: "set_thinking_level", level: "off" }]) {
    assert.equal(await inactive.service.ensureNaturalConversationPromptSafety(inactive.tab, command), null);
  }
  assert.equal(inactive.tab.pendingThinkingLevel, "high");
  assert.deepEqual(inactive.calls, []);
  const failure = { success: false, error: "cannot change thinking", data: { retained: true } };
  const failed = fixture({ thinkingResponse: failure });
  statusEvent(failed.service, failed.tab, "Voice: listening");
  assert.equal(await failed.service.ensureNaturalConversationPromptSafety(failed.tab, { type: "prompt" }), failure);
  for (const errorKey of ["thinkingError", "stateError"]) {
    const error = new Error(errorKey);
    const rejected = fixture({ [errorKey]: error });
    statusEvent(rejected.service, rejected.tab, "Voice: listening");
    await assert.rejects(rejected.service.ensureNaturalConversationPromptSafety(rejected.tab, { type: "prompt" }), (actual) => actual === error);
  }
});

test("mode enable prefers talk, sends bounded RPC and retains the existing optimistic snapshot", { timeout: 1_000 }, async () => {
  const { service, tab, calls, response } = fixture({ commands: [{ name: "voice:1" }, { name: "talk:2" }] });
  const data = await service.setNaturalConversationMode(tab, { enabled: true });
  assert.deepEqual(calls, [
    ["commands", tab, { annotateSkills: false }], ["package", NATURAL_CONVERSATION_FEATURE_ID],
    ["rpc", { type: "prompt", message: "/talk on" }, requestTimeoutMs],
    ["thinking", tab, "off", { allowPending: false }], ["package", NATURAL_CONVERSATION_FEATURE_ID],
  ]);
  assert.equal(data.response, response);
  assert.equal(data.available, true);
  assert.equal(data.packageInstalled, false);
  assert.equal(data.mode.enabled, true);
  assert.equal(data.mode.uiState, "listening");
  assert.equal(data.mode.statusText, "Voice: listening");
  assert.match(data.mode.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(tab.pendingThinkingLevel, undefined);
  assert.equal(tab.extensionStatuses.size, 0, "prompt acceptance creates no extension status or provider proof");
  const startedAt = data.mode.startedAt;
  assert.equal((await service.setNaturalConversationMode(tab, { enabled: true })).mode.startedAt, startedAt);
});

test("mode disable and default body use the first discovered fallback and skip thinking changes", { timeout: 1_000 }, async () => {
  for (const body of [undefined, { enabled: false }, { enabled: "true" }]) {
    const { service, tab, calls } = fixture({ installed: true, commands: [{ name: "conversation:4" }, { name: "voice:1" }] });
    tab.conversationMode = { statusText: "Voice: listening", startedAt: "existing-start" };
    const data = await service.setNaturalConversationMode(tab, body);
    assert.deepEqual(calls.filter(([kind]) => kind === "rpc"), [["rpc", { type: "prompt", message: "/conversation off" }, requestTimeoutMs]]);
    assert.equal(calls.some(([kind]) => kind === "thinking"), false);
    assert.equal(tab.pendingThinkingLevel, "high");
    assert.equal(data.mode.enabled, false);
    assert.equal(data.mode.uiState, "off");
    assert.equal(data.mode.statusText, "");
    assert.equal(data.mode.startedAt, "existing-start", "null patches retain the existing start timestamp");
    assert.equal(data.packageInstalled, true);
  }
});

test("mode mutation preserves status precedence until the parent clears the extension status", { timeout: 1_000 }, async () => {
  const { service, tab } = fixture({ commands: [{ name: "talk" }] });
  statusEvent(service, tab, "Voice: speaking");
  const data = await service.setNaturalConversationMode(tab, { enabled: false });
  assert.equal(data.mode.enabled, true);
  assert.equal(data.mode.uiState, "speaking");
  statusEvent(service, tab, "");
  assert.equal(service.isNaturalConversationActive(tab), false);
});

test("unavailable mode refuses mutation without sending a prompt", { timeout: 1_000 }, async () => {
  for (const installed of [false, true]) {
    const { service, tab, calls } = fixture({ installed });
    const feature = await service.naturalConversationFeatureData(tab);
    await assert.rejects(service.setNaturalConversationMode(tab, { enabled: true }), httpError(404, feature.unavailableReason));
    assert.equal(calls.some(([kind]) => ["rpc", "thinking"].includes(kind)), false);
  }
});

test("mode RPC failures preserve errors and do not enable mode or force thinking", { timeout: 1_000 }, async () => {
  for (const enabled of [false, true]) {
    for (const error of ["extension refused", undefined]) {
      const { service, tab, calls } = fixture({ commands: [{ name: "talk" }], response: { success: false, error } });
      await assert.rejects(service.setNaturalConversationMode(tab, { enabled }), httpError(400, error || `Failed to ${enabled ? "enable" : "disable"} Natural Conversation Mode`));
      assert.equal(service.isNaturalConversationActive(tab), false);
      assert.equal(tab.pendingThinkingLevel, "high");
      assert.equal(calls.some(([kind]) => kind === "thinking"), false);
    }
  }
  const rpcError = new Error("RPC disconnected");
  const rejected = fixture({ commands: [{ name: "talk" }], rpcError });
  await assert.rejects(rejected.service.setNaturalConversationMode(rejected.tab, { enabled: true }), (error) => error === rpcError);
  assert.equal(rejected.service.isNaturalConversationActive(rejected.tab), false);
});

test("mode enable retains existing best-effort thinking behavior", { timeout: 1_000 }, async () => {
  for (const options of [{ thinkingError: new Error("RPC failed") }, { thinkingResponse: { success: false, error: "refused" } }]) {
    const { service, tab, response } = fixture({ ...options, commands: [{ name: "talk" }] });
    const data = await service.setNaturalConversationMode(tab, { enabled: true });
    assert.equal(data.response, response);
    assert.equal(data.mode.enabled, true);
    assert.equal(tab.pendingThinkingLevel, undefined);
  }
});
