import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PI_THEME_SCHEMA_URL, WEBUI_THEME_EXPORT_FIELDS, validateTheme } from "../../pi-package-webui/public/theme-contract.mjs";

const root = new URL("../", import.meta.url);

test("all bundled themes conform to Pi's strict native contract", async () => {
  const names = await readdir(new URL("themes/", root));
  const files = names.filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 16);
  for (const file of files) {
    const theme = JSON.parse(await readFile(new URL(`themes/${file}`, root), "utf8"));
    assert.equal(theme.$schema, PI_THEME_SCHEMA_URL, file);
    assert.equal(theme.name, file.slice(0, -5), file);
    assert.deepEqual(validateTheme(theme, { allowWebuiExport: false }), { ok: true, issues: [] }, file);
  }
});

test("WebUI backgrounds are published separately from Pi theme JSON", async () => {
  const backgrounds = JSON.parse(await readFile(new URL("webui-backgrounds.json", root), "utf8"));
  assert.deepEqual(Object.keys(backgrounds).sort(), ["catppuccin-mocha", "matrix"]);
  for (const [name, background] of Object.entries(backgrounds)) {
    const theme = JSON.parse(await readFile(new URL(`themes/${name}.json`, root), "utf8"));
    assert.deepEqual(Object.keys(background).sort(), [...WEBUI_THEME_EXPORT_FIELDS].sort());
    for (const key of WEBUI_THEME_EXPORT_FIELDS) {
      assert.equal(typeof background[key], "string");
      assert.equal(Object.hasOwn(theme.export, key), false);
    }
  }
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.ok(manifest.files.includes("webui-backgrounds.json"));
  assert.deepEqual(manifest.pi.themes, ["./themes"]);
});
