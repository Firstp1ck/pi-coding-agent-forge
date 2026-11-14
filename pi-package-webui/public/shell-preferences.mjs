import { isMobileShellV2Enabled } from "./mobile-shell-state.mjs";

export const SHELL_PREFERENCES_STORAGE_KEY = "pi-webui-shell-preferences-v1";

function defaultPreferences() {
  return { v: 1, desktopLayout: "classic" };
}

function normalizePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1) return null;
  if (value.desktopLayout !== "classic" && value.desktopLayout !== "focused") return null;
  const normalized = { v: 1, desktopLayout: value.desktopLayout };
  if (Object.hasOwn(value, "navigation")) {
    if (value.navigation !== "left" && value.navigation !== "top") return null;
    normalized.navigation = value.navigation;
  }
  if (Object.hasOwn(value, "navCollapsed")) {
    if (typeof value.navCollapsed !== "boolean") return null;
    normalized.navCollapsed = value.navCollapsed;
  }
  if (Object.hasOwn(value, "pinnedActions")) {
    if (!Array.isArray(value.pinnedActions)) return null;
    const pins = new Set();
    for (const id of value.pinnedActions) {
      if (typeof id !== "string" || /^[a-z][\x21-\x7e]{0,511}$/i.exec(id)?.[0] !== id) return null;
      pins.add(id);
      if (pins.size > 20) return null;
    }
    normalized.pinnedActions = [...pins];
  }
  if (Object.hasOwn(value, "inspectorWidth")) {
    if (!Number.isInteger(value.inspectorWidth) || value.inspectorWidth < 240 || value.inspectorWidth > 640) return null;
    normalized.inspectorWidth = value.inspectorWidth;
  }
  return normalized;
}

/** Read only the preview record. Invalid and future records remain untouched. */
export function readShellPreferences(storage) {
  let raw;
  try {
    raw = storage.getItem(SHELL_PREFERENCES_STORAGE_KEY);
  } catch {
    return { status: "unavailable", value: defaultPreferences() };
  }
  if (raw === null) return { status: "absent", value: defaultPreferences() };
  try {
    const value = normalizePreferences(JSON.parse(raw));
    if (value) return { status: "valid", value };
  } catch {
    // A failed parse must not turn a read into a storage repair.
  }
  return { status: "invalid", value: defaultPreferences() };
}

/** Explicit writes store only validated preview fields; failures never escape to chat. */
export function writeShellPreferences(storage, value) {
  let normalized;
  try {
    normalized = normalizePreferences(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!normalized) return { ok: false, reason: "invalid" };
  try {
    storage.setItem(SHELL_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export function resolveShellMode({
  recovery = false,
  viewportMode = "desktop",
  desktopLayout = "classic",
  phoneMode = "legacy",
  tabletMode = "legacy",
} = {}) {
  if (recovery === true) return "classic";
  if (viewportMode === "phone" || viewportMode === "tablet") {
    if (!isMobileShellV2Enabled(phoneMode, viewportMode, tabletMode)) return "classic";
    return viewportMode === "phone" ? "mobile-v2" : "tablet-v2";
  }
  return viewportMode === "desktop" && desktopLayout === "focused" ? "focused" : "classic";
}
