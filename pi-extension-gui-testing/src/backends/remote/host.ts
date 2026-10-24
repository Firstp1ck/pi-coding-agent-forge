/**
 * Which SSH host a remote backend talks to (spec §4.2a, §7 `remote.host`).
 *
 * Checks and sweeps run outside a session, where no `ResolvedConfig` is at
 * hand, so the commands tell the backend its host through
 * {@link RemoteHostCapability.useHost} (from `--host`, the picker, or
 * `remote.host`). A session start prefers `config.remote.host`.
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
   * Sets the host for checks, sweeps, image builds, and sessions whose config names none.
   *
   * @throws Error for a value that is not a usable SSH destination.
   */
  useHost(host: string | undefined): void;
}

export function hasRemoteHost(backend: Backend): backend is Backend & RemoteHostCapability {
  const b = backend as Partial<RemoteHostCapability>;
  return typeof b.useHost === "function" && "remoteHost" in b;
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
