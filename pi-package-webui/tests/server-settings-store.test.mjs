import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as compatibility from "../lib/git-workflow-preferences.mjs";
import * as preferenceValues from "../lib/git-workflow-preference-values.mjs";
import * as store from "../lib/server/settings-store.mjs";

const storeExports = [
  "WEBUI_SIDE_PANEL_WIDTH_MIN_PX",
  "WEBUI_SIDE_PANEL_WIDTH_MAX_PX",
  "webuiSettingsFile",
  "legacyWebuiSettingsFile",
  "normalizeResourceDefaults",
  "normalizeInterfacePreferences",
  "normalizeWebuiSettings",
  "withWebuiSettingsLock",
  "migrateLegacyWebuiSettings",
  "validatedShellRolloutCohort",
  "initializeWebuiShellRollout",
  "readWebuiSettings",
  "updateWebuiSettings",
  "writeWebuiSettings",
];
assert.deepEqual(Object.keys(store).sort(), [...storeExports].sort());
for (const name of storeExports) {
  assert.equal(compatibility[name], store[name], `${name} must be the same binding at both import paths`);
}
assert.deepEqual(Object.keys(compatibility).sort(), [
  ...storeExports,
  ...Object.keys(preferenceValues),
  "readGitWorkflowPreferences",
  "writeGitWorkflowPreferences",
].sort(), "the compatibility module must preserve the complete existing export surface");

const root = await mkdtemp(path.join(tmpdir(), "pi-webui-settings-store-"));
try {
  const absentFile = path.join(root, "absent.json");
  const defaults = await store.updateWebuiSettings(async () => undefined, absentFile);
  assert.equal(defaults.version, 8);
  assert.equal(defaults.uiLayout.version, 3);
  await assert.rejects(readFile(absentFile), { code: "ENOENT" }, "an undefined updater must not create a settings file");
  await assert.rejects(readdir(`${absentFile}.lock`), { code: "ENOENT" });

  const settingsFile = path.join(root, "settings.json");
  const rawSettings = '{ "version": 8, "retained": { "keep": true }, "counter": 0 }\n';
  await writeFile(settingsFile, rawSettings, "utf8");
  await compatibility.updateWebuiSettings(async (current) => {
    assert.deepEqual(current.retained, { keep: true });
    return undefined;
  }, settingsFile);
  assert.equal(await readFile(settingsFile, "utf8"), rawSettings, "a no-write update must leave even the original formatting untouched");

  let releaseFirstUpdate;
  let firstUpdateStarted;
  const started = new Promise((resolve) => { firstUpdateStarted = resolve; });
  const held = new Promise((resolve) => { releaseFirstUpdate = resolve; });
  const firstUpdate = compatibility.updateWebuiSettings(async (current) => {
    firstUpdateStarted();
    await held;
    return { counter: current.counter + 1 };
  }, settingsFile);
  await started;
  let secondUpdateEntered = false;
  const secondUpdate = store.updateWebuiSettings((current) => {
    secondUpdateEntered = true;
    assert.equal(current.counter, 1, "the new import must observe the awaited compatibility updater's write");
    return { counter: current.counter + 1 };
  }, path.join(root, ".", "settings.json"));
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondUpdateEntered, false, "mixed imports must serialize on the same per-file queue");
    assert.equal((await readdir(`${settingsFile}.lock`)).length, 1, "the queued import must not start a competing lock acquisition");
    assert.equal(await readFile(settingsFile, "utf8"), rawSettings, "the store must await the updater before writing");
  } finally {
    releaseFirstUpdate();
    await Promise.all([firstUpdate, secondUpdate]);
  }
  await Promise.all(Array.from({ length: 8 }, (_, index) => (
    (index % 2 ? compatibility : store).updateWebuiSettings((current) => ({ counter: current.counter + 1 }), settingsFile)
  )));
  assert.equal((await store.readWebuiSettings(settingsFile)).counter, 10, "mixed-import updates must not lose concurrent increments");
  await Promise.all([
    compatibility.writeGitWorkflowPreferences({ generation: { provider: "fake", modelId: "fake-model" } }, settingsFile),
    store.writeWebuiSettings({ interfacePreferences: { sidePanelWidth: 641 } }, settingsFile),
  ]);
  assert.equal((await store.readWebuiSettings(settingsFile)).gitWorkflow.generation.modelId, "fake-model");
  assert.equal((await compatibility.readWebuiSettings(settingsFile)).interfacePreferences.sidePanelWidth, 641);

  const beforeRejectedUpdate = await readFile(settingsFile, "utf8");
  const updaterError = new Error("updater failed");
  await assert.rejects(store.updateWebuiSettings(async () => { throw updaterError; }, settingsFile), (error) => error === updaterError);
  assert.equal(await readFile(settingsFile, "utf8"), beforeRejectedUpdate, "a rejected updater must leave settings untouched");
  await compatibility.writeWebuiSettings({ counter: 11 }, settingsFile);
  const persisted = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(persisted.counter, 11, "a rejected update must not poison the shared queue");
  assert.deepEqual(persisted.retained, { keep: true });
  assert.equal(Object.hasOwn(persisted, "subagentLaunchSlots"), false, "unrelated writes must not materialize launch-slot settings");

  const futureLayout = { version: 99, futurePanel: { order: ["retain"] } };
  await writeFile(settingsFile, `${JSON.stringify({ ...persisted, version: 99, uiLayout: futureLayout })}\n`, "utf8");
  await store.writeWebuiSettings({ remoteAuthEnabled: true }, settingsFile);
  const futurePersisted = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(futurePersisted.version, 99);
  assert.deepEqual(futurePersisted.uiLayout, futureLayout);
  assert.deepEqual(futurePersisted.retained, { keep: true });
  assert.equal((await compatibility.readWebuiSettings(settingsFile)).uiLayout.version, 3, "future layout data must still read through the safe current normalizer");

  const targetFile = path.join(root, "migration-race.json");
  const legacyFile = path.join(root, "legacy.json");
  const winningSettings = '{"version":8,"retained":"new target wins"}\n';
  await writeFile(legacyFile, '{"retained":"legacy"}\n', "utf8");
  let migration;
  await store.withWebuiSettingsLock(targetFile, async () => {
    migration = store.migrateLegacyWebuiSettings(targetFile, legacyFile);
    // Observe the migration's pending lock before creating the competing target.
    const deadline = Date.now() + 1_000;
    while ((await readdir(`${targetFile}.lock`)).length < 2) {
      assert.ok(Date.now() < deadline, "migration must reach its locked absence recheck");
      await delay(5);
    }
    await writeFile(targetFile, winningSettings, "utf8");
  });
  assert.equal(await migration, false, "migration must recheck target absence after acquiring the lock");
  assert.equal(await readFile(targetFile, "utf8"), winningSettings);

  assert.equal((await readdir(root)).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")), false, "updates and migration must clean up their artifacts");
  console.log("server-settings-store.test.mjs passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
