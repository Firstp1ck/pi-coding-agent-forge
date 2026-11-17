import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const predicateSource = app.match(/function shouldRenderTerminalTabGroup\(group, groupCount\) \{([\s\S]*?)\n\}/)?.[1];
assert.ok(predicateSource, "terminal CWD grouping predicate should be present");

const shouldRenderTerminalTabGroup = new Function("group", "groupCount", predicateSource);
assert.equal(shouldRenderTerminalTabGroup({ custom: false, cwd: "/repo/one", tabs: [{}] }, 2), false, "a one-tab CWD should remain a normal tab instead of duplicating itself in a group dropdown");
assert.equal(shouldRenderTerminalTabGroup({ custom: false, cwd: "/repo/one", tabs: [{}, {}] }, 2), true, "a multi-tab CWD should retain its group dropdown");
assert.equal(shouldRenderTerminalTabGroup({ custom: false, cwd: "", tabs: [{}, {}] }, 2), false, "tabs without a CWD should remain ungrouped");
assert.equal(shouldRenderTerminalTabGroup({ custom: true, cwd: "", tabs: [{}] }, 2), false, "a one-tab custom group should remain ungrouped");
assert.equal(shouldRenderTerminalTabGroup({ custom: true, cwd: "", tabs: [{}, {}] }, 1), true, "multi-tab custom groups should retain their existing behavior");

assert.match(app, /function createTerminalTabCwdAddMenu\(tab\)[\s\S]*make\("div", "terminal-tab-cwd-add-menu"\)[\s\S]*make\("button", "terminal-tab-group-add terminal-tab-cwd-add", "\+ Thread"\)[\s\S]*createTerminalTab\(tab\.cwd \|\| currentDirectoryForNewTab\(\)/, "a singleton CWD should receive a below-tab + Thread menu using its directory");
assert.match(app, /const showCwdAdd = groups\.length > 1 && group\.tabs\.length === 1 && Boolean\(group\.cwd\);[\s\S]*renderTerminalTab\(tab, \{ showCwdAdd \}\)/, "the direct + Thread action should appear only for singleton CWDs when multiple CWD groups are open");
assert.match(app, /function renderTerminalTab\(tab, \{ showCwdAdd = false \} = \{\}\)[\s\S]*terminal-tab-cwd-add-host[\s\S]*if \(showCwdAdd\) wrapper\.append\(createTerminalTabCwdAddMenu\(tab\)\)/, "singleton CWDs should stay on the regular tab rendering path with a separate add-only menu");
assert.match(styles, /\.terminal-tab-cwd-add-menu \{[\s\S]*position:\s*absolute;[\s\S]*inset:\s*100% 0 auto 0;[\s\S]*display:\s*none;/, "the singleton + Tab menu should sit hidden directly below its tab");
assert.match(styles, /\.terminal-tab-cwd-add-host:hover \.terminal-tab-cwd-add-menu,\n\.terminal-tab-cwd-add-host:focus-within \.terminal-tab-cwd-add-menu \{\n\s+display:\s*flex;/, "hover or keyboard focus should reveal the singleton + Tab menu");

console.log("terminal-cwd-grouping-static.test.mjs passed");
