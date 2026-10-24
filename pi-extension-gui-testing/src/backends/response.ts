/**
 * Method-specific validation of helper results. The helper shares its UID
 * with the app under test, so an app can read the framing token from `/proc`
 * and forge responses: every result is untrusted input. Validation runs before
 * any caller sees a result; nothing a helper returns is ever used to build a
 * host path, an argv, or a Docker command.
 */
import { gunzipSync } from "node:zlib";
import { SessionError } from "../backend.ts";
import { ownedSlice } from "../framing/log-event.ts";
import { DEPS_CHUNK_BASE64_CHARS, DEPS_CHUNK_BYTES, type Coverage, type Method, type Result, type TreeNode, type WindowInfo } from "../protocol.ts";

/** Upper bounds for helper-supplied values. */
export const RESPONSE_LIMITS = {
  /** Ids, refs, roles, window targets, versions. */
  idChars: 256,
  /** Accessible names, values, titles. */
  textChars: 64 * 1024,
  /** Nodes in one tree (inline or full). */
  treeNodes: 200_000,
  /** States per node. */
  states: 64,
  windows: 1_000,
  /** Base64 text of one screenshot. */
  pngBase64Chars: 48 * 1024 * 1024,
  /** Base64 text of one gzip tree dump, and its unpacked JSON size. */
  treeGzBase64Chars: 48 * 1024 * 1024,
  treeJsonBytes: 256 * 1024 * 1024,
  /** Screenshot edge and origin in pixels. */
  pixels: 32_768,
  /**
   * X window geometry (`xwininfo`): positions are 16-bit signed, sizes
   * 16-bit unsigned; positions get a margin for the absolute translation.
   */
  windowCoordinate: 65_536,
  windowEdge: 65_535,
  /**
   * Accessibility bounds (AT-SPI extents, 32-bit, often off screen, plus a
   * window origin for GTK 4). Out-of-range or malformed bounds are dropped
   * from that node; the rest of the snapshot stays usable.
   */
  a11yCoordinate: 2 ** 31,
  leftovers: 1_000,
  /** `hello.platform` characters. */
  platformChars: 256,
  /** Transfer ids of the deps methods. */
  transferChars: 64,
  /** Bytes of one dependency archive (and of an unpacked deps dir). */
  depsBytes: 2 ** 50,
  /** Entries of one dependency archive. */
  depsEntries: 100_000_000,
  /** Base64 text and decoded bytes of one deps chunk. */
  depsChunkBase64Chars: DEPS_CHUNK_BASE64_CHARS,
  depsChunkBytes: DEPS_CHUNK_BYTES,
} as const;

/** A helper-chosen transfer id: short and plain, so it is never more than an opaque token. */
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/**
 * Standard base64 with up to two `=` at the end. A loop instead of a RegExp:
 * V8's legacy RegExp statics would keep the last tested (possibly huge,
 * rejected) helper string alive.
 */
function isBase64(text: string): boolean {
  let end = text.length;
  if (end > 0 && text.charCodeAt(end - 1) === 61) end--;
  if (end > 0 && text.charCodeAt(end - 1) === 61) end--;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
    if (!ok) return false;
  }
  return true;
}

/** A helper result that does not have the protocol's shape. */
export class BadResponseError extends SessionError {
  constructor(method: string, problem: string) {
    super("BAD_RESPONSE", `the helper sent an invalid ${method} result (${problem}); the session cannot be trusted, stop it with gui_stop`);
    this.name = "BadResponseError";
  }
}

type Obj = Record<string, unknown>;

class Checker {
  readonly method: string;
  constructor(method: string) {
    this.method = method;
  }

  fail(problem: string): never {
    throw new BadResponseError(this.method, problem);
  }

  object(value: unknown, field: string): Obj {
    if (typeof value !== "object" || value === null || Array.isArray(value)) this.fail(`${field} is not an object`);
    return value as Obj;
  }

  string(value: unknown, field: string, max: number = RESPONSE_LIMITS.idChars): string {
    if (typeof value !== "string") this.fail(`${field} is not a string`);
    if (value.length > max) this.fail(`${field} is longer than ${max} characters`);
    return value;
  }

  optionalString(value: unknown, field: string, max?: number): string | undefined {
    return value === undefined ? undefined : this.string(value, field, max);
  }

  boolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") this.fail(`${field} is not a boolean`);
    return value;
  }

  number(value: unknown, field: string, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isFinite(value)) this.fail(`${field} is not a finite number`);
    if (value < min || value > max) this.fail(`${field} ${value} is outside ${min}..${max}`);
    return value;
  }

  integer(value: unknown, field: string, min?: number, max?: number): number {
    const n = this.number(value, field, min, max);
    if (!Number.isInteger(n)) this.fail(`${field} is not an integer`);
    return n;
  }

  array(value: unknown, field: string, max: number): unknown[] {
    if (!Array.isArray(value)) this.fail(`${field} is not an array`);
    if (value.length > max) this.fail(`${field} has more than ${max} entries`);
    return value;
  }

  base64(value: unknown, field: string, max: number): string {
    const text = this.string(value, field, max);
    if (text.length % 4 !== 0 || !isBase64(text)) this.fail(`${field} is not base64`);
    return text;
  }

  /** A deps transfer id: {@link TRANSFER_ID}, as an owned copy. */
  transfer(value: unknown, field: string): string {
    const text = this.string(value, field, RESPONSE_LIMITS.transferChars);
    if (!TRANSFER_ID.test(text)) this.fail(`${field} has unexpected characters`);
    return ownedSlice(text);
  }

  /** A lowercase hex SHA-256, as an owned copy. */
  sha256(value: unknown, field: string): string {
    const text = this.string(value, field, 64);
    if (!SHA256_HEX.test(text)) this.fail(`${field} is not a lowercase hex SHA-256`);
    return ownedSlice(text);
  }

  /** Display text (names, values, titles): must be a string; longer ones are cut, not refused. */
  text(value: unknown, field: string): string {
    if (typeof value !== "string") this.fail(`${field} is not a string`);
    // Owned copies: a slice of an oversized helper string would keep the whole original alive.
    return value.length > RESPONSE_LIMITS.textChars ? `${ownedSlice(value, 0, RESPONSE_LIMITS.textChars)}…` : ownedSlice(value);
  }

  optionalText(value: unknown, field: string): string | undefined {
    return value === undefined ? undefined : this.text(value, field);
  }

  /** X window bounds: integers within X11's geometry range. */
  windowBounds(value: unknown, field: string): { x: number; y: number; width: number; height: number } {
    const b = this.object(value, field);
    const at = RESPONSE_LIMITS.windowCoordinate;
    const edge = RESPONSE_LIMITS.windowEdge;
    return {
      x: this.integer(b.x, `${field}.x`, -at, at),
      y: this.integer(b.y, `${field}.y`, -at, at),
      width: this.integer(b.width, `${field}.width`, 0, edge),
      height: this.integer(b.height, `${field}.height`, 0, edge),
    };
  }

  /** Optional accessibility bounds: finite integers in AT-SPI's range, or `undefined` (dropped) when malformed. */
  a11yBounds(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const b = value as Obj;
    const limit = RESPONSE_LIMITS.a11yCoordinate;
    const ok = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= limit;
    if (!ok(b.x, -limit) || !ok(b.y, -limit) || !ok(b.width, 0) || !ok(b.height, 0)) return undefined;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  node(value: unknown, field: string): TreeNode {
    const n = this.object(value, field);
    const node: TreeNode = {
      ref: this.string(n.ref, `${field}.ref`),
      role: this.string(n.role, `${field}.role`),
      name: this.text(n.name, `${field}.name`),
      states: this.array(n.states, `${field}.states`, RESPONSE_LIMITS.states).map((s, i) => this.string(s, `${field}.states[${i}]`)),
    };
    const value_ = this.optionalText(n.value, `${field}.value`);
    if (value_ !== undefined) node.value = value_;
    const bounds = n.bounds === undefined || n.bounds === null ? undefined : this.a11yBounds(n.bounds);
    if (bounds) node.bounds = bounds;
    const parent = this.optionalString(n.parent, `${field}.parent`);
    if (parent !== undefined) node.parent = parent;
    return node;
  }

  tree(value: unknown, field: string): TreeNode[] {
    return this.array(value, field, RESPONSE_LIMITS.treeNodes).map((n, i) => this.node(n, `${field}[${i}]`));
  }

  window(value: unknown, field: string): WindowInfo {
    const w = this.object(value, field);
    return { ref: this.string(w.ref, `${field}.ref`), title: this.text(w.title, `${field}.title`), bounds: this.windowBounds(w.bounds, `${field}.bounds`) };
  }

  windows(value: unknown, field: string): WindowInfo[] {
    return this.array(value, field, RESPONSE_LIMITS.windows).map((w, i) => this.window(w, `${field}[${i}]`));
  }
}

type Validators = { [M in Method]: (c: Checker, r: Obj) => Result<M> };

const VALIDATORS: Validators = {
  hello: (c, r) => ({
    protocol: c.integer(r.protocol, "protocol"),
    helperVersion: c.string(r.helperVersion, "helperVersion"),
    os: c.string(r.os, "os"),
    arch: (() => {
      const arch = c.string(r.arch, "arch", 64);
      if (!/^[A-Za-z0-9_.-]+$/.test(arch)) c.fail("arch has unexpected characters");
      return arch;
    })(),
    capabilities: c.array(r.capabilities, "capabilities", 256).map((x, i) => c.string(x, `capabilities[${i}]`)),
    // Owned copy: the fingerprint ends up in a cache key and must not pin the response line.
    ...(r.platform !== undefined ? { platform: ownedSlice(c.string(r.platform, "platform", RESPONSE_LIMITS.platformChars)) } : {}),
  }),
  ping: () => ({ ok: true }),
  launch: (c, r) => ({ pid: c.integer(r.pid, "pid", 0), windows: c.windows(r.windows, "windows"), ...(r.truncated !== undefined ? { truncated: c.boolean(r.truncated, "truncated") } : {}) }),
  wait: (c, r) => ({ matched: c.boolean(r.matched, "matched"), elapsedMs: c.number(r.elapsedMs, "elapsedMs", 0) }),
  snapshot: (c, r) => {
    const coverage = c.string(r.coverage, "coverage");
    if (coverage !== "full" && coverage !== "partial" && coverage !== "none") c.fail(`coverage "${coverage}" is unknown`);
    return { snapshotId: c.string(r.snapshotId, "snapshotId"), coverage: coverage as Coverage, tree: c.tree(r.tree, "tree"), truncated: c.boolean(r.truncated, "truncated") };
  },
  snapshotFull: (c, r) => ({ tree_gz_base64: c.base64(r.tree_gz_base64, "tree_gz_base64", RESPONSE_LIMITS.treeGzBase64Chars) }),
  screenshot: (c, r) => {
    const px = RESPONSE_LIMITS.pixels;
    const png = c.base64(r.png_base64, "png_base64", RESPONSE_LIMITS.pngBase64Chars);
    if (!Buffer.from(png.slice(0, 12), "base64").subarray(0, 8).equals(PNG_SIGNATURE)) c.fail("png_base64 is not a PNG");
    const result: Result<"screenshot"> = {
      captureId: c.string(r.captureId, "captureId"),
      target: c.string(r.target, "target"),
      origin: (() => {
        const o = c.object(r.origin, "origin");
        return { x: c.number(o.x, "origin.x", -px, px), y: c.number(o.y, "origin.y", -px, px) };
      })(),
      width: c.integer(r.width, "width", 1, px),
      height: c.integer(r.height, "height", 1, px),
      scale: c.number(r.scale, "scale", Number.MIN_VALUE, 1),
      png_base64: png,
      sha256: c.string(r.sha256, "sha256", 128),
    };
    if (r.allBlack !== undefined) result.allBlack = c.boolean(r.allBlack, "allBlack");
    return result;
  },
  act: () => ({ ok: true }),
  windows: (c, r) => ({ windows: c.windows(r.windows, "windows"), ...(r.truncated !== undefined ? { truncated: c.boolean(r.truncated, "truncated") } : {}) }),
  exec: (c, r) => ({ exitCode: c.integer(r.exitCode, "exitCode", -1_000, 1_000), elapsedMs: c.number(r.elapsedMs, "elapsedMs", 0) }),
  cancel: () => ({ ok: true }),
  depsPack: (c, r) => ({
    transfer: c.transfer(r.transfer, "transfer"),
    size: c.integer(r.size, "size", 0, RESPONSE_LIMITS.depsBytes),
    sha256: c.sha256(r.sha256, "sha256"),
    entries: c.integer(r.entries, "entries", 0, RESPONSE_LIMITS.depsEntries),
    skipped: c.integer(r.skipped, "skipped", 0, RESPONSE_LIMITS.depsEntries),
  }),
  depsRead: (c, r) => {
    const data = c.base64(r.data_base64, "data_base64", RESPONSE_LIMITS.depsChunkBase64Chars);
    return { data_base64: data, eof: c.boolean(r.eof, "eof") };
  },
  depsReceive: (c, r) => ({ transfer: c.transfer(r.transfer, "transfer") }),
  depsWrite: (c, r) => ({ received: c.integer(r.received, "received", 0, RESPONSE_LIMITS.depsBytes) }),
  depsUnpack: (c, r) => ({
    entries: c.integer(r.entries, "entries", 0, RESPONSE_LIMITS.depsEntries),
    bytes: c.integer(r.bytes, "bytes", 0, RESPONSE_LIMITS.depsBytes),
  }),
  depsDiscard: () => ({ ok: true }),
  stop: (c, r) => ({
    ok: c.boolean(r.ok, "ok"),
    leftovers: c.array(r.leftovers, "leftovers", RESPONSE_LIMITS.leftovers).map((l, i) => {
      const o = c.object(l, `leftovers[${i}]`);
      const detail = c.optionalString(o.detail, `leftovers[${i}].detail`, 1_024);
      return { kind: c.string(o.kind, `leftovers[${i}].kind`, 64), id: c.string(o.id, `leftovers[${i}].id`), ...(detail !== undefined ? { detail } : {}) };
    }),
  }),
};

/**
 * Checks a helper result against the shape of `method` and returns a copy
 * that holds only the known fields.
 *
 * @throws BadResponseError when a field is missing, has the wrong type, or is out of bounds.
 */
export function validateResult<M extends Method>(method: M, result: unknown): Result<M> {
  const c = new Checker(method);
  return (VALIDATORS[method] as (c: Checker, r: Obj) => Result<M>)(c, c.object(result, "result"));
}

/**
 * Unpacks and validates a `snapshotFull` dump with bounded memory.
 *
 * @throws BadResponseError when the dump is not gzip, too large, not JSON, or not a node list.
 */
export function decodeTreeDump(treeGzBase64: string): TreeNode[] {
  const c = new Checker("snapshotFull");
  let json = "";
  try {
    json = gunzipSync(Buffer.from(treeGzBase64, "base64"), { maxOutputLength: RESPONSE_LIMITS.treeJsonBytes }).toString("utf8");
  } catch (error) {
    c.fail(`tree dump does not unpack: ${(error as Error).message}`);
  }
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(json);
  } catch {
    c.fail("tree dump is not JSON");
  }
  return c.tree(parsed, "tree");
}
