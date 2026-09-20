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
const [html, css, app, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

// --- Static markup, startup graph, and accessibility ------------------------

const section = html.match(/<section class="side-panel-section collapsed" data-side-panel-section="sampling">[\s\S]*?<\/section>/)?.[0] || "";
assert.ok(section, "Sampling parameters should remain a first-class collapsed side-panel section");
assert.match(section, /id="sidePanelSectionToggleSampling"[\s\S]*aria-controls="sidePanelSectionSampling"[\s\S]*data-side-panel-section-toggle="sampling"/, "the sampling section should follow the shared toggle contract");
assert.match(section, /id="samplingParametersControls" class="sampling-parameter-groups"/, "native controls should have a dedicated generated-control host");
assert.match(section, /id="samplingParametersPreserved"/, "hidden JSON keys should have a count-only preservation status");
assert.doesNotMatch(section, /<textarea|samplingParametersInput|JSON object|<code id="samplingParameters(?:Defaults|Effective)"/, "the sampling UI must not expose raw JSON editing or raw JSON readouts");
assert.match(section, /id="samplingParametersSupport"[^>]*role="status"[^>]*aria-live="polite"/, "compatibility should be announced politely");
assert.match(section, /id="samplingParametersStatus"[^>]*role="status"[^>]*aria-live="polite"/, "validation and write outcomes should be announced politely");
assert.match(section, /id="applySamplingParametersButton"[^>]*disabled>Apply<\/button>/, "Apply should start disabled");
assert.match(section, /id="resetSamplingParametersButton"[^>]*disabled>Reset<\/button>/, "Reset should start disabled");
assert.match(app, /from "\.\/sampling-parameter-controls\.mjs";/, "the browser should consume the pure sampling control model");
assert.match(app, /enable\.type = "checkbox";/, "each generated parameter should have a native enable checkbox");
assert.match(app, /number\.type = "number";/, "each parameter should have a native exact number input");
assert.match(app, /range\.type = "range";/, "each parameter should have a native common-range slider");
assert.match(app, /number\.setAttribute\("aria-describedby", `\$\{descriptionId\} \$\{errorId\}`\)/, "number inputs should be linked to help and field errors");
assert.match(app, /tooltip\.setAttribute\("role", "tooltip"\)/, "each generated row should own a real tooltip element");
assert.match(app, /refs\.row\.setAttribute\("aria-describedby", tooltipId\)/, "unsupported focus targets should expose the tooltip reason to assistive technology");
assert.match(app, /refs\.enable\.setAttribute\("aria-describedby", tooltipId\)/, "disabled checkboxes should expose the same reason");
assert.match(app, /refs\.tooltip\.hidden = !parameterUnsupported;/, "supported rows should hide their unused tooltip nodes");
assert.match(app, /refs\.tooltip\.textContent = parameterUnsupported \? capability\.reason : "";/, "supported rows should clear tooltip text from the accessibility tree");
assert.match(app, /Sampling-capable APIs:/, "the diagnostic API label should not imply universal parameter compatibility");
assert.doesNotMatch(app, / Compatible APIs:/, "the outdated universal-compatibility wording should be removed");
assert.match(app, /event\.key !== "Escape"[\s\S]*sampling-tooltip-dismissed/, "Escape should dismiss only an active sampling tooltip");
assert.match(app, /pointerenter[\s\S]*focusin[\s\S]*focusout/, "dismissal should reset across new pointer and focus lifecycles");
assert.match(app, /spaceAbove < naturalHeight && spaceBelow > spaceAbove/, "tooltip placement should flip within the available scrollport bounds");
assert.match(app, /sampling: \["Sampling parameters", \["sidePanelSectionSampling"\]\]/, "mobile More should reuse the canonical sampling section");
assert.match(css, /\.sampling-parameter-control\.invalid \{[\s\S]*border-color:/, "invalid controls should be visually distinct");
assert.match(css, /\.sampling-parameter-editor \{[\s\S]*grid-template-columns:/, "native number and range inputs should have responsive layout");
assert.match(css, /\.sampling-parameter-control\.unsupported:hover:not\(\.sampling-tooltip-dismissed\) > \.sampling-parameter-unsupported-tooltip/, "pointer hover should reveal dismissible unsupported reasons");
assert.match(css, /\.sampling-parameter-control\.unsupported:focus-visible:not\(\.sampling-tooltip-dismissed\) > \.sampling-parameter-unsupported-tooltip/, "keyboard focus should reveal dismissible unsupported reasons");
assert.match(css, /\.sampling-parameter-unsupported-tooltip\.sampling-tooltip-below/, "bounded placement should support flipping below top-edge rows");
assert.match(css, /pointer-events: auto;/, "a visible unsupported tooltip should remain pointer-hoverable");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "native-control assets should advance the cache identity");
assert.match(serviceWorker, /"\/sampling-parameter-controls\.mjs"/, "the pure sampling module should be part of the offline app shell");
assert.match(html, /styles\.css\?v=154/, "the changed stylesheet should have a new revision");
assert.match(html, /app\.js\?v=184/, "the changed app module should have a new revision");

// --- Browser state behavior -------------------------------------------------

const blockStart = app.indexOf("function samplingParametersPath(");
const blockEnd = app.indexOf("\nfunction sessionCopyButton(", blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart, "sampling browser state should remain a focused frontend block");
const samplingBlock = app.slice(blockStart, blockEnd);

function classListNode() {
  const classes = new Set();
  return {
    classes,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
  };
}

function simpleNode() {
  const node = classListNode();
  return Object.assign(node, {
    textContent: "",
    value: "",
    disabled: false,
    checked: false,
    hidden: false,
    tabIndex: -1,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  });
}

function controlRefs() {
  return {
    row: simpleNode(),
    enable: simpleNode(),
    number: simpleNode(),
    range: simpleNode(),
    defaultValue: simpleNode(),
    effectiveValue: simpleNode(),
    error: simpleNode(),
    tooltip: simpleNode(),
  };
}

const elements = {
  samplingParametersControls: null, // Dynamic DOM construction is covered statically; refs are installed below.
  samplingParametersPreserved: simpleNode(),
  applySamplingParametersButton: simpleNode(),
  resetSamplingParametersButton: simpleNode(),
  reloadSamplingParametersButton: simpleNode(),
  samplingParametersSupport: simpleNode(),
  samplingParametersStatus: simpleNode(),
};
const refs = Object.fromEntries(SAMPLING_PARAMETER_CATALOG.map(({ key }) => [key, controlRefs()]));
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
const hostValue = (value, fallback = undefined) => value === undefined ? fallback : JSON.parse(JSON.stringify(value));
const requests = [];
let sectionActive = true;
let nextResponse = null;
let nextError = null;
let responseGate = null;
const context = {
  console,
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
    requests.push({ path, method: options.method || "GET", body: options.body, scoped: options.scoped });
    if (responseGate) await responseGate;
    if (nextError) throw nextError;
    return { data: nextResponse };
  },
};
context.refsFromHost = refs;
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
${samplingBlock}
for (const [key, value] of Object.entries(globalThis.refsFromHost)) samplingParameterControlElements.set(key, value);
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
};
`, context);
const harness = context.samplingHarness;

function capabilitiesFor(supportedKeys, api = "fixture-api") {
  const supported = new Set(supportedKeys);
  return Object.fromEntries(SAMPLING_PARAMETER_CATALOG.map(({ key, label }) => [key, {
    supported: supported.has(key),
    reason: supported.has(key) ? `Supported by ${api}.` : `${api} does not declare ${label} support.`,
    source: supported.has(key) ? "api" : "unsupported",
  }]));
}

const supportedState = (session = {}, defaults = { temperature: 1 }) => ({
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

nextResponse = supportedState({ temperature: 0.2, vendor_mode: "strict" }, { temperature: 1, top_p: 0.95 });
await harness.load({ tabId: "tab-a" });
assert.deepEqual(plain(requests), [{ path: "/api/tabs/tab-a/sampling-parameters", method: "GET", scoped: false }]);
assert.equal(refs.temperature.enable.checked, true, "stored catalog values should enable their controls");
assert.equal(refs.temperature.number.value, "0.2", "the exact session value should populate the number input");
assert.equal(refs.temperature.range.value, "0.2", "the slider should mirror an in-range exact value");
assert.equal(refs.top_p.enable.checked, false, "model defaults should not become session overrides");
assert.equal(refs.top_p.number.value, "0.95", "a disabled control may show its model default as a suggestion");
assert.equal(refs.temperature.defaultValue.textContent, "1");
assert.equal(refs.temperature.effectiveValue.textContent, "0.2");
assert.equal(refs.temperature.tooltip.hidden, true, "supported rows should hide unused tooltip nodes");
assert.equal(refs.temperature.tooltip.textContent, "", "supported rows should clear unused tooltip text");
assert.equal(refs.temperature.row.attributes["aria-describedby"], undefined, "supported rows should not reference an unsupported reason");
assert.match(elements.samplingParametersPreserved.textContent, /1 additional parameter is preserved/, "unknown keys should be counted without exposure");
assert.doesNotMatch(elements.samplingParametersPreserved.textContent, /vendor_mode/);
assert.equal(elements.applySamplingParametersButton.disabled, false);

// Applying a known edit preserves hidden keys and sends the existing direct-object API shape.
requests.length = 0;
const edited = createSamplingControlDraft({ temperature: 0.2, vendor_mode: "strict" }, { defaults: { temperature: 1, top_p: 0.95 } });
edited.controls.top_p.enabled = true;
edited.controls.top_p.value = "0.9";
harness.setDraft(edited);
harness.render();
nextResponse = supportedState({ temperature: 0.2, top_p: 0.9, vendor_mode: "strict" });
await harness.apply();
assert.deepEqual(plain(requests), [{
  path: "/api/tabs/tab-a/sampling-parameters",
  method: "PUT",
  body: { vendor_mode: "strict", temperature: 0.2, top_p: 0.9 },
  scoped: false,
}], "Apply should merge enabled known controls over preserved hidden keys");
assert.equal(harness.draft(), null, "successful Apply should clear only the submitted tab draft");
assert.match(elements.samplingParametersStatus.textContent, /Applied to this Pi session/);

// Disabling a known control removes only that key.
requests.length = 0;
const disabledTemperature = createSamplingControlDraft({ temperature: 0.2, vendor_mode: "strict" });
disabledTemperature.controls.temperature.enabled = false;
harness.setDraft(disabledTemperature);
nextResponse = supportedState({ vendor_mode: "strict" });
await harness.apply();
assert.deepEqual(plain(requests[0]?.body), { vendor_mode: "strict" });

// Invalid exact values are field-linked and block writes.
requests.length = 0;
const invalid = createSamplingControlDraft({ top_p: 0.5 });
invalid.controls.top_p.value = "0";
harness.setDraft(invalid);
harness.render();
assert.equal(refs.top_p.number.attributes["aria-invalid"], "true");
assert.match(refs.top_p.error.textContent, /greater than 0/);
assert.ok(refs.top_p.row.classes.has("invalid"));
assert.equal(elements.applySamplingParametersButton.disabled, true);
await harness.apply();
assert.deepEqual(requests, [], "invalid controls should never send a request");
assert.match(elements.samplingParametersStatus.textContent, /greater than 0/);

// Exact integer values can exceed the soft slider range without being clamped.
requests.length = 0;
const largeTopK = createSamplingControlDraft({ top_k: 1000 });
harness.setDraft(largeTopK);
harness.render();
assert.equal(refs.top_k.number.value, "1000");
assert.equal(refs.top_k.range.value, "200", "the range should stop at its common maximum only visually");
nextResponse = supportedState({ top_k: 1000 });
await harness.apply();
assert.equal(requests[0]?.body?.top_k, 1000, "Apply should retain the authoritative exact number");

// A response already in flight must not erase controls changed after the request began.
requests.length = 0;
let releaseResponse;
responseGate = new Promise((resolve) => { releaseResponse = resolve; });
nextResponse = supportedState({ temperature: 0.2 });
const inFlightRefresh = harness.load({ tabId: "tab-a", force: true });
await Promise.resolve();
const changedDuringLoad = createSamplingControlDraft({ min_p: 0.25 });
harness.setDraft(changedDuringLoad, "tab-a");
harness.render();
releaseResponse();
await inFlightRefresh;
responseGate = null;
assert.equal(harness.draft("tab-a").controls.min_p.value, 0.25, "an in-flight refresh should preserve newly edited controls");

// Successful delayed PUTs clear the originating tab only.
harness.setActiveTab("tab-a");
const delayedDraft = createSamplingControlDraft({ temperature: 0.42 });
harness.setDraft(delayedDraft, "tab-a");
nextResponse = supportedState({ temperature: 0.42 });
let releaseWrite;
responseGate = new Promise((resolve) => { releaseWrite = resolve; });
const inFlightWrite = harness.apply();
await Promise.resolve();
harness.setActiveTab("tab-b");
releaseWrite();
await inFlightWrite;
responseGate = null;
assert.equal(harness.draft("tab-a"), null, "a completed PUT should clear the originating tab draft after a tab switch");

// Tab B remains independently editable while tab A retains a different draft.
harness.setActiveTab("tab-a");
harness.setDraft(createSamplingControlDraft({ temperature: 0.33 }), "tab-a");
harness.setActiveTab("tab-b");
nextResponse = supportedState({ top_p: 0.8 });
await harness.load({ tabId: "tab-b", force: true });
assert.equal(refs.top_p.number.value, "0.8");
assert.equal(harness.draft("tab-a").controls.temperature.value, 0.33);

// Unsupported APIs remain readable but cannot be applied.
requests.length = 0;
nextResponse = {
  session: { temperature: 0.2 },
  defaults: {},
  effective: {},
  support: {
    supported: false,
    api: "anthropic-messages",
    model: { provider: "anthropic", id: "claude", name: "Claude" },
    parameters: capabilitiesFor([], "anthropic-messages"),
    compatibleApis: ["openai-completions", "openai-responses", "azure-openai-responses"],
    message: "Session sampling parameters are stored but not applied to anthropic-messages.",
  },
};
await harness.load({ tabId: "tab-b", force: true });
assert.equal(elements.applySamplingParametersButton.disabled, true);
assert.equal(refs.temperature.number.value, "0.2", "stored controls should remain readable on unsupported APIs");
assert.equal(refs.temperature.enable.checked, true, "stored unsupported values should remain visibly checked");
assert.equal(refs.temperature.enable.disabled, true, "unsupported checkboxes should be disabled");
assert.equal(refs.temperature.number.disabled, true, "unsupported number inputs should be disabled");
assert.equal(refs.temperature.range.disabled, true, "unsupported range inputs should be disabled");
assert.equal(refs.temperature.row.tabIndex, 0, "unsupported rows should remain keyboard focusable");
assert.equal(refs.temperature.row.attributes["aria-disabled"], "true");
assert.equal(refs.temperature.row.attributes["aria-describedby"], "samplingParameterTemperatureUnsupportedReason");
assert.equal(refs.temperature.tooltip.hidden, false, "unsupported tooltip nodes should remain available");
assert.match(refs.temperature.tooltip.textContent, /does not declare Temperature support/);
assert.match(elements.samplingParametersSupport.textContent, /Sampling-capable APIs:/);
assert.doesNotMatch(elements.samplingParametersSupport.textContent, /Compatible APIs:/);
requests.length = 0;
await harness.apply();
assert.deepEqual(requests, []);
assert.match(elements.samplingParametersStatus.textContent, /no verified sampling parameters/);

// Reset uses explicit {} and clears both known and hidden session parameters.
requests.length = 0;
nextResponse = supportedState({});
await harness.reset();
assert.deepEqual(plain(requests[0]?.body), {});
assert.match(elements.samplingParametersStatus.textContent, /Session override cleared/);
assert.match(elements.samplingParametersPreserved.textContent, /No additional parameters/);

// Backend failures remain visible and do not fabricate state.
requests.length = 0;
nextError = new Error("helper unavailable");
await harness.load({ tabId: "tab-b", force: true });
nextError = null;
assert.match(elements.samplingParametersStatus.textContent, /Could not load sampling parameters: helper unavailable/);
assert.ok(elements.samplingParametersStatus.classes.has("error"));

console.log("session-sampling-ui-static.test.mjs passed");
