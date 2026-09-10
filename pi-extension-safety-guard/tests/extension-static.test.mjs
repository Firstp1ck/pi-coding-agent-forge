import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("extension registers persistent setup and applies every configurable guard", async () => {
  const [source, packageRaw] = await Promise.all([
    readFile(join(root, "index.ts"), "utf8"),
    readFile(join(root, "package.json"), "utf8"),
  ]);
  const pkg = JSON.parse(packageRaw);

  assert.match(source, /registerCommand\("safety-guard-setup"[\s\S]*configureSafetyGuardSetup/);
  assert.match(source, /config\.categories\[entry\.category\]/);
  assert.match(source, /config\.protectedPaths\.write/);
  assert.match(source, /config\.protectedPaths\.edit/);
  assert.match(source, /linesBefore: config\.contextLines\.before[\s\S]*linesAfter: config\.contextLines\.after/);
  assert.match(source, /refreshConfig\(ctx\);[\s\S]*if \(!config\.enabled\) return/);
  assert.match(source, /id: "autoReview\.enabled"[\s\S]*configureAutoReviewModel/);
  assert.match(source, /modelRegistry\.getAvailable\(\)[\s\S]*supportedAutoReviewThinkingLevels/);
  assert.match(source, /requestAutoReviewFn[\s\S]*confirmOrBlock/);
  assert.equal(pkg.peerDependencies?.["@earendil-works/pi-tui"], "*", "SettingsList UI should declare the bundled Pi TUI peer");
});

test("published dependencies exclude repository links and declare the shared Pi runtime peers", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["pi-coding-agent-forge"], undefined);
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    assert.ok(!/^(?:file:|link:|workspace:|\.\.?[\\/])/.test(spec), `${name} must not depend on a local checkout`);
  }
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    assert.equal(pkg.peerDependencies[name], "*");
    assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/, `${name} has a reproducible test baseline`);
  }
  assert.match(pkg.scripts.test, /--import \.\/tests\/register-typescript\.mjs/);
});
