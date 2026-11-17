import assert from "node:assert/strict";
import {
  addLaunchSlot,
  cloneLaunchSlotRoles,
  launchSlotRolesEqual,
  removeLaunchSlot,
  subagentLaunchSlotSaveState,
  updateLaunchSlot,
} from "../public/subagent-launch-slot-state.mjs";

assert.deepEqual(
  subagentLaunchSlotSaveState({ hasConfig: true, hasDraft: true, dirty: true, activeConfigTab: true }),
  { disabled: false, reason: "Ready to save." },
  "a dirty draft owned by the active tab should be saveable",
);
assert.deepEqual(
  subagentLaunchSlotSaveState({ hasConfig: true, hasDraft: true, dirty: true, activeConfigTab: false }),
  { disabled: true, reason: "Switch back to the thread where these changes were made to save them." },
  "a dirty draft should explain that its owning tab must be active",
);
assert.deepEqual(
  subagentLaunchSlotSaveState({ hasConfig: true, hasDraft: true, dirty: true, loading: true, activeConfigTab: true }),
  { disabled: true, reason: "Wait for agent models to finish loading." },
  "loading should temporarily block saving with an explanation",
);
assert.deepEqual(
  subagentLaunchSlotSaveState({ hasConfig: true, hasDraft: true, dirty: true, saving: true, activeConfigTab: true }),
  { disabled: true, reason: "Saving agent models…" },
  "saving should remain disabled while the request is in progress",
);
assert.deepEqual(
  subagentLaunchSlotSaveState({ hasConfig: true, hasDraft: true, activeConfigTab: true }),
  { disabled: true, reason: "Change a model or thinking preset to enable saving." },
  "a clean draft should explain how saving becomes available",
);
assert.deepEqual(
  subagentLaunchSlotSaveState(),
  { disabled: true, reason: "Agent model configuration is not available for this thread." },
  "missing configuration should explain why saving is unavailable",
);

const initial = {
  reviewer: [{ id: "reviewer:base", model: "anthropic/reviewer", thinking: "high" }],
  worker: [{ id: "worker:base", model: null, thinking: null }],
};
const snapshot = cloneLaunchSlotRoles(initial);

const added = addLaunchSlot(initial, "reviewer", "reviewer:base", {
  slotsPerRole: 8,
  totalSlots: 32,
  createId: () => "reviewer:slot-1",
});
assert.ok(added, "an available role capacity should create a slot");
assert.deepEqual(added.slot, { id: "reviewer:slot-1", model: "anthropic/reviewer", thinking: "high" }, "added slots should copy the source draft");
assert.equal(initial.reviewer.length, 1, "adding should not mutate the saved draft");
assert.equal(launchSlotRolesEqual(initial, added.roles), false, "a new slot should mark the draft dirty");

const changedModel = updateLaunchSlot(added.roles, "reviewer", "reviewer:slot-1", { model: null });
assert.deepEqual(changedModel.reviewer[1], { id: "reviewer:slot-1", model: null, thinking: null }, "inheriting a model should reset thinking inheritance");

const removed = removeLaunchSlot(added.roles, "reviewer", "reviewer:slot-1");
assert.ok(removed, "added slots should be removable");
assert.equal(removed.focusSlotId, "reviewer:base", "removal should return a sensible preceding focus target");
assert.equal(launchSlotRolesEqual(snapshot, removed.roles), true, "removing the added slot should restore a clean draft");
assert.equal(removeLaunchSlot(initial, "reviewer", "reviewer:base"), null, "base slots must remain non-removable");
assert.equal(addLaunchSlot(initial, "reviewer", "reviewer:base", { totalSlots: 2, createId: () => "reviewer:slot-2" }), null, "the total cap should prevent extra slots");

console.log("subagent-launch-slot-state.test.mjs passed");
