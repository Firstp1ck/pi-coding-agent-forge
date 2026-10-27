import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_RESOURCE_NAME_LENGTH = 256;
const MAX_PROVIDER_LENGTH = 160;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_PROFILES = 512;
const SETTINGS_VERSION = 8;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const INVALID_RECORD_GRACE_MS = 1_000;
const updateQueues = new Map();

// The injected T3 extension binds the launch request before session_start.
// A bound marker inherited by a child must never confer ownership on that child.
export function isT3ResourceProfileContext(ctx, env = process.env, pid = process.pid) {
  return ctx.mode === "rpc" && env.T3_PI_RESOURCE_PROFILES === `t3-v1:${pid}`;
}

export function cleanResourceString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function normalizeResourceNameList(value) {
  if (!Array.isArray(value)) return null;
  const names = [];
  const seen = new Set();
  for (const item of value) {
    const name = cleanResourceString(item, MAX_RESOURCE_NAME_LENGTH);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function resourceObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeResourceSelection(value, key) {
  const source = resourceObject(value);
  return { ...source, [key]: normalizeResourceNameList(source[key]) };
}

export function normalizeModelProfiles(value) {
  if (!Array.isArray(value)) return [];
  const profiles = [];
  const indexes = new Map();
  for (const candidate of value.slice(0, MAX_MODEL_PROFILES)) {
    const source = resourceObject(candidate);
    const provider = cleanResourceString(source.provider, MAX_PROVIDER_LENGTH);
    const modelId = cleanResourceString(source.modelId, MAX_MODEL_ID_LENGTH);
    if (!provider || !modelId) continue;
    const profile = {
      ...source,
      provider,
      modelId,
      tools: normalizeResourceSelection(source.tools, "enabledTools"),
      skills: normalizeResourceSelection(source.skills, "enabledSkills"),
    };
    const key = `${provider}\0${modelId}`;
    if (profile.tools.enabledTools === null && profile.skills.enabledSkills === null) {
      const existingIndex = indexes.get(key);
      if (existingIndex !== undefined) {
        profiles.splice(existingIndex, 1);
        indexes.clear();
        profiles.forEach((entry, index) => indexes.set(`${entry.provider}\0${entry.modelId}`, index));
      }
      continue;
    }
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, profiles.length);
      profiles.push(profile);
    } else {
      profiles[existingIndex] = profile;
    }
  }
  return profiles;
}

export function normalizeResourceDefaults(value) {
  const source = resourceObject(value);
  return {
    ...source,
    tools: normalizeResourceSelection(source.tools, "enabledTools"),
    skills: normalizeResourceSelection(source.skills, "enabledSkills"),
    modelProfiles: normalizeModelProfiles(source.modelProfiles),
  };
}

export function exactModelProfile(resourceDefaults, provider, modelId) {
  if (!provider || !modelId) return null;
  return normalizeModelProfiles(resourceDefaults?.modelProfiles)
    .find((profile) => profile.provider === provider && profile.modelId === modelId) || null;
}

/** @param {string[] | null} runtimeDefault */
export function resolveResourceSelection(resourceDefaults, resourceType, provider, modelId, runtimeDefault = null) {
  const selectionKey = resourceType === "tools" ? "enabledTools" : "enabledSkills";
  const profile = exactModelProfile(resourceDefaults, provider, modelId);
  const modelSelection = normalizeResourceNameList(profile?.[resourceType]?.[selectionKey]);
  if (modelSelection !== null) return { names: modelSelection, source: "model" };
  const globalSelection = normalizeResourceNameList(resourceDefaults?.[resourceType]?.[selectionKey]);
  if (globalSelection !== null) return { names: globalSelection, source: "global" };
  return { names: normalizeResourceNameList(runtimeDefault), source: "runtime" };
}

export function branchResourceDirective(entryData, resourceType) {
  const data = resourceObject(entryData);
  if (data.version === 2 && data.mode === "inherit") return { pinned: false, names: null, legacyDisabledNames: null };
  const selectionKey = resourceType === "tools" ? "enabledTools" : "enabledSkills";
  const names = normalizeResourceNameList(data[selectionKey]);
  if (names !== null) return { pinned: true, names, legacyDisabledNames: null };
  if (resourceType === "skills") {
    const disabled = normalizeResourceNameList(data.disabledSkills);
    if (disabled !== null) return { pinned: true, names: null, legacyDisabledNames: disabled };
  }
  return { pinned: false, names: null, legacyDisabledNames: null };
}

export function setExactModelProfile(resourceDefaults, providerValue, modelIdValue, resourceType, enabledNames) {
  const provider = cleanResourceString(providerValue, MAX_PROVIDER_LENGTH);
  const modelId = cleanResourceString(modelIdValue, MAX_MODEL_ID_LENGTH);
  if (!provider || !modelId) throw new Error("Model resource profile requires an exact provider and model ID");
  const selectionKey = resourceType === "tools" ? "enabledTools" : "enabledSkills";
  const nextSelection = normalizeResourceNameList(enabledNames);
  const normalized = normalizeResourceDefaults(resourceDefaults);
  const profiles = normalized.modelProfiles.map((profile) => ({
    ...profile,
    tools: { ...profile.tools },
    skills: { ...profile.skills },
  }));
  const index = profiles.findIndex((profile) => profile.provider === provider && profile.modelId === modelId);
  const profile = index >= 0 ? profiles[index] : {
    provider,
    modelId,
    tools: { enabledTools: null },
    skills: { enabledSkills: null },
  };
  profile[resourceType][selectionKey] = nextSelection;
  if (profile.tools.enabledTools === null && profile.skills.enabledSkills === null) {
    if (index >= 0) profiles.splice(index, 1);
  } else if (index >= 0) profiles[index] = profile;
  else profiles.push(profile);
  return normalizeModelProfiles(profiles);
}

export function preserveUnavailableResourceNames(previousNames, visibleNames, selectedVisibleNames) {
  const visible = new Set(normalizeResourceNameList(visibleNames) || []);
  const selected = normalizeResourceNameList(selectedVisibleNames) || [];
  const unavailable = (normalizeResourceNameList(previousNames) || []).filter((name) => !visible.has(name));
  return normalizeResourceNameList([...selected, ...unavailable]) || [];
}

export function resourceSettingsFile(env = process.env) {
  if (env.PI_WEBUI_SETTINGS_FILE) return path.resolve(String(env.PI_WEBUI_SETTINGS_FILE).replace(/^~(?=$|[\\/])/, homedir()));
  return path.join(homedir(), ".pi", "webui", "settings.json");
}

async function readRawSettings(storageFile) {
  try {
    const value = JSON.parse(await readFile(storageFile, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("settings must contain an object");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read resource settings at ${storageFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readResourceDefaults(storageFile = resourceSettingsFile()) {
  return normalizeResourceDefaults((await readRawSettings(storageFile)).resourceDefaults);
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

async function readLockRecords(lockDirectory) {
  const names = (await readdir(lockDirectory)).filter((name) => name.endsWith(".json")).sort();
  const records = await Promise.all(names.map(async (name) => {
    const recordFile = path.join(lockDirectory, name);
    try {
      const [value, fileStat] = await Promise.all([
        readFile(recordFile, "utf8").then((text) => JSON.parse(text)),
        stat(recordFile),
      ]);
      return {
        ...value,
        name,
        recordFile,
        mtimeMs: fileStat.mtimeMs,
        valid: Number.isSafeInteger(value?.pid) && value.pid > 0
          && typeof value?.token === "string" && value.token.length > 0
          && ["pending", "active"].includes(value?.state),
      };
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      const fileStat = await stat(recordFile).catch(() => undefined);
      return { name, recordFile, mtimeMs: fileStat?.mtimeMs, valid: false };
    }
  }));
  return records.filter(Boolean);
}

async function writeLockRecord(recordFile, value) {
  const temporaryFile = `${recordFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await open(temporaryFile, "wx", 0o600).then(async (handle) => {
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  await rename(temporaryFile, recordFile);
}

async function withSettingsLock(storageFile, operation) {
  await mkdir(path.dirname(storageFile), { recursive: true, mode: 0o700 });
  const lockDirectory = `${storageFile}.lock`;
  await mkdir(lockDirectory, { mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const createdAt = Date.now();
  const token = `${process.pid}-${createdAt}-${Math.random().toString(16).slice(2)}`;
  const recordFile = path.join(lockDirectory, `${token}.json`);
  const ownRecord = { pid: process.pid, token, state: "pending", createdAt };
  await open(recordFile, "wx", 0o600).then(async (handle) => {
    try {
      await handle.writeFile(`${JSON.stringify(ownRecord)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  try {
    while (true) {
      const records = await readLockRecords(lockDirectory);
      let removed = false;
      for (const record of records) {
        const age = Number.isFinite(record.mtimeMs) ? Date.now() - record.mtimeMs : 0;
        if ((record.valid && lockOwnerIsDead(record.pid)) || (!record.valid && age >= INVALID_RECORD_GRACE_MS)) {
          await rm(record.recordFile, { force: true });
          removed = true;
        }
      }
      if (removed) continue;
      const active = records.filter((record) => record.valid && record.state === "active");
      if (active.length === 1 && active[0].token === token) break;
      if (active.length === 0 && records[0]?.token === token) {
        ownRecord.state = "active";
        await writeLockRecord(recordFile, ownRecord);
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the resource settings lock");
      await delay(LOCK_RETRY_MS);
    }
    return await operation();
  } finally {
    await rm(recordFile, { force: true });
    await rmdir(lockDirectory).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
    });
  }
}

async function writeRawSettings(storageFile, value) {
  await mkdir(path.dirname(storageFile), { recursive: true, mode: 0o700 });
  const temporaryFile = path.join(path.dirname(storageFile), `.${path.basename(storageFile)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporaryFile, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryFile, storageFile);
}

export function updateResourceDefaults(updater, storageFile = resourceSettingsFile()) {
  const queueKey = path.resolve(storageFile);
  const previous = updateQueues.get(queueKey) || Promise.resolve();
  const update = previous.catch(() => {}).then(() => withSettingsLock(storageFile, async () => {
    const raw = await readRawSettings(storageFile);
    const current = normalizeResourceDefaults(raw.resourceDefaults);
    const next = await updater(current);
    if (next === undefined) return current;
    const resourceDefaults = normalizeResourceDefaults(next);
    await writeRawSettings(storageFile, {
      ...raw,
      version: Math.max(SETTINGS_VERSION, Number.isInteger(raw.version) ? raw.version : 0),
      resourceDefaults,
    });
    return resourceDefaults;
  }));
  updateQueues.set(queueKey, update);
  return update.finally(() => {
    if (updateQueues.get(queueKey) === update) updateQueues.delete(queueKey);
  });
}
