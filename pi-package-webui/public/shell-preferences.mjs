import { isMobileShellV2Enabled } from "./mobile-shell-state.mjs";

export const SHELL_PREFERENCES_STORAGE_KEY = "pi-webui-shell-preferences-v1";

function defaultPreferences() {
  return { v: 1, desktopLayout: "classic" };
}

function normalizePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1) return null;
  if (value.desktopLayout !== "classic" && value.desktopLayout !== "focused") return null;
  return { v: 1, desktopLayout: value.desktopLayout };
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

/** Explicit writes store only v and desktopLayout; failures never escape to chat. */
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
