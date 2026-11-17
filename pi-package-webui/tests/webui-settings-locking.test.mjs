import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  legacyWebuiSettingsFile,
  migrateLegacyWebuiSettings,
  readWebuiSettings,
  updateWebuiSettings,
  webuiSettingsFile,
  withWebuiSettingsLock,
  writeWebuiSettings,
} from "../lib/server/settings-store.mjs";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "pi-webui-settings-locking-"));
const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "..", "lib", "server", "settings-store.mjs")).href;

try {
  assert.equal(webuiSettingsFile({}), path.join(homedir(), ".pi", "webui", "settings.json"));
  assert.equal(webuiSettingsFile({ PI_WEBUI_SETTINGS_FILE: path.join(root, "override.json") }), path.join(root, "override.json"));
  assert.equal(legacyWebuiSettingsFile({ XDG_CONFIG_HOME: path.join(root, "xdg") }), path.join(root, "xdg", "pi-webui", "settings.json"));

  const legacyFile = path.join(root, "legacy", "settings.json");
  const migratedFile = path.join(root, "new", "settings.json");
  await writeFile(legacyFile, `${JSON.stringify({ version: 4, remoteAuthEnabled: true, retained: { value: 7 } })}\n`, { mode: 0o600, recursive: false }).catch(async (error) => {
    if (error?.code !== "ENOENT") throw error;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, `${JSON.stringify({ version: 4, remoteAuthEnabled: true, retained: { value: 7 } })}\n`, { mode: 0o600 });
  });
  assert.equal(await migrateLegacyWebuiSettings(migratedFile, legacyFile), true);
  assert.equal(await migrateLegacyWebuiSettings(migratedFile, legacyFile), false, "an existing new target must always win");
  const migrated = JSON.parse(await readFile(migratedFile, "utf8"));
  assert.equal(migrated.version, 8);
  assert.equal(migrated.remoteAuthEnabled, true);
  assert.deepEqual(migrated.retained, { value: 7 }, "migration must preserve unrelated top-level settings");
  assert.equal((await readFile(legacyFile, "utf8")).includes('"retained"'), true, "migration must leave the legacy file untouched");
  if (process.platform !== "win32") {
    assert.equal((await stat(migratedFile)).mode & 0o777, 0o600, "migrated settings must be private");
    assert.equal((await stat(path.dirname(migratedFile))).mode & 0o777, 0o700, "new settings directory must be private");
  }

  const malformedTarget = path.join(root, "malformed-target.json");
  const validLegacy = path.join(root, "valid-legacy.json");
  await writeFile(malformedTarget, "{not-json", "utf8");
  await writeFile(validLegacy, '{"remoteAuthEnabled":true}\n', "utf8");
  assert.equal(await migrateLegacyWebuiSettings(malformedTarget, validLegacy), false, "an existing malformed new target must not fall back to legacy data");
  await assert.rejects(readWebuiSettings(malformedTarget), /Cannot read Pi Web UI settings/);
  assert.equal(await readFile(malformedTarget, "utf8"), "{not-json");

  const malformedLegacy = path.join(root, "malformed-legacy.json");
  const absentTarget = path.join(root, "absent-target.json");
  await writeFile(malformedLegacy, "[]\n", "utf8");
  assert.equal(await migrateLegacyWebuiSettings(absentTarget, malformedLegacy), false, "invalid legacy settings must not be imported");
  await assert.rejects(readFile(absentTarget, "utf8"), { code: "ENOENT" });

  const oldOverride = process.env.PI_WEBUI_SETTINGS_FILE;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const overrideFile = path.join(root, "isolated-override", "settings.json");
  const overrideLegacy = path.join(root, "override-xdg", "pi-webui", "settings.json");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(overrideLegacy), { recursive: true });
  await writeFile(overrideLegacy, '{"remoteAuthEnabled":true}\n', "utf8");
  process.env.PI_WEBUI_SETTINGS_FILE = overrideFile;
  process.env.XDG_CONFIG_HOME = path.join(root, "override-xdg");
  try {
    const isolated = await readWebuiSettings();
    assert.equal(isolated.remoteAuthEnabled, false, "an override must never import default-path legacy settings");
    await assert.rejects(readFile(overrideFile, "utf8"), { code: "ENOENT" });
  } finally {
    if (oldOverride === undefined) delete process.env.PI_WEBUI_SETTINGS_FILE;
    else process.env.PI_WEBUI_SETTINGS_FILE = oldOverride;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
  }

  const settingsFile = path.join(root, "concurrent", "settings.json");
  await writeWebuiSettings({ remoteAuthEnabled: false, outputModeDefault: "normal", retained: "keep" }, settingsFile);
  const childCode = (patch, holdMs) => `
    import { setTimeout as delay } from "node:timers/promises";
    import { updateWebuiSettings } from ${JSON.stringify(moduleUrl)};
    await updateWebuiSettings(async () => {
      await delay(${holdMs});
      return ${JSON.stringify(patch)};
    }, ${JSON.stringify(settingsFile)});
  `;
  await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "-e", childCode({ remoteAuthEnabled: true }, 120)]),
    execFileAsync(process.execPath, ["--input-type=module", "-e", childCode({ outputModeDefault: "compact-v1" }, 0)]),
  ]);
  const concurrent = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(concurrent.remoteAuthEnabled, true);
  assert.equal(concurrent.outputModeDefault, "compact-v1", "cross-process updates must preserve unrelated concurrent patches");
  assert.equal(concurrent.retained, "keep");

  const incrementCode = (holdMs) => `
    import { setTimeout as delay } from "node:timers/promises";
    import { updateWebuiSettings } from ${JSON.stringify(moduleUrl)};
    await updateWebuiSettings(async (current) => {
      await delay(${holdMs});
      return { stressCounter: Number(current.stressCounter || 0) + 1 };
    }, ${JSON.stringify(settingsFile)});
  `;
  await Promise.all(Array.from({ length: 8 }, (_, index) => (
    execFileAsync(process.execPath, ["--input-type=module", "-e", incrementCode((index % 3) * 10)])
  )));
  assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).stressCounter, 8, "the same-host lock must serialize a burst of cross-process read/merge/write updates");

  await Promise.all([
    updateWebuiSettings(() => ({ interfacePreferences: { sidePanelWidth: 611 } }), settingsFile),
    updateWebuiSettings(() => ({ gitWorkflow: { deliveryMode: "current" } }), settingsFile),
  ]);
  const queued = await readWebuiSettings(settingsFile);
  assert.equal(queued.interfacePreferences.sidePanelWidth, 611);
  assert.equal(queued.gitWorkflow.deliveryMode, "current");

  const futureLayout = { version: 4, futureSurface: { order: ["keep-this"] } };
  const futureSettings = JSON.parse(await readFile(settingsFile, "utf8"));
  futureSettings.uiLayout = futureLayout;
  await writeFile(settingsFile, `${JSON.stringify(futureSettings, null, 2)}\n`, "utf8");
  await writeWebuiSettings({ remoteAuthEnabled: false }, settingsFile);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).uiLayout, futureLayout, "unrelated writes must preserve an unknown future layout envelope");
  assert.deepEqual((await readWebuiSettings(settingsFile)).uiLayout.sidePanel.sectionLayout, { order: null, leftSectionIds: null }, "unknown layout versions must still read as safe nullable defaults");

  const atomicWidthFile = path.join(root, "atomic-width", "settings.json");
  await writeWebuiSettings({
    interfacePreferences: { sidePanelWidth: 612 },
    uiLayout: {
      version: 3,
      sidePanel: {
        placement: "right",
        sectionLayout: { order: ["files", "controls", "git"], leftSectionIds: [] },
        collapsedSectionIds: [],
        hiddenSectionIds: [],
        collapsedPanels: { left: false, right: false },
        panelWidths: { left: 384, right: 612 },
      },
    },
  }, atomicWidthFile);
  await updateWebuiSettings((current) => ({
    interfacePreferences: { sidePanelWidth: 700 },
    uiLayout: {
      ...current.uiLayout,
      sidePanel: {
        ...current.uiLayout.sidePanel,
        panelWidths: { ...current.uiLayout.sidePanel.panelWidths, right: 700 },
      },
    },
  }), atomicWidthFile);
  const atomicWidth = JSON.parse(await readFile(atomicWidthFile, "utf8"));
  assert.equal(atomicWidth.interfacePreferences.sidePanelWidth, 700);
  assert.equal(atomicWidth.uiLayout.sidePanel.panelWidths.right, 700, "one locked settings update must atomically persist the v3 right width and legacy mirror");
  assert.equal(atomicWidth.uiLayout.sidePanel.panelWidths.left, 384);

  const liveLockTarget = path.join(root, "live-lock", "settings.json");
  const liveLockDirectory = `${liveLockTarget}.lock`;
  const liveLockRecord = path.join(liveLockDirectory, "live.json");
  await mkdir(liveLockDirectory, { recursive: true });
  await writeFile(liveLockRecord, `${JSON.stringify({ pid: process.pid, token: "live", state: "active", createdAt: 0 })}\n`, "utf8");
  await assert.rejects(
    withWebuiSettingsLock(liveLockTarget, () => true, { timeoutMs: 35, retryMs: 5 }),
    (error) => error?.code === "WEBUI_SETTINGS_LOCK_TIMEOUT",
    "lock age alone must never permit reclaiming a live owner's lock",
  );
  assert.equal(JSON.parse(await readFile(liveLockRecord, "utf8")).token, "live");
  await rm(liveLockRecord);

  const liveIncompleteRecord = path.join(liveLockDirectory, `${process.pid}-${Date.now() - 100}-incomplete.json`);
  await writeFile(liveIncompleteRecord, "", "utf8");
  await assert.rejects(
    withWebuiSettingsLock(liveLockTarget, () => true, { timeoutMs: 35, retryMs: 5 }),
    (error) => error?.code === "WEBUI_SETTINGS_LOCK_TIMEOUT",
    "a newly created incomplete record from a live owner must retain a short write grace period",
  );
  await rm(liveIncompleteRecord);

  const exited = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const deadPid = exited.pid;
  await once(exited, "exit");
  const deadIncompleteRecord = path.join(liveLockDirectory, `${deadPid}-${Date.now()}-incomplete.json`);
  await writeFile(deadIncompleteRecord, "", "utf8");
  assert.equal(
    await withWebuiSettingsLock(liveLockTarget, () => "recovered incomplete", { timeoutMs: 250, retryMs: 5 }),
    "recovered incomplete",
    "an incomplete record from a dead owner must not block future saves",
  );
  await assert.rejects(readFile(deadIncompleteRecord, "utf8"), { code: "ENOENT" });

  await mkdir(liveLockDirectory, { recursive: true });
  const malformedLockRecord = path.join(liveLockDirectory, "malformed.json");
  await writeFile(malformedLockRecord, "{", "utf8");
  const staleTime = new Date(Date.now() - 5_000);
  await utimes(malformedLockRecord, staleTime, staleTime);
  assert.equal(
    await withWebuiSettingsLock(liveLockTarget, () => "recovered malformed", { timeoutMs: 250, retryMs: 5 }),
    "recovered malformed",
    "an old malformed record without owner metadata must not block future saves",
  );
  await assert.rejects(readFile(malformedLockRecord, "utf8"), { code: "ENOENT" });

  await mkdir(liveLockDirectory, { recursive: true });
  const deadLockRecord = path.join(liveLockDirectory, "dead.json");
  await writeFile(deadLockRecord, `${JSON.stringify({ pid: deadPid, token: "dead", state: "active" })}\n`, "utf8");
  assert.equal(await withWebuiSettingsLock(liveLockTarget, () => "recovered", { timeoutMs: 250, retryMs: 5 }), "recovered");
  await assert.rejects(readFile(deadLockRecord, "utf8"), { code: "ENOENT" });
  await assert.rejects(readdir(liveLockDirectory), { code: "ENOENT" });

  const artifacts = await readdir(path.dirname(settingsFile));
  assert.equal(artifacts.some((name) => name.endsWith(".lock") || name.endsWith(".tmp")), false, "successful writes must clean lock and temp artifacts");
  if (process.platform !== "win32") assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);

  console.log("webui-settings-locking.test.mjs passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
