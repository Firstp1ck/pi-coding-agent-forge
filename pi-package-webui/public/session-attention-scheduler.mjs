const WORKING_INTERVAL = 1500;
const IDLE_INTERVAL = 10000;
const HIDDEN_INTERVAL = 30000;
const MENU_DELAY = 600;
const REQUEST_TIMEOUT = 10000;
const MAX_BACKOFF = 30000;

/**
 * Reconcile tab metadata with one timer and one abortable refresh at a time.
 * stop() permits a later sync()/request(); dispose() permanently ends ownership.
 * An aborted refresh retains its slot until settlement, so refresh must honor
 * the signal. The caller owns applying results and must also respect abortion.
 */
export function createAttentionScheduler({
  refresh,
  getState,
  onError = () => {},
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
} = {}) {
  for (const [name, value] of Object.entries({ refresh, getState, onError, setTimeout, clearTimeout })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }

  let enabled = true;
  let disposed = false;
  let timer = null;
  let inFlight = null;
  let automaticAt = null;
  let manualAt = null;
  let menuUntil = 0;
  let retryAt = 0;
  let backoff = 0;

  function intervalFor(state) {
    if (state.tabCount <= 0 || (!state.working && state.tabCount <= 1)) return null;
    if (!state.visible) return HIDDEN_INTERVAL;
    return state.working ? WORKING_INTERVAL : IDLE_INTERVAL;
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer.handle);
    timer = null;
  }

  function setTimer(callback, at) {
    clearTimer();
    const owned = { at, handle: null };
    timer = owned;
    owned.handle = setTimeout(() => {
      if (timer !== owned) return;
      timer = null;
      callback();
    }, Math.max(0, at - Date.now()));
  }

  function stop() {
    enabled = false;
    clearTimer();
    automaticAt = manualAt = null;
    menuUntil = retryAt = backoff = 0;
    if (inFlight !== null) {
      inFlight.cancelled = true;
      inFlight.controller.abort();
    }
  }

  function reconcile() {
    if (!enabled || disposed) return;
    const state = getState();
    if (state.tabCount <= 0) {
      stop();
      return;
    }
    if (inFlight !== null) return;

    const interval = intervalFor(state);
    automaticAt = interval === null ? null : Math.min(automaticAt ?? Infinity, Date.now() + interval);
    const wantedAt = Math.min(automaticAt ?? Infinity, manualAt ?? Infinity);
    if (wantedAt === Infinity) {
      clearTimer();
      return;
    }
    const at = Math.max(wantedAt, menuUntil, retryAt);
    if (timer?.at !== at) setTimer(run, at);
  }

  function settle(owned, error) {
    if (inFlight !== owned) return;
    inFlight = null;
    clearTimer();
    if (owned.cancelled || !enabled || disposed) {
      reconcile();
      return;
    }
    const state = getState();
    if (state.tabCount <= 0) {
      stop();
      return;
    }

    if (error !== null) {
      backoff = Math.min(MAX_BACKOFF, Math.max(intervalFor(state) ?? WORKING_INTERVAL, backoff * 2));
      retryAt = Date.now() + backoff;
      manualAt = Math.min(manualAt ?? Infinity, retryAt);
      try {
        onError(error);
      } catch {
        // Error presentation must not strand the scheduler's owned resources.
      }
    } else {
      backoff = retryAt = 0;
    }
    reconcile();
  }

  function run() {
    if (!enabled || disposed || inFlight !== null) return;
    const state = getState();
    if (state.tabCount <= 0) {
      stop();
      return;
    }
    if (intervalFor(state) === null) automaticAt = null;
    if (automaticAt === null && manualAt === null) return;
    if (Math.min(automaticAt ?? Infinity, manualAt ?? Infinity) > Date.now()) {
      reconcile();
      return;
    }
    if (state.menuOpen) {
      menuUntil = Date.now() + MENU_DELAY;
      reconcile();
      return;
    }

    automaticAt = manualAt = null;
    menuUntil = 0;
    const owned = { controller: new AbortController(), cancelled: false, timeoutError: null };
    inFlight = owned;
    setTimer(() => {
      owned.timeoutError = new Error("Tab metadata refresh timed out after 10000ms");
      owned.timeoutError.name = "TimeoutError";
      owned.controller.abort(owned.timeoutError);
    }, Date.now() + REQUEST_TIMEOUT);

    let result;
    try {
      result = refresh({ signal: owned.controller.signal });
    } catch (error) {
      settle(owned, error ?? new Error("Tab metadata refresh failed"));
      return;
    }
    Promise.resolve(result).then(
      () => settle(owned, owned.timeoutError),
      (error) => settle(owned, owned.timeoutError ?? error ?? new Error("Tab metadata refresh failed")),
    );
  }

  return Object.freeze({
    sync() {
      if (disposed) return;
      enabled = true;
      reconcile();
    },
    request(delay = 0) {
      if (disposed) return;
      if (!Number.isFinite(delay) || delay < 0) throw new RangeError("delay must be a finite nonnegative number");
      enabled = true;
      if (getState().tabCount <= 0) {
        stop();
        return;
      }
      manualAt = Math.min(manualAt ?? Infinity, Date.now() + delay);
      reconcile();
    },
    stop,
    dispose() {
      disposed = true;
      stop();
    },
  });
}
