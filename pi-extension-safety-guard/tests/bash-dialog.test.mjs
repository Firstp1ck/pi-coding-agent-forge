import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { operationRule } from "../src/approvals.ts";
import { BASH_CHOICES, GLOBAL_OPERATION_WARNING, bashSelectionHint, bashSelectionSummary, buildBashPrompt, formatBashPrompt } from "../src/bash-prompt.ts";
import { showBashPrompt } from "../src/bash-dialog.ts";

const theme = {
  fg: (tone, value) => `\x1b[${{ accent: 36, warning: 33, success: 32, muted: 90, dim: 90, text: 37 }[tone]}m${value}\x1b[39m`,
  bold: (value) => `\x1b[1m${value}\x1b[22m`,
};
const command = "git switch main > /tmp/guard-preview.log";
const fallback = () => buildBashPrompt(command, [{ text: command, risks: ["git switch"], approved: false }], "Reusable operation analysis unavailable", "", [
  { reason: "git switch", range: { start: 0, end: "git switch".length } },
]);

function tuiContext(run, { rows = 50, signal } = {}) {
  return {
    mode: "tui", signal,
    ui: {
      select: () => assert.fail("TUI should use the styled dialog"),
      custom: async (factory) => new Promise((resolve, reject) => {
        const component = factory({ terminal: { rows }, requestRender() {} }, theme, getKeybindings(), resolve);
        try { run(component); } catch (error) { reject(error); }
      }),
    },
  };
}

const plain = (component, width) => component.render(width).map(stripVTControlCharacters).join("\n");

test("pattern fallback is compact, does not duplicate input or explain unavailable scopes", () => {
  const prompt = fallback();
  assert.equal(prompt.message.split(JSON.stringify(command)).length - 1, 1);
  assert.ok(prompt.message.length < 800, prompt.message);
  assert.ok(!prompt.message.includes("\n\n\n"));
  assert.ok(!prompt.message.includes("Exact operations"));
  assert.ok(!prompt.message.includes("Risk excerpts"));
  assert.match(prompt.message, /Whole-command approval required/);
  assert.match(prompt.message, /Operation reuse is unavailable/);
  assert.ok(!prompt.sections.some((section) => section.label === "Permissions"));
  const summary = bashSelectionSummary(prompt.choices);
  assert.match(summary, /save nothing/);
  assert.equal(summary, "Block/once save nothing.");
  assert.deepEqual([...prompt.choices.keys()], [BASH_CHOICES.once]);
});

test("operation-only choices use compact exact wording without listed or whole-command variants", () => {
  const command = "git restore -h";
  const prompt = buildBashPrompt(command, [{ text: command, risks: ["git restore"], approved: false }]);
  assert.deepEqual(["Block", ...prompt.choices.keys()], [
    "Block", "Allow once", "Allow the command for the current session",
    "Always allow the command in the current directory", "Always allow the command EVERYWHERE",
  ]);
  assert.ok(Object.values(BASH_CHOICES).every((label) => !/listed|exact command/.test(label)));
});

test("styled text highlights headings and risk states without changing the plain content", () => {
  const prompt = buildBashPrompt("git switch main && echo ok", [
    { text: "git switch main", risks: ["git switch"], approved: true },
    { text: "echo ok", risks: [], approved: false },
  ]);
  const styled = formatBashPrompt(prompt, theme);
  assert.equal(stripVTControlCharacters(styled), prompt.message);
  assert.ok(styled.includes(theme.fg("accent", theme.bold("Command"))));
  assert.ok(styled.includes(theme.fg("success", theme.bold("ALREADY APPROVED"))));
  assert.ok(styled.includes(theme.fg("muted", theme.bold("NO MATCHED RISK"))));
  assert.ok(formatBashPrompt(fallback(), theme).includes(theme.fg("warning", theme.bold("NEEDS APPROVAL"))));
});

test("full input, repeated operations, scope limits and type descriptions remain available", () => {
  const text = "git switch -c one";
  const operation = { text, risks: ["git switch"], approved: false, rule: operationRule(["git", "switch", "-c", "one"]) };
  const prompt = buildBashPrompt(`${text} && ${text}`, [operation, operation]);
  assert.match(prompt.message, /1\. NEEDS APPROVAL.*git switch/);
  assert.match(prompt.message, /2\. NEEDS APPROVAL.*git switch/);
  const hint = bashSelectionHint(prompt.choices.get(BASH_CHOICES.operationSession));
  assert.match(hint, /later supported chains/);
  assert.match(hint, /Same program and arguments/);
  assert.match(hint, /existing grants unchanged/);
  assert.match(prompt.message, /Broader operation types/);
  assert.match(prompt.message, /any branch name/);
  assert.match(prompt.message, /no extra flags or start point/);
  assert.deepEqual([...prompt.choices.keys()], Object.values(BASH_CHOICES));
});

test("oversized previews remain explicit and never offer remembered permissions", () => {
  const prompt = buildBashPrompt("x".repeat(20_000), [], "Unverified");
  assert.match(prompt.message, /^Preview truncated/);
  assert.ok(prompt.message.length < 13_000);
  assert.deepEqual([...prompt.choices.keys()], [BASH_CHOICES.once]);
});

test("TUI wraps at narrow widths, limits wide lines and defaults to Block", async () => {
  const result = await showBashPrompt(tuiContext((component) => {
    for (const width of [20, 40, 80, 100, 240]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= Math.min(width, 100)), `width ${width}`);
    }
    const text = plain(component, 100);
    assert.match(text, /Whole-command approval required/);
    assert.match(text, />>> git switch <<</);
    assert.ok(!text.includes("Permissions"));
    assert.match(text, /Cancel the entire command; save nothing/);
    assert.match(text, /→ Block/);
    component.invalidate();
    assert.equal(plain(component, 100), text);
    component.handleInput("\r");
  }), fallback());
  assert.equal(result, "Block");
});

test("selection guidance follows the highlighted option and stays next to the list", async () => {
  const text = "git switch -c one";
  const prompt = buildBashPrompt(text, [{ text, risks: ["git switch"], approved: false, rule: operationRule(["git", "switch", "-c", "one"]) }]);
  await showBashPrompt(tuiContext((component) => {
    const options = ["Block", ...prompt.choices.keys()];
    for (const selected of options) {
      const frame = plain(component, 100);
      const hint = bashSelectionHint(prompt.choices.get(selected));
      const collapsed = frame.replace(/\s+/g, " ");
      assert.ok(collapsed.includes(hint), selected);
      assert.ok(!frame.includes("Permissions"));
      assert.ok(frame.indexOf(hint.split(" ").slice(0, 3).join(" ")) > frame.indexOf("→ "), selected);
      if (selected === BASH_CHOICES.operationEverywhere) {
        assert.ok(collapsed.includes(GLOBAL_OPERATION_WARNING));
        assert.ok(!hint.includes("Same cwd"));
      } else if (prompt.choices.get(selected)?.lifetime) assert.match(collapsed, /Same cwd; skip future prompts\/model review/);
      component.handleInput("\x1b[B");
    }
    component.handleInput("\x1b");
  }), prompt);
});

test("EVERYWHERE appears next to local exact operations with an unavoidable selected warning", async () => {
  assert.equal(BASH_CHOICES.operationEverywhere, "Always allow the command EVERYWHERE");
  const command = "rm -rf ./build";
  const prompt = buildBashPrompt(command, [{ text: command, risks: ["recursive rm"], approved: false }]);
  const options = ["Block", ...prompt.choices.keys()];
  const index = options.indexOf(BASH_CHOICES.operationEverywhere);
  assert.equal(index, options.indexOf(BASH_CHOICES.operationPermanent) + 1);
  assert.deepEqual(prompt.choices.get(BASH_CHOICES.operationEverywhere), { scope: "operation-global", lifetime: "permanent" });
  const result = await showBashPrompt(tuiContext((component) => {
    for (let i = 0; i < index; i++) component.handleInput("\x1b[B");
    const lines = component.render(80);
    const frame = lines.map(stripVTControlCharacters).join("\n");
    assert.ok(lines.length <= 24);
    assert.ok(lines.every((line) => visibleWidth(line) <= 80));
    assert.ok(frame.replace(/\s+/g, " ").includes(GLOBAL_OPERATION_WARNING));
    assert.ok(frame.indexOf("WARNING:") > frame.indexOf("→ "));
    assert.ok(lines.some((line) => line.includes("\x1b[33mWARNING:")));
    component.handleInput("\r");
  }, { rows: 24 }), prompt);
  assert.equal(result, BASH_CHOICES.operationEverywhere);

  let rpcTitle;
  const rpc = { mode: "rpc", ui: { select: async (title) => { rpcTitle = title; return BASH_CHOICES.operationEverywhere; } } };
  assert.equal(await showBashPrompt(rpc, prompt), BASH_CHOICES.operationEverywhere);
  assert.ok(rpcTitle.includes(GLOBAL_OPERATION_WARNING));
  assert.ok(rpcTitle.includes("Cwd-scoped choices: Same cwd"));
  assert.equal(bashSelectionSummary(new Map([[BASH_CHOICES.operationEverywhere, prompt.choices.get(BASH_CHOICES.operationEverywhere)]])), `Block/once save nothing.\n${GLOBAL_OPERATION_WARNING}`);
});

test("global choices are absent from fallback and incomplete previews", () => {
  assert.ok(!fallback().choices.has(BASH_CHOICES.operationEverywhere));
  const command = `git switch ${"x".repeat(20_000)}`;
  const truncated = buildBashPrompt(command, [{ text: command, risks: ["git switch"], approved: false }]);
  assert.ok(!truncated.choices.has(BASH_CHOICES.operationEverywhere));
  assert.ok(!bashSelectionSummary(truncated.choices).includes("EVERYWHERE"));
});

test("truncated prompts have no saved-permission guidance", () => {
  const prompt = buildBashPrompt("x".repeat(20_000), [], "Unverified");
  assert.equal(bashSelectionSummary(prompt.choices), "Block/once save nothing.");
});

test("native list navigation returns unchanged choice identities and cancellation blocks", async () => {
  for (const [input, expected] of [
    ["\r", BASH_CHOICES.once], ["\x1b", undefined], ["\x03", undefined],
  ]) {
    const result = await showBashPrompt(tuiContext((component) => {
      component.render(80);
      component.handleInput("\x1b[B");
      component.handleInput(input);
    }), fallback());
    assert.equal(result, expected);
  }
});

test("long details scroll without dropping content or hiding the choice list", async () => {
  const context = Array.from({ length: 80 }, (_, i) => `context line ${i}`).join("\n");
  const prompt = buildBashPrompt(command, [], "Unverified", context);
  await showBashPrompt(tuiContext((component) => {
    assert.match(plain(component, 80), /pageUp\/pageDown scroll details/);
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const frame = plain(component, 80);
      assert.match(frame, /→ Block/);
      for (const line of frame.split("\n")) seen.add(line.trim());
      component.handleInput("\x1b[6~");
    }
    for (let i = 0; i < 80; i++) assert.ok(seen.has(`context line ${i}`));
    for (let i = 0; i < 60; i++) component.handleInput("\x1b[5~");
    assert.match(plain(component, 80), /Command/);
    component.handleInput("\x1b");
  }, { rows: 24 }), prompt);
});

test("narrow dialogs show the full selected permission label below the native list", async () => {
  const command = "git restore -h";
  const prompt = buildBashPrompt(command, [{ text: command, risks: ["git restore"], approved: false }]);
  const index = ["Block", ...prompt.choices.keys()].indexOf(BASH_CHOICES.operationEverywhere);
  const result = await showBashPrompt(tuiContext((component) => {
    for (let i = 0; i < index; i++) component.handleInput("\x1b[B");
    const frame = plain(component, 30);
    assert.ok(frame.replace(/\s+/g, " ").includes(BASH_CHOICES.operationEverywhere));
    component.handleInput("\r");
  }), prompt);
  assert.equal(result, BASH_CHOICES.operationEverywhere);
});

test("abort closes the custom dialog without allowing and RPC stays plain text", async () => {
  const controller = new AbortController();
  const result = await showBashPrompt(tuiContext(() => controller.abort(), { signal: controller.signal }), fallback());
  assert.equal(result, undefined);
  const prompt = fallback();
  const rpc = {
    mode: "rpc",
    ui: {
      custom: () => assert.fail("RPC cannot render custom components"),
      select: async (title, choices) => {
        assert.ok(!title.includes("\x1b"));
        assert.equal(title, `Safety Guard: bash approval\n\n${prompt.message}\n\n${bashSelectionSummary(prompt.choices)}`);
        assert.deepEqual(choices, ["Block", ...prompt.choices.keys()]);
        return BASH_CHOICES.once;
      },
    },
  };
  assert.equal(await showBashPrompt(rpc, prompt), BASH_CHOICES.once);
});
