/**
 * Which SSH host a remote backend talks to (spec §4.2a, §7 `remote.host`).
 *
 * Checks and sweeps run outside a session, where no `ResolvedConfig` is at
 * hand, so each operation works on a view bound to its own host through
 * {@link RemoteHostCapability.forHost} (from `--host`, the picker, or
 * `remote.host`); the shared backend is never re-pointed, so concurrent
 * operations cannot redirect each other. A session start uses `config.remote.host`.
 */
import type { Backend } from "../../backend.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { HostSupport } from "../host-support.ts";
import { assertDestination } from "../../transport/ssh/quote.ts";

/** Client platforms of the remote backends: OpenSSH with ControlMaster (not available in the Windows OpenSSH port). */
export const REMOTE_HOST_SUPPORT: HostSupport = {
  platforms: ["linux", "darwin"],
  otherwise: "the remote backends need an OpenSSH client with ControlMaster support (Linux or macOS); Windows clients are planned",
};

/** A backend that works against one SSH host chosen by the user. */
export interface RemoteHostCapability {
  /** The SSH alias (or `user@host`) in use, if one was set. */
  readonly remoteHost: string | undefined;
  /**
   * A view of the same backend bound to `host` for checks, sweeps, audits,
   * image builds, and smoke sessions. The receiver is not changed.
   *
   * @throws Error for a value that is not a usable SSH destination.
   */
  forHost(host: string | undefined): Backend & RemoteHostCapability;
}

export function hasRemoteHost(backend: Backend): backend is Backend & RemoteHostCapability {
  const b = backend as Partial<RemoteHostCapability>;
  return typeof b.forHost === "function" && "remoteHost" in b;
}

/** `backend` bound to `host` when it is a remote backend; any other backend unchanged. */
export function bindHost<B extends Backend>(backend: B, host: string | undefined): B {
  return hasRemoteHost(backend) ? (backend.forHost(host) as unknown as B) : backend;
}

/** The host for a session: `config.remote.host`, else the backend's own. */
export function sessionHost(config: ResolvedConfig, fallback: string | undefined): string | undefined {
  const host = config.remote?.host ?? fallback;
  return host === undefined ? undefined : assertDestination(host);
}

/** The message for a remote backend without a host. */
export function noHostMessage(backend: string): string {
  return `no SSH host is configured for ${backend}; run /gui-setup ${backend} --host <ssh-alias> (or pick one from ~/.ssh/config in /gui-setup)`;
}
