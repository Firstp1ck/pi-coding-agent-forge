/**
 * SSH transport (spec §4.2a, `HelperTransport` contract in
 * `../types.ts`): short remote commands through a {@link CommandRunner}, the
 * remote helper with open pipes, binary streams (tar, build contexts), and the
 * per-session ControlMaster.
 *
 * Only the user's OpenSSH client is used, with the options of
 * {@link baseSshOptions}. Every argument is quoted for the remote login shell
 * ({@link shellQuote}); scripts run under `/bin/sh -c` with their arguments
 * as positional parameters, never spliced into the script text.
 *
 * Remote environment: short commands run with the login environment minus the
 * desktop variables (`DISPLAY`, `WAYLAND_*`, the session bus, `XAUTHORITY`).
 * The helper runs under `env -i` with only {@link REMOTE_INHERITED_ENV} from
 * the login environment plus the caller's variables. Those are written to
 * the remote stdin as the first lines and read by `/bin/sh` after `env -i`,
 * so no value (in particular the protocol token) appears in any argv.
 */
import { rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createSpawner, type Spawner } from "../../backends/docker/process.ts";
import { createSpawnRunner } from "../../runner/spawn.ts";
import type { CommandRunner, RunOptions, RunResult } from "../../runner/types.ts";
import type { HelperProcess } from "../process.ts";
import type { HelperTransport } from "../types.ts";
import { classifySshFailure, SshError, sshErrorLine } from "./errors.ts";
import { baseSshOptions, controlOptions, DEFAULT_CONNECT_TIMEOUT_S, type ControlLocation } from "./options.ts";
import { assertDestination, assertEnvEntry, shellJoin, shScript } from "./quote.ts";
import { createDetachedRunner, runPiped, type DetachedRunner, type PipedRunOptions } from "./stream.ts";

/** Login-environment variables the remote helper keeps under `env -i`. */
export const REMOTE_INHERITED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ"] as const;

/** Desktop variables removed from every short remote command (R5). */
export const REMOTE_DESKTOP_ENV = ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY"] as const;

/** Exit code of the remote wrapper when `cwd` does not exist. */
export const REMOTE_CWD_EXIT = 125;
/** Exit code of the remote wrapper when the environment preamble is incomplete. */
export const REMOTE_PREAMBLE_EXIT = 97;

/** Bound for `ssh -O exit` / `-O check`. */
const CONTROL_COMMAND_TIMEOUT_MS = 5_000;

export interface SshTransportOptions {
  /** SSH alias (or `user@host`, `ssh://…`); validated with {@link assertDestination}. */
  destination: string;
  /** ControlMaster socket; without it every call connects on its own (checks, one-shot audits). */
  control?: ControlLocation;
  /** Local runner for `ssh` calls; default {@link createSpawnRunner}. */
  runner?: CommandRunner;
  /** Local spawner for long-lived and streaming `ssh` calls; default the minimal-env spawner. */
  spawner?: Spawner;
  /** Starts the backgrounded master; default {@link createDetachedRunner}. */
  detached?: DetachedRunner;
  /** `ssh` executable; default `ssh` on PATH. */
  ssh?: string;
  /** Upper bound for the connect timeout of one call (seconds). */
  connectTimeoutS?: number;
}

export interface RemoteCommandOptions {
  env?: Readonly<Record<string, string>>;
  cwd?: string;
}

/**
 * The remote command line for `argv`: desktop variables removed, `cwd`
 * (default `/`), extra `env` through `env(1)`, then `exec`.
 *
 * @throws Error for an empty argv, an `argv[0]` that `env` would misread
 *   (contains `=` or starts with `-`), or an invalid env entry.
 */
export function remoteCommand(argv: readonly string[], options: RemoteCommandOptions = {}): string {
  if (argv.length === 0) throw new Error("empty argv");
  if (argv[0].includes("=") || argv[0].startsWith("-")) throw new Error(`remote command ${JSON.stringify(argv[0])} cannot be run`);
  const env = Object.entries(options.env ?? {});
  for (const [name, value] of env) assertEnvEntry(name, value);
  const parts = [`unset ${REMOTE_DESKTOP_ENV.join(" ")} 2>/dev/null;`];
  const args: string[] = [];
  if (options.cwd !== undefined) {
    parts.push(`cd -- "$1" || exit ${REMOTE_CWD_EXIT}; shift;`);
    args.push(options.cwd);
  } else {
    parts.push(`cd / || exit ${REMOTE_CWD_EXIT};`);
  }
  parts.push(env.length > 0 ? 'exec env "$@"' : 'exec "$@"');
  args.push(...env.map(([name, value]) => `${name}=${value}`), ...argv);
  return shScript(parts.join(" "), args);
}

/**
 * The remote command line that starts `argv` under `env -i` with the
 * inherited login variables, after reading `keys` (sorted) from stdin.
 *
 * @throws Error for an empty argv or an invalid key.
 */
export function helperCommand(argv: readonly string[], keys: readonly string[]): string {
  if (argv.length === 0) throw new Error("empty argv");
  for (const key of keys) assertEnvEntry(key, "");
  const inherit = REMOTE_INHERITED_ENV.map((k) => `\${${k}+"${k}=$${k}"}`).join(" ");
  const reads = keys.map((k) => `IFS= read -r ${k} || exit ${REMOTE_PREAMBLE_EXIT}; export ${k};`).join(" ");
  const run = keys.length > 0 ? `/bin/sh -c '${reads} exec "$@"' sh "$@"` : '"$@"';
  return shScript(`cd / || exit ${REMOTE_CWD_EXIT}; exec env -i ${inherit} ${run}`, argv);
}

export class SshTransport implements HelperTransport {
  readonly destination: string;
  /** Short commands on the remote host. */
  readonly runner: CommandRunner;
  readonly #options: SshTransportOptions;
  readonly #local: CommandRunner;
  readonly #spawner: Spawner;
  #closing?: Promise<void>;
  /** Set by the first `close()`: later calls connect directly, never through the socket. */
  #closed = false;
  #opened = false;

  constructor(options: SshTransportOptions) {
    this.destination = assertDestination(options.destination);
    this.#options = options;
    this.#local = options.runner ?? createSpawnRunner();
    this.#spawner = options.spawner ?? createSpawner();
    this.runner = { run: (argv, runOptions) => this.#run(argv, runOptions) };
  }

  /** `true` when the transport has a ControlMaster socket and was not closed. */
  get multiplexed(): boolean {
    return this.#options.control !== undefined && !this.#closed;
  }

  /** The socket location, if any. */
  get control(): ControlLocation | undefined {
    return this.#options.control;
  }

  get #ssh(): string {
    return this.#options.ssh ?? "ssh";
  }

  #connectTimeout(timeoutMs?: number): number {
    const limit = this.#options.connectTimeoutS ?? DEFAULT_CONNECT_TIMEOUT_S;
    if (timeoutMs === undefined) return limit;
    return Math.max(1, Math.min(limit, Math.ceil(timeoutMs / 2_000)));
  }

  #controlArgs(): string[] {
    const control = this.#options.control;
    return control && !this.#closed ? controlOptions({ kind: "client", path: control.path }) : controlOptions({ kind: "none" });
  }

  /** Local argv of `ssh … -T -- <destination> <remote command line>`. */
  sshArgv(command: string, options: { timeoutMs?: number } = {}): string[] {
    return [this.#ssh, ...baseSshOptions(this.#connectTimeout(options.timeoutMs)), ...this.#controlArgs(), "-T", "--", this.destination, command];
  }

  /**
   * Argv for the synchronous exit handler: one bounded `ssh` call that runs
   * `command` (connect timeout 3 s; through the master when it still runs).
   */
  exitArgv(command: string): string[] {
    const control = this.#options.control;
    const mode = control ? controlOptions({ kind: "client", path: control.path }) : controlOptions({ kind: "none" });
    return [this.#ssh, ...baseSshOptions(3), ...mode, "-T", "--", this.destination, command];
  }

  /** `rsync -e` value: the `ssh` command with this transport's options (rsync appends the host). */
  rshCommand(): string {
    return [this.#ssh, ...baseSshOptions(this.#connectTimeout()), ...this.#controlArgs(), "-T"].join(" ");
  }

  #run(argv: readonly string[], options: RunOptions): Promise<RunResult> {
    let command: string;
    try {
      command = remoteCommand(argv, { ...(options.env ? { env: options.env } : {}), ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#local.run(this.sshArgv(command, { timeoutMs: options.timeoutMs }), {
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    });
  }

  /**
   * Runs `argv` on the remote host with binary or streamed stdin.
   */
  runStream(argv: readonly string[], input: Buffer | Readable, options: PipedRunOptions & RemoteCommandOptions): Promise<RunResult> {
    let command: string;
    try {
      command = remoteCommand(argv, { ...(options.env ? { env: options.env } : {}), ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
    } catch (error) {
      return Promise.reject(error);
    }
    return runPiped(this.#spawner, this.sshArgv(command, { timeoutMs: options.timeoutMs }), input, options);
  }

  /**
   * Starts `argv` on the remote host under `env -i` with the inherited login
   * variables and `env`; `env` travels on stdin (see the module comment).
   *
   * @throws Error for an invalid env entry or an empty argv.
   */
  spawnHelper(argv: readonly string[], env: Readonly<Record<string, string>>): HelperProcess {
    const keys = Object.keys(env).sort();
    for (const key of keys) assertEnvEntry(key, env[key]);
    const child = this.#spawner.spawn(this.sshArgv(helperCommand(argv, keys)), {});
    if (keys.length > 0) child.stdin.write(`${keys.map((k) => env[k]).join("\n")}\n`);
    return child;
  }

  /** Spawner whose children run on the remote host (for `docker run -i`, `docker build -`). */
  remoteSpawner(): Spawner {
    return { spawn: (argv, options) => this.spawnHelper(argv, options?.env ?? {}) };
  }

  /**
   * Starts the ControlMaster (backgrounded `ssh -M -N -f`, ending on its own
   * after {@link CONTROL_PERSIST_S} without clients). A transport without a
   * control location does nothing.
   *
   * @throws SshError naming the failure class (auth, host key, unreachable, …).
   */
  async open(signal?: AbortSignal, timeoutMs = 20_000): Promise<void> {
    const control = this.#options.control;
    if (!control) return;
    if (this.#closed) throw new Error("the SSH transport was closed");
    if (this.#opened) return;
    const argv = [this.#ssh, ...baseSshOptions(this.#connectTimeout(timeoutMs)), ...controlOptions({ kind: "master", path: control.path }), "-N", "-f", "--", this.destination];
    const detached = this.#options.detached ?? createDetachedRunner();
    const result = await detached.run(argv, { logPath: `${control.path}.log`, timeoutMs, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0) {
      const line = sshErrorLine(result.stderr) || (result.timedOut ? `no connection within ${timeoutMs} ms` : `ssh exited with ${result.exitCode ?? result.signal}`);
      throw new SshError(`cannot connect to ${this.destination}: ${line}`, result.timedOut ? "unreachable" : classifySshFailure(result.stderr));
    }
    this.#opened = true;
  }

  /** `true` when a master answers on the socket (`ssh -O check`). Read-only. */
  async masterRunning(signal?: AbortSignal): Promise<boolean> {
    const control = this.#options.control;
    if (!control) return false;
    const result = await this.#local
      .run([this.#ssh, "-o", `ControlPath=${control.path.replace(/%/g, "%%")}`, "-O", "check", "--", this.destination], { timeoutMs: CONTROL_COMMAND_TIMEOUT_MS, ...(signal ? { signal } : {}) })
      .catch(() => undefined);
    return result?.exitCode === 0;
  }

  /**
   * Ends the ControlMaster (`ssh -O exit`) and removes a separate short
   * socket directory. Concurrent calls share one attempt; when the master
   * still answers afterwards, the next call tries again. From the first call
   * on, every command connects directly.
   */
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
    const exit = await this.#local.run([this.#ssh, "-o", `ControlPath=${path}`, "-O", "exit", "--", this.destination], { timeoutMs: CONTROL_COMMAND_TIMEOUT_MS }).catch(() => undefined);
    if (exit?.exitCode !== 0 && (await this.masterRunning())) return false;
    if (control.shortDir) await rm(control.shortDir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }
}

/** A transport without ControlMaster, for checks and audits ("a fresh SSH call", spec §7a.3). */
export function oneShotTransport(destination: string, options: Omit<SshTransportOptions, "destination" | "control"> = {}): SshTransport {
  return new SshTransport({ ...options, destination });
}

/** `shellJoin` re-exported for callers that build exit commands. */
export { shellJoin };
