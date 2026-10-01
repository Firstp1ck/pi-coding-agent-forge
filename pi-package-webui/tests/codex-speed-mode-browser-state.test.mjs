import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as modes from "../public/codex-speed-mode.mjs";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("// Codex subscription Fast mode is owned");
const end = source.indexOf("function scheduleRefreshCodexUsage", start);
assert.ok(start >= 0 && end > start, "execute the actual browser speed-control implementation");
const controlSource = source.slice(start, end);

function harness({ confirm = true, eligible = true, enabledFeature = true } = {}) {
  const calls = [];
  const confirmations = [];
  const events = [];
  const ultrafastOption = { disabled: true };
  const select = { value: "normal", disabled: true, querySelector: () => ultrafastOption };
  let currentTab = "tab-one";
  const data = (mode) => ({
    available: true, statusKnown: true, enabled: mode !== "normal", mode, busy: false,
    model: { provider: "openai-codex", id: eligible ? "gpt-6-astra" : "gpt-6-sol" },
    modelEligible: true, ultrafastModelEligible: eligible, creditNotice: "Higher usage applies.",
  });
  const tabModes = new Map([["tab-one", "normal"], ["tab-two", "normal"]]);
  const context = vm.createContext({
    ...modes,
    elements: { codexFastModeSelect: select, setCodexFastModeButton: {}, codexFastModeStatus: { classList: { toggle() {} } } },
    isOptionalFeatureEnabled: () => enabledFeature,
    optionalFeatureUnavailableMessage: () => "Disabled",
    optionalFeatureAvailability: {},
    activeTabContext: () => ({ tabId: currentTab }),
    isCurrentTabContext: (tab) => tab.tabId === currentTab,
    tabs: [{ id: "tab-one", running: true }, { id: "tab-two", running: true }],
    activeTabId: "tab-one",
    currentState: { model: { provider: "openai-codex", id: "gpt-6-sol" } },
    normalizeSelectedModel: (model) => model,
    modelStateKey: (model) => `${model?.provider}/${model?.id}`,
    renderStatus() {},
    requestGitFooterWebuiPayload() {},
    queueMicrotask,
    async appConfirm(options) {
      confirmations.push(options);
      return typeof confirm === "function" ? confirm(() => { currentTab = "tab-two"; }) : confirm;
    },
    async api(path, options) {
      calls.push({ path, options });
      if (options.method === "PUT") tabModes.set(options.tabId, modes.codexSpeedModeFromIntent(options.body));
      return { data: data(tabModes.get(options.tabId)) };
    },
    addEvent(message, level) { events.push({ message, level }); },
  });
  vm.runInContext(controlSource, context);
  const modelStart = source.indexOf("function applyOptimisticModelSelection(");
  const modelEnd = source.indexOf("function applyOptimisticThinkingSelection(", modelStart);
  assert.ok(modelStart >= 0 && modelEnd > modelStart);
  vm.runInContext(source.slice(modelStart, modelEnd), context);
  context.applyCodexFastModeData(data("normal"));
  vm.runInContext("codexFastModeLoaded = true", context);
  context.renderCodexFastModeControl();
  return { context, calls, confirmations, events, select, tabModes, ultrafastOption, data, setEligible(value) { eligible = value; } };
}

{
  const h = harness();
  assert.equal(h.context.applyCodexFastModeStatus("ultrafast"), true);
  assert.equal(h.select.value, "ultrafast");
  assert.equal(h.context.codexFastModeStatusText(), "Ultrafast · This tab");
  assert.equal(h.context.applyCodexFastModeStatus("ultrafast now"), false);
  assert.equal(h.select.value, "ultrafast");
  assert.equal(h.context.codexFastModeConfirmedOff({ statusKnown: true, mode: "ultrafast", enabled: false }), false);
  assert.equal(h.context.codexFastModeConfirmedOff({ statusKnown: true, enabled: false }), true);
}
{
  const h = harness({ confirm: false });
  h.select.value = "ultrafast";
  await h.context.applyCodexFastMode();
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0].summary, /8x.*6x/);
  assert.equal(h.calls.length, 0, "cancelled cost confirmation must not mutate the extension");
  assert.equal(h.select.value, "normal");
}
{
  const h = harness();
  h.select.value = "ultrafast";
  await h.context.applyCodexFastMode();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.body.mode, "ultrafast");
  assert.equal(h.select.value, "ultrafast");
  h.select.value = "fast";
  await h.context.applyCodexFastMode();
  assert.equal(h.confirmations.length, 1, "ordinary Fast selection does not require the Ultrafast prompt");
  assert.equal(h.calls[1].options.body.mode, "fast");
  assert.equal(h.select.value, "fast");
}
{
  const h = harness({ confirm: (switchTab) => { switchTab(); return true; } });
  h.select.value = "ultrafast";
  await h.context.applyCodexFastMode();
  assert.equal(h.calls.length, 0, "changing tabs during cost confirmation must cancel the mutation");
}
{
  const h = harness({ eligible: false });
  assert.equal(h.ultrafastOption.disabled, true);
  h.select.value = "ultrafast";
  await h.context.applyCodexFastMode();
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirmations.length, 0);
  h.context.applyCodexFastModeData(h.data("ultrafast"));
  assert.equal(h.context.codexFastModeStatusText(), "Ultrafast · Inactive for current model");
  h.select.value = "normal";
  await h.context.applyCodexFastMode();
  assert.equal(h.calls[0].options.body.mode, "normal", "inactive Ultrafast must remain disarmable");
}
{
  const h = harness();
  h.tabModes.set("tab-one", "ultrafast");
  h.tabModes.set("tab-two", "fast");
  await h.context.disableCodexFastModeIntegration();
  const mutations = h.calls.filter((call) => call.options.method === "PUT");
  assert.equal(mutations.length, 2);
  assert.ok(mutations.every((call) => call.options.body.enabled === false));
  assert.equal(h.tabModes.get("tab-one"), "normal");
  assert.equal(h.tabModes.get("tab-two"), "normal");
}
for (const options of [{ enabledFeature: false }, {}]) {
  const h = harness(options);
  if (options.enabledFeature !== false) h.context.applyCodexFastModeData({ ...h.data("normal"), busy: true });
  h.select.value = "ultrafast";
  await h.context.applyCodexFastMode();
  assert.equal(h.calls.length, 0, "hidden or busy controls must not request a mode change");
}
{
  const h = harness({ eligible: false });
  assert.equal(h.ultrafastOption.disabled, true);
  h.setEligible(true);
  const refresh = h.context.refreshCodexFastMode;
  let refreshed;
  h.context.refreshCodexFastMode = (...args) => {
    refreshed = refresh(...args);
    return refreshed;
  };
  h.context.applyOptimisticModelSelection({ provider: "openai-codex", id: "gpt-6-astra" });
  assert.ok(refreshed, "model selection must schedule the speed-eligibility refresh");
  await refreshed;
  assert.equal(h.ultrafastOption.disabled, false, "selecting Astra should refresh Ultrafast eligibility without reloading the tab");
  assert.equal(h.calls.at(-1).path, "/api/codex-fast-mode");
}
console.log("codex-speed-mode-browser-state.test.mjs passed");
