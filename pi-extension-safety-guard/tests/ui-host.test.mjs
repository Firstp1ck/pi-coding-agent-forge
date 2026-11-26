import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRowsUiHost, isOmpUiHost, loadUiHost, resetUiHostForTests, setUiHostForTests } from "../src/ui-host.ts";
import { showBashPrompt } from "../src/bash-dialog.ts";
import { buildBashPrompt } from "../src/bash-prompt.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("published sources do not statically import upstream pi-tui", async () => {
  const files = ["index.ts", "src/bash-dialog.ts", "src/ui-host.ts", "src/auto-review.ts"];
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    assert.doesNotMatch(source, /from\s+["']@earendil-works\/pi-tui["']/);
    assert.doesNotMatch(source, /import\(\s*["']@earendil-works\/pi-tui["']\s*\)/);
  }
});

test("rows host cycles settings and selects bash choices without pi-tui", async () => {
  const host = createRowsUiHost();
  const items = [{ id: "enabled", label: "Guard", currentValue: "on", values: ["on", "off"] }];
  let saved = false;
  let changed = "";
  const overlay = host.createSettingsOverlay({
    theme: { fg: (_tone, text) => text, bold: (text) => text },
    items,
    title: "Safety guard setup",
    footer: "Ctrl+S save",
    onChange: (id, value) => { changed = `${id}:${value}`; },
    onCancel: () => { },
    onSave: () => { saved = true; },
  });
  overlay.handleInput(" ");
  assert.equal(items[0].currentValue, "off");
  assert.equal(changed, "enabled:off");
  overlay.handleInput("\x13");
  assert.equal(saved, true);
  assert.ok(overlay.render(40).join("\n").includes("Guard"));

  setUiHostForTests(host);
  try {
    const prompt = buildBashPrompt("rm -rf example", [{ text: "rm -rf example", risks: ["rm -rf"], approved: false }]);
    const choice = await showBashPrompt({
      mode: "tui",
      ui: {
        select: () => assert.fail("rows host should use custom"),
        custom: (factory) => new Promise((resolve) => {
          const component = factory({ size: () => ({ columns: 80, rows: 24 }), requestRender() { } }, {
            fg: (_tone, text) => text,
            bold: (text) => text,
          }, undefined, resolve);
          component.render(80);
          component.handleInput("\x1b[B");
          component.handleInput("\r");
        }),
      },
    }, prompt);
    assert.equal(choice, [...prompt.choices.keys()][0]);
  } finally {
    resetUiHostForTests();
  }
});
test("omp capability selects rows without importing pi-tui", async () => {
  resetUiHostForTests();
  let imported = false;
  const refuse = async () => {
    imported = true;
    throw new Error("pi-tui import must not run on omp");
  };
  const fromComposer = await loadUiHost({ ui: { composer: {} } }, { importPiTui: refuse });
  assert.equal(fromComposer.kind, "omp");
  const fromFactory = await loadUiHost({
    factoryUi: { size: () => ({ rows: 24, columns: 80 }), requestRender() { } },
  }, { importPiTui: refuse });
  assert.equal(fromFactory.kind, "omp");
  assert.equal(imported, false);
  assert.equal(isOmpUiHost({ ui: { select() { } }, factoryUi: { terminal: { rows: 24 }, requestRender() { } } }), false);
});

test("pi-tui peer loads the component host when installed", async () => {
  resetUiHostForTests();
  const host = await loadUiHost();
  assert.equal(host.kind, "pi");
});
