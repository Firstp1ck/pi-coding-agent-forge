/**
 * SSH keys of the Windows guest, generated on this machine with the user's
 * `ssh-keygen` and kept in `<agent dir>/gui/docker-windows/` (directory 0700,
 * files 0600):
 *
 * - `id_ed25519` (+ `.pub`): this machine's login key; the public half goes
 *   into the guest's `administrators_authorized_keys` during the install.
 * - `ssh_host_ed25519_key` (+ `.pub`): the guest's host key. The private half
 *   is only needed until the install has put it into the guest; it is deleted
 *   afterwards. The public half is pinned in `known_hosts` under
 *   {@link HOST_KEY_ALIAS}, so the client never trusts a key it did not make.
 */
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "../../runner/types.ts";
import { describeFailure } from "../docker/cli.ts";
import { HOST_KEY_ALIAS } from "./constants.ts";

export interface GuestKeys {
  dir: string;
  clientKey: string;
  clientPub: string;
  hostKey: string;
  hostPub: string;
  knownHosts: string;
}

export function keyPaths(dir: string): GuestKeys {
  return {
    dir,
    clientKey: join(dir, "id_ed25519"),
    clientPub: join(dir, "id_ed25519.pub"),
    hostKey: join(dir, "ssh_host_ed25519_key"),
    hostPub: join(dir, "ssh_host_ed25519_key.pub"),
    knownHosts: join(dir, "known_hosts"),
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** `ssh-ed25519 AAAA…` without the comment; refuses anything else. */
export function publicKeyLine(text: string): string {
  const match = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})(?:\s|$)/.exec(text.trim());
  if (!match) throw new Error("not an ssh-ed25519 public key");
  return `${match[1]} ${match[2]}`;
}

async function generate(runner: CommandRunner, path: string, comment: string, signal?: AbortSignal): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}.pub`, { force: true });
  const result = await runner.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", path], { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) throw new Error(`ssh-keygen failed (${describeFailure(result)})`);
  await chmod(path, 0o600);
  await chmod(`${path}.pub`, 0o600);
}

/**
 * Creates the keys that are missing (`withHostKey`: also a host key pair when
 * none is pinned yet) and (re)writes `known_hosts`. Existing keys are reused,
 * so a resumed install keeps the identity it started with.
 *
 * @throws Error when `ssh-keygen` is missing or fails.
 */
export async function ensureKeys(dir: string, runner: CommandRunner, options: { withHostKey: boolean; signal?: AbortSignal }): Promise<GuestKeys> {
  const keys = keyPaths(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if (!(await exists(keys.clientKey)) || !(await exists(keys.clientPub))) await generate(runner, keys.clientKey, "pi-gui-testing-docker-windows-client", options.signal);
  if (options.withHostKey && (!(await exists(keys.hostKey)) || !(await exists(keys.hostPub)))) await generate(runner, keys.hostKey, "pi-gui-testing-docker-windows-host", options.signal);
  if (await exists(keys.hostPub)) await writeKnownHosts(keys);
  return keys;
}

/** Writes `known_hosts` with the pinned guest host key only. */
export async function writeKnownHosts(keys: GuestKeys): Promise<void> {
  const line = publicKeyLine(await readFile(keys.hostPub, "utf8"));
  await writeFile(keys.knownHosts, `${HOST_KEY_ALIAS} ${line}\n`, { mode: 0o600 });
  await chmod(keys.knownHosts, 0o600);
}

/** The client's public key line, for the guest's `administrators_authorized_keys`. */
export async function clientPublicKey(keys: GuestKeys): Promise<string> {
  return publicKeyLine(await readFile(keys.clientPub, "utf8"));
}

/** Deletes the guest host's private key from this machine (after the install put it into the guest). */
export async function forgetHostPrivateKey(keys: GuestKeys): Promise<void> {
  await rm(keys.hostKey, { force: true });
}

/** `true` when this machine can log in to an installed guest (client key and pinned host key present). */
export async function keysReady(dir: string): Promise<boolean> {
  const keys = keyPaths(dir);
  return (await exists(keys.clientKey)) && (await exists(keys.knownHosts));
}
