/**
 * One `docker-windows` session (spec §4.4, §7a): a dockurr/windows container
 * booted from the installed base disk with a copy-on-write overlay (QEMU
 * `-snapshot`, see `./run-args.ts`), its SSH port published on `127.0.0.1`,
 * the workspace synced into a guest session dir, and the Windows helper
 * started over SSH in `guest` mode with its variables on stdin
 * (`-StdinEnv`), never in argv.
 *
 * Teardown on every path (stop, failed start, Pi exit through
 * {@link forceRemoveArgv}): the SSH master ends, `docker rm -f` removes the
 * container, and with it the overlay and the guest session dir. The base disk
 * stamp is compared afterwards: a changed installed disk is reported.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { SessionError, type SyncSummary } from "../../backend.ts";
import type { BackendId } from "../../config/types.ts";
import type { Leftover, LogEvent } from "../../protocol.ts";
import { HEARTBEAT_TIMEOUT_TEST_ENV, TOKEN_ENV } from "../../protocol.ts";
import type { CommandRunner, DockerEndpoint } from "../../runner/types.ts";
import type { FileSet } from "../../sync/fileset.ts";
import { HelperSession } from "../../transport/helper-session.ts";
import { assertEnvEntry } from "../../transport/ssh/quote.ts";
import { classifySshFailure } from "../../transport/ssh/errors.ts";
import type { ControlLocation } from "../../transport/ssh/options.ts";
import { describeFailure, dockerArgv, runDocker } from "../docker/cli.ts";
import { BOOT_POLL_MS, BOOT_TIMEOUT_MS, GUEST_HELPER_DIR, GUEST_SESSIONS, GUEST_SSH_PORT, HELPER_READY_TIMEOUT_MS, type WindowsVmSettings } from "./constants.ts";
import { baseDiskStamp, containerState, lastLogLine, publishedPort, removeContainer } from "./docker.ts";
import type { GuestSsh } from "./guest-ssh.ts";
import { hashScript, helperMismatches } from "./install.ts";
import type { GuestKeys } from "./keys.ts";
import type { HelperFile } from "./oem.ts";
import { assertGuestPath, cmdLine, jsonOut, parseJsonOutput, POWERSHELL, psQuote } from "./powershell.ts";
import { windowsRunArgs } from "./run-args.ts";
import { deployHelper, syncToGuest, type GuestSyncReport } from "./sync.ts";

/** Guest paths of one session. The runtime dir must be named `pi-gui-testing-*` (helper contract). */
export function guestSessionPaths(sessionId: string): { dir: string; workspace: string; runtime: string; helper: string } {
  const dir = assertGuestPath(`${GUEST_SESSIONS}\\${sessionId}`);
  return { dir, workspace: `${dir}\\workspace`, runtime: `${dir}\\pi-gui-testing-${sessionId}`, helper: `${dir}\\helper` };
}

/** Script creating the session dirs; refuses an existing one (the overlay starts from the clean base). */
export function createDirsScript(paths: ReturnType<typeof guestSessionPaths>): string {
  return [
    `if (Test-Path -LiteralPath ${psQuote(paths.dir)}) { throw 'the guest session dir already exists' }`,
    `foreach ($d in @(${[paths.dir, paths.workspace, paths.runtime].map(psQuote).join(", ")})) { New-Item -ItemType Directory -Path $d | Out-Null }`,
    jsonOut("@{ ok = $true }"),
  ].join("\n");
}

/** Command line that starts the helper; the variables named in `-StdinEnv` follow as the first stdin lines. */
export function helperCommandLine(helperDir: string, names: readonly string[]): string {
  return cmdLine([...POWERSHELL, "-File", `${assertGuestPath(helperDir)}\\helper.ps1`, "-StdinEnv", names.join(",")]);
}

export interface DockerWindowsSessionOptions {
  id: string;
  backend: BackendId;
  runner: CommandRunner;
  endpoint: DockerEndpoint;
  packageVersion: string;
  onLog(event: LogEvent): void;
  onStatus?(text: string): void;
  name: string;
  ownerLabel: string;
  installId: string;
  image: string;
  vm: WindowsVmSettings;
  viewer?: boolean;
  keys: GuestKeys;
  control: ControlLocation;
  /** Guest connection to a published port through `control`. */
  guest: (port: number, keys: GuestKeys, control: ControlLocation) => GuestSsh;
  fileSet: FileSet;
  stagingRoot: string;
  helper: readonly HelperFile[];
  /** Base disk stamp before the session (see `baseDiskStamp`). */
  baseStamp?: string;
  allowExec: boolean;
  bootTimeoutMs?: number;
  bootPollMs?: number;
  readyTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  warnings?: readonly string[];
  /** Gives up the machine's one-session lease; called once the container is gone (or was never created). */
  releaseLease?: () => Promise<void>;
}

export class DockerWindowsSession extends HelperSession {
  readonly containerName: string;
  readonly #o: DockerWindowsSessionOptions;
  readonly #paths: ReturnType<typeof guestSessionPaths>;
  #guest?: GuestSsh;
  #helperDir = GUEST_HELPER_DIR;
  #started = false;

  constructor(o: DockerWindowsSessionOptions) {
    const paths = guestSessionPaths(o.id);
    const heartbeat = o.heartbeatTimeoutMs;
    super({
      id: o.id,
      backend: o.backend,
      packageVersion: o.packageVersion,
      onLog: o.onLog,
      workspacePath: paths.workspace,
      workspaceDescription: "a synced copy in the Windows guest (writable; discarded with the session, changes never come back)",
      ...(o.warnings?.length ? { warnings: o.warnings } : {}),
      readyTimeoutMs: o.readyTimeoutMs ?? HELPER_READY_TIMEOUT_MS,
      ...(heartbeat !== undefined ? { heartbeatIntervalMs: Math.max(250, Math.floor(heartbeat / 3)) } : {}),
      labels: { launcher: "ssh", target: "the Windows session", inside: "inside the Windows guest", stillRunning: "ssh to the Windows guest still running" },
      hooks: {
        spawn: (env) => this.#spawn(env),
        verifyAfterStart: async () => {
          const caps = this.capabilities;
          if (!caps.includes("desktop-private") && !caps.includes("desktop-interactive")) {
            throw new SessionError("ISOLATION", `the Windows helper reported no desktop isolation (capabilities: ${caps.join(", ") || "none"}); the session was stopped`);
          }
        },
        onExitTimeout: async () => void (await removeContainer(o.runner, o.endpoint, o.name)),
        teardown: () => this.#teardown(),
        audit: () => this.#audit(),
      },
    });
    this.#o = o;
    this.#paths = paths;
    this.containerName = o.name;
  }

  /** Argv the synchronous exit handler runs: removes the container (and with it the overlay and the guest). */
  forceRemoveArgv(): string[] {
    return dockerArgv(this.#o.endpoint, ["rm", "-f", this.#o.name]);
  }

  #status(text: string): void {
    this.#o.onStatus?.(text);
  }

  /**
   * Everything before the helper: container, boot, SSH, guest dirs,
   * workspace, helper files. Call {@link start} afterwards.
   *
   * @throws Error or SessionError; the caller stops the session (teardown removes what exists).
   */
  async prepare(signal: AbortSignal): Promise<void> {
    const o = this.#o;
    this.#status("starting the Windows VM (copy-on-write overlay of the installed disk)");
    this.#started = true;
    const run = await runDocker(
      o.runner,
      o.endpoint,
      windowsRunArgs({ role: "session", name: o.name, sessionId: o.id, ownerLabel: o.ownerLabel, installId: o.installId, image: o.image, vm: o.vm, viewer: o.viewer ?? false }),
      { timeoutMs: 120_000, signal },
    );
    if (run.exitCode !== 0) throw new SessionError("START_FAILED", `docker run failed (${describeFailure(run)})`);
    const port = await publishedPort(o.runner, o.endpoint, o.name, `${GUEST_SSH_PORT}/tcp`, signal);
    this.#guest = o.guest(port, o.keys, o.control);
    await this.#waitForBoot(signal);
    await this.#guest.open(signal).catch(() => undefined); // multiplexing only speeds things up
    const made = await this.#guest.runScript(createDirsScript(this.#paths), { timeoutMs: 60_000, signal });
    if (made.exitCode !== 0) throw new SessionError("START_FAILED", `creating the guest session dir failed (${describeFailure(made)})`);
    this.#status("copying the workspace into the Windows guest (sync rules apply)");
    this.#recordSync(await syncToGuest(this.#guest, o.fileSet, o.stagingRoot, this.#paths.workspace, signal));
    const hashes = await this.#guest.runScript(hashScript(GUEST_HELPER_DIR, o.helper.map((f) => f.path)), { timeoutMs: 60_000, signal });
    const differs = hashes.exitCode !== 0 || helperMismatches(o.helper, parseJsonOutput<Record<string, string | null>>(hashes.stdout)).length > 0;
    if (differs) {
      // The base holds another package version's helper: this session gets its own copy (discarded with the overlay).
      this.#status("deploying this package's helper into the session");
      const made = await this.#guest.runScript(`New-Item -ItemType Directory -Path ${psQuote(this.#paths.helper)} | Out-Null; ${jsonOut("@{ ok = $true }")}`, { timeoutMs: 30_000, signal });
      if (made.exitCode !== 0) throw new SessionError("START_FAILED", `creating the helper dir failed (${describeFailure(made)})`);
      await deployHelper(this.#guest, o.helper, this.#paths.helper, signal);
      const check = await this.#guest.runScript(hashScript(this.#paths.helper, o.helper.map((f) => f.path)), { timeoutMs: 60_000, signal });
      if (check.exitCode !== 0 || helperMismatches(o.helper, parseJsonOutput<Record<string, string | null>>(check.stdout)).length > 0) {
        throw new SessionError("START_FAILED", "the helper files deployed into the guest do not match this package");
      }
      this.#helperDir = this.#paths.helper;
    }
    this.#status("starting the Windows helper");
  }

  /** `Session.sync` and `Session.warnings` are known only after the sync, which runs after construction. */
  #recordSync(report: GuestSyncReport): void {
    const self = this as { sync?: SyncSummary; warnings?: readonly string[] };
    self.sync = { files: report.files, bytes: report.bytes, excluded: report.excluded };
    if (report.windowsExcluded.length > 0) {
      const shown = report.windowsExcluded.slice(0, 5).join(", ");
      const more = report.windowsExcluded.length > 5 ? ` and ${report.windowsExcluded.length - 5} more` : "";
      self.warnings = [...(this.warnings ?? []), `${report.windowsExcluded.length} file(s) were not synced because Windows cannot store their names: ${shown}${more}`];
    }
  }

  async #waitForBoot(signal: AbortSignal): Promise<void> {
    const o = this.#o;
    const sleep = o.sleep ?? ((ms, s) => sleepFor(ms, undefined, { signal: s }));
    const deadline = Date.now() + (o.bootTimeoutMs ?? BOOT_TIMEOUT_MS);
    for (let attempt = 0; ; attempt++) {
      const probe = await this.#guest!.runCommand("echo pi-gui-ready", { timeoutMs: 20_000, signal });
      if (probe.exitCode === 0 && probe.stdout.includes("pi-gui-ready")) return;
      const failure = classifySshFailure(probe.stderr);
      if (failure === "hostkey-changed" || failure === "hostkey-unknown" || failure === "auth") {
        throw new SessionError("START_FAILED", `the Windows guest refused this machine's pinned SSH identity (${failure}); reinstall with /gui-reset docker-windows and /gui-setup docker-windows`);
      }
      const state = await containerState(o.runner, o.endpoint, o.name, signal);
      if (!state?.running) {
        const line = await lastLogLine(o.runner, o.endpoint, o.name, signal).catch(() => undefined);
        throw new SessionError("START_FAILED", `the Windows container stopped while booting${line ? ` (last output: ${line})` : ""}`);
      }
      if (Date.now() > deadline) throw new SessionError("START_FAILED", `Windows did not answer over SSH within ${Math.round((o.bootTimeoutMs ?? BOOT_TIMEOUT_MS) / 1000)} s`);
      if (attempt % 10 === 0) this.#status("waiting for Windows to boot");
      await sleep(o.bootPollMs ?? BOOT_POLL_MS, signal);
    }
  }

  #spawn(env: Record<string, string>) {
    if (!this.#guest) throw new SessionError("START_FAILED", "the Windows guest is not prepared");
    const values: Record<string, string> = {
      PI_GUI_HELPER_MODE: "guest",
      PI_GUI_WORKSPACE: this.#paths.workspace,
      PI_GUI_RUNTIME_DIR: this.#paths.runtime,
      ...(this.#o.allowExec ? { PI_GUI_ALLOW_EXEC: "1" } : {}),
      ...(this.#o.heartbeatTimeoutMs !== undefined ? { [HEARTBEAT_TIMEOUT_TEST_ENV]: String(this.#o.heartbeatTimeoutMs) } : {}),
      [TOKEN_ENV]: env[TOKEN_ENV],
    };
    const names = Object.keys(values).sort();
    for (const name of names) assertEnvEntry(name, values[name]);
    return this.#guest.spawn(helperCommandLine(this.#helperDir, names), `${names.map((n) => values[n]).join("\n")}\n`);
  }

  async #teardown(): Promise<Leftover[]> {
    const o = this.#o;
    const leftovers: Leftover[] = [];
    if (this.#guest) await this.#guest.close().catch(() => undefined);
    // No guest connection yet: still remove a separate short socket dir (long session paths).
    else if (o.control.shortDir) await rm(o.control.shortDir, { recursive: true, force: true }).catch(() => undefined);
    if (!this.#started) {
      await this.#releaseLease();
      return leftovers;
    }
    const failed = await removeContainer(o.runner, o.endpoint, o.name).catch((e: Error) => e.message);
    if (failed) {
      // The lease stays while the container may live: no second session boots the same disk.
      leftovers.push({ kind: "container", id: o.name, detail: `remove failed (${failed})` });
      return leftovers;
    }
    const state = await containerState(o.runner, o.endpoint, o.name).catch(() => undefined);
    if (state) {
      leftovers.push({ kind: "container", id: o.name, detail: `still present after docker rm -f (${state.status})` });
      return leftovers;
    }
    leftovers.push(...(await this.#baseChanged()));
    await this.#releaseLease();
    return leftovers;
  }

  async #releaseLease(): Promise<void> {
    // A lease file a failed removal leaves is harmless: no session of this process holds it any
    // more, so the next start (of this or any process) takes it over as stale.
    await this.#o.releaseLease?.().catch(() => undefined);
  }

  /** The installed disk must be unchanged after a session (the overlay took every write). */
  async #baseChanged(): Promise<Leftover[]> {
    const o = this.#o;
    if (o.baseStamp === undefined) return [];
    const now = await baseDiskStamp(o.runner, o.endpoint, o.image).catch((e: Error) => `unreadable: ${e.message}`);
    if (now === o.baseStamp) return [];
    return [{ kind: "base-disk", id: "pi-gui-testing-windows-base", detail: `the installed Windows disk changed during the session (${o.baseStamp} → ${now}); its overlay may not have held every write. Reinstall with /gui-reset docker-windows and /gui-setup docker-windows` }];
  }

  async #audit(): Promise<Leftover[]> {
    const o = this.#o;
    const leftovers: Leftover[] = [];
    const state = await containerState(o.runner, o.endpoint, o.name);
    if (state) leftovers.push({ kind: "container", id: o.name, detail: `session container (${state.status}) with its disk overlay` });
    if (await this.#guest?.masterRunning().catch(() => false)) leftovers.push({ kind: "process", id: "ssh-master", detail: "SSH ControlMaster to the Windows guest still running" });
    return leftovers;
  }
}

/** Staging dir of the workspace copy inside the client session dir. */
export function stagingRootFor(sessionDir: string): string {
  return join(sessionDir, "sync");
}
