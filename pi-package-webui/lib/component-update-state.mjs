export const COMPONENT_UPDATE_TARGETS = Object.freeze(["pi", "webui"]);

const TARGET_SET = new Set(COMPONENT_UPDATE_TARGETS);
const DEFAULT_ERROR_MAX_LENGTH = 1200;
const DEFAULT_MESSAGE_MAX_LENGTH = 320;

function targetLabel(target) {
  return target === "pi" ? "Pi" : "Web UI";
}

function boundedText(value, maxLength) {
  const text = String(value ?? "")
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

export function sanitizeComponentUpdateError(value, maxLength = DEFAULT_ERROR_MAX_LENGTH) {
  const raw = value instanceof Error ? (value.userMessage || value.message || String(value)) : String(value ?? "Unknown error");
  const redacted = raw
    .replace(/\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b((?:_?auth[_-]?token|access[_-]?token|api[_-]?key|password|passwd|secret|token)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:npm_[A-Za-z0-9]{20,}|gh[opusr]_[A-Za-z0-9_]{20,})\b/g, "[redacted]");
  return boundedText(redacted, Math.max(80, Number(maxLength) || DEFAULT_ERROR_MAX_LENGTH)) || "Unknown error";
}

export function validateComponentUpdateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object containing only target." };
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "target" || !TARGET_SET.has(body.target)) {
    return { ok: false, error: 'target must be exactly "pi" or "webui", with no additional fields.' };
  }
  return { ok: true, target: body.target };
}

export function validateUpdatePlanRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Request body must be an object." };
  const keys = Object.keys(body).sort();
  if (keys.some((key) => key !== "targets") || !Array.isArray(body.targets) || body.targets.length !== 1) {
    return { ok: false, error: "targets must contain exactly one value: pi or webui." };
  }
  const targets = body.targets;
  if (!TARGET_SET.has(targets[0])) return { ok: false, error: "targets contains an unsupported target." };
  return { ok: true, targets };
}

export function validateUpdateApplyRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Request body must be an object." };
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "planDigest,transactionId") return { ok: false, error: "Apply accepts only transactionId and planDigest." };
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(body.transactionId || "")) || !/^[a-f0-9]{64}$/.test(String(body.planDigest || ""))) {
    return { ok: false, error: "transactionId or planDigest is invalid." };
  }
  return { ok: true, transactionId: body.transactionId, planDigest: body.planDigest };
}

function initialState(target) {
  return {
    target,
    state: "idle",
    startedAt: null,
    finishedAt: null,
    message: "",
    error: "",
    restartRequired: target === "webui",
  };
}

export class ComponentUpdateState {
  #states;
  #now;

  constructor({ now = () => new Date() } = {}) {
    this.#now = now;
    this.#states = Object.fromEntries(COMPONENT_UPDATE_TARGETS.map((target) => [target, initialState(target)]));
  }

  hasRunning() {
    return COMPONENT_UPDATE_TARGETS.some((target) => this.#states[target].state === "running");
  }

  begin(target) {
    if (!TARGET_SET.has(target)) throw new TypeError(`Unsupported component update target: ${target}`);
    if (this.hasRunning()) throw new Error("Another component update is already running.");
    const startedAt = this.#now().toISOString();
    this.#states[target] = {
      ...initialState(target),
      state: "running",
      startedAt,
      message: `Updating ${targetLabel(target)}…`,
    };
    return this.get(target);
  }

  succeed(target, message) {
    this.#requireRunning(target);
    this.#states[target] = {
      ...this.#states[target],
      state: "succeeded",
      finishedAt: this.#now().toISOString(),
      message: boundedText(message, DEFAULT_MESSAGE_MAX_LENGTH),
      error: "",
    };
    return this.get(target);
  }

  fail(target, error, message = `${targetLabel(target)} update failed.`) {
    this.#requireRunning(target);
    this.#states[target] = {
      ...this.#states[target],
      state: "failed",
      finishedAt: this.#now().toISOString(),
      message: boundedText(message, DEFAULT_MESSAGE_MAX_LENGTH),
      error: sanitizeComponentUpdateError(error),
    };
    return this.get(target);
  }

  get(target) {
    if (!TARGET_SET.has(target)) throw new TypeError(`Unsupported component update target: ${target}`);
    return { ...this.#states[target] };
  }

  publicStates({ localRequest = false, updateInProgress = this.hasRunning(), webuiAvailable = true, webuiUnavailableReason = "" } = {}) {
    return Object.fromEntries(COMPONENT_UPDATE_TARGETS.map((target) => {
      const state = this.get(target);
      let unavailableReason = "";
      if (!localRequest) unavailableReason = "Component updates are only available from localhost.";
      else if (target === "webui" && !webuiAvailable) unavailableReason = boundedText(webuiUnavailableReason || "Automatic Web UI update is unavailable for this installation.", DEFAULT_MESSAGE_MAX_LENGTH);
      else if (updateInProgress) unavailableReason = "Another privileged update is already running.";
      return [target, {
        ...state,
        canStart: unavailableReason === "",
        unavailableReason,
      }];
    }));
  }

  #requireRunning(target) {
    if (!TARGET_SET.has(target)) throw new TypeError(`Unsupported component update target: ${target}`);
    if (this.#states[target].state !== "running") throw new Error(`Component update target ${target} is not running.`);
  }
}
