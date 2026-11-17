import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = await readFile(join(root, "public", "app.js"), "utf8");

const scheduleStart = app.indexOf("function scheduleSupervisorContinuityRefresh(");
const scheduleEnd = app.indexOf("\nfunction handleInactiveTabEvent(", scheduleStart);
const schedule = app.slice(scheduleStart, scheduleEnd);
const closeStart = app.indexOf("async function closeTerminalTabs(");
const closeEnd = app.indexOf("\nasync function closeTerminalTab(", closeStart);
const closeTabs = app.slice(closeStart, closeEnd);

assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart, "the continuity refresh scheduler should remain inspectable");
assert.ok(closeStart >= 0 && closeEnd > closeStart, "the terminal close lifecycle should remain inspectable");
assert.match(app, /const closingTerminalTabIds = new Set\(\)/, "the frontend should track tabs whose intentional shutdown is in progress");
assert.match(schedule, /closingTerminalTabIds\.has\(tabContext\.tabId\)/, "continuity refreshes should skip tabs that are intentionally closing");
assert.match(schedule, /if \(!isCurrentTabContext\(tabContext\) \|\| closingTerminalTabIds\.has\(tabContext\.tabId\)\) return;[\s\S]*continuity refresh failed/, "an in-flight refresh rejected by intentional shutdown should not produce a false error");
assert.match(closeTabs, /for \(const id of targetIds\) closingTerminalTabIds\.add\(id\);[\s\S]*finally \{\s*for \(const id of targetIds\) closingTerminalTabIds\.delete\(id\);/, "the close lifecycle should mark every target before the request and always clear the marker afterward");
assert.match(closeTabs, /addEvent\(`closed \$\{closedIds\.length \|\| targetTabs\.length\} \$\{closedIds\.length === 1 \? "thread" : "threads"\}`, "info"\)/, "successful terminal tab closure should be recorded as information rather than a warning");
assert.doesNotMatch(closeTabs, /addEvent\(`closed [^`]+`, "warn"\)/, "successful terminal tab closure should never be classified as a warning");

console.log("tab-close-continuity-static.test.mjs passed");
