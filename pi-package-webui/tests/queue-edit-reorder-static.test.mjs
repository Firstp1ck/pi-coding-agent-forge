import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeQueuedMessages, queueMutationBody, preservedFocusedFollowUpQueueDraft, createActivityQueueController } from "../public/activity-queue-controller.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, css, app, queue] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "activity-queue-controller.mjs"), "utf8"),
]);

assert.match(
  html,
  /id="followUpQueueTrigger"[^>]*aria-controls="followUpQueueOverlay"[^>]*aria-expanded="false"[\s\S]*id="followUpQueueTriggerCount"[\s\S]*id="followUpQueueOverlay"[^>]*aria-label="Queued follow-ups"[\s\S]*id="followUpQueueRows"[\s\S]*id="followUpQueueStatus"[^>]*role="status"[^>]*aria-live="polite"/,
  "the composer should expose a count trigger and accessible non-modal follow-up queue overlay",
);
assert.match(css, /\.follow-up-queue-overlay \{[\s\S]*position:\s*absolute;[\s\S]*bottom:\s*calc\(100% \+ 0\.42rem\);[\s\S]*max-height:\s*min\(32rem, calc\(var\(--visual-viewport-height, 100dvh\) - 2rem\)\)/, "the queue overlay should float upward without changing composer layout and be bounded by the visual viewport");
assert.match(css, /\.composer:has\(\.follow-up-queue-overlay:not\(\[hidden\]\)\) \{\s*z-index:\s*80;\s*\}/, "an open queue should raise the composer stacking context above transcript copy buttons and normal interface controls");
assert.match(css, /\.follow-up-queue-trigger \{[\s\S]*justify-content:\s*center;[\s\S]*min-width:\s*5\.25rem;/, "the queue trigger should reserve a predictable width for its label and three-digit count");
assert.match(css, /body:not\(\.mobile-keyboard-open\) \.composer-input-row:has\(\.composer-workflow-mode-dock:not\(\[hidden\]\)\) \.follow-up-queue-trigger \{\s*right:\s*calc\(3\.55rem \+ 2\.25rem \+ 0\.4rem\);\s*\}/, "the queue trigger should move left of the visible Workflow control instead of overlapping it");
assert.match(css, /\.composer-input-row:has\(\.follow-up-queue-trigger:not\(\[hidden\]\)\) \.composer-context-tags \{\s*max-width:\s*max\(0px, calc\(100% - 9\.7rem\)\);\s*\}/, "visible queues should reserve prompt-frame space so feature and context tags cannot overlap the queue trigger");
assert.match(css, /body:not\(\.mobile-keyboard-open\) \.composer-input-row:has\(\.composer-workflow-mode-dock:not\(\[hidden\]\)\):has\(\.follow-up-queue-trigger:not\(\[hidden\]\)\) \.composer-context-tags \{\s*max-width:\s*max\(0px, calc\(100% - 12\.6rem\)\);\s*\}/, "context tags should reserve the combined Workflow and queue dock width");
assert.match(css, /body\.mobile-keyboard-open \.follow-up-queue-trigger:not\(\[hidden\]\) \{ display: inline-flex; \}/, "the queue trigger should remain usable while the mobile keyboard is open");
assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.follow-up-queue-overlay,[\s\S]*\.follow-up-queue-row \{ transition: none; \}/, "the queue overlay should suppress motion for reduced-motion users");

const compactionSnapshot = normalizeQueuedMessages({ source: "webui-compaction", revision: 7, draining: true, steering: ["steer"], followUp: ["first", "second"] });
assert.deepEqual(compactionSnapshot, {
  source: "webui-compaction",
  revision: 7,
  draining: true,
  steering: ["steer"],
  followUp: ["first", "second"],
}, "frontend queue normalization should retain compaction source, revision, draining state, and both queue arrays");

const compactionMutation = queueMutationBody({ source: "webui-compaction", revision: 3, steering: ["steer"], followUp: ["one", "two"] }, { type: "move", from: 1, to: 0, expectedText: "two" });
assert.deepEqual(compactionMutation, {
  source: "webui-compaction",
  kind: "followUp",
  revision: 3,
  expected: { steering: ["steer"], followUp: ["one", "two"] },
  operation: { type: "move", from: 1, to: 0, expectedText: "two" },
}, "compaction moves should use the B1 source-aware, revisioned full-snapshot mutation contract");
const runtimeMutation = queueMutationBody({ source: "pi-runtime", steering: [], followUp: ["old"] }, { type: "edit", index: 0, expectedText: "old", text: "new" });
assert.equal(Object.hasOwn(runtimeMutation, "revision"), false, "Pi-runtime mutations must omit the compaction-only revision field");
assert.deepEqual(runtimeMutation.expected, { steering: [], followUp: ["old"] }, "Pi-runtime mutations should send the complete B1 expected snapshot");
const deleteMutation = queueMutationBody({ source: "webui-compaction", revision: 4, steering: ["steer"], followUp: ["remove me"] }, { type: "delete", index: 0, expectedText: "remove me" });
assert.deepEqual(deleteMutation.operation, { type: "delete", index: 0, expectedText: "remove me" }, "queue deletion should use the same source-aware full-snapshot mutation contract");

const draftDecisions = {
  preserve: preservedFocusedFollowUpQueueDraft({ index: 1, authoritativeText: "second", value: "unsaved second", selectionStart: 3, selectionEnd: 10 }, ["first", "second"]),
  targetChanged: preservedFocusedFollowUpQueueDraft({ index: 1, authoritativeText: "second", value: "unsaved second", selectionStart: 3, selectionEnd: 10 }, ["first", "server replacement"]),
  indexChanged: preservedFocusedFollowUpQueueDraft({ index: 1, authoritativeText: "second", value: "unsaved second" }, ["second", "first"]),
  clean: preservedFocusedFollowUpQueueDraft({ index: 1, authoritativeText: "second", value: "second" }, ["first", "second"]),
};
assert.deepEqual(draftDecisions.preserve, { index: 1, value: "unsaved second", selectionStart: 3, selectionEnd: 10 }, "an SSE queue update should preserve the focused dirty draft only when its same authoritative item remains at its index");
assert.equal(draftDecisions.targetChanged, null, "an authoritative replacement at the focused index must discard the old draft instead of carrying it across a conflict");
assert.equal(draftDecisions.indexChanged, null, "a reordered target must not retain a dirty draft at the old index");
assert.equal(draftDecisions.clean, null, "unchanged focused text should not be treated as a dirty draft");

// Exercise the actual owner with late responses across navigation and replacement.
for (const state of ["returned", "background", "closed", "replaced"]) {
  let foreground = "A", generation = 1, lifetime = 1, live = true, resolve;
  const cache = new Map([["A", normalizeQueuedMessages({ followUp: ["old"] })]]);
  const target = (tabId = foreground) => ({ tabId, generation, lifetime });
  const alive = context => live && context.lifetime === lifetime;
  const painted = [];
  const owner = createActivityQueueController({
    document: { defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame() {} } }, nodes: {},
    api: () => new Promise(done => { resolve = done; }), getContext: target,
    isAlive: alive, isCurrent: context => context.tabId === foreground && context.generation === generation,
    getSnapshot: id => cache.get(id), setSnapshot: (id, snapshot) => cache.set(id, snapshot),
    onProjectionChange: () => painted.push(foreground),
  });
  const pending = owner.mutate({ type: "edit", index: 0, expectedText: "old", text: "new" });
  foreground = "B"; generation++;
  if (state === "returned") { foreground = "A"; generation++; }
  if (state === "closed") live = false;
  if (state === "replaced") lifetime++;
  resolve({ data: { mutated: true, queue: { followUp: ["new"] } } });
  await pending;
  assert.equal(cache.get("A").followUp[0], ["closed", "replaced"].includes(state) ? "old" : "new", state);
  assert.deepEqual(painted, state === "returned" ? ["A"] : [], state);
  owner.dispose();
}

assert.match(app, /createActivityQueueController\(\{[\s\S]*isCurrent: isCurrentProjectTarget,[\s\S]*isAlive: isAliveProjectTarget,[\s\S]*setSnapshot: \(tabId, snapshot\) => latestQueuedMessagesByTab\.set/, "the app must supply real lifetime guards and its single queue cache");
assert.match(queue, /api\("\/api\/queue\/mutate", \{ method: "POST", body: queueMutationBody\(snapshot, operation\), tabId: context\.tabId \}\)[\s\S]*if \(!alive\(context\)\) return false;[\s\S]*error\?\.statusCode === 409[\s\S]*refreshed the authoritative queue/, "mutations retain exact origin, lifetime checks and conflict refresh");
assert.match(queue, /function ingest\(event\)[\s\S]*setSnapshot\(context\.tabId, normalizeQueuedMessages\(event\)\)[\s\S]*if \(current\(context\)\) render\(\)/, "ingestion caches before foreground rendering");
assert.match(queue, /control\.disabled = locked \|\| draining/, "in-flight and draining states lock mutation controls");
assert.match(queue, /textarea\.dataset\.followUpQueueAuthoritativeText = item[\s\S]*textarea === suppressBlurFor[\s\S]*saveText\(index, item, textarea\.value, context\)[\s\S]*event\.ctrlKey \|\| event\.metaKey[\s\S]*textarea\.value = item/, "edits retain dirty drafts and keyboard save/cancel");
assert.match(queue, /row\.draggable = false;[\s\S]*dragHandle\.draggable = !unavailable;[\s\S]*application\/x-pi-webui-follow-up[\s\S]*type: "move", from: source\.index, to: index/, "dragging uses handles and final indexes");
assert.match(app, /function handleComposerDragOver\(event\) \{\n\s*if \(event\.target\?\.closest\?\.\("#followUpQueueOverlay"\) \|\| !isFileDrag\(event\)\) return;[\s\S]*function handleComposerDrop\(event\) \{\n\s*if \(event\.target\?\.closest\?\.\("#followUpQueueOverlay"\) \|\| !isFileDrag\(event\)\) return;/, "attachment drops ignore queue drags");
assert.match(queue, /Moved queued follow-up[\s\S]*Move queued follow-up \$\{index \+ 1\} up[\s\S]*Move queued follow-up \$\{index \+ 1\} down/, "move controls retain accessible announcements and keyboard/touch actions");
assert.match(queue, /follow-up-queue-remove-button[\s\S]*remove\(index, item, context\)/, "overlay rows retain removal");
assert.match(css, /\.follow-up-queue-remove-button \{[\s\S]*color:\s*var\(--ctp-red\)/, "queue removal should have a distinct destructive visual treatment");
assert.match(app, /setFollowUpQueueOpen\(false, \{ restoreFocus: true \}\)/, "outside close and Escape should request queue-focus restoration");
assert.match(queue, /restoreFocusTarget[\s\S]*target\?\.focus\(\{ preventScroll: true \}\)/, "closing restores captured focus");
assert.match(app, /onBeforeOpen\(\) \{[\s\S]*setComposerActionsOpen\(false\)[\s\S]*setPublishMenuOpen\(false\)[\s\S]*setNativeCommandMenuOpen\(false\)[\s\S]*setAppRunnerMenuOpen\(false\)[\s\S]*setOptionsMenuOpen\(false\)[\s\S]*setConversationVoiceMenuOpen\(false\)[\s\S]*setBusyPromptBehaviorMenuOpen\(false\)[\s\S]*setNewTabMenuOpen\(false\)/, "opening closes competing dropdown surfaces");
assert.match(queue, /defer\("follow-up-queue", renderOverlay\)/, "queue rendering defers during pointer activation");
assert.match(app, /function switchTab\(tabId\)[\s\S]*setFollowUpQueueOpen\(false\)[\s\S]*activityQueue\.setStatus\(""\)/, "tab switching closes and clears queue UI");
assert.match(queue, /renderQueueGroup\("Follow-up", followUp, "follow-up", \{ removable: !snapshot\.draining, context \}\)/, "deck removal supports every mutable source");
assert.doesNotMatch(app, /nextQueuedFollowUpPrompt|sticky-user-follow-up-prompt|Next follow-up prompt:/, "the sticky last/current prompt control must no longer expose queued follow-up preview content");

console.log("queue edit/reorder static tests passed");
