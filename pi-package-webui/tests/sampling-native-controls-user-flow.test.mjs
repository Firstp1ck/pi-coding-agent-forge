import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAMPLING_PARAMETER_CATALOG,
  buildSamplingParametersFromDraft,
  createSamplingControlDraft,
  samplingControlDraftEquals,
  samplingParameterCapability,
  samplingParameterSliderValue,
  splitSamplingParameters,
  summarizePreservedSamplingParameters,
  validateSamplingControlDraft,
} from "../public/sampling-parameter-controls.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appJs = await readFile(join(root, "public", "app.js"), "utf8");

// Extract the sampling parameter control block from app.js
const blockStart = appJs.indexOf("function samplingParametersPath(");
const blockEnd = appJs.indexOf("\nfunction sessionCopyButton(", blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart, "sampling browser state block must be present in app.js");
const samplingBlock = appJs.slice(blockStart, blockEnd);

// MockElement class for full DOM event and hierarchy simulation
class MockElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = {
      _set: new Set(),
      add: (...names) => names.forEach((n) => this.classList._set.add(n)),
      remove: (...names) => names.forEach((n) => this.classList._set.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) force = !this.classList._set.has(name);
        if (force) this.classList._set.add(name);
        else this.classList._set.delete(name);
        return force;
      },
      contains: (name) => this.classList._set.has(name),
    };
    this.dataset = {};
    this._value = "";
    this._checked = false;
    this._disabled = false;
    this._hidden = false;
    this._hovered = false;
    this._textContent = "";
    this.id = "";
    this.type = "";
    this.htmlFor = "";
    this.tabIndex = -1;
  }

  get value() { return this._value; }
  set value(v) { this._value = String(v ?? ""); }

  get checked() { return Boolean(this._checked); }
  set checked(v) { this._checked = Boolean(v); }

  get disabled() { return Boolean(this._disabled); }
  set disabled(v) { this._disabled = Boolean(v); }

  get hidden() { return Boolean(this._hidden); }
  set hidden(v) { this._hidden = Boolean(v); }

  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v ?? ""); }

  get className() { return Array.from(this.classList._set).join(" "); }
  set className(v) {
    this.classList._set.clear();
    if (v) String(v).split(/\s+/).forEach((n) => this.classList._set.add(n));
  }

  append(...nodes) {
    for (const child of nodes) {
      if (child) this.children.push(child);
    }
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  contains(node) {
    return node === this || this.children.some((child) => child?.contains?.(node));
  }

  matches(selector) {
    return selector === ":hover" ? this._hovered : false;
  }

  dispatchEvent(eventOrType) {
    const event = typeof eventOrType === "string" ? { type: eventOrType } : eventOrType;
    if (event.type === "pointerenter") this._hovered = true;
    if (event.type === "pointerleave") this._hovered = false;
    event.target ||= this;
    event.currentTarget = this;
    event.defaultPrevented ||= false;
    event.propagationStopped ||= false;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.stopPropagation ||= () => { event.propagationStopped = true; };
    const list = this.listeners.get(event.type) || [];
    for (const listener of list) listener(event);
    return !event.defaultPrevented;
  }
}

function createHarness() {
  const elements = {
    samplingParametersControls: new MockElement("div"),
    samplingParametersPreserved: new MockElement("p"),
    applySamplingParametersButton: new MockElement("button"),
    resetSamplingParametersButton: new MockElement("button"),
    reloadSamplingParametersButton: new MockElement("button"),
    samplingParametersSupport: new MockElement("p"),
    samplingParametersStatus: new MockElement("p"),
  };

  const requests = [];
  let sectionActive = true;
  let nextResponse = null;
  let nextError = null;
  let responseGate = null;

  const mockDocument = {
    createElement(tagName) {
      return new MockElement(tagName);
    },
  };

  const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
  const hostValue = (value, fallback = undefined) => (value === undefined ? fallback : JSON.parse(JSON.stringify(value)));

  const context = {
    console, AbortSignal,
    document: mockDocument,
    elements,
    SAMPLING_PARAMETER_CATALOG,
    buildSamplingParametersFromDraft: (draft) => buildSamplingParametersFromDraft(hostValue(draft, null)),
    createSamplingControlDraft: (parameters, options) => createSamplingControlDraft(hostValue(parameters, {}), hostValue(options, {})),
    samplingControlDraftEquals: (left, right) => samplingControlDraftEquals(hostValue(left, null), hostValue(right, null)),
    samplingParameterCapability: (parameters, key) => samplingParameterCapability(hostValue(parameters, undefined), key),
    samplingParameterSliderValue,
    splitSamplingParameters: (parameters) => splitSamplingParameters(hostValue(parameters, {})),
    summarizePreservedSamplingParameters: (parameters) => summarizePreservedSamplingParameters(hostValue(parameters, {})),
    validateSamplingControlDraft: (draft) => validateSamplingControlDraft(hostValue(draft, null)),
    sidePanelSectionRecords: () => [{
      id: "sampling",
      section: { hidden: !sectionActive, classList: { contains: () => !sectionActive } },
    }],
    api: async (path, options = {}) => {
      requests.push({ path, method: options.method || "GET", body: plain(options.body), scoped: options.scoped });
      if (responseGate) await responseGate;
      if (nextError) throw nextError;
      return { data: plain(nextResponse) };
    },
  };

  vm.runInNewContext(`
    let samplingParametersState = null;
    let samplingParametersStateTabId = null;
    const samplingParametersDrafts = new Map();
    let samplingParametersLoading = false;
    let samplingParametersBusy = false;
    let samplingParametersError = "";
    let samplingParametersNotice = "";
    let samplingParametersFeedbackTabId = null;
    let samplingParametersRequestSerial = 0;
    let activeTabId = "tab-a";
    function activeTabContext(tabId = activeTabId) { return { tabId: tabId || null, generation: 0 }; }
    function isCurrentTabContext(context) { return context.tabId === activeTabId && context.generation === 0; }
    const focusedShell = null;
    const sessionContext = {
      captureLifetime: tabId => ({ tabId, generation: 0 }),
      isLifetimeCurrent: target => target.generation === 0,
    };
    ${samplingBlock}
    globalThis.samplingHarness = {
      setActiveTab(value) { activeTabId = value; },
      setDraft(value, tabId = activeTabId) { setSamplingParametersDraft(value, tabId); },
      draft(tabId = activeTabId) { return samplingParametersDraft(tabId); },
      editable(tabId = activeTabId) { return samplingParametersEditableDraft(tabId); },
      dirty: samplingParametersDraftIsDirty,
      state() { return samplingParametersState; },
      stateTabId() { return samplingParametersStateTabId; },
      render: renderSamplingParameters,
      load: loadSamplingParameters,
      refresh: refreshSamplingParametersForTabContext,
      apply: applySamplingParameters,
      reset: resetSamplingParameters,
      ensureLoaded: ensureSamplingParametersLoaded,
      getControlsMap() { return samplingParameterControlElements; },
    };
  `, context);

  const harness = context.samplingHarness;

  return {
    harness,
    elements,
    requests,
    getControl(key) {
      return harness.getControlsMap().get(key);
    },
    setNextResponse(res) { nextResponse = res; },
    setNextError(err) { nextError = err; },
    setResponseGate(gate) { responseGate = gate; },
    setSectionActive(active) { sectionActive = active; },
  };
}

function capabilitiesFor(supportedKeys, api = "fixture-api") {
  const supported = new Set(supportedKeys);
  return Object.fromEntries(SAMPLING_PARAMETER_CATALOG.map(({ key, label }) => [key, {
    supported: supported.has(key),
    reason: supported.has(key) ? `Supported by ${api}.` : `${api} does not declare ${label} support.`,
    source: supported.has(key) ? "api" : "unsupported",
  }]));
}

const supportedState = (session = {}, defaults = { temperature: 1, top_p: 0.95 }) => ({
  session,
  defaults,
  effective: { ...defaults, ...session },
  support: {
    supported: true,
    api: "openai-completions",
    model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
    parameters: capabilitiesFor(SAMPLING_PARAMETER_CATALOG.map(({ key }) => key), "openai-completions"),
    compatibleApis: ["openai-completions", "openai-responses", "azure-openai-responses"],
    message: "Session sampling parameters apply to subsequent provider requests.",
  },
});

// --- Test 1: Enable / Disable Semantics ---
{
  const { harness, elements, requests, getControl, setNextResponse } = createHarness();
  setNextResponse(supportedState({}, { temperature: 1 }));
  await harness.load({ tabId: "tab-a" });

  const tempControl = getControl("temperature");
  assert.equal(tempControl.enable.checked, false, "initially temperature is disabled");
  assert.equal(tempControl.tooltip.hidden, true, "supported controls should hide unused tooltip nodes");
  assert.equal(tempControl.tooltip.textContent, "", "supported controls should clear unused tooltip text");
  assert.equal(tempControl.row.getAttribute("aria-describedby"), null, "supported controls should not reference an unsupported reason");

  // User checks enable checkbox for temperature
  tempControl.enable.checked = true;
  tempControl.enable.dispatchEvent("change");

  // User types 0.7 into exact value number input
  tempControl.number.value = "0.7";
  tempControl.number.dispatchEvent("input");

  assert.equal(harness.dirty("tab-a"), true, "draft should be marked dirty after user interaction");

  requests.length = 0;
  setNextResponse(supportedState({ temperature: 0.7 }));
  await harness.apply();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PUT");
  assert.deepEqual(requests[0].body, { temperature: 0.7 }, "Apply should include enabled temperature in payload");

  // User unchecks enable checkbox for temperature
  tempControl.enable.checked = false;
  tempControl.enable.dispatchEvent("change");

  requests.length = 0;
  setNextResponse(supportedState({}));
  await harness.apply();

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, {}, "Disabling temperature should exclude key from payload");
  console.log("✓ Test 1: Enable / Disable Semantics passed");
}

// --- Test 2: Number / Range Synchronization ---
{
  const { harness, getControl, setNextResponse } = createHarness();
  setNextResponse(supportedState({ temperature: 1 }));
  await harness.load({ tabId: "tab-a" });

  const tempControl = getControl("temperature");
  
  // Entering value into number input updates draft and syncs range slider
  tempControl.number.value = "0.45";
  tempControl.number.dispatchEvent("input");

  assert.equal(tempControl.range.value, "0.45", "range input visual value should mirror number input");
  assert.equal(harness.editable("tab-a").controls.temperature.value, "0.45");

  // Sliding range input updates draft and number input
  tempControl.range.value = "1.2";
  tempControl.range.dispatchEvent("input");

  assert.equal(tempControl.number.value, "1.2", "number input value should mirror range slider movement");
  assert.equal(harness.editable("tab-a").controls.temperature.value, "1.2");
  console.log("✓ Test 2: Number / Range Synchronization passed");
}

// --- Test 3: Exact Values Outside Soft Slider Bounds ---
{
  const { harness, requests, getControl, setNextResponse } = createHarness();
  setNextResponse(supportedState({}));
  await harness.load({ tabId: "tab-a" });

  const topKControl = getControl("top_k");
  topKControl.enable.checked = true;
  topKControl.enable.dispatchEvent("change");

  // Setting top_k = 1000 via exact number input (soft slider max is 200)
  topKControl.number.value = "1000";
  topKControl.number.dispatchEvent("input");

  assert.equal(topKControl.number.value, "1000");
  assert.equal(topKControl.range.value, "200", "slider position should clamp visually to common max 200");

  requests.length = 0;
  setNextResponse(supportedState({ top_k: 1000 }));
  await harness.apply();

  assert.equal(requests[0].body.top_k, 1000, "authoritative exact number 1000 must be sent in PUT body");

  // Setting seed = -1 (soft slider min is 0)
  const seedControl = getControl("seed");
  seedControl.enable.checked = true;
  seedControl.enable.dispatchEvent("change");
  seedControl.number.value = "-1";
  seedControl.number.dispatchEvent("input");

  assert.equal(seedControl.number.value, "-1");
  assert.equal(seedControl.range.value, "0", "slider position for seed -1 should clamp visually to 0");

  requests.length = 0;
  setNextResponse(supportedState({ top_k: 1000, seed: -1 }));
  await harness.apply();

  assert.equal(requests[0].body.seed, -1, "exact seed value -1 must be sent in PUT body");
  console.log("✓ Test 3: Exact Values Outside Soft Slider Bounds passed");
}

// --- Test 4: Invalid Value Blocking and Accessible Error State ---
{
  const { harness, elements, requests, getControl, setNextResponse } = createHarness();
  setNextResponse(supportedState({}));
  await harness.load({ tabId: "tab-a" });

  const topPControl = getControl("top_p");
  topPControl.enable.checked = true;
  topPControl.enable.dispatchEvent("change");

  // Enter invalid top_p = 0 (top_p must be > 0 and <= 1)
  topPControl.number.value = "0";
  topPControl.number.dispatchEvent("input");

  assert.equal(topPControl.number.getAttribute("aria-invalid"), "true", "invalid field must set aria-invalid=true");
  assert.ok(topPControl.row.classList.contains("invalid"), "invalid row must have .invalid class");
  assert.match(topPControl.error.textContent, /greater than 0/, "field error paragraph must explain the restriction");
  assert.equal(topPControl.error.hidden, false, "field error element must be visible");
  assert.equal(elements.applySamplingParametersButton.disabled, true, "Apply button must be disabled for invalid draft");

  requests.length = 0;
  await harness.apply();
  assert.equal(requests.length, 0, "applySamplingParameters must not make HTTP request when draft is invalid");

  // Fix the invalid value
  topPControl.number.value = "0.95";
  topPControl.number.dispatchEvent("input");

  assert.equal(topPControl.number.getAttribute("aria-invalid"), "false");
  assert.equal(topPControl.row.classList.contains("invalid"), false);
  assert.equal(elements.applySamplingParametersButton.disabled, false, "Apply button should be enabled once valid");
  console.log("✓ Test 4: Invalid Value Blocking and Accessible Error State passed");
}

// --- Test 5: Unknown-Key Preservation ---
{
  const { harness, elements, requests, getControl, setNextResponse } = createHarness();
  // Server state has unknown keys: custom_vendor_key and llama_mirostat
  setNextResponse(supportedState(
    { temperature: 0.5, custom_vendor_key: "special_value", llama_mirostat: 2 },
    { temperature: 1 },
  ));
  await harness.load({ tabId: "tab-a" });

  assert.match(
    elements.samplingParametersPreserved.textContent,
    /2 additional parameters are preserved outside this editor/,
    "preservation element should report correct unknown key count",
  );
  assert.doesNotMatch(elements.samplingParametersPreserved.textContent, /custom_vendor_key/);

  // User edits a known parameter (enables min_p = 0.05)
  const minPControl = getControl("min_p");
  minPControl.enable.checked = true;
  minPControl.enable.dispatchEvent("change");
  minPControl.number.value = "0.05";
  minPControl.number.dispatchEvent("input");

  requests.length = 0;
  setNextResponse(supportedState({ temperature: 0.5, custom_vendor_key: "special_value", llama_mirostat: 2, min_p: 0.05 }));
  await harness.apply();

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, {
    custom_vendor_key: "special_value",
    llama_mirostat: 2,
    temperature: 0.5,
    min_p: 0.05,
  }, "PUT body must preserve unknown keys alongside updated known parameter controls");
  console.log("✓ Test 5: Unknown-Key Preservation passed");
}

// --- Test 6: Reset Semantics ---
{
  const { harness, elements, requests, setNextResponse } = createHarness();
  setNextResponse(supportedState({ temperature: 0.8, vendor_key: "preserved" }));
  await harness.load({ tabId: "tab-a" });

  requests.length = 0;
  setNextResponse(supportedState({}, { temperature: 1 }));
  await harness.reset();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PUT");
  assert.deepEqual(requests[0].body, {}, "Reset must send empty object {} to clear both known and unknown session overrides");
  assert.match(elements.samplingParametersStatus.textContent, /Session override cleared/);
  assert.match(elements.samplingParametersPreserved.textContent, /No additional parameters/);
  console.log("✓ Test 6: Reset Semantics passed");
}

// --- Test 7: Tab-Isolated Drafts Including Delayed Responses ---
{
  const { harness, requests, getControl, setNextResponse, setResponseGate } = createHarness();
  setNextResponse(supportedState({ temperature: 0.5 }));
  await harness.load({ tabId: "tab-a" });

  // User edits temperature on tab-a
  const tempControl = getControl("temperature");
  tempControl.number.value = "0.2";
  tempControl.number.dispatchEvent("input");

  // Switch to tab-b
  harness.setActiveTab("tab-b");
  setNextResponse(supportedState({ top_p: 0.9 }));
  await harness.load({ tabId: "tab-b", force: true });

  const topPControl = getControl("top_p");
  assert.equal(topPControl.enable.checked, true, "tab-b should reflect tab-b's state");
  assert.equal(getControl("temperature").enable.checked, false, "tab-a draft should not bleed into tab-b controls");

  // Refresh tab-a beneath its preserved draft before starting a delayed write.
  harness.setActiveTab("tab-a");
  setNextResponse(supportedState({ temperature: 0.5 }));
  await harness.load({ tabId: "tab-a" });

  let releaseGate;
  setResponseGate(new Promise((resolve) => { releaseGate = resolve; }));
  setNextResponse(supportedState({ temperature: 0.2 }));
  const inFlightWrite = harness.apply();
  await Promise.resolve();

  // Switch to tab-b while tab-a PUT is in-flight. The completed write clears only tab-a's draft.
  harness.setActiveTab("tab-b");
  releaseGate();
  await inFlightWrite;
  setResponseGate(null);
  setNextResponse(supportedState({ top_p: 0.9 }));
  await harness.load({ tabId: "tab-b", force: true });
  assert.equal(topPControl.enable.checked, true, "tab-b controls must reload intact after tab-a's delayed PUT resolves");

  // Switch back to tab-a: tab-a's draft was cleared by successful Apply, and loading tab-a fetches tab-a's updated state
  harness.setActiveTab("tab-a");
  setNextResponse(supportedState({ temperature: 0.2 }));
  await harness.load({ tabId: "tab-a", force: true });
  assert.equal(getControl("temperature").enable.checked, true);
  assert.equal(getControl("temperature").number.value, "0.2");
  assert.equal(harness.draft("tab-a"), null, "successful PUT should clear tab-a's draft");
  console.log("✓ Test 7: Tab-Isolated Drafts Including Delayed Responses passed");
}

// --- Test 8: Unsupported Model Behavior ---
{
  const { harness, elements, requests, getControl, setNextResponse } = createHarness();
  const unsupportedState = {
    session: { temperature: 0.7 },
    defaults: {},
    effective: {},
    support: {
      supported: false,
      api: "anthropic-messages",
      model: { provider: "anthropic", id: "claude-sonnet-3.5", name: "Claude Sonnet" },
      parameters: capabilitiesFor([], "anthropic-messages"),
      compatibleApis: ["openai-completions", "openai-responses", "azure-openai-responses"],
      message: "Session sampling parameters are stored but not applied to anthropic-messages.",
    },
  };
  setNextResponse(unsupportedState);
  await harness.load({ tabId: "tab-a" });

  assert.equal(elements.applySamplingParametersButton.disabled, true, "Apply button must be disabled for unsupported model API");
  assert.match(elements.samplingParametersSupport.textContent, /anthropic-messages/);
  assert.match(elements.samplingParametersStatus.textContent, /no verified sampling parameters/);

  const tempControl = getControl("temperature");
  assert.equal(tempControl.enable.checked, true, "stored controls must remain visible and checked");
  assert.equal(tempControl.number.value, "0.7", "stored values must be readable");
  assert.equal(tempControl.enable.disabled, true, "an unsupported checkbox must be disabled without clearing its checked state");
  assert.equal(tempControl.number.disabled, true, "an unsupported exact input must be disabled");
  assert.equal(tempControl.range.disabled, true, "an unsupported range input must be disabled");
  assert.equal(tempControl.row.tabIndex, 0, "the unsupported row must remain keyboard focusable");
  assert.equal(tempControl.row.getAttribute("aria-disabled"), "true");
  assert.equal(tempControl.row.getAttribute("aria-describedby"), tempControl.tooltip.id, "the focusable row must expose the tooltip reason as its accessible description");
  assert.equal(tempControl.enable.getAttribute("aria-describedby"), tempControl.tooltip.id, "the disabled checkbox must expose the same reason");
  assert.equal(tempControl.tooltip.getAttribute("role"), "tooltip");
  assert.equal(tempControl.tooltip.hidden, false, "the unsupported reason must remain available to pointer, focus, and assistive technology");
  assert.match(tempControl.tooltip.textContent, /does not declare Temperature support/);
  assert.match(elements.samplingParametersSupport.textContent, /Sampling-capable APIs:/, "the diagnostic list should describe API-level sampling capability");
  assert.doesNotMatch(elements.samplingParametersSupport.textContent, /Compatible APIs:/, "the diagnostic label must not imply universal per-parameter support");

  const escapeEvent = { type: "keydown", key: "Escape" };
  assert.equal(tempControl.row.dispatchEvent(escapeEvent), false, "Escape dismissal should consume the scoped key event");
  assert.equal(tempControl.row.classList.contains("sampling-tooltip-dismissed"), true);
  tempControl.row.dispatchEvent("pointerleave");
  assert.equal(tempControl.row.classList.contains("sampling-tooltip-dismissed"), true, "dismissal-induced pointerleave must not immediately restore the tooltip");
  tempControl.row.dispatchEvent("pointerenter");
  assert.equal(tempControl.row.classList.contains("sampling-tooltip-dismissed"), false, "a new pointer lifecycle should restore tooltip availability");
  tempControl.row.dispatchEvent({ type: "keydown", key: "Escape" });
  tempControl.row.dispatchEvent({ type: "focusout", relatedTarget: null });
  assert.equal(tempControl.row.classList.contains("sampling-tooltip-dismissed"), true, "focus dismissal should persist while the pointer remains over the row");
  tempControl.row.dispatchEvent("pointerleave");
  assert.equal(tempControl.row.classList.contains("sampling-tooltip-dismissed"), true, "dismissal should remain stable after the active pointer lifecycle ends");
  tempControl.row.dispatchEvent("pointerenter");
  assert.equal(tempControl.row.classList.contains("sampling-tooltip-dismissed"), false, "the next pointer lifecycle should reset a completed dismissal");

  requests.length = 0;
  await harness.apply();
  assert.equal(requests.length, 0, "Apply click must not trigger HTTP request for unsupported models");
  console.log("✓ Test 8: Unsupported Model Behavior passed");
}

// --- Test 9: Status / Default / Effective Rendering ---
{
  const { harness, elements, getControl, setNextResponse } = createHarness();
  setNextResponse(supportedState({ temperature: 0.3 }, { temperature: 1, top_p: 0.95 }));
  await harness.load({ tabId: "tab-a" });

  const tempControl = getControl("temperature");
  const topPControl = getControl("top_p");

  assert.equal(tempControl.defaultValue.textContent, "1", "temperature default should display 1");
  assert.equal(tempControl.effectiveValue.textContent, "0.3", "temperature effective value should display 0.3");

  assert.equal(topPControl.defaultValue.textContent, "0.95", "top_p default should display 0.95");
  assert.equal(topPControl.effectiveValue.textContent, "0.95", "top_p effective value should fall back to model default");

  // Status message in clean state
  assert.equal(elements.samplingParametersStatus.textContent, "Saved for this Pi session · unchecked parameters inherit model defaults.");

  // Make draft dirty
  tempControl.number.value = "0.4";
  tempControl.number.dispatchEvent("input");

  assert.equal(elements.samplingParametersStatus.textContent, "Unsaved controls · Apply stores enabled values for this session only.");
  console.log("✓ Test 9: Status / Default / Effective Rendering passed");
}

// --- Test 10: Controls Stay Locked Until Loaded Unknown Keys Are Available ---
{
  const { harness, elements, requests, getControl, setNextResponse, setResponseGate } = createHarness();
  let releaseLoad;
  setResponseGate(new Promise((resolve) => { releaseLoad = resolve; }));
  setNextResponse(supportedState({ vendor_mode: "strict" }));

  const inFlightLoad = harness.load({ tabId: "tab-a" });
  await Promise.resolve();

  const minPControl = getControl("min_p");
  assert.equal(minPControl.enable.disabled, true, "controls must stay disabled until the active tab state has loaded");
  minPControl.enable.checked = true;
  minPControl.enable.dispatchEvent("change");
  assert.equal(harness.draft("tab-a"), null, "defensive event handling must ignore edits before a base draft exists");

  releaseLoad();
  await inFlightLoad;
  setResponseGate(null);
  assert.match(elements.samplingParametersPreserved.textContent, /1 additional parameter is preserved/);

  minPControl.enable.checked = true;
  minPControl.enable.dispatchEvent("change");
  minPControl.number.value = "0.05";
  minPControl.number.dispatchEvent("input");
  requests.length = 0;
  setNextResponse(supportedState({ vendor_mode: "strict", min_p: 0.05 }));
  await harness.apply();
  assert.deepEqual(requests[0].body, { vendor_mode: "strict", min_p: 0.05 }, "the first editable draft must retain hidden keys loaded from the server");
  console.log("✓ Test 10: Pre-load Editing Guard and Unknown-Key Preservation passed");
}

// --- Test 11: Dirty Draft Survives Tab Round-Trip and Remains Applicable ---
{
  const { harness, elements, requests, getControl, setNextResponse } = createHarness();
  setNextResponse(supportedState({ temperature: 0.5, vendor_mode: "strict" }));
  await harness.load({ tabId: "tab-a" });

  const temperature = getControl("temperature");
  temperature.number.value = "0.2";
  temperature.number.dispatchEvent("input");
  assert.equal(harness.dirty("tab-a"), true);

  harness.setActiveTab("tab-b");
  setNextResponse(supportedState({ top_p: 0.9 }));
  await harness.load({ tabId: "tab-b" });

  harness.setActiveTab("tab-a");
  setNextResponse(supportedState({ temperature: 0.5, vendor_mode: "strict" }));
  await harness.load({ tabId: "tab-a" });

  assert.equal(harness.draft("tab-a").controls.temperature.value, "0.2", "the tab-a draft must survive a non-forced tab round-trip");
  assert.equal(elements.applySamplingParametersButton.disabled, false, "Apply must be available after active-tab state refreshes beneath a dirty draft");
  assert.equal(elements.resetSamplingParametersButton.disabled, false, "Reset must remain available after the round-trip");
  assert.match(elements.samplingParametersStatus.textContent, /Unsaved controls/);

  requests.length = 0;
  setNextResponse(supportedState({ temperature: 0.2, vendor_mode: "strict" }));
  await harness.apply();
  assert.deepEqual(requests[0].body, { vendor_mode: "strict", temperature: 0.2 }, "applying the restored draft must retain refreshed hidden keys");
  console.log("✓ Test 11: Dirty Draft Tab Round-Trip passed");
}

// --- Test 12: Tab Refresh During Apply Cannot Strand Busy State or Leak Defaults ---
{
  const { harness, elements, requests, getControl, setNextResponse, setResponseGate } = createHarness();
  setNextResponse(supportedState({ temperature: 0.5 }, { temperature: 1.7 }));
  await harness.load({ tabId: "tab-a" });

  const temperature = getControl("temperature");
  temperature.number.value = "0.2";
  temperature.number.dispatchEvent("input");

  let releaseRequests;
  setResponseGate(new Promise((resolve) => { releaseRequests = resolve; }));
  setNextResponse(supportedState({ temperature: 0.2 }, { temperature: 1.7 }));
  const inFlightWrite = harness.apply();
  await Promise.resolve();

  harness.setActiveTab("tab-b");
  setNextResponse(supportedState({ top_p: 0.9 }, { top_p: 1 }));
  const inFlightLoad = harness.load({ tabId: "tab-b" });
  await Promise.resolve();

  assert.equal(getControl("temperature").number.value, "", "an unloaded tab must not display the previous tab's default suggestion");
  assert.equal(elements.reloadSamplingParametersButton.disabled, true, "Reload remains disabled while the write/load pair is active");

  releaseRequests();
  await Promise.all([inFlightWrite, inFlightLoad]);
  setResponseGate(null);

  assert.equal(harness.stateTabId(), "tab-b", "the superseding load must install the active tab's state");
  assert.equal(elements.reloadSamplingParametersButton.disabled, false, "a superseded write must always clear the global busy state");
  assert.doesNotMatch(elements.samplingParametersStatus.textContent, /Applying sampling parameters/, "status must not remain stuck in Applying");
  assert.equal(getControl("top_p").enable.checked, true, "tab-b controls remain usable after the interleaving");
  assert.equal(harness.draft("tab-a"), null, "the successful write still clears only its originating draft");
  assert.equal(requests.filter(({ method }) => method === "PUT").length, 1);
  console.log("✓ Test 12: Write/Refresh Busy-State Recovery and Default Isolation passed");
}

// --- Test 13: Codex Per-Key Refresh, Draft Preservation, and Missing-Map Fail-Closed ---
{
  const { harness, elements, requests, getControl, setNextResponse } = createHarness();
  setNextResponse({
    session: { temperature: 0.6, top_p: 0.9 },
    defaults: {},
    effective: { temperature: 0.6, top_p: 0.9 },
    support: {
      supported: true,
      api: "openai-completions",
      model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
      parameters: capabilitiesFor(["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed"], "openai-completions"),
      message: "Session sampling parameters apply to subsequent provider requests.",
    },
  });
  await harness.load({ tabId: "tab-a" });
  const temperature = getControl("temperature");
  temperature.number.value = "0.25";
  temperature.number.dispatchEvent("input");

  setNextResponse({
    session: { temperature: 0.6, top_p: 0.9 },
    defaults: {},
    effective: { temperature: 0.6 },
    support: {
      supported: true,
      api: "openai-codex-responses",
      model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      parameters: capabilitiesFor(["temperature"], "openai-codex-responses"),
      message: "Session sampling parameters apply to subsequent provider requests.",
    },
  });
  await harness.refresh({ tabId: "tab-a", generation: 1 });

  assert.equal(temperature.number.value, "0.25", "a model capability refresh must not discard an unsaved Temperature draft");
  assert.equal(temperature.enable.disabled, false, "Codex Temperature must remain enabled");
  assert.equal(temperature.row.getAttribute("aria-disabled"), null, "supported rows must remove unsupported accessibility state");
  assert.equal(temperature.tooltip.hidden, true, "supported rows must hide tooltip nodes after a capability transition");
  assert.equal(temperature.tooltip.textContent, "", "supported rows must clear stale unsupported reasons after a capability transition");
  const topP = getControl("top_p");
  assert.equal(topP.enable.checked, true, "a stored unsupported value must remain checked and preserved");
  assert.equal(topP.enable.disabled, true, "Codex Top P is unverified and must be disabled");
  assert.equal(topP.tooltip.hidden, false);
  assert.equal(topP.row.getAttribute("aria-describedby"), topP.tooltip.id);
  assert.match(topP.tooltip.textContent, /openai-codex-responses does not declare Top P support/);
  for (const key of ["top_p", "frequency_penalty", "presence_penalty", "seed", "top_k", "min_p"]) {
    assert.equal(getControl(key).enable.disabled, true, `Codex ${key} must fail closed when unverified`);
  }
  assert.equal(elements.applySamplingParametersButton.disabled, false, "a draft remains applicable when at least one parameter is supported");
  requests.length = 0;
  setNextResponse({
    session: { temperature: 0.25, top_p: 0.9 },
    defaults: {},
    effective: { temperature: 0.25 },
    support: {
      supported: true,
      api: "openai-codex-responses",
      model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      parameters: capabilitiesFor(["temperature"], "openai-codex-responses"),
      message: "Session sampling parameters apply to subsequent provider requests.",
    },
  });
  await harness.apply();
  assert.deepEqual(requests[0].body, { temperature: 0.25, top_p: 0.9 }, "applying a supported edit must preserve the stored unsupported value for backend filtering");

  setNextResponse({
    session: { temperature: 0.25, top_p: 0.9 },
    defaults: {},
    effective: {},
    support: { supported: true, api: "legacy-fixture-without-parameters", message: "Legacy whole-API support only." },
  });
  await harness.load({ tabId: "tab-a", force: true });
  assert.ok(SAMPLING_PARAMETER_CATALOG.every(({ key }) => getControl(key).enable.disabled), "missing support.parameters must disable every control even when legacy support.supported is true");
  assert.equal(elements.applySamplingParametersButton.disabled, true);
  assert.match(getControl("temperature").tooltip.textContent, /support was not reported/);
  console.log("✓ Test 13: Codex Per-Key Refresh and Missing-Map Fail-Closed passed");
}

console.log("All native sampling parameter control user-flow acceptance tests passed!");
