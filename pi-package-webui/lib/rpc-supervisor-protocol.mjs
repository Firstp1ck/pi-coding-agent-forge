import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export const RPC_SUPERVISOR_PROTOCOL = Object.freeze({ major: 1, minor: 3 });
// Pi permits one bounded JSONL record this large. IPC envelopes need a small
// additional allowance so a single valid Pi record can always be forwarded.
export const PI_RPC_JSONL_LINE_MAX_BYTES = 32 * 1024 * 1024;
export const RPC_SUPERVISOR_MAX_FRAME_BYTES = PI_RPC_JSONL_LINE_MAX_BYTES + 1024 * 1024;
export const RPC_SUPERVISOR_EVENT_RING_LIMIT = 512;
// Retained replay must fit comfortably inside one attach frame even alongside
// tab snapshots. A live record larger than this is forwarded but omitted from
// replay, which produces an explicit gap for affected cursors.
export const RPC_SUPERVISOR_EVENT_RING_MAX_BYTES = 4 * 1024 * 1024;
export const RPC_SUPERVISOR_REQUEST_DEDUPE_LIMIT = 2048;
export const RPC_SUPERVISOR_TAB_LIMIT = 64;
// Each configured extension, skill, prompt, and theme contributes a flag/value
// pair. Real WebUI profiles can exceed 256 arguments before a --session pair
// is appended during reload, CWD changes, or forks.
export const RPC_SUPERVISOR_CHILD_ARG_LIMIT = 1024;
export const RPC_SUPERVISOR_METADATA_MAX_BYTES = 64 * 1024;
export const RPC_SUPERVISOR_ID_MAX_LENGTH = 128;
// This applies only to persisted metadata, state, and journals. Live Pi RPC
// command, response, and event payloads are byte-faithful transport data.
export const RPC_SUPERVISOR_SECRET_KEY = /(token|secret|password|authorization|api.?key|credential|cookie)/i;

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TAB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPE_ID = /^[a-f0-9]{64}$/;
const SEQ = /^(?:0|[1-9][0-9]{0,19})$/;
const OPERATION_TYPES = new Set(["create", "update", "replace", "replace_update", "close", "command", "write", "ack", "prepare_handoff", "detach", "shutdown"]);

export class RpcSupervisorProtocolError extends Error {
  constructor(message, code = "RPC_SUPERVISOR_PROTOCOL") {
    super(message);
    this.name = "RpcSupervisorProtocolError";
    this.code = code;
  }
}

function fail(message) {
  throw new RpcSupervisorProtocolError(message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function onlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${label} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function string(value, label, { min = 1, max = RPC_SUPERVISOR_ID_MAX_LENGTH, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) fail(`${label} must be a string between ${min} and ${max} characters`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function optionalString(value, label, options) {
  if (value === undefined) return undefined;
  return string(value, label, options);
}

function boundedJson(value, label, maximum = RPC_SUPERVISOR_METADATA_MAX_BYTES) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(`${label} must be JSON-serializable`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > maximum) fail(`${label} exceeds the ${maximum}-byte limit`);
  return value;
}

function version(value) {
  object(value, "version");
  onlyKeys(value, new Set(["major", "minor"]), "version");
  if (!Number.isInteger(value.major) || value.major < 0 || !Number.isInteger(value.minor) || value.minor < 0) fail("version must contain non-negative integer major and minor values");
  return { major: value.major, minor: value.minor };
}

export function protocolCompatible(remote) {
  const parsed = version(remote);
  return parsed.major === RPC_SUPERVISOR_PROTOCOL.major;
}

export function protocolCurrent(remote) {
  const parsed = version(remote);
  return parsed.major === RPC_SUPERVISOR_PROTOCOL.major && parsed.minor === RPC_SUPERVISOR_PROTOCOL.minor;
}

export function assertProtocolCompatible(remote) {
  if (!protocolCompatible(remote)) {
    const parsed = version(remote);
    throw new RpcSupervisorProtocolError(`RPC supervisor protocol major ${parsed.major} is incompatible with ${RPC_SUPERVISOR_PROTOCOL.major}`, "RPC_SUPERVISOR_VERSION_MISMATCH");
  }
}

export function constantTimeTokenEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function deriveSupervisorRecoveryToken(supervisorToken) {
  if (typeof supervisorToken !== "string" || !supervisorToken) throw new TypeError("supervisorToken is required");
  return createHmac("sha256", supervisorToken).update("pi-webui-recovery-v1").digest("base64url");
}

export function newRequestId() {
  return randomUUID();
}

export function sanitizeSupervisorData(value, { depth = 0 } = {}) {
  if (depth > 16) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitizeSupervisorData(item, { depth: depth + 1 }));
  if (!value || typeof value !== "object") return typeof value === "string" && value.length > 64 * 1024 ? `${value.slice(0, 64 * 1024)}…` : value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (RPC_SUPERVISOR_SECRET_KEY.test(key)) continue;
    result[key] = sanitizeSupervisorData(item, { depth: depth + 1 });
  }
  return result;
}

export function encodeFrame(frame) {
  // Authentication frames contain the private bearer token. Secret stripping is
  // deliberately applied at persistence and event/publication boundaries, not
  // here, otherwise an attach could never authenticate.
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line) > RPC_SUPERVISOR_MAX_FRAME_BYTES) fail(`frame exceeds the ${RPC_SUPERVISOR_MAX_FRAME_BYTES}-byte limit`);
  return `${line}\n`;
}

export function parseFrame(line) {
  if (typeof line !== "string" || Buffer.byteLength(line) > RPC_SUPERVISOR_MAX_FRAME_BYTES) fail(`frame exceeds the ${RPC_SUPERVISOR_MAX_FRAME_BYTES}-byte limit`);
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail("frame is not valid JSON");
  }
  return object(parsed, "frame");
}

export function validateCursor(cursor, { optional = true } = {}) {
  if (cursor === undefined && optional) return undefined;
  object(cursor, "cursor");
  onlyKeys(cursor, new Set(["epoch", "seq"]), "cursor");
  return {
    epoch: string(cursor.epoch, "cursor.epoch", { max: RPC_SUPERVISOR_ID_MAX_LENGTH, pattern: REQUEST_ID }),
    seq: string(cursor.seq, "cursor.seq", { max: 20, pattern: SEQ }),
  };
}

function validateTabId(value, label = "tabId") {
  return string(value, label, { pattern: TAB_ID });
}

function validateMetadata(value, label = "metadata") {
  object(value, label);
  boundedJson(value, label);
  return sanitizeSupervisorData(value);
}

function validateChild(value, label = "child") {
  object(value, label);
  onlyKeys(value, new Set(["command", "args", "cwd"]), label);
  const command = string(value.command, `${label}.command`, { max: 4096 });
  if (!Array.isArray(value.args) || value.args.length > RPC_SUPERVISOR_CHILD_ARG_LIMIT) fail(`${label}.args must be an array with at most ${RPC_SUPERVISOR_CHILD_ARG_LIMIT} entries`);
  const args = value.args.map((arg, index) => string(arg, `${label}.args[${index}]`, { min: 0, max: 64 * 1024 }));
  const cwd = string(value.cwd, `${label}.cwd`, { max: 16 * 1024 });
  return { command, args, cwd };
}

export function validateClientFrame(frame) {
  const value = object(frame, "frame");
  const type = string(value.type, "frame.type", { max: 40 });
  if (type === "attach") {
    onlyKeys(value, new Set(["type", "version", "scopeId", "token", "controllerId", "cursor"]), "attach");
    return {
      type,
      version: version(value.version),
      scopeId: string(value.scopeId, "scopeId", { max: 64, pattern: SCOPE_ID }),
      token: string(value.token, "token", { max: 512 }),
      controllerId: string(value.controllerId, "controllerId", { pattern: REQUEST_ID }),
      cursor: validateCursor(value.cursor),
    };
  }
  if (!OPERATION_TYPES.has(type)) fail(`unsupported operation: ${type}`);
  const common = new Set(["type", "requestId", "tabId", "metadata", "child", "command", "timeoutMs", "cursor", "restart"]);
  onlyKeys(value, common, type);
  if (type !== "replace_update" && value.restart !== undefined) fail("restart authorization is only valid for replace_update");
  const requestId = string(value.requestId, "requestId", { pattern: REQUEST_ID });
  if (type === "create") {
    return { type, requestId, tabId: validateTabId(value.tabId), metadata: validateMetadata(value.metadata), child: validateChild(value.child) };
  }
  if (type === "update") return { type, requestId, tabId: validateTabId(value.tabId), metadata: validateMetadata(value.metadata) };
  if (type === "replace" || type === "replace_update") {
    const commonReplace = { type, requestId, tabId: validateTabId(value.tabId),
      metadata: value.metadata === undefined ? undefined : validateMetadata(value.metadata), child: validateChild(value.child) };
    if (type === "replace") return commonReplace;
    const restart = object(value.restart, "restart");
    onlyKeys(restart, new Set(["transactionId", "lockToken", "effectRoot", "nonce"]), "restart");
    return { ...commonReplace, restart: {
      transactionId: string(restart.transactionId, "restart.transactionId", { pattern: REQUEST_ID }),
      lockToken: string(restart.lockToken, "restart.lockToken", { pattern: REQUEST_ID }),
      effectRoot: string(restart.effectRoot, "restart.effectRoot", { max: 4096 }),
      nonce: string(restart.nonce, "restart.nonce", { pattern: REQUEST_ID }),
    } };
  }
  if (type === "close") return { type, requestId, tabId: validateTabId(value.tabId) };
  if (type === "command" || type === "write") {
    const command = object(value.command, "command");
    // This validates size without altering a live Pi RPC object. In particular,
    // token-named keys, long strings, and large arrays are legitimate payload.
    boundedJson(command, "command", PI_RPC_JSONL_LINE_MAX_BYTES);
    if (typeof command.type !== "string" || !command.type) fail("command.type must be a non-empty string");
    if (type === "command" && value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 24 * 60 * 60_000)) fail("timeoutMs must be an integer between 1 and 86400000");
    if (type === "write" && value.timeoutMs !== undefined) fail("write does not accept timeoutMs");
    return { type, requestId, tabId: validateTabId(value.tabId), command, ...(type === "command" ? { timeoutMs: value.timeoutMs } : {}) };
  }
  if (type === "ack") return { type, requestId, cursor: validateCursor(value.cursor, { optional: false }) };
  return { type, requestId };
}

export function frameReader(onFrame, onError) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let discarding = false;
  return (chunk) => {
    let input = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    while (input) {
      if (discarding) {
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        input = input.slice(newline + 1);
        discarding = false;
        continue;
      }
      const newline = input.indexOf("\n");
      const piece = newline < 0 ? input : input.slice(0, newline);
      if (Buffer.byteLength(buffer) + Buffer.byteLength(piece) > RPC_SUPERVISOR_MAX_FRAME_BYTES) {
        buffer = "";
        onError?.(new RpcSupervisorProtocolError(`frame exceeds the ${RPC_SUPERVISOR_MAX_FRAME_BYTES}-byte limit`));
        if (newline < 0) { discarding = true; return; }
        input = input.slice(newline + 1);
        continue;
      }
      buffer += piece;
      if (newline < 0) return;
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      buffer = "";
      if (line.trim()) {
        try { onFrame(parseFrame(line)); } catch (error) { onError?.(error); }
      }
      input = input.slice(newline + 1);
    }
  };
}
