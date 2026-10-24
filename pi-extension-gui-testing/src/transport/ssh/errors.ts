/**
 * Classifies OpenSSH client failures from `ssh`'s stderr (exit code 255), so
 * the host picker and the checks can name the specific remediation.
 */

export type SshFailure =
  /** No key the server accepts (BatchMode never asks for a password). */
  | "auth"
  /** The host key is not in `known_hosts`. */
  | "hostkey-unknown"
  /** The host key differs from the one in `known_hosts`. */
  | "hostkey-changed"
  /** The host name does not resolve. */
  | "resolve"
  /** Refused, timed out, no route. */
  | "unreachable"
  | "other";

/** The failure class of an `ssh` stderr text. */
export function classifySshFailure(stderr: string): SshFailure {
  const text = stderr.toLowerCase();
  if (text.includes("remote host identification has changed") || text.includes("host key for") && text.includes("has changed")) return "hostkey-changed";
  if (text.includes("host key verification failed") || text.includes("no ") && text.includes("host key is known")) return "hostkey-unknown";
  if (text.includes("permission denied") || text.includes("too many authentication failures") || text.includes("no supported authentication methods")) return "auth";
  if (text.includes("could not resolve hostname") || text.includes("name or service not known") || text.includes("nodename nor servname")) return "resolve";
  if (/connection (refused|timed out|closed)|operation timed out|no route to host|network is unreachable|connection reset|timeout, server|kex_exchange_identification/.test(text)) return "unreachable";
  return "other";
}

/** The last meaningful line of `ssh`'s stderr, for one-line messages. */
export function sshErrorLine(stderr: string, max = 300): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^@+$/.test(l) && !l.startsWith("Warning: Permanently added"));
  const line = lines.at(-1) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A connection or ControlMaster failure; `failure` names its class. */
export class SshError extends Error {
  readonly failure: SshFailure;
  constructor(message: string, failure: SshFailure) {
    super(message);
    this.name = "SshError";
    this.failure = failure;
  }
}

/** One-line remediation for a failure class on `destination`. */
export function sshRemediation(failure: SshFailure, destination: string): string {
  switch (failure) {
    case "auth":
      return `install your public key on the host once: ssh-copy-id ${destination} (the package never asks for or stores an SSH password)`;
    case "hostkey-unknown":
      return `connect once yourself to check and accept the host key fingerprint: ssh ${destination}`;
    case "hostkey-changed":
      return `the host key changed; verify the new fingerprint with the host's owner, then update known_hosts (ssh-keygen -R <host>) and connect once: ssh ${destination}`;
    case "resolve":
      return `the host name does not resolve; check the Host entry for ${destination} in ~/.ssh/config`;
    case "unreachable":
      return `the host is unreachable; check that it is on and that sshd listens (ssh ${destination})`;
    default:
      return `run ssh ${destination} true yourself to see the error`;
  }
}
