const ACTIVE_REFRESH_MS = 1500;
const IDLE_REFRESH_MS = 4000;
const HIDDEN_REFRESH_MS = 10_000;

export function createActivityAgentsController({
  api,
  getVisibility,
  getAutoClear,
  finishedSelections,
  canCancel,
  canDismiss,
  isAttachedProjection,
  agentCount,
  onOverview = () => {},
  onRefreshSettled = () => {},
  onChange = () => {},
  onEvent = () => {},
  onCancelStatus = () => {},
  onCancelClosed = () => {},
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  let data = null;
  let error = null;
  let loading = false;
  let clearingFinished = false;
  let cancelSelection = null;
  let cancelRequest = null;
  let refreshPromise = null;
  let refreshQueued = false;
  let timer = null;
  let scheduleVersion = 0;
  let started = false;
  let disposed = false;

  function getSnapshot() {
    // Overview data is borrowed read-only by the host, without a render-time copy.
    return Object.freeze({ data, error, loading, clearingFinished, cancelSelection, cancelSubmitting: cancelRequest !== null });
  }

  function stopTimer() {
    clearTimeout(timer);
    timer = null;
    return ++scheduleVersion;
  }

  function schedule(delay) {
    if (disposed) return;
    const version = stopTimer();
    const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
    const hasRunningGate = tabs.some((tab) => (Array.isArray(tab?.gates) ? tab.gates : []).some((gate) => gate?.status === "running"));
    const nextDelay = delay ?? (getVisibility() === "hidden" ? HIDDEN_REFRESH_MS : Number(data?.runningAgents || 0) > 0 || hasRunningGate ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    timer = setTimeout(() => {
      if (disposed || version !== scheduleVersion) return;
      timer = null;
      return refresh().finally(() => {
        if (!disposed && version === scheduleVersion) schedule();
      });
    }, nextDelay);
  }

  async function runRefresh(owner) {
    let refreshed = false;
    try {
      do {
        refreshQueued = false;
        try {
          if (disposed) break;
          const response = await api("/api/subagents", { scoped: false });
          if (disposed || refreshPromise !== owner) break;
          data = response.data || null;
          error = null;
          refreshed = true;
          onOverview(data);
        } catch (failure) {
          if (disposed || refreshPromise !== owner) break;
          error = failure;
        }
      } while (!disposed && refreshQueued);
    } finally {
      if (!disposed && refreshPromise === owner) {
        refreshPromise = null;
        loading = false;
        onChange();
        if (!disposed) onRefreshSettled();
      }
    }
    return refreshed;
  }

  function refresh() {
    if (disposed) return Promise.resolve(false);
    if (refreshPromise) {
      refreshQueued = true;
      return refreshPromise;
    }
    let resolve;
    let reject;
    const pending = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    refreshPromise = pending;
    loading = true;
    onChange();
    runRefresh(pending).then(resolve, reject);
    // Release the overview request before Auto-Clear refreshes the resulting list.
    return pending.then(async (refreshed) => {
      if (!disposed && refreshed && getAutoClear() && finishedSelections(data).length) {
        await clearFinished({ automatic: true });
      }
      return refreshed;
    });
  }

  function start() {
    if (disposed || started) return;
    started = true;
    const version = scheduleVersion;
    return refresh().finally(() => {
      if (!disposed && version === scheduleVersion) schedule();
    });
  }

  function beginCancel(tab, run, agent = null) {
    if (disposed || cancelRequest || !tab?.groupId || !run?.id || !canCancel(run, agent)) return null;
    cancelSelection = Object.freeze({
      groupId: tab.groupId,
      tabId: tab.tabId,
      runId: run.id,
      agentId: agent?.instanceId || agent?.id || "",
      agentCount: agentCount(run),
    });
    onCancelStatus("");
    onChange();
    return cancelSelection;
  }

  function resetCancel() {
    if (disposed) return;
    cancelSelection = null;
    cancelRequest = null;
    onCancelStatus("");
    onChange();
  }

  async function submitCancel({ reason = "", note = "" } = {}) {
    if (disposed || !cancelSelection || cancelRequest) return false;
    const selection = cancelSelection;
    const request = {};
    cancelRequest = request;
    const isCurrent = () => !disposed && cancelSelection === selection && cancelRequest === request;
    reason = String(reason || "").trim();
    note = String(note || "").trim();
    onChange();
    onCancelStatus("Cancelling subagent…");
    try {
      if (!isCurrent()) return false;
      await api("/api/subagents/cancel", {
        method: "POST",
        scoped: false,
        body: {
          group: selection.groupId,
          runId: selection.runId,
          ...(selection.agentId ? { agentId: selection.agentId } : {}),
          ...(reason ? { reason } : {}),
          ...(note ? { note } : {}),
        },
      });
      if (!isCurrent()) return false;
      onCancelClosed(selection);
      if (disposed) return false;
      onEvent(`cancelled run ${selection.runId}; the parent agent was notified`, "info");
      await refresh();
      if (!disposed) schedule();
      return !disposed;
    } catch (failure) {
      if (!isCurrent()) return false;
      const message = `subagent cancel failed: ${failure.message || String(failure)}`;
      onCancelStatus(message, "error");
      onEvent(message, "error");
      return false;
    } finally {
      // Closing/resetting can open a different selection while this refresh awaits.
      if (isCurrent()) {
        cancelRequest = null;
        onChange();
      }
    }
  }

  async function dismiss(tab, run) {
    if (disposed || !tab?.groupId || !run?.id || !canDismiss(run)) return false;
    const groupId = tab.groupId;
    const runId = run.id;
    const attachedProjection = isAttachedProjection(run);
    try {
      await api("/api/subagents/dismiss", { method: "POST", scoped: false, body: { group: groupId, runId } });
      if (disposed) return false;
      onEvent(attachedProjection ? `detached persisted session projection ${runId}` : `dismissed finished subagent run ${runId}`, "info");
      await refresh();
      if (!disposed) schedule();
      return !disposed;
    } catch (failure) {
      if (!disposed) onEvent(`subagent dismiss failed: ${failure.message || String(failure)}`, "error");
      return false;
    }
  }

  async function clearFinished({ automatic = false } = {}) {
    if (disposed || clearingFinished || loading) return;
    const selections = finishedSelections(data)
      .filter((selection) => selection.groupId && selection.runId)
      .map(({ groupId, runId }) => ({ groupId, runId }));
    if (!selections.length) return;
    const version = stopTimer();
    clearingFinished = true;
    onChange();
    let dismissed = 0;
    let failures = 0;
    try {
      for (const selection of selections) {
        if (disposed) return;
        try {
          await api("/api/subagents/dismiss", {
            method: "POST",
            scoped: false,
            body: { group: selection.groupId, runId: selection.runId },
          });
          dismissed += 1;
        } catch {
          failures += 1;
        }
      }
      if (disposed) return;
      await refresh();
    } finally {
      if (!disposed) {
        clearingFinished = false;
        onChange();
        if (!disposed && version === scheduleVersion) schedule();
      }
    }
    if (disposed) return;
    if (dismissed) {
      if (automatic) {
        onEvent("auto-cleared", "info", {
          aggregateKey: "subagent-auto-clear",
          aggregateIncrement: dismissed,
          aggregateSingular: "finished subagent run",
          aggregatePlural: "finished subagent runs",
        });
      } else {
        onEvent(`cleared ${dismissed} finished subagent ${dismissed === 1 ? "run" : "runs"}`, "info");
      }
    }
    if (failures) onEvent(`could not ${automatic ? "auto-clear" : "clear"} ${failures} finished subagent ${failures === 1 ? "run" : "runs"}`, "warn");
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopTimer();
    refreshPromise = null;
    refreshQueued = false;
    loading = false;
    clearingFinished = false;
    cancelRequest = null;
  }

  return { start, refresh, schedule, getSnapshot, beginCancel, resetCancel, submitCancel, dismiss, clearFinished, dispose };
}
