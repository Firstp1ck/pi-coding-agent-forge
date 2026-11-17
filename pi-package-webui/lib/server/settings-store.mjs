import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeSubagentLaunchSlots } from "../subagent-launch-slots.mjs";
import { normalizeUiLayout } from "../ui-layout-settings.mjs";
import { normalizeResourceDefaults } from "../resource-selection.mjs";
import {
  normalizeAppendSystemPromptPath,
  normalizeAppendSystemPromptRootPath,
} from "../append-system-selection.mjs";
import { normalizeOutputMode, OUTPUT_MODE_NORMAL } from "../webui-output-mode.mjs";
import { mergeGitWorkflowPreferences, normalizeGitWorkflowPreferences } from "../git-workflow-preference-values.mjs";

const WEBUI_SETTINGS_VERSION = 8;
const WEBUI_SETTINGS_FILE_ENV = "PI_WEBUI_SETTINGS_FILE";
const WEBUI_SETTINGS_LOCK_TIMEOUT_MS = 2_000;
const WEBUI_SETTINGS_LOCK_RETRY_MS = 25;
const WEBUI_SETTINGS_LOCK_INVALID_RECORD_GRACE_MS = 1_000;
export const WEBUI_SIDE_PANEL_WIDTH_MIN_PX = 320;
export const WEBUI_SIDE_PANEL_WIDTH_MAX_PX = 4096;
const webuiSettingsUpdateQueues = new Map();

export function webuiSettingsFile(env = process.env) {
  if (env[WEBUI_SETTINGS_FILE_ENV]) return path.resolve(String(env[WEBUI_SETTINGS_FILE_ENV]).replace(/^~(?=$|[\\/])/, homedir()));
  return path.join(homedir(), ".pi", "webui", "settings.json");
}

export function legacyWebuiSettingsFile(env = process.env) {
  const configRoot = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(configRoot, "pi-webui", "settings.json");
}

export { normalizeResourceDefaults } from "../resource-selection.mjs";

export function normalizeInterfacePreferences(value) {
  const rawSidePanelWidth = value?.sidePanelWidth;
  const sidePanelWidth = rawSidePanelWidth === null || rawSidePanelWidth === undefined ? Number.NaN : Number(rawSidePanelWidth);
  return {
    sidePanelWidth: Number.isFinite(sidePanelWidth)
      ? Math.max(WEBUI_SIDE_PANEL_WIDTH_MIN_PX, Math.min(WEBUI_SIDE_PANEL_WIDTH_MAX_PX, Math.round(sidePanelWidth)))
      : null,
  };
}

function settingsObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizedSettingsVersion(value) {
  const stored = Number.isInteger(value?.version) ? value.version : 0;
  return Math.max(WEBUI_SETTINGS_VERSION, stored, value?.subagentLaunchSlots !== undefined ? 5 : 0);
}

export function normalizeWebuiSettings(value) {
  const source = settingsObject(value);
  const storedVersion = Number.isInteger(source.version) ? source.version : 0;
  const resourceDefaultsSource = storedVersion >= 8
    ? source.resourceDefaults
    : { ...settingsObject(source.resourceDefaults), modelProfiles: [] };
  const interfacePreferences = normalizeInterfacePreferences(source.interfacePreferences);
  const legacyLayoutSource = source.uiLayout === undefined
    && interfacePreferences.sidePanelWidth !== null
    && (!Number.isInteger(source.version) || source.version < WEBUI_SETTINGS_VERSION)
    ? { version: 1 }
    : source.uiLayout;
  return {
    ...source,
    version: normalizedSettingsVersion(source),
    remoteAuthEnabled: source.remoteAuthEnabled === true,
    appendSystemPromptPath: normalizeAppendSystemPromptPath(source.appendSystemPromptPath),
    appendSystemPromptRootPath: normalizeAppendSystemPromptRootPath(source.appendSystemPromptRootPath),
    outputModeDefault: normalizeOutputMode(source.outputModeDefault, OUTPUT_MODE_NORMAL),
    gitWorkflow: normalizeGitWorkflowPreferences(source.gitWorkflow),
    resourceDefaults: normalizeResourceDefaults(resourceDefaultsSource),
    interfacePreferences,
    uiLayout: normalizeUiLayout(legacyLayoutSource, { legacySidePanelWidth: interfacePreferences.sidePanelWidth }),
    subagentLaunchSlots: normalizeSubagentLaunchSlots(source.subagentLaunchSlots),
  };
}

function settingsReadError(storageFile, error) {
  const wrapped = new Error(`Cannot read Pi Web UI settings at ${storageFile}: ${error instanceof Error ? error.message : String(error)}`);
  wrapped.code = "WEBUI_SETTINGS_READ_FAILED";
  wrapped.cause = error;
  return wrapped;
}

async function readRawWebuiSettings(storageFile, { missing = {} } = {}) {
  let text;
  try {
    text = await readFile(storageFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
    throw settingsReadError(storageFile, error);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("settings must contain a JSON object");
    return parsed;
  } catch (error) {
    throw settingsReadError(storageFile, error);
  }
}

function isDefaultSettingsTarget(storageFile, env = process.env) {
  return !env[WEBUI_SETTINGS_FILE_ENV] && path.resolve(storageFile) === path.resolve(webuiSettingsFile(env));
}

async function ensurePrivateSettingsDirectory(storageFile) {
  await mkdir(path.dirname(storageFile), { recursive: true, mode: 0o700 });
}

function lockDirectoryFor(storageFile) {
  return `${storageFile}.lock`;
}

function lockOwnerIsDead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function settingsLockRecordNameMetadata(name) {
  const match = name.match(/^(\d+)-(\d+)-[^/]+\.json$/);
  if (!match) return {};
  const ownerPid = Number(match[1]);
  const createdAt = Number(match[2]);
  return {
    ownerPid: Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : undefined,
    createdAt: Number.isSafeInteger(createdAt) && createdAt > 0 ? createdAt : undefined,
  };
}

async function readSettingsLockRecords(lockDirectory) {
  const names = (await readdir(lockDirectory)).filter((name) => name.endsWith(".json")).sort();
  const records = await Promise.all(names.map(async (name) => {
    const recordFile = path.join(lockDirectory, name);
    const nameMetadata = settingsLockRecordNameMetadata(name);
    try {
      const [value, fileStat] = await Promise.all([
        readFile(recordFile, "utf8").then((text) => JSON.parse(text)),
        stat(recordFile),
      ]);
      const valid = Number.isSafeInteger(value?.pid)
        && value.pid > 0
        && typeof value?.token === "string"
        && value.token.length > 0
        && ["pending", "active"].includes(value?.state);
      const createdAt = Number.isSafeInteger(value?.createdAt) && value.createdAt > 0
        ? value.createdAt
        : nameMetadata.createdAt;
      return {
        ...value,
        ownerPid: nameMetadata.ownerPid,
        createdAt,
        name,
        recordFile,
        mtimeMs: fileStat.mtimeMs,
        valid,
      };
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      const fileStat = await stat(recordFile).catch(() => undefined);
      return { ...nameMetadata, name, recordFile, mtimeMs: fileStat?.mtimeMs, valid: false };
    }
  }));
  return records.filter(Boolean);
}

async function renameWithWindowsRetry(source, target) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (process.platform !== "win32" || !["EACCES", "EBUSY", "EPERM"].includes(error?.code)) throw error;
      await delay(25 * (attempt + 1));
    }
  }
  throw lastError;
}

async function writeSettingsLockRecord(recordFile, value) {
  const temporaryFile = `${recordFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await open(temporaryFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithWindowsRetry(temporaryFile, recordFile);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
}

async function releaseSettingsLock(lockDirectory, recordFile) {
  await rm(recordFile, { force: true });
  await rmdir(lockDirectory).catch((error) => {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
  });
}

export async function withWebuiSettingsLock(storageFile, operation, {
  timeoutMs = WEBUI_SETTINGS_LOCK_TIMEOUT_MS,
  retryMs = WEBUI_SETTINGS_LOCK_RETRY_MS,
} = {}) {
  await ensurePrivateSettingsDirectory(storageFile);
  const lockDirectory = lockDirectoryFor(storageFile);
  await mkdir(lockDirectory, { mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const createdAt = Date.now();
  const token = `${process.pid}-${createdAt}-${Math.random().toString(16).slice(2)}`;
  const recordFile = path.join(lockDirectory, `${token}.json`);
  const ownRecord = { pid: process.pid, token, state: "pending", createdAt };
  let handle;
  try {
    handle = await open(recordFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(ownRecord)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(recordFile, { force: true }).catch(() => {});
    throw error;
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  let acquired = false;
  try {
    while (!acquired) {
      let records = await readSettingsLockRecords(lockDirectory);
      let removedStaleRecord = false;
      for (const record of records) {
        const ownerPid = record.valid ? record.pid : record.ownerPid;
        const ownerIsDead = lockOwnerIsDead(ownerPid);
        const recordAgeMs = Math.max(
          Number.isFinite(record.mtimeMs) ? Date.now() - record.mtimeMs : 0,
          Number.isSafeInteger(record.createdAt) ? Date.now() - record.createdAt : 0,
        );
        const invalidRecordIsStale = !record.valid
          && (ownerIsDead || recordAgeMs >= WEBUI_SETTINGS_LOCK_INVALID_RECORD_GRACE_MS);
        if ((record.valid && ownerIsDead) || invalidRecordIsStale) {
          await rm(record.recordFile, { force: true });
          removedStaleRecord = true;
        }
      }
      if (removedStaleRecord) continue;

      const active = records.filter((record) => record.valid && record.state === "active");
      if (active.length === 1 && active[0].token === token) {
        acquired = true;
        break;
      }
      if (active.length === 0 && records[0]?.token === token && records[0]?.valid) {
        ownRecord.state = "active";
        await writeSettingsLockRecord(recordFile, ownRecord);
        continue;
      }
      if (Date.now() >= deadline) {
        const timeoutError = new Error("Timed out waiting for the Pi Web UI settings lock");
        timeoutError.code = "WEBUI_SETTINGS_LOCK_TIMEOUT";
        throw timeoutError;
      }
      await delay(Math.max(1, Math.min(retryMs, deadline - Date.now())));
    }
    return await operation();
  } finally {
    await releaseSettingsLock(lockDirectory, recordFile);
  }
}

async function syncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unsupported on some platforms/filesystems.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writePrivateAtomicSettings(storageFile, value) {
  await ensurePrivateSettingsDirectory(storageFile);
  const temporaryFile = path.join(
    path.dirname(storageFile),
    `.${path.basename(storageFile)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithWindowsRetry(temporaryFile, storageFile);
    await syncDirectoryBestEffort(path.dirname(storageFile));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
}

export async function migrateLegacyWebuiSettings(targetFile, legacyFile) {
  if (path.resolve(targetFile) === path.resolve(legacyFile)) return false;
  try {
    await readFile(targetFile, "utf8");
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw settingsReadError(targetFile, error);
  }
  let legacy;
  try {
    legacy = await readRawWebuiSettings(legacyFile, { missing: null });
  } catch {
    return false;
  }
  if (!legacy) return false;
  return withWebuiSettingsLock(targetFile, async () => {
    try {
      await readFile(targetFile, "utf8");
      return false;
    } catch (error) {
      if (error?.code !== "ENOENT") throw settingsReadError(targetFile, error);
    }
    const { settings, persistLaunchSlots, persistedUiLayout } = mergeWebuiSettings(legacy, {});
    const persisted = { ...settings, uiLayout: persistedUiLayout };
    if (!persistLaunchSlots) delete persisted.subagentLaunchSlots;
    await writePrivateAtomicSettings(targetFile, persisted);
    return true;
  });
}

async function ensureDefaultSettingsMigration(storageFile, env = process.env) {
  if (!isDefaultSettingsTarget(storageFile, env)) return false;
  return migrateLegacyWebuiSettings(storageFile, legacyWebuiSettingsFile(env));
}

export function validatedShellRolloutCohort(rawMarker) {
  if (!rawMarker || typeof rawMarker !== "object" || Array.isArray(rawMarker) || rawMarker.version !== 1) return null;
  return rawMarker.cohort === "fresh" || rawMarker.cohort === "established" ? rawMarker.cohort : null;
}

async function rolloutPathStat(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function hasRolloutEvidence(filenames) {
  let found = false;
  for (const filename of filenames) {
    if (await rolloutPathStat(filename)) found = true;
  }
  return found;
}

async function readRolloutSettings(storageFile) {
  const entry = await rolloutPathStat(storageFile);
  if (!entry) return null;
  const file = entry.isSymbolicLink() ? await stat(storageFile) : entry;
  // Reading a special file could block startup outside the lock's deadline.
  if (!file.isFile()) throw new TypeError("Rollout settings must be a regular file");
  return readRawWebuiSettings(storageFile, { missing: null });
}

/** Initializes startup-only rollout evidence without normalizing stored settings. */
export async function initializeWebuiShellRollout({
  env = process.env,
  storageFile = webuiSettingsFile(env),
  legacyFile = legacyWebuiSettingsFile(env),
  additionalEvidencePaths = [],
} = {}) {
  try {
    const target = path.resolve(storageFile);
    const root = path.dirname(target);
    const defaultTarget = isDefaultSettingsTarget(target, env);
    // Canonicalize the parent, never the root: creating the root here loses proof.
    await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    const parent = await realpath(path.dirname(root));
    const initializationLock = path.join(parent, `.${path.basename(root)}-shell-rollout-init`);
    return await withWebuiSettingsLock(initializationLock, async () => {
      const rootBefore = await rolloutPathStat(root);
      const targetBefore = await rolloutPathStat(target);
      const initialRaw = targetBefore ? await readRolloutSettings(target) : null;
      if (initialRaw && Object.hasOwn(initialRaw, "shellRollout")) {
        return withWebuiSettingsLock(target, async () => {
          const raw = await readRolloutSettings(target);
          return { cohort: validatedShellRolloutCohort(raw?.shellRollout) };
        });
      }
      if (rootBefore && !rootBefore.isDirectory()) return { cohort: null };
      if (targetBefore && !targetBefore.isFile()) return { cohort: null };

      const evidencePaths = [legacyFile, ...additionalEvidencePaths];
      const priorUse = await hasRolloutEvidence(evidencePaths);
      let legacy = null;
      if (defaultTarget && !targetBefore && path.resolve(legacyFile) !== target) {
        const legacyStat = await rolloutPathStat(legacyFile);
        if (legacyStat && !legacyStat.isFile()) return { cohort: null };
        legacy = await readRawWebuiSettings(legacyFile, { missing: null });
      }

      let createdRoot = false;
      if (defaultTarget && !rootBefore && !targetBefore && !priorUse) {
        try {
          await mkdir(root, { mode: 0o700 });
          createdRoot = true;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      // Migration must precede the marker, which would otherwise hide legacy data.
      if (defaultTarget && legacy) await migrateLegacyWebuiSettings(target, legacyFile);
      return withWebuiSettingsLock(target, async () => {
        const raw = await readRolloutSettings(target);
        if (raw && Object.hasOwn(raw, "shellRollout")) {
          return { cohort: validatedShellRolloutCohort(raw.shellRollout) };
        }
        const currentRoot = await rolloutPathStat(root);
        const currentTarget = await rolloutPathStat(target);
        if (!currentRoot?.isDirectory() || (currentTarget && !currentTarget.isFile())) return { cohort: null };
        // A source appearing after migration must be handled by the next startup.
        if (!raw && defaultTarget && path.resolve(legacyFile) !== target
          && await rolloutPathStat(legacyFile)) return { cohort: null };
        if (!raw && legacy) return { cohort: null };
        const cohort = createdRoot && !raw && !await hasRolloutEvidence(evidencePaths) ? "fresh" : "established";
        await writePrivateAtomicSettings(target, { ...raw, shellRollout: { version: 1, cohort } });
        const persisted = await readRolloutSettings(target);
        return { cohort: validatedShellRolloutCohort(persisted?.shellRollout) };
      });
    });
  } catch {
    // Failed proof or persistence must never enable a transient fresh default.
    return { cohort: null };
  }
}

export async function readWebuiSettings(storageFile = webuiSettingsFile(), { reportInvalidOutputMode = false } = {}) {
  await ensureDefaultSettingsMigration(storageFile);
  const raw = await readRawWebuiSettings(storageFile);
  const normalized = normalizeWebuiSettings(raw);
  if (reportInvalidOutputMode && raw.outputModeDefault !== undefined && normalized.outputModeDefault !== raw.outputModeDefault) {
    console.warn(`Invalid persisted Web UI output mode ${JSON.stringify(raw.outputModeDefault)}; using ${OUTPUT_MODE_NORMAL}.`);
  }
  return normalized;
}

function mergeWebuiSettings(rawCurrent, patch) {
  const raw = settingsObject(rawCurrent);
  const current = normalizeWebuiSettings(raw);
  const patchValue = settingsObject(patch);
  const hasLaunchSlotPatch = Object.hasOwn(patchValue, "subagentLaunchSlots");
  const persistLaunchSlots = raw.subagentLaunchSlots !== undefined || hasLaunchSlotPatch;
  const source = {
    ...raw,
    ...patchValue,
    gitWorkflow: patchValue.gitWorkflow
      ? mergeGitWorkflowPreferences(current.gitWorkflow, patchValue.gitWorkflow)
      : current.gitWorkflow,
    resourceDefaults: patchValue.resourceDefaults
      ? {
          ...current.resourceDefaults,
          ...patchValue.resourceDefaults,
          tools: { ...current.resourceDefaults.tools, ...(patchValue.resourceDefaults.tools || {}) },
          skills: { ...current.resourceDefaults.skills, ...(patchValue.resourceDefaults.skills || {}) },
        }
      : current.resourceDefaults,
    interfacePreferences: patchValue.interfacePreferences
      ? { ...current.interfacePreferences, ...patchValue.interfacePreferences }
      : current.interfacePreferences,
    uiLayout: Object.hasOwn(patchValue, "uiLayout")
      ? normalizeUiLayout(patchValue.uiLayout)
      : current.uiLayout,
  };
  if (persistLaunchSlots) {
    source.subagentLaunchSlots = hasLaunchSlotPatch
      ? normalizeSubagentLaunchSlots(patchValue.subagentLaunchSlots)
      : normalizeSubagentLaunchSlots(raw.subagentLaunchSlots);
    source.version = Math.max(5, Number.isInteger(raw.version) ? raw.version : 0);
  } else {
    delete source.subagentLaunchSlots;
    source.version = Math.max(WEBUI_SETTINGS_VERSION, Number.isInteger(raw.version) ? raw.version : 0);
  }
  const settings = normalizeWebuiSettings(source);
  const rawLayoutVersion = Number.isInteger(raw.uiLayout?.version) ? raw.uiLayout.version : 0;
  const persistedUiLayout = !Object.hasOwn(patchValue, "uiLayout") && rawLayoutVersion > settings.uiLayout.version
    ? raw.uiLayout
    : settings.uiLayout;
  return { settings, persistLaunchSlots, persistedUiLayout };
}

async function writeMergedWebuiSettings(rawCurrent, patch, storageFile) {
  const { settings, persistLaunchSlots, persistedUiLayout } = mergeWebuiSettings(rawCurrent, patch);
  const persisted = { ...settings, uiLayout: persistedUiLayout };
  if (!persistLaunchSlots) delete persisted.subagentLaunchSlots;
  await writePrivateAtomicSettings(storageFile, persisted);
  return settings;
}

/**
 * Applies a settings patch against the latest on-disk snapshot and writes it
 * atomically. Returning undefined from the updater avoids an unnecessary write.
 */
export function updateWebuiSettings(updater, storageFile = webuiSettingsFile()) {
  const queueKey = path.resolve(storageFile);
  const previous = webuiSettingsUpdateQueues.get(queueKey) || Promise.resolve();
  const currentUpdate = previous.catch(() => {}).then(async () => {
    await ensureDefaultSettingsMigration(storageFile);
    return withWebuiSettingsLock(storageFile, async () => {
      const rawCurrent = await readRawWebuiSettings(storageFile);
      const current = normalizeWebuiSettings(rawCurrent);
      const patch = await updater(current);
      if (patch === undefined) return current;
      return writeMergedWebuiSettings(rawCurrent, patch, storageFile);
    });
  });
  webuiSettingsUpdateQueues.set(queueKey, currentUpdate);
  return currentUpdate.finally(() => {
    if (webuiSettingsUpdateQueues.get(queueKey) === currentUpdate) webuiSettingsUpdateQueues.delete(queueKey);
  });
}

export async function writeWebuiSettings(patch, storageFile = webuiSettingsFile()) {
  return updateWebuiSettings(() => patch, storageFile);
}
