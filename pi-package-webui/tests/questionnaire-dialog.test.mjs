import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [app, css, html, serviceWorker] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
]);

function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in app.js`);
  const tail = app.slice(start);
  const end = tail.search(/^}\s*$/m);
  assert.notEqual(end, -1, `${name} must have a complete declaration`);
  return tail.slice(0, end + 1);
}

function branchSource(startMarker, endMarker) {
  const start = app.indexOf(startMarker);
  assert.notEqual(start, -1, `missing branch marker: ${startMarker}`);
  const bodyStart = start + startMarker.length;
  const end = app.indexOf(endMarker, bodyStart);
  assert.notEqual(end, -1, `missing branch end marker: ${endMarker}`);
  return app.slice(bodyStart, end);
}

class FakeClassList {
  constructor(node) {
    this.node = node;
    this.values = new Set();
  }

  setFromString(value) {
    this.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  add(...values) {
    for (const value of values) this.values.add(value);
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }

  toString() {
    return [...this.values].join(" ");
  }
}

class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.disabled = false;
    this.textContent = "";
    this.value = "";
  }

  set className(value) {
    this.classList.setFromString(value);
  }

  get className() {
    return this.classList.toString();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }

  querySelectorAll(selector) {
    assert.equal(selector, "button", "the focused dialog harness only queries buttons");
    const matches = [];
    const visit = (node) => {
      if (node.tagName === "BUTTON") matches.push(node);
      for (const child of node.children || []) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }

  focus() {
    this.focused = true;
  }
}

const document = { createElement: (tag) => new FakeNode(tag) };
const constantNames = [
  "QUESTIONNAIRE_TITLE_PATTERN",
  "QUESTIONNAIRE_ROW_PATTERN",
  "QUESTIONNAIRE_STATE_PATTERN",
  "QUESTIONNAIRE_MAX_QUESTIONS",
  "QUESTIONNAIRE_MAX_OPTIONS",
];
const constants = constantNames.map((name) => {
  const match = app.match(new RegExp(`^const ${name} = .+;$`, "m"));
  assert.ok(match, `${name} must remain a bounded parser constant`);
  return match[0];
});
const helperNames = [
  "make",
  "dialogInputEnterIntent",
  "createDialogResponder",
  "isQuestionnaireChangeOtherAction",
  "questionnaireContinueCount",
  "questionnaireActionKind",
  "parseQuestionnaireOption",
  "questionnaireActionSequenceMatches",
  "questionnaireSelectParts",
  "renderQuestionnaireOptionButton",
  "renderQuestionnaireActionButton",
];
const helperSource = [...constants, ...helperNames.map(functionSource)].join("\n\n");
const context = { document, stripAnsi: (value) => String(value).replace(/\x1b\[[0-9;]*m/g, "") };
vm.runInNewContext(`${helperSource}\nglobalThis.questionnaireTestApi = { ${helperNames.join(", ")} };`, context, { filename: "questionnaire-app-helpers.js" });
const helpers = context.questionnaireTestApi;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function keyEvent(overrides = {}) {
  return {
    key: "Enter",
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...overrides,
  };
}

// Exercise the actual input branch extracted from showNextDialog. This proves
// keyboard and click activation share the same one-shot transport closure.
const inputBranch = branchSource('  } else if (request.method === "input") {', '  } else if (isWorkflowScriptPreview) {');
const runInputBranch = new Function(
  "make",
  "elements",
  "request",
  "respondToDialog",
  "dialogInputEnterIntent",
  "addDialogButton",
  "setTimeout",
  "activeDialogCancel",
  inputBranch,
);

function inputHarness(prefill = "") {
  const elements = { dialogBody: new FakeNode("div"), dialogActions: new FakeNode("menu") };
  const responses = [];
  const addDialogButton = (label, handler, className) => {
    const button = new FakeNode("button");
    button.textContent = label;
    button.className = className || "";
    button.addEventListener("click", handler);
    elements.dialogActions.append(button);
    return button;
  };
  runInputBranch(
    (tag, className, text) => {
      const node = new FakeNode(tag);
      node.className = className || "";
      if (text !== undefined) node.textContent = text;
      return node;
    },
    elements,
    { id: "input-request", tabId: "tab-one", prefill, placeholder: "Type exactly" },
    helpers.createDialogResponder((response) => responses.push({
      type: "extension_ui_response",
      id: "input-request",
      tabId: "tab-one",
      ...response,
    })),
    helpers.dialogInputEnterIntent,
    addDialogButton,
    (callback) => callback(),
    null,
  );
  return {
    elements,
    input: elements.dialogBody.children[0],
    cancel: elements.dialogActions.children[0],
    submit: elements.dialogActions.children[1],
    responses,
  };
}

{
  const harness = inputHarness("initial");
  harness.input.value = "  exact Ω input  ";
  const enter = keyEvent();
  harness.input.dispatch("keydown", enter);
  harness.submit.dispatch("click");
  harness.cancel.dispatch("click");
  assert.equal(enter.defaultPrevented, true, "Enter must block method=dialog implicit submission");
  assert.equal(enter.propagationStopped, true, "handled Enter must not activate another control");
  assert.deepEqual(harness.responses, [{
    type: "extension_ui_response",
    id: "input-request",
    tabId: "tab-one",
    value: "  exact Ω input  ",
  }], "Enter must send the current input exactly once even if click/cancel follow");
  assert.equal(harness.input.disabled, true, "the one-shot guard must disable the input immediately");
  assert.equal(harness.submit.disabled, true, "the one-shot guard must disable Submit immediately");
}

{
  const harness = inputHarness();
  harness.input.value = "click path exact";
  harness.submit.dispatch("click");
  harness.submit.dispatch("click");
  harness.input.dispatch("keydown", keyEvent());
  assert.deepEqual(harness.responses.map((response) => response.value), ["click path exact"], "Submit click must use the same one-shot exact-value guard");
}

const cancelActiveExtensionDialogSource = functionSource("cancelActiveExtensionDialog");
const makeCancelActiveExtensionDialog = new Function(
  "activeDialog",
  "activeDialogCancel",
  `${cancelActiveExtensionDialogSource}; return cancelActiveExtensionDialog;`,
);
{
  let cancellationCount = 0;
  let responseSent = false;
  const cancelActiveExtensionDialog = makeCancelActiveExtensionDialog({ id: "active-request" }, () => {
    if (responseSent) return false;
    responseSent = true;
    cancellationCount += 1;
    return true;
  });
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(cancelActiveExtensionDialog(event), true, "native dialog cancellation must route through the active one-shot responder");
  assert.equal(cancelActiveExtensionDialog(event), false, "repeated native cancellation must not send twice");
  assert.equal(event.defaultPrevented, true, "native Escape cancellation must prevent the browser from closing method=dialog directly");
  assert.equal(cancellationCount, 1, "native Escape cancellation must send exactly once");
  const inactiveEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(makeCancelActiveExtensionDialog(null, null)(inactiveEvent), false, "inactive dialogs must ignore stray cancel events");
  assert.equal(inactiveEvent.defaultPrevented, false);
}
assert.match(app, /elements\.dialog\.addEventListener\("cancel", cancelActiveExtensionDialog\)/, "the native dialog cancel event must use the active response guard");
{
  const responses = [];
  const respondToDialog = helpers.createDialogResponder((response) => responses.push(response));
  assert.equal(respondToDialog({ value: "first" }), true);
  assert.equal(respondToDialog({ cancelled: true }), false, "all actions for one request must share the same response guard");
  assert.deepEqual(plain(responses), [{ value: "first" }]);
}
assert.ok((app.match(/activeDialogCancel = null;/g) || []).length >= 4, "active cancellation state must reset on cleanup, removal, completion, and new render");

for (const [label, overrides, intent, prevented] of [
  ["composition", { isComposing: true }, "ignore", false],
  ["legacy IME", { keyCode: 229 }, "ignore", false],
  ["repeat", { repeat: true }, "suppress", true],
  ["Alt", { altKey: true }, "suppress", true],
  ["Control", { ctrlKey: true }, "suppress", true],
  ["Meta", { metaKey: true }, "suppress", true],
  ["Shift", { shiftKey: true }, "suppress", true],
  ["non-Enter", { key: "a" }, "ignore", false],
]) {
  const event = keyEvent(overrides);
  assert.equal(helpers.dialogInputEnterIntent(event), intent, `${label} intent must be classified correctly`);
  const harness = inputHarness();
  harness.input.dispatch("keydown", event);
  assert.equal(harness.responses.length, 0, `${label} must not accidentally submit`);
  assert.equal(event.defaultPrevented, prevented, `${label} prevention must match its intent`);
  assert.equal(event.propagationStopped, prevented, `${label} propagation must match its intent`);
}

const singleOptions = [
  "01. Alpha — First description",
  "02. 同じ — Unicode description",
  "Other… (enter a custom answer)",
  "Ask Pi to clarify…",
  "Cancel questionnaire",
];
const single = helpers.questionnaireSelectParts({ title: "Question 1 of 2: Scope" }, singleOptions);
assert.equal(single?.mode, "single");
assert.deepEqual(plain(single.rows.slice(0, 2)), [
  { kind: "option", marker: "none", number: "01", label: "Alpha", description: "First description", value: singleOptions[0] },
  { kind: "option", marker: "none", number: "02", label: "同じ", description: "Unicode description", value: singleOptions[1] },
]);
assert.deepEqual(plain(single.rows.slice(2).map((row) => row.action)), ["other", "clarify", "cancel"], "single actions must receive distinct semantics");

const multiOptions = [
  "01. [ ] Alpha — First description",
  "02. [x] Beta",
  "03. [selected] Legacy",
  'Change Other… (currently "quoted \\"value\\"")',
  "Remove Other answer",
  "Ask Pi to clarify…",
  "Continue with 3 selection(s)",
  "Cancel questionnaire",
];
const multi = helpers.questionnaireSelectParts({ title: "Question 2 of 2: Features" }, multiOptions);
assert.equal(multi?.mode, "multi");
assert.deepEqual(plain(multi.rows.slice(0, 3).map((row) => row.marker)), ["unselected", "selected", "selected"], "[x] and legacy [selected] must preserve selected semantics");
assert.deepEqual(plain(multi.rows.slice(3).map((row) => row.action)), ["other", "remove-other", "clarify", "continue", "cancel"], "multi actions must remain explicitly classified");
for (const count of [0, 51]) {
  assert.equal(helpers.questionnaireContinueCount(`Continue with ${count} selection(s)`), count, `runtime boundary count ${count} must be accepted`);
}
for (const count of [52, "999999999999999999999999999999999999"]) {
  assert.equal(helpers.questionnaireContinueCount(`Continue with ${count} selection(s)`), null, `impossible count ${count} must be rejected`);
  assert.equal(helpers.questionnaireActionKind(`Continue with ${count} selection(s)`), null);
}

const singleButton = helpers.renderQuestionnaireOptionButton(single.rows[0], single.mode);
assert.equal(singleButton.classList.contains("questionnaire-option-single"), true);
assert.equal(singleButton.getAttribute("aria-label"), singleOptions[0], "semantic rendering must retain the exact native accessible label");
assert.equal(singleButton.getAttribute("aria-pressed"), null, "single answers must not advertise toggle state");
assert.deepEqual(singleButton.children.map((child) => child.className), ["questionnaire-option-number", "questionnaire-option-text"]);
assert.deepEqual(singleButton.children[1].children.map((child) => child.className), ["questionnaire-option-label", "questionnaire-option-description"]);

const unselectedButton = helpers.renderQuestionnaireOptionButton(multi.rows[0], multi.mode);
const selectedButton = helpers.renderQuestionnaireOptionButton(multi.rows[1], multi.mode);
assert.equal(unselectedButton.getAttribute("aria-pressed"), "false");
assert.equal(selectedButton.getAttribute("aria-pressed"), "true");
assert.equal(selectedButton.classList.contains("is-selected"), true);
assert.deepEqual(selectedButton.children.map((child) => child.className), ["questionnaire-option-number", "questionnaire-option-state", "questionnaire-option-text"]);
assert.equal(selectedButton.children[1].getAttribute("aria-hidden"), "true", "the decorative check must not duplicate the exact accessible name");
for (const row of multi.rows.slice(3)) {
  const button = helpers.renderQuestionnaireActionButton(row);
  assert.equal(button.classList.contains(`questionnaire-action-${row.action}`), true, `${row.action} requires a semantic class`);
  assert.equal(button.classList.contains("primary"), row.action === "continue", "only Continue is the primary questionnaire action");
}

for (const [name, title, options] of [
  ["non-question title", "Choose a feature", singleOptions],
  ["out-of-range progress", "Question 3 of 2: Scope", singleOptions],
  ["bad numbering", "Question 1 of 2: Scope", ["02. Alpha", ...singleOptions.slice(2)]],
  ["mixed modes", "Question 1 of 2: Scope", ["01. Alpha", "02. [ ] Beta", "Ask Pi to clarify…", "Cancel questionnaire"]],
  ["unknown action", "Question 1 of 2: Scope", ["01. Alpha", "Do something", "Ask Pi to clarify…", "Cancel questionnaire"]],
  ["missing action tail", "Question 1 of 2: Scope", ["01. Alpha", "Cancel questionnaire"]],
  ["noncanonical Other JSON", "Question 1 of 2: Scope", ["01. [ ] Alpha", 'Change Other… (currently "\\u0041")', "Remove Other answer", "Ask Pi to clarify…", "Continue with 1 selection(s)", "Cancel questionnaire"]],
]) {
  assert.equal(helpers.questionnaireSelectParts({ title }, options), null, `${name} must use generic select rendering`);
}

// Execute the actual questionnaire response branch to prove exact option
// transport and its click/cancel race guard, not just parser output.
const questionnaireBranch = branchSource("  if (questionnaire) {", '  } else if (request.method === "select") {');
const runQuestionnaireBranch = new Function(
  "make",
  "elements",
  "request",
  "questionnaire",
  "respondToDialog",
  "renderQuestionnaireActionButton",
  "renderQuestionnaireOptionButton",
  "addDialogButton",
  "activeDialogCancel",
  questionnaireBranch,
);

{
  const elements = { dialogBody: new FakeNode("div"), dialogActions: new FakeNode("menu") };
  const responses = [];
  const addDialogButton = (label, handler, className) => {
    const button = new FakeNode("button");
    button.textContent = label;
    button.className = className || "";
    button.addEventListener("click", handler);
    elements.dialogActions.append(button);
    return button;
  };
  runQuestionnaireBranch(
    (tag, className, text) => {
      const node = new FakeNode(tag);
      node.className = className || "";
      if (text !== undefined) node.textContent = text;
      return node;
    },
    elements,
    { id: "select-request", tabId: "tab-two", options: multiOptions },
    multi,
    helpers.createDialogResponder((response) => responses.push({
      type: "extension_ui_response",
      id: "select-request",
      tabId: "tab-two",
      ...response,
    })),
    helpers.renderQuestionnaireActionButton,
    helpers.renderQuestionnaireOptionButton,
    addDialogButton,
    null,
  );
  const optionButtons = elements.dialogBody.children[0].children;
  optionButtons[2].dispatch("click");
  optionButtons[6].dispatch("click");
  elements.dialogActions.children[0].dispatch("click");
  assert.deepEqual(responses, [{
    type: "extension_ui_response",
    id: "select-request",
    tabId: "tab-two",
    value: "03. [selected] Legacy",
  }], "parsed option clicks must send the untouched native string exactly once");
  assert.equal(optionButtons.every((button) => button.disabled), true, "one response must disable every questionnaire option/action");
  assert.equal(elements.dialogActions.children[0].disabled, true, "one response must disable footer Cancel");
}

// Non-questionnaire selects still follow the generic exact-string branch.
const genericSelectBranch = branchSource('  } else if (request.method === "select") {', '  } else if (request.method === "confirm") {');
const runGenericSelectBranch = new Function(
  "make",
  "elements",
  "request",
  "isGuardrailDialog",
  "isReleaseDialog",
  "respondToDialog",
  "addDialogButton",
  "cancel",
  genericSelectBranch,
);
{
  const elements = { dialogBody: new FakeNode("div"), dialogActions: new FakeNode("menu") };
  const responses = [];
  const addDialogButton = (label, handler) => {
    const button = new FakeNode("button");
    button.textContent = label;
    button.addEventListener("click", handler);
    elements.dialogActions.append(button);
  };
  const options = ["plain choice", "01. lookalike — unchanged"];
  const respondToDialog = helpers.createDialogResponder((response) => responses.push({
    type: "extension_ui_response",
    id: "generic-request",
    tabId: "tab-three",
    ...response,
  }));
  runGenericSelectBranch(
    (tag, className, text) => {
      const node = new FakeNode(tag);
      node.className = className || "";
      if (text !== undefined) node.textContent = text;
      return node;
    },
    elements,
    { id: "generic-request", tabId: "tab-three", options },
    false,
    false,
    respondToDialog,
    addDialogButton,
    () => respondToDialog({ cancelled: true }),
  );
  assert.deepEqual(elements.dialogBody.children[0].children.map((button) => button.textContent), options, "generic select labels must remain unsplit");
  elements.dialogBody.children[0].children[1].dispatch("click");
  elements.dialogActions.children[0].dispatch("click");
  assert.equal(responses[0].value, options[1], "generic fallback must retain exact transport");
  assert.equal(responses.length, 1, "generic option click and Escape/Cancel must share the one-shot responder");
}

assert.equal((app.match(/sendDialogResponse\(/g) || []).length, 2, "all dialog actions must route through the one per-request responder");
assert.match(app, /elements\.dialog\.classList\.toggle\("questionnaire-dialog", !!questionnaire\)/, "each render must add or remove questionnaire scope");
assert.doesNotMatch(app, /request\.method\s*===\s*["']questionnaire["']|method\s*:\s*["']questionnaire["']/, "presentation must not introduce a questionnaire RPC method");
assert.match(html, /<dialog id="extensionDialog" class="extension-dialog" aria-labelledby="dialogTitle" aria-describedby="dialogMessage">/, "the native extension dialog needs an explicit accessible name and description");

assert.match(css, /\.extension-dialog\.questionnaire-dialog\s*\{[\s\S]*?max-height:[\s\S]*?overflow:\s*hidden/, "desktop questionnaire layout must have bounded scrolling");
assert.match(css, /\.questionnaire-option-single\s*\{\s*grid-template-columns:\s*2\.55rem minmax\(0, 1fr\)/, "single rows must separate number and label columns");
assert.match(css, /\.questionnaire-option-multi\s*\{\s*grid-template-columns:\s*2\.55rem 2rem minmax\(0, 1fr\)/, "multi rows must separate number, state, and label columns");
assert.match(css, /\.questionnaire-option-multi\.is-selected[\s\S]*?var\(--ctp-green\)/, "selected multi rows need a non-marker visual state");
assert.match(css, /\.questionnaire-action:focus-visible,[\s\S]*?outline:\s*3px solid/, "questionnaire actions need visible keyboard focus");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\)[\s\S]*?\.extension-dialog\.questionnaire-dialog[\s\S]*?width:\s*100vw[\s\S]*?\.questionnaire-dialog form \{[\s\S]*?2\.5rem[\s\S]*?\.questionnaire-dialog #dialogActions[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)[\s\S]*?env\(safe-area-inset-bottom\)/, "phone/coarse-pointer questionnaires must use a safe-area-aware one-column bottom sheet with content-box headroom");
assert.match(css, /\.questionnaire-options button\s*\{\s*min-height:\s*3\.35rem/, "mobile questionnaire targets must exceed the 44px floor");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\*, \*::before, \*::after[\s\S]*?transition-duration:\s*1ms !important/, "global reduced-motion rules must cover questionnaire transitions");

assert.match(html, /styles\.css\?v=154/, "questionnaire CSS needs the current stylesheet revision");
assert.match(html, /app\.js\?v=184/, "questionnaire behavior needs the current app revision");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "questionnaire public assets need a coherent PWA cache revision");

console.log("questionnaire-dialog.test.mjs passed");
