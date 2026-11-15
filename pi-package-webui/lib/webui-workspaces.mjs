import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const WEBUI_WORKSPACES_VERSION = 1;
export const WEBUI_WORKSPACE_LIMIT = 20;
export const WEBUI_WORKSPACE_TAB_LIMIT = 30;

const WEBUI_WORKSPACES_FILE_ENV = "PI_WEBUI_WORKSPACES_FILE";
const workspaceUpdateQueues = new Map();

function boundedString(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizedId(value, seenIds = new Set()) {
  const id = boundedString(value, 128);
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id) || seenIds.has(id)) return undefined;
  seenIds.add(id);
  return id;
}

function normalizedSavedAt(value) {
  const savedAt = boundedString(value, 128);
  return savedAt && Number.isFinite(Date.parse(savedAt)) ? savedAt : undefined;
}

function workspaceDocument(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function webuiWorkspacesFile(env = process.env) {
  if (env[WEBUI_WORKSPACES_FILE_ENV]) return path.resolve(String(env[WEBUI_WORKSPACES_FILE_ENV]).replace(/^~(?=$|[\\/])/, homedir()));
  const configRoot = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(configRoot, "pi-webui", "workspaces.json");
}

export function normalizeWorkspaceTabDescriptor(value, seenIds = new Set()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = normalizedId(value.id, seenIds);
  const cwd = boundedString(value.cwd || value.workspace?.cwd, 4096);
  if (!id || !cwd) return null;
  const descriptor = {
    id,
    title: boundedString(value.title, 160),
    titleSource: ["explicit", "auto", "default"].includes(value.titleSource) ? value.titleSource : undefined,
    cwd,
    ...(value.workspaceKind !== undefined ? { workspaceKind: value.workspaceKind } : {}),
    ...(value.noProjectId !== undefined ? { noProjectId: value.noProjectId } : {}),
    conversationStarted: value.conversationStarted === true,
    sessionFile: boundedString(value.sessionFile || value.state?.sessionFile, 4096),
  };
  if (Number.isInteger(value.index) && value.index > 0) descriptor.index = value.index;
  return descriptor;
}

export function normalizeWorkspaceGroups(value, tabIds = new Set()) {
  if (!Array.isArray(value)) return [];
  const groups = [];
  const seen = new Set();
  for (const item of value.slice(0, WEBUI_WORKSPACE_TAB_LIMIT)) {
    const title = boundedString(item?.title, 160);
    if (!title) continue;
    const tabIdsForGroup = [];
    for (const tabId of Array.isArray(item?.tabIds) ? item.tabIds.slice(0, WEBUI_WORKSPACE_TAB_LIMIT) : []) {
      const normalized = boundedString(tabId, 128);
      if (!normalized || !tabIds.has(normalized) || tabIdsForGroup.includes(normalized)) continue;
      tabIdsForGroup.push(normalized);
    }
    if (!tabIdsForGroup.length) continue;
    const key = `${title}\u0000${tabIdsForGroup.join("\u0000")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ title, tabIds: tabIdsForGroup });
  }
  return groups;
}

export function normalizeWebuiWorkspace(value, seenWorkspaceIds = new Set()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = normalizedId(value.id, seenWorkspaceIds);
  const name = boundedString(value.name, 160);
  const savedAt = normalizedSavedAt(value.savedAt);
  const seenTabIds = new Set();
  const tabs = (Array.isArray(value.tabs) ? value.tabs : [])
    .slice(0, WEBUI_WORKSPACE_TAB_LIMIT)
    .map((item) => normalizeWorkspaceTabDescriptor(item, seenTabIds))
    .filter(Boolean);
  if (!id || !name || !savedAt || !tabs.length) return null;
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const activeTabId = boundedString(value.activeTabId, 128);
  return {
    id,
    name,
    savedAt,
    activeTabId: activeTabId && tabIds.has(activeTabId) ? activeTabId : null,
    tabs,
    groups: normalizeWorkspaceGroups(value.groups, tabIds),
  };
}

export function normalizeWebuiWorkspaces(value) {
  const source = workspaceDocument(value);
  const seenWorkspaceIds = new Set();
  const workspaces = (Array.isArray(source.workspaces) ? source.workspaces : [])
    .map((item) => normalizeWebuiWorkspace(item, seenWorkspaceIds))
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.savedAt) - Date.parse(right.savedAt))
    .slice(-WEBUI_WORKSPACE_LIMIT);
  return { version: WEBUI_WORKSPACES_VERSION, workspaces };
}

export function workspaceMetadata(workspace) {
  const normalized = normalizeWebuiWorkspace(workspace);
  if (!normalized) return null;
  return {
    id: normalized.id,
    name: normalized.name,
    savedAt: normalized.savedAt,
    tabCount: normalized.tabs.length,
    groupCount: normalized.groups.length,
    cwds: [...new Set(normalized.tabs.map((tab) => tab.cwd))],
  };
}

function warningMessage(storageFile, error) {
  return `failed to read Pi Web UI workspaces at ${storageFile}; treating it as empty: ${error instanceof Error ? error.message : String(error)}`;
}

async function readWorkspaceDocument(storageFile, { onWarning = console.warn } = {}) {
  try {
    const parsed = JSON.parse(await readFile(storageFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("workspace document must be an object");
    if (parsed.version !== undefined && parsed.version !== WEBUI_WORKSPACES_VERSION) {
      throw new Error(`unsupported workspace document version ${JSON.stringify(parsed.version)}`);
    }
    if (parsed.workspaces !== undefined && !Array.isArray(parsed.workspaces)) throw new Error("workspaces must be an array");
    return normalizeWebuiWorkspaces(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeWebuiWorkspaces({});
    onWarning?.(warningMessage(storageFile, error));
    return normalizeWebuiWorkspaces({});
  }
}

export async function readWebuiWorkspaces(storageFile = webuiWorkspacesFile(), options = {}) {
  return readWorkspaceDocument(storageFile, options);
}

export async function listWebuiWorkspaces(storageFile = webuiWorkspacesFile(), options = {}) {
  const document = await readWorkspaceDocument(storageFile, options);
  return document.workspaces.slice().reverse().map(workspaceMetadata).filter(Boolean);
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

async function writeWorkspaceDocument(document, storageFile) {
  const normalized = normalizeWebuiWorkspaces(document);
  await mkdir(path.dirname(storageFile), { recursive: true });
  const temporaryFile = `${storageFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await renameWithWindowsRetry(temporaryFile, storageFile);
  } catch (error) {
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
  return normalized;
}

function enqueueWorkspaceUpdate(storageFile, update) {
  const queueKey = path.resolve(storageFile);
  const previous = workspaceUpdateQueues.get(queueKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(update);
  workspaceUpdateQueues.set(queueKey, current);
  return current.finally(() => {
    if (workspaceUpdateQueues.get(queueKey) === current) workspaceUpdateQueues.delete(queueKey);
  });
}

async function mutateWorkspaces(updater, storageFile) {
  return enqueueWorkspaceUpdate(storageFile, async () => {
    const document = await readWorkspaceDocument(storageFile);
    const result = await updater(document);
    if (result?.write !== false) await writeWorkspaceDocument(document, storageFile);
    return result?.data;
  });
}

function automaticWorkspaceName(tabs, savedAt) {
  const cwd = tabs[0]?.cwd || "";
  const base = path.basename(cwd) || "workspace";
  return `${base} ${savedAt.slice(0, 10)}`.slice(0, 160);
}

function normalizedNewWorkspace({ name, tabs, groups, activeTabId, savedAt = new Date().toISOString(), id = `ws-${randomUUID()}` }) {
  const seenTabIds = new Set();
  const normalizedTabs = (Array.isArray(tabs) ? tabs : [])
    .slice(0, WEBUI_WORKSPACE_TAB_LIMIT)
    .map((item) => normalizeWorkspaceTabDescriptor(item, seenTabIds))
    .filter(Boolean);
  if (!normalizedTabs.length) throw new Error("A workspace requires at least one tab");
  const tabIds = new Set(normalizedTabs.map((tab) => tab.id));
  const normalizedName = boundedString(name, 160) || automaticWorkspaceName(normalizedTabs, savedAt);
  return {
    id,
    name: normalizedName,
    savedAt,
    activeTabId: tabIds.has(boundedString(activeTabId, 128)) ? boundedString(activeTabId, 128) : null,
    tabs: normalizedTabs,
    groups: normalizeWorkspaceGroups(groups, tabIds),
  };
}

export async function saveWebuiWorkspace({ name, tabs, groups, activeTabId, overwrite = false } = {}, storageFile = webuiWorkspacesFile()) {
  return mutateWorkspaces((document) => {
    const savedAt = new Date().toISOString();
    const candidate = normalizedNewWorkspace({ name, tabs, groups, activeTabId, savedAt });
    const existingIndex = document.workspaces.findIndex((workspace) => workspace.name === candidate.name);
    if (existingIndex !== -1 && overwrite !== true) {
      const error = new Error("A workspace with that name already exists");
      error.code = "WORKSPACE_NAME_CONFLICT";
      throw error;
    }
    const existing = existingIndex === -1 ? null : document.workspaces[existingIndex];
    const workspace = existing ? { ...candidate, id: existing.id } : candidate;
    const evicted = [];
    if (existingIndex !== -1) document.workspaces.splice(existingIndex, 1);
    document.workspaces.push(workspace);
    document.workspaces.sort((left, right) => Date.parse(left.savedAt) - Date.parse(right.savedAt));
    while (document.workspaces.length > WEBUI_WORKSPACE_LIMIT) {
      const removed = document.workspaces.shift();
      const metadata = workspaceMetadata(removed);
      if (metadata) evicted.push(metadata);
    }
    return {
      data: {
        workspace: workspaceMetadata(workspace),
        workspaces: document.workspaces.slice().reverse().map(workspaceMetadata).filter(Boolean),
        evicted,
      },
    };
  }, storageFile);
}

export async function getWebuiWorkspace(id, storageFile = webuiWorkspacesFile()) {
  const requestedId = boundedString(id, 128);
  if (!requestedId) return null;
  const document = await readWorkspaceDocument(storageFile);
  return document.workspaces.find((workspace) => workspace.id === requestedId) || null;
}

export async function deleteWebuiWorkspace(id, storageFile = webuiWorkspacesFile()) {
  const requestedId = boundedString(id, 128);
  if (!requestedId) return null;
  return mutateWorkspaces((document) => {
    const index = document.workspaces.findIndex((workspace) => workspace.id === requestedId);
    if (index === -1) return { write: false, data: null };
    document.workspaces.splice(index, 1);
    return {
      data: {
        deletedId: requestedId,
        workspaces: document.workspaces.slice().reverse().map(workspaceMetadata).filter(Boolean),
      },
    };
  }, storageFile);
}
