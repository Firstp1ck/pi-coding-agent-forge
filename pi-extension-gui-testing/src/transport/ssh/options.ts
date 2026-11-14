/**
 * OpenSSH client options of every call this package makes (spec §4.2a, plan
 * invariant 3): never prompt (`BatchMode=yes`), never trust a new host key
 * silently (`StrictHostKeyChecking=yes`), never write `known_hosts`
 * (`UpdateHostKeys=no`), no agent, X11, or port forwarding, a connect timeout,
 * and keep-alives so a dead link ends the session. The user's own
 * `~/.ssh/config` still applies to everything else (keys, user, jump hosts);
 * this package only reads it.
 */
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

/** Seconds between keep-alives; three missed ones end the connection. */
export const SERVER_ALIVE_INTERVAL_S = 15;
/** How long the per-session ControlMaster stays up without any client (crash safety: it ends on its own). */
export const CONTROL_PERSIST_S = 60;
/** Default connect timeout for one call (seconds). */
export const DEFAULT_CONNECT_TIMEOUT_S = 10;

/** Options for every `ssh` invocation, before the connection-specific ones. */
export function baseSshOptions(connectTimeoutS: number = DEFAULT_CONNECT_TIMEOUT_S): string[] {
  const timeout = Math.max(1, Math.min(60, Math.ceil(connectTimeoutS)));
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no",
    "-o", `ConnectTimeout=${timeout}`,
    "-o", `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_S}`,
    "-o", "ServerAliveCountMax=3",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
  ];
}

/** How a call uses the session's ControlMaster socket. */
export type ControlMode =
  /** No multiplexing at all, whatever the user's config says (checks, one-shot calls). */
  | { kind: "none" }
  /** Use the socket when a master listens there; otherwise connect directly. */
  | { kind: "client"; path: string }
  /** Start the master (backgrounded, ends after {@link CONTROL_PERSIST_S} without clients). */
  | { kind: "master"; path: string };

/** `%` starts an OpenSSH token in `ControlPath`; a literal one is written `%%`. */
function escapeControlPath(path: string): string {
  return path.replace(/%/g, "%%");
}

/** Options selecting the ControlMaster behaviour. */
export function controlOptions(mode: ControlMode): string[] {
  if (mode.kind === "none") return ["-o", "ControlMaster=no", "-o", "ControlPath=none"];
  const path = escapeControlPath(mode.path);
  if (mode.kind === "client") return ["-o", "ControlMaster=no", "-o", `ControlPath=${path}`];
  return ["-o", "ControlMaster=yes", "-o", `ControlPath=${path}`, "-o", `ControlPersist=${CONTROL_PERSIST_S}`];
}

/**
 * Longest socket path accepted. `sun_path` holds 104 bytes on macOS and 108 on
 * Linux, and OpenSSH first binds `<path>.<16 random chars>` before renaming,
 * so the path itself must leave 17 bytes and a NUL free.
 */
export const MAX_CONTROL_PATH_BYTES = 104 - 17 - 1;

/** Characters allowed in a control path (no whitespace or quotes: `ssh -o` and `rsync -e` split on them). */
const SAFE_LOCAL_PATH = /^\/[A-Za-z0-9._/@+-]*$/;

/** `true` when `path` can be used as a `ControlPath` as is. */
export function usableControlPath(path: string): boolean {
  return Buffer.byteLength(path) <= MAX_CONTROL_PATH_BYTES && SAFE_LOCAL_PATH.test(path);
}

/** Prefix of the fallback directory for control sockets when the session dir path is too long. */
export const SHORT_CONTROL_DIR_PREFIX = "pgt-ssh-";

export interface ControlLocation {
  /** Socket path. */
  path: string;
  /** Set when a separate short directory had to be created; the caller removes it at teardown. */
  shortDir?: string;
}

/**
 * Where the ControlMaster socket of a session lives: `<sessionDir>/ssh` when
 * that path is short and plain enough, otherwise a new 0700 directory
 * `/tmp/pgt-ssh-XXXXXX` (the macOS `TMPDIR` is long).
 *
 * @throws Error when neither location is usable.
 */
export async function controlLocation(sessionDir: string, shortRoot = "/tmp"): Promise<ControlLocation> {
  const inSession = join(sessionDir, "ssh");
  if (usableControlPath(inSession)) return { path: inSession };
  const shortDir = await mkdtemp(join(shortRoot, SHORT_CONTROL_DIR_PREFIX));
  const path = join(shortDir, "s");
  if (!usableControlPath(path)) throw new Error(`no usable ControlMaster socket path (tried ${inSession} and ${path})`);
  return { path, shortDir };
}
