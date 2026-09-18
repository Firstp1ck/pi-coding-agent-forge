import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("package ships one ESM extension with only public Pi peers", () => {
  assert.equal(manifest.name, "@firstpick/pi-extension-review");
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.peerDependencies).sort(), [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]);
  for (const source of manifest.files.filter((file) => file.endsWith(".ts"))) assert.match(manifest.scripts.check, new RegExp(source.replaceAll(".", "\\."), "u"));
});

test("test helpers contain no workstation-specific absolute paths", async () => {
  const directory = new URL("./", import.meta.url);
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".mjs")) continue;
    const source = await readFile(new URL(name, directory), "utf8");
    assert.doesNotMatch(source, /C:\/Users\//u);
  }
});

test("package contents include all documentation layers and no generated state", () => {
  for (const file of ["README.md", "TECHNICAL.md", "DEVELOPMENT.md", "LICENSE"]) assert.ok(manifest.files.includes(file));
  assert.equal(manifest.files.some((file) => /state|settings\.json|report\.json/u.test(file)), false);
});
