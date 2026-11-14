import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildInventory, scanDomConstruction, scanMarkup, scanPersistence, serializeInventory } from "../overhaul-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(root, "pi-package-webui/scripts/overhaul-inventory.mjs");
const inventory = await buildInventory(root);
const evidencePath = path.join(root, "pi-package-webui/docs/overhaul/capability-inventory.json");

async function withSourceFixture(run) {
  const fixture = await mkdtemp(path.join(tmpdir(), "webui-overhaul-inventory-"));
  try {
    const paths = new Set([...inventory.sources.map((item) => item.file), ...inventory.families.flatMap((item) => item.startingTests)]);
    for (const file of paths) {
      await mkdir(path.dirname(path.join(fixture, file)), { recursive: true });
      await copyFile(path.join(root, file), path.join(fixture, file));
    }
    await run(fixture);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

function cli(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: "utf8", timeout: 15_000 });
}

test("baseline evidence reconciles controls and all canonical families without runtime claims", async () => {
  assert.equal(serializeInventory(inventory), await readFile(evidencePath, "utf8"));
  assert.equal(new Set(inventory.controls.map((item) => item.id)).size, inventory.controls.length);
  assert.equal(Object.values(inventory.reconciliation.classifications).reduce((a, b) => a + b, 0), inventory.controls.length);
  assert.equal(inventory.reconciliation.staticDialogs, [...(await readFile(path.join(root, "pi-package-webui/public/index.html"), "utf8")).matchAll(/<dialog\b/g)].length);
  assert.ok(inventory.reconciliation.staticDialogs > 20);
  assert.ok(inventory.controls.some((item) => item.sourceId === "promptInput"));
  assert.ok(inventory.controls.some((item) => item.expression?.includes("dataset.issueWizardAction")));
  assert.ok(inventory.families.length >= 34);
  for (const family of inventory.families) {
    assert.ok(family.currentOwners.length && family.startingTests.length && family.destination && family.scope, family.id);
    assert.equal(family.legacyActive, true);
    assert.match(family.availability, /runtime/);
    for (const id of family.controls) assert.equal(inventory.controls.find((item) => item.id === id).family, family.id);
  }
  assert.equal(inventory.companions.length, 20);
  assert.deepEqual(inventory.reconciliation.companionIdentityDifferences, []);
  assert.deepEqual(inventory.reconciliation.unassignedNativeDefinitions, []);
  assert.deepEqual(inventory.reconciliation.unassignedPaletteDefinitions, []);
  assert.equal(new Set(inventory.companions.map((item) => item.packageName)).size, 20);
  assert.ok(inventory.companions.some((item) => item.id === "tuiSkillsCommand" && item.packageName === "@firstpick/pi-extension-setup-skills"));
  assert.ok(inventory.nativeDefinitions.some((item) => item.id === "/resume"));
  assert.ok(inventory.families.find(item => item.id === "diagnostics").currentOwners.some(owner => owner.file.endsWith("/activity-events-controller.mjs") && owner.symbol === "createActivityEventsController"));
  assert.ok(inventory.paletteDefinitions.some((item) => item.labelExpression === '"Show all controls"'));
  assert.ok(inventory.commandRegistrations.some((item) => item.nameExpression === '"webui-start"'));
  assert.ok(inventory.commandDefinitions.find((item) => item.id === "HIDDEN_COMMAND_NAMES").additions.includes("btw-transfer"));
  for (const id of ["palette-models", "slash-catalog", "skills-catalog", "extension-requests", "questionnaire-responses", "artifact-dialog", "image-dialog"]) {
    const family = inventory.dynamicFamilies.find((item) => item.id === id);
    assert.ok(family?.owners.length, id);
    assert.equal(family.availability, "Dynamic; no instances enumerated");
  }
  assert.ok(inventory.serverPersistence.some((item) => item.id === "ui-layout" && item.keyPaths.includes("sidePanel.sectionLayout.leftSectionIds")));
  assert.ok(inventory.persistence.some((item) => item.resolvedKey === "pi-webui-mobile-shell-v2"));
  assert.ok(inventory.persistence.some((item) => item.keyExpression === "key" && item.resolvedKey === null), "preserve dynamic storage expressions");
});

test("markup identities survive line shifts and retain ID, data action and non-action evidence", () => {
  const source = '<html><body><section id="fileTree"><button id="openFile" data-file-menu-action="open" title="a > b">Open</button><input aria-label="Search"><span id="label">Title</span></section><button id="unknownAction">Unknown</button><!-- <button id="fake"> --></body></html>';
  const original = scanMarkup("public/index.html", source);
  const shifted = scanMarkup("public/index.html", `\n\n${source}`);
  assert.deepEqual(original.map((item) => item.id), shifted.map((item) => item.id));
  assert.equal(shifted[0].anchor.line, original[0].anchor.line + 2);
  assert.equal(original.find((item) => item.sourceId === "openFile").data["data-file-menu-action"], "open");
  assert.equal(original.find((item) => item.sourceId === "openFile").family, "files");
  assert.equal(original.find((item) => item.sourceId === "unknownAction").classification, "unresolved");
  assert.ok(!original.some((item) => item.sourceId === "fake"));
  assert.ok(original.some((item) => item.actionable && !item.sourceId));
});

test("DOM constructions preserve dynamic owners and source IDs without counting comparisons as assignments", () => {
  const source = 'function renderQuestionnaire() {\nconst button = make("button", "choice", row.label);\nbutton.dataset.action = action;\nbutton.id = "questionnaireChoice";\nif (button.id === other && button.dataset.action === action) return;\n}';
  const records = scanDomConstruction("public/app.js", source);
  assert.equal(records.length, 3);
  assert.ok(records.every((item) => item.classification === "dynamic-template" && item.anchor.symbol === "renderQuestionnaire"));
  assert.ok(records.some((item) => item.sourceId === "questionnaireChoice"));
  assert.deepEqual(records.map((item) => item.id), scanDomConstruction("public/app.js", `\n${source}`).map((item) => item.id));
});

test("persistence captures literals, named keys, IDB and unresolved expressions", () => {
  const source = 'const PREF_STORAGE_KEY = "pref-v1";\nconst CUSTOM_BACKGROUND_IDB_NAME = "background-db";\nfunction save() {\nlocalStorage.setItem(PREF_STORAGE_KEY, value);\nsessionStorage.getItem("literal");\nlocalStorage.removeItem(key);\n}';
  const records = scanPersistence("public/app.js", source);
  assert.equal(records.length, 5);
  assert.ok(records.some((item) => item.kind === "indexeddb-declaration"));
  assert.ok(records.some((item) => item.keyExpression === "key"));
  assert.ok(records.some((item) => item.operation === "sessionStorage.getItem"));
});

test("computed DOM tags and data keys remain explicit dynamic candidates", () => {
  const records = scanDomConstruction("public/app.js", 'function footerMetric() {\nconst node = make(isAction ? "button" : "span", "footer");\nnode.dataset[key] = value;\n}');
  assert.equal(records.length, 2);
  assert.ok(records.every((item) => item.classification === "dynamic-template"));
  assert.ok(records.some((item) => item.expression.includes('isAction ? "button"')));
  assert.ok(records.some((item) => item.expression.includes("dataset[key]")));
});

test("CLI is CWD-independent, deterministic and check mode does not overwrite stale output", async () => {
  assert.equal(cli(["--check"]).status, 0);
  await withSourceFixture(async (fixture) => {
    const output = path.join(fixture, "pi-package-webui/docs/overhaul/evidence.json");
    const args = ["--root", fixture, "--output", output];
    assert.equal(cli(args).status, 0);
    assert.equal(await readFile(output, "utf8"), serializeInventory(inventory));
    assert.equal(cli([...args, "--check"]).status, 0);
    await writeFile(output, "stale\n");
    const stale = cli([...args, "--check"]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Stale inventory/);
    assert.equal(await readFile(output, "utf8"), "stale\n");
    assert.equal(cli(args).status, 0);
    assert.equal(await readFile(output, "utf8"), serializeInventory(inventory));
  });
});

test("unavailable sources and malformed catalogs fail rather than emitting partial evidence", async () => {
  await assert.rejects(buildInventory(path.join(tmpdir(), "nonexistent-webui-inventory-root")), /ENOENT/);
  await withSourceFixture(async (fixture) => {
    const file = path.join(fixture, "pi-package-webui/lib/optional-feature-catalog.mjs");
    await writeFile(file, 'const entries = [["only", "two"]];\nexport const OPTIONAL_FEATURE_CATALOG = [];');
    await assert.rejects(buildInventory(fixture), /Malformed/);
  });
  await withSourceFixture(async (fixture) => {
    await writeFile(path.join(fixture, "pi-package-webui/lib/WEBUI_TUI_NATIVE_PARITY.json"), '{"surfaces": [');
    await assert.rejects(buildInventory(fixture), /Malformed native parity/);
  });
});

test("malformed HTML, missing owner symbols and unsafe source traversal fail explicitly", async () => {
  await withSourceFixture(async (fixture) => {
    const file = path.join(fixture, "pi-package-webui/public/index.html");
    await writeFile(file, "<html><button id=broken>");
    await assert.rejects(buildInventory(fixture), /malformed/);
  });
  await withSourceFixture(async (fixture) => {
    const file = path.join(fixture, "pi-package-webui/public/app.js");
    await writeFile(file, (await readFile(file, "utf8")).replace("function openNativeResumeSelector(", "function removedResumeSelector("));
    await assert.rejects(buildInventory(fixture), /Missing source function.*openNativeResumeSelector/);
  });
  await withSourceFixture(async (fixture) => {
    await symlink(path.join(root, "pi-package-webui/public/app.js"), path.join(fixture, "pi-package-webui/public/linked.js"));
    await assert.rejects(buildInventory(fixture), /Source symlink/);
  });
  await withSourceFixture(async (fixture) => {
    await writeFile(path.join(fixture, "pi-package-webui/public/oversized.js"), "x".repeat(4 * 1024 * 1024 + 1));
    await assert.rejects(buildInventory(fixture), /file bound/);
  });
});

test("canonical family reordering requires explicit reconciliation", async () => {
  await withSourceFixture(async (fixture) => {
    const file = path.join(fixture, "plans/planned/webui-design-architecture-overhaul.md");
    const source = await readFile(file, "utf8");
    const rows = source.split("\n");
    const first = rows.findIndex((row) => row.startsWith("| New, close, resume and switch sessions;"));
    [rows[first], rows[first + 1]] = [rows[first + 1], rows[first]];
    await writeFile(file, rows.join("\n"));
    await assert.rejects(buildInventory(fixture), /Canonical feature anchor changed/);
  });
});

test("CLI rejects unknown/missing arguments and refuses production output paths", () => {
  for (const args of [["--unknown"], ["--root"], ["--output", path.join(root, "pi-package-webui/lib/WEBUI_TUI_NATIVE_PARITY.json")]]) {
    const result = cli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown argument|Missing value|Output must/);
  }
});
