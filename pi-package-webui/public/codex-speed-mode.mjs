export function isCodexSpeedMode(value) {
  return value === "normal" || value === "fast" || value === "ultrafast";
}

export function codexSpeedModeFromStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "off") return "normal";
  if (status === "on") return "fast";
  if (status === "ultrafast") return "ultrafast";
  return null;
}

export function codexSpeedModeFromData(data) {
  if (Object.hasOwn(data || {}, "mode")) return isCodexSpeedMode(data.mode) ? data.mode : null;
  return data?.statusKnown === true ? (data.enabled === true ? "fast" : "normal") : null;
}

/** Legacy boolean writes select Normal or Fast; an explicit mode must not contradict them. */
export function codexSpeedModeFromIntent(body) {
  if (Object.hasOwn(body || {}, "mode")) {
    if (!isCodexSpeedMode(body.mode)) throw new TypeError("Codex speed requires mode normal, fast, or ultrafast");
    if (Object.hasOwn(body, "enabled") && (typeof body.enabled !== "boolean" || body.enabled !== (body.mode !== "normal"))) {
      throw new TypeError("Codex speed mode and enabled must agree");
    }
    return body.mode;
  }
  if (typeof body?.enabled !== "boolean") throw new TypeError("Codex speed requires an explicit mode or enabled boolean");
  return body.enabled ? "fast" : "normal";
}

export function codexSpeedModeLabel(mode) {
  if (mode === "normal") return "Normal";
  if (mode === "fast") return "Fast";
  if (mode === "ultrafast") return "Ultrafast";
  return "Unknown";
}
