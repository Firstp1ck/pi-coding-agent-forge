import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_THEME_EXPORT_FIELDS,
  PI_THEME_SCHEMA_URL,
  REQUIRED_THEME_TOKENS,
  THEME_TOKEN_GROUPS,
  ThemeContractError,
  canonicalizeTheme,
  effectiveThemeColors,
  normalizeThemeFileName,
  resolveThemeColor,
  serializeTheme,
  themeColorToRgb,
  themeNameFromFileName,
  validateTheme,
  xterm256ToRgb,
} from "../public/theme-contract.mjs";

const piRoot = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const schemaPath = join(piRoot, "schemas", "theme.schema.json");
const legacySchemaPath = join(piRoot, "dist", "modes", "interactive", "theme", "theme-schema.json");

function fixture(overrides = {}) {
  return {
    name: "contract-fixture",
    vars: { primary: "#123456", nested: "primary", neutral: 244 },
    colors: Object.fromEntries(REQUIRED_THEME_TOKENS.map((token, index) => [token, index % 3 === 0 ? "nested" : index % 3 === 1 ? 39 : ""])),
    export: { pageBg: "primary", cardBg: 235, infoBg: "", backgroundImage: "url(/fixture.png)" },
    ...overrides,
  };
}

assert.equal(REQUIRED_THEME_TOKENS.length, 51, "the browser contract must expose exactly 51 required tokens");
assert.equal(new Set(REQUIRED_THEME_TOKENS).size, 51, "required tokens must be unique");
assert.equal(THEME_TOKEN_GROUPS.length, 7, "the documented token inventory has seven groups");
assert.deepEqual(THEME_TOKEN_GROUPS.map(({ tokens }) => tokens.length), [11, 11, 10, 3, 9, 6, 1]);

const installedSchema = JSON.parse(await readFile(schemaPath, "utf8").catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return readFile(legacySchemaPath, "utf8");
}));
assert.equal(PI_THEME_SCHEMA_URL, "https://pi.dev/schemas/theme.schema.json");
assert.deepEqual(
  [...REQUIRED_THEME_TOKENS].sort(),
  [...installedSchema.properties.colors.required].sort(),
  "the shared contract must stay in exact parity with the installed Pi schema",
);
assert.deepEqual(
  [...PI_THEME_EXPORT_FIELDS].sort(),
  Object.keys(installedSchema.properties.export.properties).sort(),
  "Pi-native export fields must match the installed schema",
);

const valid = fixture();
assert.deepEqual(validateTheme(valid), { ok: true, issues: [] });
assert.equal(validateTheme(fixture({ name: "Pi Theme 1" })).ok, true, "theme names must retain installed Pi schema compatibility");
assert.equal(resolveThemeColor("nested", valid.vars), "#123456");
assert.equal(themeColorToRgb("neutral", valid.vars), "#808080");
assert.equal(effectiveThemeColors(valid).thinkingMax, valid.colors.thinkingXhigh, "thinkingMax must fall back to thinkingXhigh");
const explicitMax = fixture({ colors: { ...valid.colors, thinkingMax: "primary" } });
assert.equal(effectiveThemeColors(explicitMax).thinkingMax, "primary");

const native = canonicalizeTheme(valid);
assert.equal(native.$schema, PI_THEME_SCHEMA_URL);
assert.deepEqual(Object.keys(native.export), ["pageBg", "cardBg", "infoBg"]);
assert.equal(Object.hasOwn(native.export, "backgroundImage"), false, "WebUI-only export fields must not enter Pi-native files");
assert.deepEqual(Object.keys(native.colors), REQUIRED_THEME_TOKENS, "canonical colors must retain documented order");
assert.deepEqual(Object.keys(native.vars), ["nested", "neutral", "primary"], "variables must serialize deterministically");
const serialized = serializeTheme(valid);
assert.equal(serialized.endsWith("\n"), true, "canonical JSON must have one trailing newline");
assert.equal(serialized, `${JSON.stringify(native, null, 2)}\n`);
assert.deepEqual(JSON.parse(serialized), native);

for (const [label, theme, expectedPath] of [
  ["unknown root", { ...valid, secret: true }, "secret"],
  ["unknown color", { ...valid, colors: { ...valid.colors, madeUp: "" } }, "colors.madeUp"],
  ["missing required", { ...valid, colors: Object.fromEntries(Object.entries(valid.colors).filter(([key]) => key !== "accent")) }, "colors.accent"],
  ["float", { ...valid, colors: { ...valid.colors, accent: 1.5 } }, "colors.accent"],
  ["range", { ...valid, colors: { ...valid.colors, accent: 256 } }, "colors.accent"],
  ["short hex", { ...valid, colors: { ...valid.colors, accent: "#fff" } }, "colors.accent"],
  ["missing variable", { ...valid, colors: { ...valid.colors, accent: "absent" } }, "colors.accent"],
  ["unknown export", { ...valid, export: { ...valid.export, arbitrary: "value" } }, "export.arbitrary"],
  ["circular variable", { ...valid, vars: { first: "second", second: "first" } }, "vars.first"],
]) {
  const result = validateTheme(theme);
  assert.equal(result.ok, false, `${label} must be rejected`);
  assert.ok(result.issues.some(({ path }) => path === expectedPath), `${label} must identify ${expectedPath}`);
}
assert.equal(validateTheme(valid, { allowWebuiExport: false }).ok, false, "Pi-only validation must reject WebUI export fields");
assert.throws(() => canonicalizeTheme({ ...valid, unexpected: true }), ThemeContractError);

assert.equal(normalizeThemeFileName("my-theme.json"), "my-theme.json");
assert.equal(themeNameFromFileName("my-theme.json"), "my-theme");
for (const invalid of ["", ".json", "../theme.json", "nested/theme.json", "theme.txt", "space theme.json", `x${"y".repeat(75)}.json`]) {
  assert.throws(() => normalizeThemeFileName(invalid), ThemeContractError, `${JSON.stringify(invalid)} must not be a save basename`);
}

assert.equal(xterm256ToRgb(0), "#000000");
assert.equal(xterm256ToRgb(15), "#ffffff");
assert.equal(xterm256ToRgb(16), "#000000");
assert.equal(xterm256ToRgb(21), "#0000ff");
assert.equal(xterm256ToRgb(39), "#00afff");
assert.equal(xterm256ToRgb(232), "#080808");
assert.equal(xterm256ToRgb(255), "#eeeeee");
assert.throws(() => xterm256ToRgb(-1), RangeError);
assert.throws(() => xterm256ToRgb(1.5), RangeError);

console.log("theme-contract: ok");
