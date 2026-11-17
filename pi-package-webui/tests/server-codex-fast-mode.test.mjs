import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import * as adapter from "../lib/server/codex-fast-mode.mjs";

const packageName = "@fixture/codex-fast-mode";
const eligibleModel = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" };
const serviceFunctions = [
  "codexFastModeCommandBaseName", "codexFastModeStatusState", "codexFastModeSnapshot",
  "resetCodexFastMode", "codexFastModePackageStatus", "codexFastModeCommandState",
  "codexFastModeFeatureData", "waitForCodexFastModeStatus", "setCodexFastMode",
];

function fixture(t) {
  const calls = { packages: [], commands: [], states: [], busy: [], statuses: [], prompts: [], sleeps: [] };
  const tab = { id: "speed-tab", extensionStatuses: new Map(), lastState: {}, busy: false };
  const f = {
    tab,
    calls,
    now: 1_000,
    packageStatus: { featureId: "codexFastMode", packageName, installed: true },
    commandData: { commands: [{ name: "fast-mode:7" }], rpcRunning: true },
    state: { model: { ...eligibleModel } },
    send: async () => ({ success: true }),
    onSleep: async () => {},
  };
  t.mock.method(Date, "now", () => f.now);
  tab.rpc = {
    send: async (command, timeoutMs) => {
      calls.prompts.push({ command, timeoutMs });
      return f.send(command);
    },
  };
  f.dependencies = {
    packageName,
    optionalFeaturePackageStatus: async (featureId) => {
      calls.packages.push(featureId);
      if (f.packageError) throw f.packageError;
      return f.packageStatus;
    },
    getCommandData: async (target, options) => {
      calls.commands.push({ target, options });
      if (f.commandError) throw f.commandError;
      return f.commandData;
    },
    currentSessionState: async (target) => {
      calls.states.push(target);
      if (f.stateError) throw f.stateError;
      return f.state;
    },
    tabHasActiveOutput: (target) => {
      calls.busy.push(target);
      return target.busy;
    },
    extensionStatusMap: (target) => {
      calls.statuses.push(target);
      return target.extensionStatuses;
    },
    stripAnsi: stripVTControlCharacters,
    makeHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    sanitizeError: (error) => `sanitized: ${error.message}`,
    sleepMs: async (ms) => {
      calls.sleeps.push(ms);
      assert.ok(calls.sleeps.length <= 40, "status polling must stop after its one-second deadline");
      f.now += ms;
      await f.onSleep();
    },
    requestTimeoutMs: 12_345,
  };
  f.service = adapter.createCodexFastModeService(f.dependencies);
  return f;
}

function httpError(statusCode, message) {
  return (error) => error.statusCode === statusCode && message.test(error.message);
}

test("import and factory expose the fixed API without invoking dependencies", () => {
  assert.deepEqual(Object.keys(adapter), ["createCodexFastModeService"]);
  const unexpected = () => assert.fail("factory must not invoke dependencies");
  const service = adapter.createCodexFastModeService({
    packageName,
    optionalFeaturePackageStatus: unexpected,
    getCommandData: unexpected,
    currentSessionState: unexpected,
    tabHasActiveOutput: unexpected,
    extensionStatusMap: unexpected,
    stripAnsi: unexpected,
    makeHttpError: unexpected,
    sanitizeError: unexpected,
    sleepMs: unexpected,
    requestTimeoutMs: 12_345,
  });
  assert.deepEqual(Object.keys(service).sort(), [...serviceFunctions].sort());
  for (const fn of Object.values(service)) assert.equal(typeof fn, "function");
});

test("command suffixes and ANSI status normalize while non-status text stays unknown", (t) => {
  const { service } = fixture(t);
  for (const [input, expected] of [
    [" FAST-MODE:12 ", "fast-mode"], ["fast-mode", "fast-mode"],
    [undefined, ""], ["fast-mode:abc", "fast-mode:abc"],
    ["fast-mode:2:3", "fast-mode:2"], ["/fast-mode", "/fast-mode"],
  ]) assert.equal(service.codexFastModeCommandBaseName(input), expected);
  for (const [input, mode] of [
    [" OFF ", "normal"], ["\u001b[32mOn\u001b[0m", "fast"], [" UltraFast ", "ultrafast"],
    ["", null], ["enabled", null], ["Fast mode: on", null], ["on (busy)", null],
  ]) {
    assert.deepEqual(service.codexFastModeStatusState(input), {
      known: mode !== null, enabled: mode !== null && mode !== "normal", mode,
    });
  }
});

test("snapshots preserve remembered state, exact status and patch precedence on the tab", (t) => {
  const { service, tab } = fixture(t);
  const unknown = service.codexFastModeSnapshot(tab, { updatedAt: "fixed" });
  assert.deepEqual(unknown, {
    featureId: "codexFastMode", mode: null, enabled: false, statusKnown: false, updatedAt: "fixed",
  });
  assert.equal(tab.codexFastMode, undefined, "snapshot reads must not store a separate record");
  tab.codexFastMode = { ...unknown, mode: "fast", enabled: true, statusKnown: true };
  tab.extensionStatuses.set("codex-fast-mode", "not a status");
  assert.equal(service.codexFastModeSnapshot(tab).mode, "fast");
  assert.equal(service.codexFastModeSnapshot(tab).statusKnown, true);
  tab.extensionStatuses.set("codex-fast-mode", "off");
  assert.equal(service.codexFastModeSnapshot(tab).mode, "normal");
  assert.deepEqual(service.codexFastModeSnapshot(tab, { mode: "ultrafast", statusKnown: false, updatedAt: "patch" }), {
    featureId: "codexFastMode", mode: "ultrafast", enabled: true, statusKnown: false, updatedAt: "patch",
  });
  tab.codexFastModeCommandName = "fast-mode:7";
  service.resetCodexFastMode(tab);
  service.resetCodexFastMode(null);
  assert.equal(tab.codexFastMode, null);
  assert.equal(tab.codexFastModeCommandName, "");
  assert.equal(tab.extensionStatuses.get("codex-fast-mode"), "off", "status lifecycle remains caller-owned");
});

test("package probes preserve results and sanitize failures using the injected catalog name", async (t) => {
  const f = fixture(t);
  assert.equal(await f.service.codexFastModePackageStatus(), f.packageStatus);
  f.packageError = new Error("package probe failed");
  assert.deepEqual(await f.service.codexFastModePackageStatus(), {
    featureId: "codexFastMode", packageName, installed: false, error: "sanitized: package probe failed",
  });
  assert.deepEqual(f.calls.packages, ["codexFastMode", "codexFastMode"]);
});

test("command discovery caches the original suffixed name and exposes RPC failures", async (t) => {
  const f = fixture(t);
  f.commandData = {
    commands: [{ name: "fast-mode-extra" }, { name: " FAST-MODE:12 " }, { name: "fast-mode" }],
    rpcRunning: false, error: "RPC stopped",
  };
  assert.deepEqual(await f.service.codexFastModeCommandState(f.tab), {
    commandName: " FAST-MODE:12 ", rpcRunning: false, error: "RPC stopped",
  });
  assert.deepEqual(f.calls.commands, [{ target: f.tab, options: { annotateSkills: false } }]);
  assert.deepEqual(await f.service.codexFastModeCommandState(f.tab, { refreshCommands: false }), {
    commandName: " FAST-MODE:12 ", rpcRunning: true, error: "",
  });
  assert.equal(f.calls.commands.length, 1);
  f.commandError = new Error("command lookup failed");
  assert.deepEqual(await f.service.codexFastModeCommandState(f.tab), {
    commandName: "", rpcRunning: false, error: "sanitized: command lookup failed",
  });
  assert.equal(f.tab.codexFastModeCommandName, "");
  delete f.commandError;
  f.commandData = {};
  assert.deepEqual(await f.service.codexFastModeCommandState(f.tab), {
    commandName: "", rpcRunning: true, error: "",
  });
});

test("feature payload distinguishes loaded command availability from package installation", async (t) => {
  const f = fixture(t);
  f.packageStatus.installed = false;
  f.tab.extensionStatuses.set("codex-fast-mode", "ultrafast");
  const data = await f.service.codexFastModeFeatureData(f.tab);
  const { updatedAt } = f.tab.codexFastMode;
  assert.ok(Number.isFinite(Date.parse(updatedAt)));
  assert.deepEqual(data, {
    featureId: "codexFastMode", packageName, available: true, packageInstalled: false,
    packageStatus: f.packageStatus, commandName: "fast-mode:7", enabled: true, mode: "ultrafast",
    statusKnown: true, busy: false, model: eligibleModel, modelEligible: true,
    ultrafastModelEligible: true,
    creditNotice: "Fast mode increases Codex usage; current rates depend on the model and billing plan. Ultrafast requires GPT-6 Astra and Pro $500 or eligible Enterprise/Edu access, using 8x Standard included usage or 6x purchased-credit/pay-as-you-go usage. Workspace terms may differ. Only subscription-backed openai-codex requests are changed; upstream eligibility stays authoritative.",
    rpcRunning: true, unavailableReason: "", error: undefined,
  });
  assert.deepEqual(f.tab.codexFastMode, {
    featureId: "codexFastMode", mode: "ultrafast", enabled: true, statusKnown: true, updatedAt,
  });
  f.commandData.commands = [];
  let unavailable = await f.service.codexFastModeFeatureData(f.tab);
  assert.equal(unavailable.available, false);
  assert.match(unavailable.unavailableReason, /not installed or not visible/);
  f.packageStatus.installed = true;
  unavailable = await f.service.codexFastModeFeatureData(f.tab);
  assert.equal(unavailable.packageInstalled, true);
  assert.equal(unavailable.available, false);
  assert.match(unavailable.unavailableReason, /installed, but \/fast-mode is not loaded/);
});

test("feature reads expose busy state, fall back to lastState and preserve exact model eligibility", async (t) => {
  const f = fixture(t);
  f.stateError = new Error("state unavailable");
  f.tab.busy = true;
  f.tab.lastState.model = { ...eligibleModel };
  assert.equal((await f.service.codexFastModeFeatureData(f.tab)).ultrafastModelEligible, true);
  assert.equal((await f.service.codexFastModeFeatureData(f.tab)).busy, true);
  delete f.stateError;
  for (const [model, modelEligible, ultrafastModelEligible] of [
    [{ ...eligibleModel, provider: "openai" }, false, false],
    [{ ...eligibleModel, api: "openai-responses" }, true, false],
    [{ ...eligibleModel, id: "gpt-6-sol" }, true, false],
    [{ ...eligibleModel, id: "GPT-6-ASTRA" }, true, false],
    [{ ...eligibleModel, api: undefined }, true, false],
    [{ provider: "openai-codex" }, false, false],
    [null, false, false],
  ]) {
    f.state = { model };
    const data = await f.service.codexFastModeFeatureData(f.tab);
    assert.equal(data.modelEligible, modelEligible);
    assert.equal(data.ultrafastModelEligible, ultrafastModelEligible);
    assert.deepEqual(data.model, model?.provider && model?.id ? { ...model, api: model.api || "" } : null);
  }
});

test("a successful prompt waits for delayed exact status instead of acknowledging the request", async (t) => {
  const f = fixture(t);
  f.tab.extensionStatuses.set("codex-fast-mode", "off");
  let settled = false;
  f.onSleep = async () => {
    assert.equal(settled, false);
    assert.equal(f.tab.codexFastMode.mode, "normal", "RPC acknowledgment must not update mode");
    if (f.calls.sleeps.length === 1) f.tab.extensionStatuses.set("codex-fast-mode", "on (busy)");
    if (f.calls.sleeps.length === 2) f.tab.extensionStatuses.set("codex-fast-mode", "\u001b[32mON\u001b[0m");
  };
  const data = await f.service.setCodexFastMode(f.tab, { mode: "fast" }).then((value) => {
    settled = true;
    return value;
  });
  assert.equal(data.mode, "fast");
  assert.equal(data.enabled, true);
  assert.equal(data.statusKnown, true);
  assert.equal(data.requested, "fast");
  assert.deepEqual(f.calls.sleeps, [25, 25]);
  assert.deepEqual(f.calls.prompts, [{ command: { type: "prompt", message: "/fast-mode:7 on" }, timeoutMs: 12_345 }]);
  assert.equal(f.calls.commands.length, 1, "response reuses the tab's loaded command");
});

test("status timeout rejects RPC success and retains the last confirmed preference", async (t) => {
  for (const [mode, originalStatus, label] of [["normal", "on", "off"], ["fast", "off", "on"], ["ultrafast", "on", "ultrafast"]]) {
    const f = fixture(t);
    f.tab.extensionStatuses.set("codex-fast-mode", originalStatus);
    await assert.rejects(f.service.setCodexFastMode(f.tab, { mode }), httpError(409, new RegExp(`did not confirm ${label}\\.`)));
    assert.equal(f.now, 2_000);
    assert.equal(f.calls.sleeps.length, 40);
    assert.equal(f.calls.prompts.length, 1);
    assert.equal(f.tab.codexFastMode.mode, originalStatus === "on" ? "fast" : "normal");
  }
});

test("busy, unavailable and Ultrafast model guards reject before sending prompts", async (t) => {
  const f = fixture(t);
  f.tab.busy = true;
  await assert.rejects(f.service.setCodexFastMode(f.tab, { mode: "normal" }), httpError(409, /This tab is busy/));
  f.tab.busy = false;
  f.commandData.commands = [];
  await assert.rejects(f.service.setCodexFastMode(f.tab, { mode: "fast" }), httpError(404, /installed, but/));
  f.packageStatus.installed = false;
  await assert.rejects(f.service.setCodexFastMode(f.tab, { mode: "fast" }), httpError(404, /not installed/));
  f.commandData.commands = [{ name: "fast-mode" }];
  for (const model of [
    { ...eligibleModel, provider: "openai" }, { ...eligibleModel, api: "openai-responses" },
    { ...eligibleModel, id: "gpt-6-sol" }, null,
  ]) {
    f.state = { model };
    await assert.rejects(f.service.setCodexFastMode(f.tab, { mode: "ultrafast" }), httpError(400, /Select GPT-6 Astra/));
  }
  assert.deepEqual(f.calls.prompts, []);
  assert.deepEqual(f.calls.sleeps, []);
});

test("invalid or conflicting intent rejects before probing package, commands or state", async (t) => {
  const f = fixture(t);
  for (const body of [undefined, {}, null, { enabled: "true" }, { mode: "turbo" }, { mode: "fast", enabled: false }, { mode: "normal", enabled: true }]) {
    await assert.rejects(f.service.setCodexFastMode(f.tab, body), httpError(400, /Codex speed/));
  }
  for (const calls of Object.values(f.calls)) assert.deepEqual(calls, []);
});

test("prompt failure preserves HTTP errors and thrown transport errors without polling", async (t) => {
  const f = fixture(t);
  f.send = async () => ({ success: false, error: "extension refused" });
  await assert.rejects(f.service.setCodexFastMode(f.tab, { mode: "fast" }), httpError(400, /^extension refused$/));
  f.send = async () => ({ success: false });
  await assert.rejects(f.service.setCodexFastMode(f.tab, { mode: "normal" }), httpError(400, /^Failed to select Codex speed normal$/));
  const transportError = new Error("RPC deadline exceeded");
  f.send = async () => { throw transportError; };
  await assert.rejects(f.service.setCodexFastMode(f.tab, { mode: "fast" }), (error) => error === transportError);
  assert.deepEqual(f.calls.sleeps, []);
  assert.equal(f.tab.codexFastMode.mode, null);
  assert.equal(f.tab.codexFastMode.statusKnown, false);
});

test("legacy enabled writes retain boolean requested responses and explicit modes stay strings", async (t) => {
  const f = fixture(t);
  f.send = async (command) => {
    f.tab.extensionStatuses.set("codex-fast-mode", command.message.split(" ").at(-1));
    return { success: true };
  };
  // Normal/Fast preserve the extension's provider policy; only Ultrafast has a WebUI write guard.
  f.state.model = { provider: "other", id: "other-model", api: "other-api" };
  for (const [body, mode, argument, requested] of [
    [{ enabled: true }, "fast", "on", true], [{ enabled: false }, "normal", "off", false],
    [{ mode: "fast", enabled: true }, "fast", "on", "fast"],
  ]) {
    const data = await f.service.setCodexFastMode(f.tab, body);
    assert.equal(data.mode, mode);
    assert.equal(data.enabled, mode !== "normal");
    assert.equal(data.statusKnown, true);
    assert.equal(data.requested, requested);
    assert.equal(f.calls.prompts.at(-1).command.message, `/fast-mode:7 ${argument}`);
  }
  f.state.model = { ...eligibleModel };
  assert.equal((await f.service.setCodexFastMode(f.tab, { mode: "ultrafast" })).requested, "ultrafast");
  assert.equal(f.calls.prompts.at(-1).command.message, "/fast-mode:7 ultrafast");
  assert.deepEqual(f.calls.sleeps, []);
});

test("multiple adapters share only the supplied tab records and keep other tabs isolated", async (t) => {
  const f = fixture(t);
  const second = adapter.createCodexFastModeService(f.dependencies);
  const other = { id: "other", extensionStatuses: new Map([["codex-fast-mode", "off"]]), busy: false };
  f.tab.extensionStatuses.set("codex-fast-mode", "on");
  await f.service.codexFastModeFeatureData(f.tab);
  assert.equal(second.codexFastModeSnapshot(f.tab).mode, "fast");
  assert.equal(second.codexFastModeSnapshot(other).mode, "normal");
  assert.equal(other.codexFastMode, undefined);
  assert.equal(other.codexFastModeCommandName, undefined);
  assert.equal((await second.codexFastModeCommandState(f.tab, { refreshCommands: false })).commandName, "fast-mode:7");
  second.resetCodexFastMode(f.tab);
  assert.equal((await f.service.codexFastModeCommandState(f.tab, { refreshCommands: false })).commandName, "");
  assert.equal(second.codexFastModeSnapshot(other).mode, "normal");
});
