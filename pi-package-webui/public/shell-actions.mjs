function paletteText(value) {
  return String(value || "").toLowerCase();
}

function actionSearchText(item) {
  const aliases = Array.isArray(item.aliases) ? item.aliases.join(" ") : item.aliases;
  return [item.label, item.description, item.kind, item.keywords, aliases].map(paletteText).join(" ");
}

function actionScore(item, tokens) {
  const label = paletteText(item.label);
  let score = 0;
  for (const token of tokens) {
    if (label.startsWith(token)) score += 40;
    else if (label.replace(/^\//, "").startsWith(token)) score += 36;
    else if (new RegExp(`(^|[\\s/_-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label)) score += 24;
    else if (label.includes(token)) score += 12;
    else score += 1;
  }
  return score;
}

/** Return matching records in palette order, retaining their identity and availability. */
export function filterActionItems(items, query, { limit = 80 } = {}) {
  const normalizedQuery = paletteText(query).trim();
  if (!normalizedQuery) return items.slice(0, limit);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return items
    .map((item, index) => {
      const text = actionSearchText(item);
      return { item, index, score: tokens.every((token) => text.includes(token)) ? actionScore(item, tokens) : -1 };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Check captured invocation identity only; the caller owns execution and server authorization. */
export function checkActionTarget(action, currentTarget) {
  if (action?.available === false) {
    return {
      ok: false,
      reason: nonemptyString(action.unavailableReason) ? action.unavailableReason : "This action is currently unavailable.",
    };
  }

  const scope = action?.scope;
  if (scope === "browser" || scope === "server") return { ok: true, reason: "" };
  if (scope !== "session" && scope !== "project" && scope !== "tab") {
    return { ok: false, reason: "This action has a missing or unknown scope." };
  }

  const target = action.target;
  if (!nonemptyString(target?.tabId)) return { ok: false, reason: "This action is missing its target tab." };

  if (scope === "tab") {
    if (!Array.isArray(currentTarget?.liveTabIds) || !currentTarget.liveTabIds.includes(target.tabId)) {
      return { ok: false, reason: "The target tab is no longer available." };
    }
    return { ok: true, reason: "" };
  }

  if (!Number.isInteger(target.generation) || target.generation < 0) {
    return { ok: false, reason: "This action is missing a valid session generation." };
  }
  if (target.tabId !== currentTarget?.tabId) {
    return { ok: false, reason: "The active tab has changed. Choose the action again." };
  }
  if (target.generation !== currentTarget?.generation) {
    return { ok: false, reason: "The session has changed. Choose the action again." };
  }
  if (scope === "project") {
    if (!nonemptyString(target.cwd)) return { ok: false, reason: "This action is missing its target working directory." };
    if (target.cwd !== currentTarget?.cwd) {
      return { ok: false, reason: "The working directory has changed. Choose the action again." };
    }
  }
  return { ok: true, reason: "" };
}
