import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the extension ships native generation without prompt-package registration or bundling", () => {
  assert.equal(manifest.dependencies?.["@firstpick/pi-prompts-git-pr"], undefined);
  assert.equal(manifest.bundledDependencies, undefined);
  assert.equal(manifest.pi?.prompts, undefined);
  assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(manifest.files.filter((file) => file.startsWith("src/")), [
    "src/core.ts",
    "src/native-generation.ts",
    "src/preferences.ts",
    "src/message-files.ts",
    "src/repository-setup.ts",
    "src/tui.ts",
  ]);
  for (const source of manifest.files.filter((file) => file.startsWith("src/"))) {
    assert.match(manifest.scripts.check, new RegExp(source.replace(".", "\\."), "u"));
  }
  assert.doesNotMatch(JSON.stringify(manifest), /pi-prompts-git-pr/u);
});
