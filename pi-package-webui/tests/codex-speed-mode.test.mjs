import assert from "node:assert/strict";
import {
  codexSpeedModeFromData,
  codexSpeedModeFromIntent,
  codexSpeedModeFromStatus,
  codexSpeedModeLabel,
  isCodexSpeedMode,
} from "../public/codex-speed-mode.mjs";

for (const [status, mode] of [["off", "normal"], ["on", "fast"], ["ultrafast", "ultrafast"]]) {
  assert.equal(codexSpeedModeFromStatus(status), mode);
  assert.equal(codexSpeedModeFromStatus(` ${status.toUpperCase()} `), mode);
  assert.equal(codexSpeedModeFromIntent({ mode }), mode);
  assert.equal(codexSpeedModeFromIntent({ mode, enabled: mode !== "normal" }), mode);
  assert.equal(codexSpeedModeFromData({ mode, enabled: mode !== "normal", statusKnown: true }), mode);
  assert.equal(isCodexSpeedMode(mode), true);
}
for (const value of [undefined, null, "", "fast", "normal", "Fast mode: on", "on now", "ultra-fast", {}, 1]) {
  assert.equal(codexSpeedModeFromStatus(value), null);
}
assert.equal(codexSpeedModeFromIntent({ enabled: true }), "fast");
assert.equal(codexSpeedModeFromIntent({ enabled: false }), "normal");
for (const body of [{}, undefined, null, { enabled: "yes" }, { mode: "turbo" }, { mode: null, enabled: true },
  { mode: "ultrafast", enabled: false }, { mode: "normal", enabled: true }, { mode: "fast", enabled: "yes" }]) {
  assert.throws(() => codexSpeedModeFromIntent(body), TypeError);
}
assert.equal(codexSpeedModeFromData({ enabled: true, statusKnown: true }), "fast");
assert.equal(codexSpeedModeFromData({ enabled: false, statusKnown: true }), "normal");
assert.equal(codexSpeedModeFromData({ enabled: true, statusKnown: false }), null);
assert.equal(codexSpeedModeFromData({ mode: "turbo", enabled: true, statusKnown: true }), null);
assert.equal(codexSpeedModeFromData(undefined), null);
assert.equal(codexSpeedModeLabel("normal"), "Normal");
assert.equal(codexSpeedModeLabel("fast"), "Fast");
assert.equal(codexSpeedModeLabel("ultrafast"), "Ultrafast");
assert.equal(codexSpeedModeLabel(null), "Unknown");
console.log("codex-speed-mode.test.mjs passed");
