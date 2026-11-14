import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = await readFile(join(root, "public", "app.js"), "utf8");

function selectorBody() {
  const start = app.indexOf("async function openNativeAppendSystemSelector()");
  assert.ok(start > 0, "openNativeAppendSystemSelector should exist in public/app.js");
  const end = app.indexOf("async function confirmAppendSystemRestart", start);
  assert.ok(end > start, "confirmAppendSystemRestart should follow the selector");
  return app.slice(start, end);
}

const selector = selectorBody();

assert.match(
  selector,
  /renderNativeSelectorItems\(items, \{[\s\S]*?emptyText: "No APPEND_SYSTEM\.md files match this filter\.",[\s\S]*?activeId:[\s\S]*?onSelect: async \(item\) => \{/,
  "the append-system selector must reuse renderNativeSelectorItems with an active id and onSelect",
);
assert.match(
  selector,
  /elements\.nativeCommandSearch\.oninput = render;\s*\n\s*render\(\);/,
  "the append-system selector should filter through the shared search input",
);
assert.match(selector, /const dialogGeneration = openNativeCommandDialog\(\{[\s\S]*?title: "\/append-system"/, "the selector should use and own the shared native command dialog");
assert.match(selector, /const ownsNativeCommandDialog = \(\) => dialogGeneration === nativeCommandDialogGeneration && elements\.nativeCommandDialog\.open;/, "the selector should detect when a newer dialog or close event supersedes its async work");
assert.match(selector, /let saveInFlight = false;/, "the selector should track one in-flight settings mutation");
assert.match(selector, /searchPlaceholder: "Filter APPEND_SYSTEM\.md files…"/, "the selector should expose the shared filter box");
assert.match(selector, /renderNativeLoading\("Scanning APPEND_SYSTEM\.md candidates…"\)/, "the selector should show a busy state while scanning");
assert.match(selector, /const tabId = nativeCommandTabId \|\| activeTabId;/, "the selector should target the dialog's Pi tab");

assert.match(
  selector,
  /nativeCommandApi\("\/api\/append-system-files"\);\s*\n\s*if \(!ownsNativeCommandDialog\(\)\) return;/,
  "the selector should load scoped candidates and ignore a response after its dialog is superseded",
);
assert.match(
  selector,
  /nativeCommandApi\("\/api\/append-system-selection", \{\s*\n\s*method: "POST",\s*\n\s*body: \{ tabId, path: item\.appendSystemPath \?\? null \},\s*\n\s*\}\)/,
  "the selector should save through POST /api/append-system-selection with { tabId, path }",
);
assert.match(selector, /if \(!ownsNativeCommandDialog\(\) \|\| saveInFlight\) return;\s*\n\s*saveInFlight = true;/, "rapid pointer or Enter activation must not start a second save");
assert.match(selector, /elements\.nativeCommandSearch\.disabled = true;\s*\n\s*for \(const button of nativeSelectorItemButtons\(\)\) button\.disabled = true;/, "saving should disable filtering and every enabled selector item");
assert.match(selector, /body: \{ tabId, path: item\.appendSystemPath \?\? null \},[\s\S]*?if \(!ownsNativeCommandDialog\(\)\) return;[\s\S]*?const result = response\.data \|\| \{\};/, "a completed save must not update or restart after another native dialog supersedes it");
assert.match(selector, /catch \(error\) \{\s*\n\s*if \(!ownsNativeCommandDialog\(\)\) return;/, "a stale scan failure must not overwrite a newer native dialog");
assert.match(selector, /saveInFlight = false;\s*\n\s*elements\.nativeCommandSearch\.disabled = false;\s*\n\s*render\(\);\s*\n\s*setNativeCommandError/, "an owned save failure should restore selector interaction before showing the error");
assert.match(app, /elements\.nativeCommandSearch\.disabled = false;\s*\n\s*elements\.nativeCommandSearch\.oninput = null;/, "opening a newer native dialog should always restore its search control");
assert.match(selector, /const savedPath = typeof data\.appendSystemPromptPath === "string"/, "the selector should read the saved override from appendSystemPromptPath");
assert.match(selector, /const candidates = Array\.isArray\(data\.candidates\) \? data\.candidates : \[\];/, "the selector should read the bounded candidates list");
assert.match(selector, /const diagnostics = Array\.isArray\(data\.diagnostics\) \? data\.diagnostics : \[\];/, "the selector should read bounded scan diagnostics");
assert.match(selector, /const savedIsInvalid = !!savedPath && diagnostics\.some\([\s\S]*?saved-selection-invalid[\s\S]*?diagnostic\?\.path === savedPath\);/, "provenance-invalid saved paths must not be treated as effective candidates");
assert.match(selector, /savedIsCandidate && candidate\.path === savedPath \? "current" : ""/, "only a provenance-valid saved candidate may be marked as current");
assert.match(selector, /badge: savedIsCandidate \? "" : "current"/, "Pi default discovery is current when no valid override is saved");

assert.match(selector, /label: "Use Pi default discovery"/, "the rollback choice must be present");
assert.equal((selector.match(/label: "Use Pi default discovery"/g) || []).length, 1, "the rollback/default row must be rendered exactly once");
assert.match(selector, /label: candidate\.path,/, "each candidate must show its complete visible alias path");
assert.match(selector, /description: `Visible path[\s\S]*?linked targets may be outside that root\.`/, "candidate wording must preserve visible aliases and warn about out-of-root link targets");
assert.doesNotMatch(selector, /Complete canonical path/, "followed aliases must not be mislabeled as canonical paths");
assert.match(selector, /badge: "invalid",\s*\n\s*badgeClass: "disabled",\s*\n\s*disabled: true/, "an invalid saved path must stay visible, use warning styling, and not be selectable");
assert.match(app, /badgeState === "disabled" \|\| String\(item\.badgeClass \|\| ""\)\.includes\("disabled"\)[\s\S]*?badge\.style\.color = "#ff9f43"/, "disabled badge classes must receive warning styling");
assert.match(selector, /saved choice is no longer a valid APPEND_SYSTEM\.md candidate/i, "an invalid saved path must explain the fallback");

assert.match(selector, /diagnostics\.slice\(0, 20\)/, "diagnostics must stay bounded in the UI");
assert.match(selector, /\[diagnostic\?\.kind, diagnostic\?\.path, diagnostic\?\.message\]/, "diagnostics must show kind, path, and message only");
assert.doesNotMatch(selector, /\/api\/file|\/api\/workspace-file|fileContents|contentText/, "the selector must never fetch prompt file contents");

assert.match(selector, /result\.changed === true && result\.restartRequired === true\) await confirmAppendSystemRestart\(tabId\);/, "restart may only be offered after a changed save with restartRequired");
assert.doesNotMatch(selector, /sendPrompt\("prompt", "\/reload"/, "the selector body must not reload the tab directly");

const restartBody = app.slice(app.indexOf("async function confirmAppendSystemRestart"));
assert.match(restartBody, /appConfirmText\([\s\S]*?confirmLabel: "Restart tab"/, "restart must be gated behind an explicit confirmation");
assert.match(restartBody, /if \(!confirmed\) return;/, "cancelling the confirmation must not restart the tab");
assert.match(restartBody, /sendPrompt\("prompt", "\/reload", \{ targetTabId: tabId, throwOnError: true \}\)/, "confirmed restart must reuse the standard active-tab reload path");
assert.match(restartBody, /Append-system tab restart failed:/, "reload errors must remain visible in the events log");
assert.match(restartBody, /Cancel keeps it for the next manual reload or new tab/, "cancellation must be described as keeping the saved choice");

assert.match(
  app,
  /\{ id: "native:append-system", scope: "server", destination: "settings", kind: "Pi", label: "\/append-system", description: "Choose the APPEND_SYSTEM\.md append prompt", keywords: "append system prompt settings global", run: \(\) => openNativeAppendSystemSelector\(\) \},/,
  "the command palette must expose the append-system selector",
);

assert.match(selector, /one global APPEND_SYSTEM\.md append prompt for WebUI-managed Pi tabs/i, "the dialog must label the choice as a global WebUI setting");
assert.match(selector, /bounded scan uses the active tab folder and ~\/\.pi up to depth 10/i, "the dialog must describe the bounded scan roots and depth");
assert.match(selector, /follows file and folder links even outside those roots/i, "the dialog must warn that followed links can leave the visible roots");
assert.match(selector, /never shows file contents/i, "the dialog must promise no prompt content exposure");

assert.match(selector, /setNativeCommandError\(`Append-system scan failed: \$\{error\.message \|\| String\(error\)\}`\)/, "a rejected scan route must surface a clear dialog error");

console.log("append-system selector static tests passed");
