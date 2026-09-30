import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

for (const name of hostPackages) {
  assert.equal(manifest.dependencies?.[name], undefined, `${name} must come from the Pi host`);
  assert.equal(manifest.optionalDependencies?.[name], undefined, `${name} must not install as an optional dependency`);
  assert.equal(manifest.peerDependencies?.[name], "*", `${name} must accept the host's version`);
  assert.ok(manifest.devDependencies?.[name], `${name} must remain available to local tests`);
}
assert.equal(manifest.dependencies?.["@earendil-works/pi-agent-core"], undefined);
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  assert.deepEqual(lock.packages[""][field], manifest[field], `npm lock root must match ${field}`);
}

console.log("host-peer-dependencies.test.mjs passed");
