import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, server] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
]);

const start = app.indexOf("function threadDisplayTitle(");
const end = app.indexOf("\nfunction tabIndicator(", start);
assert.ok(start >= 0 && end > start, "threadDisplayTitle should remain a standalone frontend helper");
const threadDisplayTitle = vm.runInNewContext(`${app.slice(start, end)}\nthreadDisplayTitle;`);

assert.equal(threadDisplayTitle("Terminal 1"), "Thread 1", "legacy default titles should display as threads");
assert.equal(threadDisplayTitle("Terminal 42"), "Thread 42", "multi-digit legacy default titles should keep their number");
assert.equal(threadDisplayTitle("Thread 3"), "Thread 3", "current default titles should pass through");
assert.equal(threadDisplayTitle("Terminal 1 fork"), "Terminal 1 fork", "custom titles that only start like a default should stay unchanged");
assert.equal(threadDisplayTitle("My Terminal 2"), "My Terminal 2", "custom titles that end like a default should stay unchanged");
assert.equal(threadDisplayTitle("terminal 2"), "terminal 2", "only the exact legacy default spelling should be relabelled");
assert.equal(threadDisplayTitle("Terminal "), "Terminal ", "a legacy prefix without a number should stay unchanged");
assert.equal(threadDisplayTitle(""), "", "empty titles should stay empty so callers can apply their fallback");
assert.equal(threadDisplayTitle(undefined), "", "missing titles should produce an empty label");
assert.equal(threadDisplayTitle(7), "", "non-string titles should produce an empty label");

assert.match(server, /function defaultTabTitle\(tabIndex\) \{\n\s+if \(options\.name\) return tabIndex === 1 \? options\.name : `\$\{options\.name\} \$\{tabIndex\}`;\n\s+return `Thread \$\{tabIndex\}`;\n\}/, "new default conversation titles should be Thread N while the --name override stays unchanged");

for (const [label, pattern] of [
  ["sidebar tab button", /appendTerminalTabContent\(button, \{ title: threadDisplayTitle\(tab\.title\),/],
  ["document title", /document\.title = tab \? `Pi Web UI · \$\{threadDisplayTitle\(tab\.title\)\}`/],
  ["command palette thread rows", /`Current thread: \$\{threadDisplayTitle\(tab\.title\)\}` : `Switch to thread: \$\{threadDisplayTitle\(tab\.title\)\}`/],
  ["focused shell header", /title: threadDisplayTitle\(active\?\.title\) \|\| "Start a conversation"/],
  ["All tools context label", /contextLabel: threadDisplayTitle\(activeTab\(\)\?\.title\) \|\| "No active session"/],
  ["subagent view parent meta", /parent \$\{threadDisplayTitle\(parent\?\.title \|\| view\.parentTitle\) \|\| "thread"\}/],
  ["subagent parent group", /make\("strong", undefined, threadDisplayTitle\(tab\.tabTitle\) \|\| `Thread \$\{tab\.tabIndex \|\| "\?"\}`\)/],
]) {
  assert.match(app, pattern, `${label} should display legacy default titles through threadDisplayTitle`);
}
assert.doesNotMatch(app, /\btab\.title = threadDisplayTitle/, "display relabelling must not rewrite stored tab titles");

console.log("thread display title tests passed");
