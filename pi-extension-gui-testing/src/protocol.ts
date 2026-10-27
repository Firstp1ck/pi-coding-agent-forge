/**
 * Helper JSON-lines protocol shared by the TypeScript client and every helper
 * (spec §6). Frozen in Wave 0 of the M1 plan; changes go through the
 * integration owner and bump {@link PROTOCOL_VERSION}.
 *
 * Wire format: after the ready line, every protocol line is
 * `<token> <json>\n`. Lines without the token prefix are diagnostics.
 */

/** Bumped on every incompatible change; `hello` fails closed on mismatch. */
export const PROTOCOL_VERSION = 1;

/** Environment variable that carries the framing token to the helper (never argv, so it stays out of `ps`). */
export const TOKEN_ENV = "PI_GUI_TESTING_TOKEN";
/** Token length in hex characters (128 bits). It separates protocol lines from noise; it is not a secret. */
export const TOKEN_HEX_LENGTH = 32;
/** The helper prints `${READY_PREFIX} <token>` once it accepts requests. */
export const READY_PREFIX = "PI-GUI-TESTING-READY";
/** The session fails when the ready line does not arrive within this time. */
export const READY_TIMEOUT_MS = 10_000;

export const HEARTBEAT_INTERVAL_MS = 15_000;
/** A helper that receives no client message for this long tears down and exits. */
export const HEARTBEAT_TIMEOUT_MS = 60_000;
/**
 * Test-only override for the helper's heartbeat timeout, in milliseconds.
 * Production code never sets it; e2e tests use it to exercise the heartbeat path quickly.
 */
export const HEARTBEAT_TIMEOUT_TEST_ENV = "PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS";

/** Upper bound for one protocol line; longer lines are a protocol error. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** Upper bound for the `data` field of one `log` event. */
export const MAX_LOG_EVENT_BYTES = 64 * 1024;

/** Requests that bypass the per-session sequential queue (spec §6). */
export const QUEUE_BYPASS_METHODS = ["ping", "cancel"] as const;

export type ErrorCode =
  | "STALE_REF"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "HANDOFF"
  | "PROTOCOL_MISMATCH"
  | "CANCELLED"
  | "BAD_REQUEST"
  | "INTERNAL";

export interface ProtocolError {
  code: ErrorCode;
  message: string;
}

/** Window or screen bounds in screen pixels. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Typed leftover reported by `stop` and by footprint audits. `kind` is an open
 * string (`container`, `process`, `tempdir`, `job`, `desktop`, …) so later
 * backends add kinds without a protocol change.
 */
export interface Leftover {
  kind: string;
  id: string;
  detail?: string;
}

export type Coverage = "full" | "partial" | "none";

export interface TreeNode {
  /** `<snapshotId>:<n>`; valid only until the next snapshot. */
  ref: string;
  role: string;
  name: string;
  value?: string;
  bounds?: Bounds;
  states: string[];
  /** Ref of the parent node; absent for roots. */
  parent?: string;
}

export interface WindowInfo {
  ref: string;
  title: string;
  bounds: Bounds;
}

export type WaitFor = "window" | "text" | "ref" | "idle";

export type ActAction =
  | "click"
  | "double_click"
  | "right_click"
  | "type"
  | "key"
  | "scroll"
  | "set_value";

/** Request parameters and results, keyed by method name. */
export interface Methods {
  hello: {
    params: { protocol: number; packageVersion: string };
    result: {
      protocol: number;
      helperVersion: string;
      os: string;
      arch: string;
      capabilities: string[];
    };
  };
  ping: { params: Record<string, never>; result: { ok: true } };
  launch: {
    params: { cmd: string; args: string[]; env: Record<string, string>; cwd: string };
    result: { pid: number; windows: WindowInfo[] };
  };
  wait: {
    params: { for: WaitFor; value?: string; timeoutMs: number };
    result: { matched: boolean; elapsedMs: number };
  };
  snapshot: {
    params: { maxNodes: number };
    result: {
      snapshotId: string;
      coverage: Coverage;
      /** Truncated to `maxNodes`; the full tree comes from `snapshotFull`. */
      tree: TreeNode[];
      truncated: boolean;
    };
  };
  snapshotFull: {
    params: { snapshotId: string };
    /** Gzip-compressed JSON array of {@link TreeNode}, base64-encoded. */
    result: { tree_gz_base64: string };
  };
  screenshot: {
    params: { window?: string; maxEdge?: number };
    result: {
      /** Identifies this capture; only the most recent capture is valid for coordinate actions. */
      captureId: string;
      /** `"screen"` or the window ref that was captured. */
      target: string;
      /** Top-left corner of the captured area on the screen. */
      origin: Point;
      /** Unscaled capture size in pixels. */
      width: number;
      height: number;
      /** Downscale factor of the returned PNG (returned size = unscaled size × scale; 1 = not scaled). */
      scale: number;
      png_base64: string;
      /** SHA-256 of the unscaled capture, hex. */
      sha256: string;
      /** Set when the capture is entirely black. */
      allBlack?: boolean;
    };
  };
  act: {
    /**
     * Either `ref`, or `captureId` + `x`,`y` in the unscaled pixel space of that
     * capture. An older `captureId` fails with `STALE_REF`.
     */
    params: {
      ref?: string;
      captureId?: string;
      x?: number;
      y?: number;
      action: ActAction;
      text?: string;
    };
    result: { ok: true };
  };
  windows: { params: Record<string, never>; result: { windows: WindowInfo[] } };
  exec: {
    /** Runs a `setup` command via `sh -c`; output arrives as `log` events with `source: "setup"`. */
    params: { cmd: string; cwd: string; env: Record<string, string>; timeoutMs: number };
    result: { exitCode: number; elapsedMs: number };
  };
  cancel: { params: { targetId: number }; result: { ok: true } };
  stop: { params: Record<string, never>; result: { ok: boolean; leftovers: Leftover[] } };
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];

/** Client → helper. `id` is unique per connection and increases monotonically. */
export interface Request<M extends Method = Method> {
  id: number;
  method: M;
  params: Params<M>;
}

/** Helper → client, answering the request with the same `id`. */
export type Response<M extends Method = Method> =
  | { id: number; ok: true; result: Result<M> }
  | { id: number; ok: false; error: ProtocolError };

/** Helper → client, unsolicited. Events carry no `id`. */
export interface LogEvent {
  event: "log";
  stream: "stdout" | "stderr";
  source: "app" | "setup";
  /** UTF-8 text, at most {@link MAX_LOG_EVENT_BYTES} bytes. */
  data: string;
}

export type HelperEvent = LogEvent;
export type HelperMessage = Response | HelperEvent;
