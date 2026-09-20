import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, styles, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

// --- Approved stable catalog ------------------------------------------------

const catalog = [
  // Workspace toolbar
  ["workspace.save", "Save workspace", "#workspaceSaveButton"],
  ["workspace.command-palette", "Command palette", "#commandPaletteButton"],
  ["workspace.overview", "Show workspace overview", "#workspaceDashboardToggleButton"],
  ["workspace.close-all-tabs", "Close all tabs", "#closeAllTabsButton"],
  // Control Deck
  ["control-deck.sponsor", "Sponsor", ".sponsor-link"],
  ["control-deck.open-issue", "Open Issue", "#openIssueButton"],
  // Composer actions
  ["composer.new", "New", '[data-composer-action-id="new"]'],
  ["composer.compact", "Compact", '[data-composer-action-id="compact"]'],
  ["composer.guided-git", "Guided Git workflow", '[data-composer-action-id="git"]'],
  ["composer.publish", "AUR/npm release dropdown", '[data-composer-action-id="publish"]'],
  ["composer.tools-skills", "Tools/skills setup dropdown", '[data-composer-action-id="native-command"]'],
  ["composer.common-options", "Common options", '[data-composer-action-id="options"]'],
  ["composer.app-runner", "App runner", '[data-composer-action-id="app-runner"]'],
  ["composer.steer", "Steer", '[data-composer-action-id="steer"]'],
  ["composer.follow-up", "Follow-up", '[data-composer-action-id="follow-up"]'],
  ["composer.btw", "/btw side question", '[data-composer-action-id="btw"]'],
  // Prompt input-frame controls
  ["input.workflow", "Workflow controls", "#workflowModeControls"],
  ["input.attach-files", "Attach files", "#attachButton"],
  // Prompt input-frame tag types
  ["tag.prompt-behavior", "Follow-up/Steer busy-prompt behavior tag", "#busyPromptBehaviorTag"],
  ["tag.skills", "Session skill tags", "#sessionSkillTags"],
  ["tag.agent-conversations", "Intercom agent-conversation tags", "#intercomConversationTags"],
  ["tag.feature-category", "Feature-category tag", "#featureCategoryTag"],
  ["tag.voice-mode", "Natural-conversation/voice tag", "#conversationModeChip"],
  ["tag.workflow-mode", "Workflow-mode tag", "#workflowModeChip"],
];

const groupLabels = ["Workspace toolbar", "Control Deck", "Composer actions", "Input-frame controls", "Input-frame tags"];

for (const [id, label] of catalog) {
  assert.ok(app.includes(`id: "${id}",`), `registry should keep the stable ${id} key`);
  assert.ok(
    html.includes(`data-visibility-key="${id}"`),
    `the ${label} control should declare data-visibility-key="${id}" for direct hide targets`,
  );
}
for (const label of groupLabels) {
  assert.ok(app.includes(`"${label}"`), `the region menu should group entries under "${label}"`);
}

// --- Send exclusion ---------------------------------------------------------

assert.doesNotMatch(
  app,
  /composer\.send/,
  "Send must never be registered as a visibility toggle",
);
assert.doesNotMatch(
  html,
  /data-visibility-key="[^"]*send"/i,
  "the Send button must not carry a visibility key",
);
{
  const sendButtonMatch = html.match(/<button id="sendButton"[^>]*>/);
  assert.ok(sendButtonMatch, "the composer should keep a Send button");
  assert.doesNotMatch(sendButtonMatch[0], /data-visibility-key/, "the Send markup must stay unregistered");
}

// --- Durable schema and field ------------------------------------------------

assert.match(
  app,
  /const UI_LAYOUT_SCHEMA_VERSION = 3;/,
  "the browser controller should send schema version 3 with the control visibility field",
);
assert.match(
  app,
  /const UI_LAYOUT_FIELDS = \[[^\]]*"controlVisibility"[^\]]*\];/,
  "controlVisibility should travel through the revision-guarded interface-preferences writer",
);
assert.match(
  app,
  /case "controlVisibility":[\s{]*\n?\s*return \{ hiddenIds: readStoredControlVisibilityHiddenIds\(\) \};/,
  "collecting the durable field should read the bounded local hidden-id list",
);
assert.match(
  app,
  /function applyDurableControlVisibility\(value\)[\s\S]*writeDurableLayoutCache\(CONTROL_VISIBILITY_HIDDEN_IDS_STORAGE_KEY[\s\S]*applyControlVisibility\(\)/,
  "snapshot adoption should cache the hidden-key list and reapply it immediately",
);

// --- Class-based composition with runtime gating ------------------------------

assert.match(
  styles,
  /\.webui-user-hidden \{\s*display: none !important;\s*\}/,
  "preference hiding needs a dedicated webui-user-hidden class",
);
assert.match(
  app,
  /element\.classList\.toggle\("webui-user-hidden", shouldHide\)/,
  "showing a control only toggles the preference class instead of the hidden attribute",
);
assert.doesNotMatch(
  app.match(/function applyControlVisibility[\s\S]*?function persistControlVisibilityHiddenIds/)?.[0] || "",
  /\.hidden\s*=\s*[^)]/,
  "the visibility applier must not assign or clear runtime hidden state",
);

// --- Empty-region grouped menu and direct hide menu ---------------------------

assert.match(
  html,
  /<div id="visibilityContextMenu"[^>]*role="menu"[^>]*hidden>/,
  "the visibility recovery menu should be an initially empty menu container",
);
assert.match(
  app,
  /const CONTROL_VISIBILITY_GROUP_LABELS = \[[\s\:]*?\["workspace", "Workspace toolbar"\]/,
  "the catalog should label its host regions",
);
for (const region of ["workspace", "control-deck", "composer", "inputframe"]) {
  assert.ok(
    html.includes(`data-visibility-region="${region}"`),
    `the ${region} empty-area region should be marked in the markup`,
  );
}
assert.match(
  app,
  /button\.setAttribute\("role", "menuitemcheckbox"\)/,
  "the empty-region menu should expose menuitemcheckbox entries",
);
assert.match(
  app,
  /`Hide \$\{entry\.label\}`/,
  "direct targets should offer a Hide <label> action",
);
for (const action of ["show-all", "reset-defaults"]) {
  assert.ok(app.includes(`"${action}"`), `recovery action ${action} should exist`);
}
assert.match(
  app,
  /if \(action === "show-all"\)[\s\S]*showAllControls\(\)[\s\S]*else if \(action === "reset-defaults"\)[\s\S]*resetControlVisibilityDefaults\(\)/,
  "Show all and Reset defaults remain distinct actions",
);
assert.match(
  app,
  /function showAllControls\(\) \{\s*persistControlVisibilityHiddenIds\(\[\]\);/,
  "Show all should persist an explicit empty hidden-id list",
);
assert.match(
  app,
  /function resetControlVisibilityDefaults\(\) \{\s*persistControlVisibilityHiddenIds\(null\);/,
  "Reset defaults should clear the preference back to null",
);

// --- Specialized menu preservation --------------------------------------------

assert.match(
  app,
  /target\.closest\?\.\("button, input, textarea, select, \[contenteditable='true'\], a"\)/,
  "non-registered buttons, inputs, links, and editable contexts keep their native menu",
);
assert.match(
  app,
  /if \(target\.closest\?\.\("\.file-context-menu, dialog, \.composer-publish-menu-panel"\)\) return;[\s\S]*const direct/,
  "open submenus and specialized context menus stay untouched before ancestor registry lookup",
);

// --- Accessible keyboard and dismissal behavior --------------------------------

assert.match(
  app,
  /event\.key !== "ContextMenu" && !\(event\.shiftKey && event\.key === "F10"\)/,
  "Context Menu key and Shift+F10 should be keyboard-equivalent invocations",
);
assert.match(
  app,
  /addEventListener\("contextmenu", handleControlVisibilityContextMenu, \{ capture: true \}\)/,
  "registered target handling should preempt owners of specialized menus",
);
{
  const keydownBlock = app.match(/elements\.visibilityContextMenu\?\.addEventListener\("keydown", \(event\) => \{[\s\S]*?event\.key === "Home" \? 0 : items\.length - 1[\s\S]*?\}\);/)?.[0] || "";
  for (const key of ["Escape", "ArrowDown", "ArrowUp", "Home", "End"]) {
    assert.ok(keydownBlock.includes(`"${key}"`), `the menu should handle ${key}`);
  }
}
assert.match(
  app,
  /pointerdown[\s\S]*\.control-visibility-context-menu[\s\S]*closeVisibilityContextMenu\(\{ returnFocus: false \}\)/,
  "outside clicks should dismiss the menu",
);
assert.match(
  app,
  /window\.addEventListener\("resize", \(\) => closeVisibilityContextMenu/,
  "window resizing should dismiss the menu",
);
assert.match(
  app,
  /document\.addEventListener\("scroll",[\s\S]*closeVisibilityContextMenu\(\{ returnFocus: false \}\)/,
  "document scrolling should dismiss the menu after the invocation grace period",
);
assert.match(
  app,
  /function positionControlVisibilityMenu\(clientX, clientY\)[\s\S]*window\.innerWidth - rect\.width[\s\S]*window\.innerHeight - rect\.height/,
  "menu positioning should stay bounded inside the viewport",
);
assert.match(
  app,
  /wasHidden !== shouldHide && entry\.group === "composer"/,
  "composer reflow detection must compare prior and next state so un-hiding also restores saved slots",
);
assert.match(
  app,
  /if \(composerChanged\) scheduleComposerActionSlotLayoutRestore\(\)/,
  "composer action visibility changes should schedule a grid projection",
);
assert.match(
  app,
  /root\.classList\.contains\("webui-user-hidden"\)[\s\S]*repackComposerActionSlotLayout\(\{ persist: false \}\)/,
  "hidden composer actions should project a dense grid without overwriting saved slots",
);
assert.match(
  app,
  /event\.key === CONTROL_VISIBILITY_HIDDEN_IDS_STORAGE_KEY\) \{\s*\/\/ [\s\S]*durableLayoutDirtyFields\.get\("controlVisibility"\)[\s\S]*applyControlVisibility\(dirtyVisibility \? dirtyVisibility\.value\?\.hiddenIds : undefined\)/,
  "same-origin tabs should apply visibility cache updates immediately unless a local mutation is still pending",
);
assert.match(
  app,
  /durableLayoutDirtyFields\.delete\(field\);\s*if \(field === "controlVisibility"\) \{[\s\S]*writeDurableLayoutCache\(CONTROL_VISIBILITY_HIDDEN_IDS_STORAGE_KEY, JSON\.stringify\(entry\.value\?\.hiddenIds \?\? null\)\)[\s\S]*applyControlVisibility\(\)/,
  "a successful visibility PUT should rewrite the acknowledged value into the same-origin cache",
);
assert.match(
  styles,
  /\.side-panel-context-menu-item\[aria-checked="true"\]::before \{\s*content: "✓";/,
  "checked menu items should expose a visible check mark as well as aria-checked",
);

// --- Catalog-driven setup dialog -----------------------------------------------

assert.equal(catalog.length, 24, "the approved visibility catalog should contain 24 entries");
assert.equal(groupLabels.length, 5, "the setup should retain the five approved groups");
assert.match(
  html,
  /<dialog id="controlVisibilitySetupDialog"[^>]*aria-labelledby="controlVisibilitySetupDialogTitle"[^>]*aria-describedby="controlVisibilitySetupDescription"[\s\S]*?<div id="controlVisibilitySetupBody"[^>]*><\/div>[\s\S]*?<button id="controlVisibilitySetupCloseButton"[^>]*type="button">Close<\/button>/,
  "the setup should use a labelled native dialog with a generated body and explicit Close button",
);
assert.equal(
  app.match(/controlVisibilityMenuAction\("open-setup", "Open setup"\)/g)?.length,
  2,
  "both the direct and grouped visibility menus should offer Open setup",
);
assert.match(
  app,
  /function renderControlVisibilitySetupDialog\(\)[\s\S]*CONTROL_VISIBILITY_GROUP_LABELS\.map[\s\S]*CONTROL_VISIBILITY_CATALOG\.filter[\s\S]*checkbox\.dataset\.visibilitySetupId = entry\.id[\s\S]*body\.replaceChildren\(\.\.\.groups\)/,
  "the five setup groups and their checkboxes should be generated from the canonical catalog",
);
assert.match(
  app,
  /controlVisibilitySetupBody\?\.addEventListener\("change"[\s\S]*CONTROL_VISIBILITY_REGISTRY\.get\(checkbox\.dataset\.visibilitySetupId\)[\s\S]*setControlVisibilityHidden\(entry\.id, !checkbox\.checked\)/,
  "native setup checkbox changes should persist immediately through the existing setter",
);
assert.match(
  app,
  /function applyControlVisibility\(hiddenIdsOverride\)[\s\S]*refreshControlVisibilitySetupDialog\(\)/,
  "normal visibility application should synchronize an open setup dialog",
);
assert.match(
  app,
  /controlVisibilitySetupShowAllButton\?\.addEventListener\("click"[\s\S]*showAllControls\(\)[\s\S]*refreshControlVisibilitySetupDialog\(\)[\s\S]*controlVisibilitySetupResetButton\?\.addEventListener\("click"[\s\S]*resetControlVisibilityDefaults\(\)[\s\S]*refreshControlVisibilitySetupDialog\(\)/,
  "setup quick actions should retain the existing [] and null setters and refresh checkbox state",
);
assert.match(
  app,
  /if \(action === "open-setup"\) \{[\s\S]*closeVisibilityContextMenu\(\{ returnFocus: false \}\)[\s\S]*openControlVisibilitySetupDialog\(trigger\)/,
  "Open setup should transfer the context-menu trigger to the dialog without intermediate focus restoration",
);
{
  const restoreSetupFocus = app.match(/function restoreControlVisibilitySetupFocus\(\) \{[\s\S]*?^\}/m)?.[0] || "";
  assert.match(
    restoreSetupFocus,
    /trigger\.isConnected[\s\S]*!trigger\.closest\?\.\("\[hidden\], \.webui-user-hidden"\)[\s\S]*if \(triggerSurvives\) trigger\.focus[\s\S]*else elements\.promptInput\?\.focus/,
    "Close and Escape should restore a surviving opener or use the prompt fallback",
  );
}
assert.match(
  app,
  /controlVisibilitySetupDialog\?\.addEventListener\("close", restoreControlVisibilitySetupFocus\)/,
  "native dialog dismissal should share the setup focus-restoration path",
);
assert.match(
  styles,
  /\.control-visibility-setup-body \{[\s\S]*overflow: auto;[\s\S]*overscroll-behavior: contain;[\s\S]*@media \(max-width: 34rem\)[\s\S]*\.control-visibility-setup-grid \{ grid-template-columns: minmax\(0, 1fr\); \}[\s\S]*min-height: 44px;/,
  "the generated catalog should scroll independently and retain usable narrow-screen controls",
);
assert.doesNotMatch(
  app.match(/function renderControlVisibilitySetupDialog\(\)[\s\S]*?function refreshControlVisibilitySetupDialog/)?.[0] || "",
  /send/i,
  "the setup renderer should not introduce a Send-specific entry outside the catalog",
);

// --- Keyboard-only recovery from Send ------------------------------------------

assert.match(
  app,
  /const sendAnchor = entry \? null : target\.closest\?\.\("#sendButton"\);[\s\S]*if \(!entry && !sendAnchor && target\.closest\?\.\("button, input, textarea, select, \[contenteditable='true'\], a"\)\) return;/,
  "Context Menu/Shift+F10 on the permanently visible Send button should open the grouped recovery menu",
);
{
  const sendButtonMatch = html.match(/<button id="sendButton"[^>]*>/);
  assert.ok(sendButtonMatch, "the composer should keep a Send button");
  assert.match(
    sendButtonMatch[0],
    /aria-keyshortcuts="Alt\+ArrowLeft Alt\+ArrowRight Alt\+ArrowUp Alt\+ArrowDown ContextMenu Shift\+F10"/,
    "Send should expose the keyboard recovery shortcut to assistive technology",
  );
}
assert.match(
  app,
  /record\.id === "send"[\s\S]*"Alt\+ArrowLeft Alt\+ArrowRight Alt\+ArrowUp Alt\+ArrowDown ContextMenu Shift\+F10"/,
  "the runtime composer-action shortcut wiring should keep the Send recovery shortcut",
);

// --- Focus restoration --------------------------------------------------------

assert.match(
  app,
  /function closeVisibilityContextMenu\(\{ returnFocus = true \} = \{\}\)[\s\S]*triggerSurvives[\s\S]*elements\.promptInput\?\.focus/,
  "closing the menu should restore focus to a surviving trigger or the prompt input",
);
assert.match(
  app,
  /trigger\.matches\("button, a, input, select, textarea, \[tabindex\]"\)[\s\S]*\? trigger[\s\S]*: elements\.promptInput/,
  "non-focusable region hosts should fall back to the prompt as the focus-restoration trigger",
);

// --- Cache identity -----------------------------------------------------------

assert.match(
  serviceWorker,
  /const CACHE_NAME = "pi-webui-pwa-v155";/,
  "browser asset changes should advance the PWA cache identity",
);
assert.match(html, /styles\.css\?v=154/, "visibility styles should advance the stylesheet query revision");
assert.match(html, /data-app-src="\/app\.js\?v=184"/, "visibility behavior should advance the app query revision");

console.log("control-visibility-static.test.mjs passed");
