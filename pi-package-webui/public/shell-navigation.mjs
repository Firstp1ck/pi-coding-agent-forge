import { MOBILE_ROUTES, MOBILE_SURFACES, normalizeMobileNavigationTarget } from "./mobile-shell-state.mjs";

function isRecord(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function navigationPatch(state) {
  if (!isRecord(state) || Reflect.ownKeys(state).some((key) => key !== "piMobileShellV2" && key !== "mobileShellState")) {
    throw new TypeError("History state must contain only shell navigation fields");
  }
  const patch = {};
  if (Object.hasOwn(state, "piMobileShellV2")) {
    if (state.piMobileShellV2 !== true) throw new TypeError("piMobileShellV2 must be true");
    patch.piMobileShellV2 = true;
  }
  if (Object.hasOwn(state, "mobileShellState")) {
    const mobile = state.mobileShellState;
    const keys = ["route", "surface", "surfacePage", "routeHistory"];
    if (!isRecord(mobile) || Reflect.ownKeys(mobile).length !== keys.length || keys.some((key) => !Object.hasOwn(mobile, key)) ||
        !MOBILE_ROUTES.has(mobile.route) || !MOBILE_SURFACES.has(mobile.surface) ||
        typeof mobile.surfacePage !== "string" || !mobile.surfacePage ||
        !Array.isArray(mobile.routeHistory) || mobile.routeHistory.length > 16 ||
        Array.from(mobile.routeHistory).some((route) => !MOBILE_ROUTES.has(route))) {
      throw new TypeError("Invalid serialized mobile shell navigation state");
    }
    patch.mobileShellState = {
      route: mobile.route,
      surface: mobile.surface,
      surfacePage: mobile.surfacePage,
      routeHistory: Array.from(mobile.routeHistory),
    };
  }
  return patch;
}

function navigationUrl(url, currentHref) {
  if (typeof url !== "string" && !(url instanceof URL)) throw new TypeError("History URL must be a string or URL");
  const current = new URL(currentHref);
  const next = new URL(url, current);
  if (next.origin !== current.origin) throw new TypeError("History URL must remain same-origin");
  for (const key of ["tab", "run", "blocker"]) {
    for (const id of next.searchParams.getAll(key)) {
      const field = { tab: "tabId", run: "runId", blocker: "blockerId" }[key];
      const target = normalizeMobileNavigationTarget({ v: 1, route: "chat", [field]: id });
      if (target?.[field] !== id) throw new TypeError(`Invalid navigation identifier: ${key}`);
    }
  }
  if (next.searchParams.getAll("mobileRoute").some((route) => !MOBILE_ROUTES.has(route))) {
    throw new TypeError("Invalid mobileRoute");
  }
  return next.href;
}

/**
 * Own one popstate listener without writing an initial entry. The caller confirms
 * destructive navigation before write. Invalid input throws TypeError; browser
 * history failures propagate. write/back throw after disposal; dispose is idempotent.
 */
export function createShellHistory({ window, onPopState } = {}) {
  if (!window || typeof window.addEventListener !== "function" || typeof window.removeEventListener !== "function" ||
      !window.history || ["pushState", "replaceState", "back"].some((method) => typeof window.history[method] !== "function") ||
      typeof onPopState !== "function") {
    throw new TypeError("Shell history requires a window with history and an onPopState callback");
  }
  let disposed = false;
  const handlePopState = (event) => {
    if (!disposed) onPopState(event);
  };
  window.addEventListener("popstate", handlePopState);

  function assertActive() {
    if (disposed) throw new Error("Shell history is disposed");
  }

  return {
    write({ state, replace = false, url } = {}) {
      assertActive();
      if (typeof replace !== "boolean") throw new TypeError("replace must be a boolean");
      const patch = navigationPatch(state);
      const nextUrl = url === undefined ? undefined : navigationUrl(url, window.location.href);
      const existing = window.history.state;
      const merged = { ...(isRecord(existing) ? existing : {}), ...patch };
      const method = replace ? "replaceState" : "pushState";
      if (nextUrl === undefined) window.history[method](merged, "");
      else window.history[method](merged, "", nextUrl);
    },
    back() {
      assertActive();
      window.history.back();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("popstate", handlePopState);
    },
  };
}
