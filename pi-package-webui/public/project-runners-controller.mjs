export const APP_RUNNER_CONTEXT_DEFAULT_LINES = 80;
export const APP_RUNNER_CONTEXT_MAX_LINES = 1000;

export function normalizeAppRunnerContextLineCount(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return APP_RUNNER_CONTEXT_DEFAULT_LINES;
  return Math.max(1, Math.min(APP_RUNNER_CONTEXT_MAX_LINES, number));
}

function runIdentity(run) {
  return run ? run.id || run.runnerId || "active" : null;
}

function isRunning(run) {
  return run?.status === "running" || run?.stopping === true;
}

/**
 * Owns runner snapshots, requests and tab/run drafts. Data projections are read-only.
 * Draft accessors take (tabId, runId), setters add the value as their third argument.
 * Requests return {success:true,data}, with inputDraftCleared on sendInput, or
 * {success:false,reason,error?}. Reasons are target, run, runner, stale or error.
 * A stale server action may have completed; this controller does not cancel it.
 */
export function createProjectRunnersController({
  api,
  captureTarget,
  isTargetCurrent,
  cleanStatusText,
  onData = () => {},
  onRender = () => {},
  addEvent = () => {},
  onRefreshContext = () => {},
}) {
  const owners = new Map();

  function ensureOwner(tabId) {
    let owner = owners.get(tabId);
    if (!owner) {
      owner = { data: { runners: [], activeRun: null }, request: null, input: new Map(), context: new Map() };
      owners.set(tabId, owner);
    }
    return owner;
  }

  function getData(tabId) {
    return owners.get(tabId)?.data || { runners: [], activeRun: null };
  }

  function mergeData(tabId, owner, data, token) {
    const previous = owner.data;
    const hasActiveRun = Object.prototype.hasOwnProperty.call(data, "activeRun");
    const next = {
      cwd: data.cwd || previous.cwd || "",
      runners: Array.isArray(data.runners) ? data.runners : previous.runners || [],
      customRunnerConfig: data.customRunnerConfig || previous.customRunnerConfig || null,
      activeRun: hasActiveRun ? data.activeRun : previous.activeRun || null,
    };
    owner.data = next;
    if (token) token.runId = runIdentity(next.activeRun);
    onData(tabId, next, { hasActiveRun });
    return next;
  }

  function applyData(tabId, data = {}) {
    if (!tabId) return;
    const owner = ensureOwner(tabId);
    const nextRun = Object.hasOwn(data, "activeRun") ? data.activeRun : owner.data.activeRun;
    // Output can arrive before the stdin POST acknowledgment. Retire its snapshot,
    // but retain the acknowledgment while the original run and request still own it.
    if (owner.request?.action === "input" && runIdentity(nextRun) === owner.request.runId) {
      owner.request.snapshotSuperseded = true;
    } else {
      owner.request = null;
    }
    return mergeData(tabId, owner, data);
  }

  function getInputDraft(tabId, runId) {
    return owners.get(tabId)?.input.get(runId)?.text ?? "";
  }

  function setInputDraft(tabId, runId, text) {
    if (tabId && runId) ensureOwner(tabId).input.set(runId, { text: String(text ?? "") });
  }

  function getContextDraft(tabId, runId) {
    return owners.get(tabId)?.context.get(runId) ?? String(APP_RUNNER_CONTEXT_DEFAULT_LINES);
  }

  function setContextDraft(tabId, runId, value) {
    if (tabId && runId) ensureOwner(tabId).context.set(runId, String(normalizeAppRunnerContextLineCount(value)));
  }

  function isCurrent(token) {
    return owners.get(token.target.tabId) === token.owner
      && token.owner.request === token
      && runIdentity(token.owner.data.activeRun) === token.runId
      && isTargetCurrent(token.target);
  }

  function failureState(runnerId, error, data) {
    const runner = data.runners.find((item) => item.id === runnerId) || {};
    const message = cleanStatusText(error?.message || String(error) || "Unknown app runner error");
    const command = runner.displayCommand || runner.shortDisplayCommand || runner.label || runnerId || "app runner";
    const timestamp = new Date().toISOString();
    return {
      id: `start-error:${Date.now()}`,
      runnerId,
      kind: runner.kind || "custom",
      label: runner.label || "App runner failed",
      command: runner.command || "",
      args: Array.isArray(runner.args) ? runner.args : [],
      displayCommand: command,
      cwd: data.cwd || "",
      status: "error",
      startedAt: timestamp,
      endedAt: timestamp,
      lineCount: 3,
      lines: [`$ ${command}`, "# failed to start app runner", `# ${message}`],
    };
  }

  async function request(action, target, { runnerId, runId, text, closeStdin = false, lineCount } = {}) {
    if (!target?.tabId || !isTargetCurrent(target)) return { success: false, reason: "target" };
    const owner = ensureOwner(target.tabId);
    if (action === "start" && !runnerId) return { success: false, reason: "runner" };
    if (["stop", "clear", "input", "context"].includes(action)
      && (!runId || runIdentity(owner.data.activeRun) !== runId
        || (action === "input" && !isRunning(owner.data.activeRun)))) {
      return { success: false, reason: "run" };
    }

    const token = { owner, target, action, runId: runIdentity(owner.data.activeRun), snapshotSuperseded: false };
    owner.request = token;
    const submittedDraft = owner.input.get(runId);
    let path = `/api/app-runner/${action}`;
    let options = { method: "POST", body: {}, tabId: target.tabId };
    if (action === "refresh") {
      path = "/api/app-runners";
      options = { tabId: target.tabId };
    } else if (action === "start") {
      path = "/api/app-runner";
      options.body = { runnerId };
    } else if (action === "input") {
      text = String(text ?? "");
      options.body = { text, newline: !closeStdin || Boolean(text), closeStdin };
    } else if (action === "context") {
      lineCount = normalizeAppRunnerContextLineCount(lineCount === undefined || lineCount === null || lineCount === ""
        ? getContextDraft(target.tabId, runId) : lineCount);
      setContextDraft(target.tabId, runId, lineCount);
      options.body = { lineCount };
    }

    let response;
    try {
      response = await api(path, options);
    } catch (error) {
      if (!isCurrent(token)) return { success: false, reason: "stale" };
      if (action === "start") {
        mergeData(target.tabId, owner, { activeRun: failureState(runnerId, error, owner.data) }, token);
        if (!isCurrent(token)) return { success: false, reason: "stale" };
        onRender({ tabs: true });
        if (isCurrent(token)) addEvent(`app runner failed: ${cleanStatusText(error?.message || String(error))}`, "error");
      } else if (action !== "refresh") {
        const prefix = action === "input" ? "app runner input failed: "
          : action === "context" ? "app runner context transfer failed: " : "";
        addEvent(`${prefix}${error?.message || String(error)}`, "error");
      }
      return { success: false, reason: "error", error };
    }
    if (!isCurrent(token)) return { success: false, reason: "stale" };

    const data = response.data || {};
    let inputDraftCleared = false;
    if (action === "input" && owner.input.get(runId) === submittedDraft
      && getInputDraft(target.tabId, runId) === text) {
      setInputDraft(target.tabId, runId, "");
      inputDraftCleared = true;
    }
    if (!token.snapshotSuperseded) {
      if (action === "context") {
        if (data.activeRun) mergeData(target.tabId, owner, { activeRun: data.activeRun }, token);
      } else {
        mergeData(target.tabId, owner, data, token);
      }
    }
    if (!isCurrent(token)) return { success: false, reason: "stale" };

    // Context transfer schedules message/state refresh, without rebuilding runner widgets.
    if (action !== "context") onRender({ tabs: ["start", "stop", "clear"].includes(action) });
    if (!isCurrent(token)) return { success: false, reason: "stale" };
    if (action === "start") addEvent(`started ${data.activeRun?.displayCommand || "app runner"}`, "info");
    else if (action === "stop") addEvent("app runner stop requested", "warn");
    else if (action === "input") addEvent(closeStdin ? "sent app runner EOF" : text ? "sent app runner input" : "sent app runner Enter", "info");
    else if (action === "context") {
      addEvent(data.delivery === "steer"
        ? `sent last ${data.lineCount || lineCount} app runner output lines as live steering context`
        : `added last ${data.lineCount || lineCount} app runner output lines to agent context`, "info");
      if (isCurrent(token)) onRefreshContext(target);
    }
    return action === "input" ? { success: true, data, inputDraftCleared } : { success: true, data };
  }

  return {
    getData,
    applyData,
    forgetTab(tabId) { owners.delete(tabId); },
    refresh(target = captureTarget()) { return request("refresh", target); },
    start(runnerId, target = captureTarget()) { return request("start", target, { runnerId }); },
    stop(runId, target = captureTarget()) { return request("stop", target, { runId }); },
    clear(runId, target = captureTarget()) { return request("clear", target, { runId }); },
    sendInput(options, target = captureTarget()) { return request("input", target, options); },
    transferContext(options, target = captureTarget()) { return request("context", target, options); },
    getInputDraft,
    setInputDraft,
    getContextDraft,
    setContextDraft,
  };
}
