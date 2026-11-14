/**
 * SSH to the Windows guest's OpenSSH server (plan decision: the M2b SSH
 * transport's options, ControlMaster, and token-on-stdin model, aimed at a
 * port Docker published on `127.0.0.1` only).
 *
 * Differences from `SshTransport` (`src/transport/ssh/transport.ts`), whose
 * remote side is a POSIX shell: commands here are `cmd.exe` command lines
 * built by `./powershell.ts`, and the connection never reads the user's
 * `~/.ssh/config`, agent, or `known_hosts` (`-F none`): it uses this
 * machine's generated key (`IdentitiesOnly`), the pinned guest host key under
 * {@link HOST_KEY_ALIAS} in its own `known_hosts`, and `StrictHostKeyChecking=yes`
 * as everywhere else ({@link baseSshOptions}).
 */
import { rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createSpawner, type Spawner } from "../docker/process.ts";
import { createSpawnRunner } from "../../runner/spawn.ts";
import type { CommandRunner, RunResult } from "../../runner/types.ts";
import type { HelperProcess } from "../../transport/process.ts";
import { classifySshFailure, SshError, sshErrorLine } from "../../transport/ssh/errors.ts";
import { baseSshOptions, controlOptions, type ControlLocation } from "../../transport/ssh/options.ts";
import { createDetachedRunner, runPiped, type DetachedRunner, type PipedRunOptions } from "../../transport/ssh/stream.ts";
import { GUEST_USER, HOST_KEY_ALIAS } from "./constants.ts";
import { scriptCommand } from "./powershell.ts";

/** Loopback address every published port is bound to. */
export const LOOPBACK = "127.0.0.1";

export interface GuestSshOptions {
  /** Host port Docker published for the guest's port 22. */
  port: number;
  /** Private key of this machine (mode 0600). */
  keyPath: string;
  /** `known_hosts` holding only the guest's pinned host key. */
  knownHostsPath: string;
  user?: string;
  control?: ControlLocation;
  runner?: CommandRunner;
  spawner?: Spawner;
  detached?: DetachedRunner;
  ssh?: string;
}

/** OpenSSH reads these option values as whitespace-separated lists, so the paths must have none. */
function assertOptionPath(path: string, what: string): string {
  if (/[\s"'\\]/.test(path) || path.includes("%")) throw new Error(`${what} path ${JSON.stringify(path)} contains whitespace, quotes, % or \\, which ssh options cannot carry`);
  return path;
}

/** Options that pin the guest connection to this package's key and host key. */
export function guestIdentityOptions(o: Pick<GuestSshOptions, "port" | "keyPath" | "knownHostsPath" | "user">): string[] {
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65_535) throw new Error(`invalid guest SSH port ${o.port}`);
  return [
    "-F", "none",
    "-i", o.keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", `UserKnownHostsFile=${assertOptionPath(o.knownHostsPath, "known_hosts")}`,
    "-o", "GlobalKnownHostsFile=none",
    "-o", `HostKeyAlias=${HOST_KEY_ALIAS}`,
    "-o", "HostKeyAlgorithms=ssh-ed25519",
    "-o", "CheckHostIP=no",
    "-o", "PreferredAuthentications=publickey",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-p", String(o.port),
    "-l", o.user ?? GUEST_USER,
  ];
}

export interface GuestRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export class GuestSsh {
  readonly port: number;
  readonly #options: GuestSshOptions;
  readonly #local: CommandRunner;
  readonly #spawner: Spawner;
  #closed = false;
  #opened = false;
  #closing?: Promise<void>;

  constructor(options: GuestSshOptions) {
    guestIdentityOptions(options);
    this.port = options.port;
    this.#options = options;
    this.#local = options.runner ?? createSpawnRunner();
    this.#spawner = options.spawner ?? createSpawner();
  }

  get #ssh(): string {
    return this.#options.ssh ?? "ssh";
  }

  #control(): string[] {
    const control = this.#options.control;
    return control && !this.#closed && this.#opened ? controlOptions({ kind: "client", path: control.path }) : controlOptions({ kind: "none" });
  }

  /** Local argv of one call running the `cmd.exe` command line `command` in the guest. */
  argv(command: string, connectTimeoutS = 10): string[] {
    return [this.#ssh, ...baseSshOptions(connectTimeoutS), ...guestIdentityOptions(this.#options), ...this.#control(), "-T", "--", LOOPBACK, command];
  }

  /** Runs a `cmd.exe` command line. A connection failure is exit code 255 (like `ssh`). */
  runCommand(command: string, options: GuestRunOptions): Promise<RunResult> {
    return this.#local.run(this.argv(command, Math.max(1, Math.min(10, Math.ceil(options.timeoutMs / 2_000)))), { timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
  }

  /** Runs a PowerShell script (see `./powershell.ts`). */
  runScript(script: string, options: GuestRunOptions): Promise<RunResult> {
    let command: string;
    try {
      command = scriptCommand(script);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.runCommand(command, options);
  }

  /** Runs `command` with binary or streamed stdin (the workspace and helper tar streams). */
  stream(command: string, input: Buffer | Readable, options: PipedRunOptions): Promise<RunResult> {
    return runPiped(this.#spawner, this.argv(command), input, options);
  }

  /** Starts `command` with open pipes and writes `preamble` (the `-StdinEnv` values) first. */
  spawn(command: string, preamble: string): HelperProcess {
    const child = this.#spawner.spawn(this.argv(command), {});
    if (preamble) child.stdin.write(preamble);
    return child;
  }

  /**
   * Starts the ControlMaster (`ssh -M -N -f`, ending itself 60 s after its
   * last client). Without a control location this does nothing.
   *
   * @throws SshError naming the failure class.
   */
  async open(signal?: AbortSignal, timeoutMs = 20_000): Promise<void> {
    const control = this.#options.control;
    if (!control || this.#opened) return;
    if (this.#closed) throw new Error("the guest SSH connection was closed");
    const argv = [this.#ssh, ...baseSshOptions(10), ...guestIdentityOptions(this.#options), ...controlOptions({ kind: "master", path: control.path }), "-N", "-f", "--", LOOPBACK];
    const detached = this.#options.detached ?? createDetachedRunner();
    const result = await detached.run(argv, { logPath: `${control.path}.log`, timeoutMs, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0) {
      const line = sshErrorLine(result.stderr) || (result.timedOut ? `no connection within ${timeoutMs} ms` : `ssh exited with ${result.exitCode ?? result.signal}`);
      throw new SshError(`cannot connect to the Windows guest on ${LOOPBACK}:${this.port}: ${line}`, result.timedOut ? "unreachable" : classifySshFailure(result.stderr));
    }
    this.#opened = true;
  }

  /** `true` when a master answers on the socket. Read-only. */
  async masterRunning(signal?: AbortSignal): Promise<boolean> {
    const control = this.#options.control;
    if (!control) return false;
    const result = await this.#local
      .run([this.#ssh, "-o", `ControlPath=${control.path.replace(/%/g, "%%")}`, "-O", "check", "--", LOOPBACK], { timeoutMs: 5_000, ...(signal ? { signal } : {}) })
      .catch(() => undefined);
    return result?.exitCode === 0;
  }

  /** Ends the ControlMaster; concurrent calls share one attempt, a failed one is retried by the next call. */
  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#close().then((done) => {
      if (!done) this.#closing = undefined;
    });
    return this.#closing;
  }

  async #close(): Promise<boolean> {
    const control = this.#options.control;
    if (!control) return true;
    const path = control.path.replace(/%/g, "%%");
    const exit = await this.#local.run([this.#ssh, "-o", `ControlPath=${path}`, "-O", "exit", "--", LOOPBACK], { timeoutMs: 5_000 }).catch(() => undefined);
    if (exit?.exitCode !== 0 && (await this.masterRunning())) return false;
    if (control.shortDir) await rm(control.shortDir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }
}
