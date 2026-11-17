export const CODEX_USAGE_REFRESH_MS = 5 * 60 * 1000;
export const CODEX_USAGE_RENDER_TICK_MS = 30 * 1000;
export const CLAUDE_USAGE_REFRESH_MS = 5 * 60 * 1000;
export const CLAUDE_USAGE_RENDER_TICK_MS = 30 * 1000;

export function formatCodexPlanType(value) {
  const text = String(value || "").trim();
  if (!text) return "unknown plan";
  const normalized = text.replace(/[\s_-]+/g, "").toLowerCase();
  if (normalized === "prolite") return "Usage";
  return text.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatCodexPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.max(0, Math.min(100, Math.round(number)))}%` : "—";
}

export function codexWindowDurationMinutes(window) {
  const minutes = Number(window?.windowDurationMins);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  const seconds = Number(window?.windowDurationSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : null;
}

export function formatCodexWindowDuration(window) {
  const minutes = codexWindowDurationMinutes(window);
  if (!minutes) return "window";
  if (minutes >= 280 && minutes <= 320) return "5h window";
  if (minutes >= 9500 && minutes <= 10550) return "weekly window";
  if (minutes >= 60 * 24) {
    const days = minutes / (60 * 24);
    return `${days >= 10 ? Math.round(days) : Number(days.toFixed(1))}d window`;
  }
  if (minutes >= 60) {
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(1))}h window`;
  }
  return `${Math.round(minutes)}m window`;
}

export function formatDurationParts(milliseconds) {
  if (!Number.isFinite(Number(milliseconds))) return "now";
  const totalMinutes = Math.max(0, Math.ceil(Number(milliseconds) / 60000));
  if (totalMinutes <= 1) return "<1m";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

export function codexWindowResetDate(window) {
  const resetAt = window?.resetsAt ? new Date(window.resetsAt) : null;
  if (resetAt && Number.isFinite(resetAt.getTime())) return resetAt;
  const resetAfterSeconds = Number(window?.resetAfterSeconds);
  if (Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0) return new Date(Date.now() + resetAfterSeconds * 1000);
  return null;
}

export function formatCodexReset(window) {
  const resetDate = codexWindowResetDate(window);
  if (!resetDate) return "reset unknown";
  const diff = resetDate.getTime() - Date.now();
  if (diff <= 0) return "resetting now";
  return `resets in ${formatDurationParts(diff)}`;
}

export function codexSnapshotName(snapshot) {
  return snapshot?.limitName || snapshot?.limitId || "codex";
}

export function codexUsageBuckets(data) {
  const buckets = [];
  const selected = data?.selected || data?.rateLimits || null;
  const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : selected ? [selected] : [];
  const selectedKey = selected?.limitId || selected?.limitName || "codex";
  const pushWindow = (snapshot, kind, window, { prefix } = {}) => {
    if (!window) return;
    const durationLabel = formatCodexWindowDuration(window);
    const baseLabel = kind === "secondary" && durationLabel === "window" ? "secondary window" : durationLabel;
    buckets.push({
      key: `${snapshot?.limitId || snapshot?.limitName || buckets.length}-${kind}`,
      label: prefix ? `${prefix} · ${baseLabel}` : baseLabel,
      window,
    });
  };

  if (selected) {
    pushWindow(selected, "primary", selected.primary);
    pushWindow(selected, "secondary", selected.secondary);
  }
  for (const snapshot of snapshots) {
    const key = snapshot?.limitId || snapshot?.limitName;
    if (!snapshot || snapshot === selected || key === selectedKey) continue;
    const name = codexSnapshotName(snapshot);
    pushWindow(snapshot, "primary", snapshot.primary, { prefix: name });
    pushWindow(snapshot, "secondary", snapshot.secondary, { prefix: name });
  }
  return buckets.slice(0, 6);
}

export function claudeUsageWindowFromProvider(window, capturedAt) {
  if (!window) return null;
  const resetAt = Number(window.resetAt);
  const resetAfterSeconds = Number(window.resetAfterSeconds);
  const resetsAt = Number.isFinite(resetAt) && resetAt >= 0
    ? new Date(resetAt).toISOString()
    : Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0
      ? new Date(capturedAt + resetAfterSeconds * 1000).toISOString()
      : undefined;
  return {
    label: window.label || "Usage window",
    usedPercent: window.usedPercent,
    ...(Number.isFinite(window.windowMinutes) ? { windowMinutes: window.windowMinutes } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

export function claudeUsageFromGitFooterPayload(payload) {
  const providerUsage = payload?.providerUsage;
  if (providerUsage?.provider !== "anthropic") return null;
  const capturedAt = Number(providerUsage.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return null;
  const windows = [providerUsage.primary, providerUsage.secondary]
    .map((window) => claudeUsageWindowFromProvider(window, capturedAt))
    .filter(Boolean);
  if (windows.length === 0) return null;
  return {
    available: true,
    providerId: "claude-code",
    source: "git-footer-status-provider-headers",
    fetchedAt: new Date(capturedAt).toISOString(),
    summary: "Live Anthropic subscription usage from provider response headers.",
    windows,
    activityTitle: "",
    activity: [],
    notes: [],
  };
}

export function claudeUsageResetDate(window) {
  const resetAt = window?.resetsAt ? new Date(window.resetsAt) : null;
  if (resetAt && Number.isFinite(resetAt.getTime())) return resetAt;
  const resetAfterSeconds = Number(window?.resetAfterSeconds);
  if (Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0) return new Date(Date.now() + resetAfterSeconds * 1000);
  return null;
}

export function formatClaudeUsageReset(window) {
  const resetDate = claudeUsageResetDate(window);
  if (resetDate) {
    const diff = resetDate.getTime() - Date.now();
    if (diff <= 0) return "resetting now";
    return `resets in ${formatDurationParts(diff)}`;
  }
  return window?.resetText ? `resets ${window.resetText}` : "reset unknown";
}

export function createActivityUsageController({
  document,
  nodes,
  api,
  getFooterPayload = () => null,
  onChange = () => {},
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
}) {
  let latestCodexUsage = null;
  let codexUsageError = null;
  let codexUsageLoading = false;
  let codexUsageRenderSignature = "";
  let latestClaudeUsage = null;
  let claudeUsageError = null;
  let claudeUsageLoading = false;
  let claudeUsageRenderSignature = "";
  let disposed = false;
  let started = false;
  let footerVersion = 0;
  const visible = { codex: true, claude: true };
  const refreshTimers = { codex: null, claude: null };
  const renderTimers = { codex: null, claude: null };
  const scheduleVersions = { codex: 0, claude: 0 };

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setText(node, text) {
    if (node.textContent !== String(text)) node.textContent = text;
  }

  function readOnly(value) {
    if (!value || typeof value !== "object") return value;
    if (value instanceof Error) return Object.freeze({ name: value.name, message: value.message });
    return Object.freeze(Array.isArray(value)
      ? value.map(readOnly)
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readOnly(item)])));
  }

  function codexUsageStructureSignature() {
    if (!latestCodexUsage) return JSON.stringify({ state: codexUsageLoading ? "loading" : codexUsageError ? "error" : "empty", error: codexUsageError?.message || String(codexUsageError || "") });
    return JSON.stringify({
      state: "data",
      plan: formatCodexPlanType(latestCodexUsage.planType),
      source: latestCodexUsage.source || "",
      sourceNotice: latestCodexUsage.sourceNotice || "",
      buckets: codexUsageBuckets(latestCodexUsage).map((bucket) => [bucket.key, bucket.label]),
      rateLimitReachedType: latestCodexUsage.rateLimitReachedType || "",
      error: codexUsageError?.message || String(codexUsageError || ""),
    });
  }

  function updateCodexUsageValues(box, buckets) {
    if (!latestCodexUsage || !box.querySelector(".codex-usage-summary")) return false;
    const fetched = box.querySelector(".codex-usage-fetched");
    if (fetched) setText(fetched, latestCodexUsage.fetchedAt ? `updated ${formatDurationParts(Date.now() - new Date(latestCodexUsage.fetchedAt).getTime())} ago` : "updated now");
    const rendered = [...box.querySelectorAll(".codex-usage-bucket[data-codex-usage-key]")];
    if (rendered.length !== buckets.length) return false;
    for (const bucket of buckets) {
      const item = rendered.find((node) => node.dataset.codexUsageKey === bucket.key);
      if (!item) return false;
      const usedPercent = Number(bucket.window?.usedPercent);
      const fillPercent = Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : 0;
      const percent = item.querySelector(".codex-usage-percent");
      const fill = item.querySelector(".codex-usage-meter-fill");
      const reset = item.querySelector(".codex-usage-reset");
      if (!percent || !fill || !reset) return false;
      setText(percent, formatCodexPercent(usedPercent));
      fill.style.width = `${fillPercent}%`;
      setText(reset, formatCodexReset(bucket.window));
    }
    return true;
  }

  function renderCodexUsage() {
    if (disposed) return;
    const box = nodes.codexUsageBox;
    if (!box) return;
    if (nodes.refreshCodexUsageButton) {
      nodes.refreshCodexUsageButton.disabled = codexUsageLoading;
      nodes.refreshCodexUsageButton.textContent = codexUsageLoading ? "Refreshing…" : "Refresh usage";
    }

    const buckets = codexUsageBuckets(latestCodexUsage);
    const structureSignature = codexUsageStructureSignature();
    if (structureSignature === codexUsageRenderSignature && (!latestCodexUsage || updateCodexUsageValues(box, buckets))) {
      box.classList.toggle("muted", !latestCodexUsage);
      return;
    }
    codexUsageRenderSignature = structureSignature;
    box.replaceChildren();
    box.classList.toggle("muted", !latestCodexUsage);

    if (!latestCodexUsage && codexUsageLoading) {
      box.textContent = "Checking Codex usage…";
      return;
    }
    if (!latestCodexUsage && codexUsageError) {
      const title = make("div", "codex-usage-unavailable", "Usage unavailable");
      const detail = make("div", "codex-usage-detail", codexUsageError.message || String(codexUsageError));
      box.append(title, detail);
      return;
    }
    if (!latestCodexUsage) {
      box.textContent = "Codex usage has not loaded yet.";
      return;
    }

    const header = make("div", "codex-usage-summary");
    header.append(
      make("span", "codex-usage-plan", formatCodexPlanType(latestCodexUsage.planType)),
      make("span", "codex-usage-fetched", latestCodexUsage.fetchedAt ? `updated ${formatDurationParts(Date.now() - new Date(latestCodexUsage.fetchedAt).getTime())} ago` : "updated now"),
    );
    box.append(header);
    if (latestCodexUsage.source === "codex-cli") {
      box.append(make("div", "codex-usage-detail", "Source: Codex CLI account. Its login is separate from Pi; these limits may differ from Pi's ChatGPT-plan allowance."));
    } else {
      box.append(make("div", "codex-usage-detail", "Source: Pi's legacy Codex login."));
    }
    if (latestCodexUsage.sourceNotice) box.append(make("div", "codex-usage-detail", latestCodexUsage.sourceNotice));

    if (buckets.length === 0) {
      box.append(make("div", "codex-usage-detail", "No Codex rate-limit windows were returned."));
    } else {
      for (const bucket of buckets) {
        const usedPercent = Number(bucket.window?.usedPercent);
        const fillPercent = Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : 0;
        const item = make("div", "codex-usage-bucket");
        item.dataset.codexUsageKey = bucket.key;
        const row = make("div", "codex-usage-row");
        row.append(
          make("span", "codex-usage-label", bucket.label),
          make("strong", "codex-usage-percent", formatCodexPercent(bucket.window?.usedPercent)),
        );
        const meter = make("div", "codex-usage-meter");
        const fill = make("span", "codex-usage-meter-fill");
        fill.style.width = `${fillPercent}%`;
        meter.append(fill);
        item.append(row, meter, make("div", "codex-usage-reset", formatCodexReset(bucket.window)));
        box.append(item);
      }
    }

    if (latestCodexUsage.rateLimitReachedType) {
      box.append(make("div", "codex-usage-warning", `Limit status: ${latestCodexUsage.rateLimitReachedType}`));
    }
    if (codexUsageError) {
      box.append(make("div", "codex-usage-detail", `Latest refresh failed: ${codexUsageError.message || codexUsageError}`));
    }
  }

  function renderClaudeUsageWindow(box, window, key = "") {
    const usedPercent = Number(window?.usedPercent);
    const fillPercent = Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : 0;
    const item = make("div", "claude-usage-bucket");
    if (key) item.dataset.claudeUsageKey = key;
    const row = make("div", "claude-usage-row");
    row.append(
      make("span", "claude-usage-label", window?.label || "Usage window"),
      make("strong", "claude-usage-percent", formatCodexPercent(usedPercent)),
    );
    const meter = make("div", "claude-usage-meter");
    const fill = make("span", "claude-usage-meter-fill");
    fill.style.width = `${fillPercent}%`;
    meter.append(fill);
    item.append(row, meter, make("div", "claude-usage-reset", formatClaudeUsageReset(window)));
    box.append(item);
  }

  function renderClaudeUsageActivity(box, activity) {
    if (!Array.isArray(activity) || activity.length === 0) return;
    const title = make("div", "claude-usage-activity-title", latestClaudeUsage?.activityTitle || "What's contributing to your limits usage?");
    box.append(title);
    for (const item of activity.slice(0, 2)) {
      const group = make("div", "claude-usage-activity-group");
      const row = make("div", "claude-usage-row");
      row.append(
        make("span", "claude-usage-label", item.label || "Activity"),
        make("span", "claude-usage-reset", `${Number(item.requests || 0)} requests · ${Number(item.sessions || 0)} sessions`),
      );
      group.append(row);
      for (const detail of (Array.isArray(item.details) ? item.details : []).slice(0, 4)) {
        group.append(make("div", "claude-usage-detail", detail?.text || String(detail || "")));
      }
      box.append(group);
    }
  }

  function claudeUsageStructureSignature() {
    if (!latestClaudeUsage) return JSON.stringify({ state: claudeUsageLoading ? "loading" : claudeUsageError ? "error" : "empty", error: claudeUsageError?.message || String(claudeUsageError || "") });
    const windows = Array.isArray(latestClaudeUsage.windows) ? latestClaudeUsage.windows : [];
    return JSON.stringify({
      state: "data",
      summary: latestClaudeUsage.summary || "",
      windows: windows.slice(0, 6).map((window, index) => [String(window?.id || index), window?.label || "Usage window"]),
      activityTitle: latestClaudeUsage.activityTitle || "",
      activity: latestClaudeUsage.activity || [],
      error: claudeUsageError?.message || String(claudeUsageError || ""),
    });
  }

  function updateClaudeUsageValues(box, windows) {
    if (!latestClaudeUsage || !box.querySelector(".claude-usage-summary")) return false;
    const fetched = box.querySelector(".claude-usage-fetched");
    if (fetched) setText(fetched, latestClaudeUsage.fetchedAt ? `updated ${formatDurationParts(Date.now() - new Date(latestClaudeUsage.fetchedAt).getTime())} ago` : "updated now");
    const rendered = [...box.querySelectorAll(".claude-usage-bucket[data-claude-usage-key]")];
    if (rendered.length !== windows.length) return false;
    for (const [index, window] of windows.entries()) {
      const key = String(window?.id || index);
      const item = rendered.find((node) => node.dataset.claudeUsageKey === key);
      if (!item) return false;
      const usedPercent = Number(window?.usedPercent);
      const fillPercent = Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : 0;
      const percent = item.querySelector(".claude-usage-percent");
      const fill = item.querySelector(".claude-usage-meter-fill");
      const reset = item.querySelector(".claude-usage-reset");
      if (!percent || !fill || !reset) return false;
      setText(percent, formatCodexPercent(usedPercent));
      fill.style.width = `${fillPercent}%`;
      setText(reset, formatClaudeUsageReset(window));
    }
    return true;
  }

  function renderClaudeUsage() {
    if (disposed) return;
    const box = nodes.claudeUsageBox;
    if (!box) return;
    if (nodes.refreshClaudeUsageButton) {
      nodes.refreshClaudeUsageButton.disabled = claudeUsageLoading;
      nodes.refreshClaudeUsageButton.textContent = claudeUsageLoading ? "Refreshing…" : "Refresh usage";
    }

    const windows = Array.isArray(latestClaudeUsage?.windows) ? latestClaudeUsage.windows.slice(0, 6) : [];
    const structureSignature = claudeUsageStructureSignature();
    if (structureSignature === claudeUsageRenderSignature && (!latestClaudeUsage || updateClaudeUsageValues(box, windows))) {
      box.classList.toggle("muted", !latestClaudeUsage);
      return;
    }
    claudeUsageRenderSignature = structureSignature;
    box.replaceChildren();
    box.classList.toggle("muted", !latestClaudeUsage);

    if (!latestClaudeUsage && claudeUsageLoading) {
      box.textContent = "Checking Claude usage…";
      return;
    }
    if (!latestClaudeUsage && claudeUsageError) {
      const title = make("div", "claude-usage-unavailable", "Usage unavailable");
      const detail = make("div", "claude-usage-detail", claudeUsageError.message || String(claudeUsageError));
      box.append(title, detail);
      return;
    }
    if (!latestClaudeUsage) {
      box.textContent = "Claude usage has not loaded yet.";
      return;
    }

    const header = make("div", "claude-usage-summary");
    header.append(
      make("span", "claude-usage-plan", "Claude Code"),
      make("span", "claude-usage-fetched", latestClaudeUsage.fetchedAt ? `updated ${formatDurationParts(Date.now() - new Date(latestClaudeUsage.fetchedAt).getTime())} ago` : "updated now"),
    );
    box.append(header);

    if (latestClaudeUsage.summary) box.append(make("div", "claude-usage-detail", latestClaudeUsage.summary));
    if (windows.length === 0) {
      box.append(make("div", "claude-usage-detail", "No Claude usage windows were returned."));
    } else {
      for (const [index, window] of windows.entries()) renderClaudeUsageWindow(box, window, String(window?.id || index));
    }

    renderClaudeUsageActivity(box, latestClaudeUsage.activity);
    if (claudeUsageError) {
      box.append(make("div", "claude-usage-detail", `Latest refresh failed: ${claudeUsageError.message || claudeUsageError}`));
    }
  }

  function syncFooter(payload) {
    if (disposed) return false;
    const usage = claudeUsageFromGitFooterPayload(payload === undefined ? getFooterPayload() : payload);
    if (!usage) return false;
    if (claudeUsageError || JSON.stringify(latestClaudeUsage) !== JSON.stringify(usage)) {
      footerVersion += 1;
      latestClaudeUsage = readOnly(usage);
      claudeUsageError = null;
      renderClaudeUsage();
      onChange();
    }
    return true;
  }

  async function refreshCodex({ forceAuthRefresh = false } = {}) {
    if (disposed || codexUsageLoading) return;
    codexUsageLoading = true;
    renderCodexUsage();
    onChange();
    try {
      // A host notification may dispose the owner synchronously.
      if (disposed) return;
      const suffix = forceAuthRefresh ? "?refresh=1" : "";
      const response = await api(`/api/codex-usage${suffix}`, { scoped: false });
      if (disposed) return;
      latestCodexUsage = readOnly(response.data || null);
      codexUsageError = null;
    } catch (error) {
      if (disposed) return;
      codexUsageError = error;
    } finally {
      if (!disposed) {
        codexUsageLoading = false;
        renderCodexUsage();
        onChange();
      }
    }
  }

  async function refreshClaude({ forceCli = false } = {}) {
    if (disposed) return;
    if (!forceCli && syncFooter()) return;
    if (claudeUsageLoading) return;
    const requestFooterVersion = footerVersion;
    claudeUsageLoading = true;
    renderClaudeUsage();
    onChange();
    try {
      if (disposed) return;
      const response = await api("/api/claude-usage", { scoped: false });
      if (disposed) return;
      if (!forceCli && (footerVersion !== requestFooterVersion || syncFooter())) return;
      latestClaudeUsage = readOnly(response.data || null);
      claudeUsageError = null;
    } catch (error) {
      if (disposed) return;
      if (!forceCli && (footerVersion !== requestFooterVersion || syncFooter())) return;
      claudeUsageError = error;
    } finally {
      if (!disposed) {
        claudeUsageLoading = false;
        renderClaudeUsage();
        onChange();
      }
    }
  }

  function schedule(provider, delay) {
    if (disposed) return;
    clearTimeout(refreshTimers[provider]);
    const version = ++scheduleVersions[provider];
    refreshTimers[provider] = setTimeout(() => {
      if (disposed || scheduleVersions[provider] !== version) return;
      refreshTimers[provider] = null;
      const refresh = provider === "codex" ? refreshCodex : refreshClaude;
      refresh().finally(() => {
        // A newer explicit schedule must survive an older request settling.
        if (!disposed && scheduleVersions[provider] === version) schedule(provider, provider === "codex" ? CODEX_USAGE_REFRESH_MS : CLAUDE_USAGE_REFRESH_MS);
      });
    }, delay);
  }

  function scheduleCodex(delay = CODEX_USAGE_REFRESH_MS) {
    schedule("codex", delay);
  }

  function scheduleClaude(delay = CLAUDE_USAGE_REFRESH_MS) {
    schedule("claude", delay);
  }

  function start() {
    if (disposed || started) return;
    started = true;
    for (const provider of ["codex", "claude"]) {
      const render = provider === "codex" ? renderCodexUsage : renderClaudeUsage;
      const refresh = provider === "codex" ? refreshCodex : refreshClaude;
      const version = scheduleVersions[provider];
      render();
      refresh().finally(() => {
        if (!disposed && scheduleVersions[provider] === version) schedule(provider, provider === "codex" ? CODEX_USAGE_REFRESH_MS : CLAUDE_USAGE_REFRESH_MS);
      });
      if (disposed) return;
      renderTimers[provider] = setInterval(() => {
        if (!disposed && visible[provider]) render();
      }, provider === "codex" ? CODEX_USAGE_RENDER_TICK_MS : CLAUDE_USAGE_RENDER_TICK_MS);
    }
  }

  function setVisible(provider, value) {
    if (disposed || !Object.hasOwn(visible, provider)) return;
    const next = Boolean(value);
    if (visible[provider] === next) return;
    visible[provider] = next;
    if (next) (provider === "codex" ? renderCodexUsage : renderClaudeUsage)();
  }

  function getSnapshot() {
    return Object.freeze({
      codex: Object.freeze({ data: latestCodexUsage, error: readOnly(codexUsageError), loading: codexUsageLoading }),
      claude: Object.freeze({ data: latestClaudeUsage, error: readOnly(claudeUsageError), loading: claudeUsageLoading }),
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    codexUsageLoading = false;
    claudeUsageLoading = false;
    for (const provider of ["codex", "claude"]) {
      clearTimeout(refreshTimers[provider]);
      clearInterval(renderTimers[provider]);
      refreshTimers[provider] = null;
      renderTimers[provider] = null;
      scheduleVersions[provider] += 1;
    }
  }

  return {
    start, refreshCodex, refreshClaude, scheduleCodex, scheduleClaude,
    renderCodex: renderCodexUsage, renderClaude: renderClaudeUsage,
    syncFooter, setVisible, getSnapshot, dispose,
  };
}
