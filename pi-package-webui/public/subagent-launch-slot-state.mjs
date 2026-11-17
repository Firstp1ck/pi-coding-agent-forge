function cloneSlot(slot = {}) {
  return {
    id: String(slot.id || ""),
    model: typeof slot.model === "string" ? slot.model : null,
    thinking: typeof slot.thinking === "string" ? slot.thinking : null,
  };
}

export function cloneLaunchSlotRoles(roles = {}) {
  return Object.fromEntries(Object.entries(roles || {}).map(([roleId, slots]) => [
    roleId,
    Array.isArray(slots) ? slots.map(cloneSlot) : [],
  ]));
}

export function subagentLaunchSlotSaveState({
  hasConfig = false,
  hasDraft = false,
  dirty = false,
  loading = false,
  saving = false,
  activeConfigTab = false,
} = {}) {
  if (saving) return { disabled: true, reason: "Saving agent models…" };
  if (loading) return { disabled: true, reason: "Wait for agent models to finish loading." };
  if (!hasConfig || !hasDraft) return { disabled: true, reason: "Agent model configuration is not available for this thread." };
  if (!dirty) return { disabled: true, reason: "Change a model or thinking preset to enable saving." };
  if (!activeConfigTab) return { disabled: true, reason: "Switch back to the thread where these changes were made to save them." };
  return { disabled: false, reason: "Ready to save." };
}

export function launchSlotRolesEqual(left, right) {
  const leftRoles = Object.keys(left || {}).sort();
  const rightRoles = Object.keys(right || {}).sort();
  if (leftRoles.length !== rightRoles.length || leftRoles.some((roleId, index) => roleId !== rightRoles[index])) return false;
  return leftRoles.every((roleId) => {
    const leftSlots = Array.isArray(left?.[roleId]) ? left[roleId] : [];
    const rightSlots = Array.isArray(right?.[roleId]) ? right[roleId] : [];
    return leftSlots.length === rightSlots.length && leftSlots.every((slot, index) => (
      slot?.id === rightSlots[index]?.id
      && (slot?.model || null) === (rightSlots[index]?.model || null)
      && (slot?.thinking || null) === (rightSlots[index]?.thinking || null)
    ));
  });
}

export function updateLaunchSlot(roles, roleId, slotId, patch = {}) {
  const next = cloneLaunchSlotRoles(roles);
  const slots = next[roleId];
  const index = Array.isArray(slots) ? slots.findIndex((slot) => slot.id === slotId) : -1;
  if (index < 0) return next;
  const model = Object.hasOwn(patch, "model") ? (patch.model || null) : slots[index].model;
  const thinking = model && Object.hasOwn(patch, "thinking") ? (patch.thinking || null) : model ? slots[index].thinking : null;
  slots[index] = { ...slots[index], model, thinking };
  return next;
}

export function addLaunchSlot(roles, roleId, sourceSlotId, { slotsPerRole = 8, totalSlots = 32, createId } = {}) {
  const next = cloneLaunchSlotRoles(roles);
  const slots = next[roleId];
  if (!Array.isArray(slots) || slots.length >= slotsPerRole) return null;
  const total = Object.values(next).reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0);
  if (total >= totalSlots) return null;
  const source = slots.find((slot) => slot.id === sourceSlotId) || slots[slots.length - 1];
  const id = typeof createId === "function" ? String(createId(roleId, slots) || "") : "";
  if (!id || slots.some((slot) => slot.id === id)) return null;
  const slot = { id, model: source?.model || null, thinking: source?.model ? source.thinking || null : null };
  slots.push(slot);
  return { roles: next, slot };
}

export function removeLaunchSlot(roles, roleId, slotId, baseSlotId = `${roleId}:base`) {
  if (slotId === baseSlotId) return null;
  const next = cloneLaunchSlotRoles(roles);
  const slots = next[roleId];
  const index = Array.isArray(slots) ? slots.findIndex((slot) => slot.id === slotId) : -1;
  if (index < 0) return null;
  const [removed] = slots.splice(index, 1);
  return { roles: next, removed, focusSlotId: slots[Math.max(0, index - 1)]?.id || null };
}
