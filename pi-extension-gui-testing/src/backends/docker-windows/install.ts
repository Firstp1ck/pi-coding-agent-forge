/**
 * Base install of `docker-windows` (spec §4.4, the `vm.installed`
 * remediation): one long-running dockurr/windows container installs Windows
 * unattended into the labelled volume {@link BASE_VOLUME}; the OEM script
 * (`./oem.ts`) adds OpenSSH Server, this machine's key, the pinned host key,
 * and the helper. The client polls the container and, once the guest's SSH
 * server answers with the pinned host key, reads the completion marker,
 * checks the helper files, shuts Windows down, and records the install.
 *
 * States (persisted in the settings, so a new Pi process resumes):
 *
 * 1. no record (or a record whose volume is gone): fresh install with a new
 *    id: a stopped install container is removed, the volume is created, keys
 *    are generated, the record is `installing`. A base volume or a running
 *    install container that no record here knows is refused, never taken
 *    over (`/gui-reset docker-windows` removes them);
 * 2. `installing`: a running install container is adopted; a stopped or
 *    missing one is started again on the same volume (dockurr continues or
 *    restarts its own install there);
 * 3. `installed`: nothing to do.
 *
 * Cancel keeps the record and the volume (the next run resumes) but removes
 * the container. A timeout, a failed guest setup, or a foreign guest discard
 * the attempt (container, volume, record), because dockurr would only boot the
 * half-configured disk again.
 */
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import type { CommandRunner, DockerEndpoint, RunResult } from "../../runner/types.ts";
import { classifySshFailure } from "../../transport/ssh/errors.ts";
import { describeFailure, runDocker } from "../docker/cli.ts";
import {
  BASE_VOLUME,
  GUEST_HELPER_DIR,
  GUEST_INSTALLED_MARKER,
  GUEST_SSH_PORT,
  INSTALL_CONTAINER,
  INSTALL_POLL_MS,
  INSTALL_TIMEOUT_MS,
  LABEL_WINDOWS_INSTALL,
  SHUTDOWN_TIMEOUT_S,
  VIEWER_PORT,
  type WindowsVmSettings,
} from "./constants.ts";
import { containerState, createBaseVolume, lastLogLine, publishedPort, removeBaseVolumes, removeContainer, volumeLabels } from "./docker.ts";
import type { GuestSsh } from "./guest-ssh.ts";
import { ensureKeys, forgetHostPrivateKey, type GuestKeys } from "./keys.ts";
import { stageOem, type HelperFile } from "./oem.ts";
import { jsonOut, parseJsonOutput, psQuote } from "./powershell.ts";
import { PASSWORD_ENV, windowsRunArgs } from "./run-args.ts";
import type { WindowsInstallRecord, WindowsSettingsStore } from "./settings.ts";

export interface InstallOptions {
  runner: CommandRunner;
  endpoint: DockerEndpoint;
  store: WindowsSettingsStore;
  ownerLabel: string;
  image: string;
  packageVersion: string;
  vm: WindowsVmSettings;
  /** Also publish dockurr's web viewer on `127.0.0.1` (to watch the install). */
  viewer?: boolean;
  helper: () => Promise<HelperFile[]>;
  /** One guest connection (no ControlMaster) to a published port. */
  guest: (port: number, keys: GuestKeys) => GuestSsh;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  signal: AbortSignal;
  onLine?: (line: string) => void;
}

/** Thrown for a failed attempt; `discard` makes the next run start fresh. */
export class InstallError extends Error {
  readonly discard: boolean;
  constructor(message: string, discard: boolean) {
    super(message);
    this.name = "InstallError";
    this.discard = discard;
  }
}

function result(exitCode: number, text: string, durationMs: number): RunResult {
  return { exitCode, signal: null, stdout: exitCode === 0 ? text : "", stderr: exitCode === 0 ? "" : text, timedOut: false, truncated: false, durationMs };
}

/** PowerShell script printing `installed.json` (or `{}` while it does not exist yet). */
export const MARKER_SCRIPT = `if (Test-Path -LiteralPath ${psQuote(GUEST_INSTALLED_MARKER)}) { Get-Content -LiteralPath ${psQuote(GUEST_INSTALLED_MARKER)} -Raw } else { '{}' }`;

/** PowerShell script printing `{ "<relative path>": "<sha256>" }` for the given files below `dir` (`null` when missing). */
export function hashScript(dir: string, paths: readonly string[]): string {
  const list = paths.map((p) => psQuote(p.replace(/\//g, "\\"))).join(", ");
  return [
    "$h = [ordered]@{}",
    `foreach ($p in @(${list})) { $f = Join-Path ${psQuote(dir)} $p; if (Test-Path -LiteralPath $f -PathType Leaf) { $h[$p.Replace('\\', '/')] = (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLowerInvariant() } else { $h[$p.Replace('\\', '/')] = $null } }`,
    jsonOut("$h"),
  ].join("\n");
}

/** Files whose guest hash differs from the package (missing included). */
export function helperMismatches(files: readonly HelperFile[], guest: Record<string, string | null>): string[] {
  return files.filter((f) => guest[f.path] !== f.sha256).map((f) => f.path);
}

/** Runs (or resumes) the install. Resolves with a {@link RunResult} for the setup report; never leaves a running VM behind on failure. */
export async function installBase(o: InstallOptions): Promise<RunResult> {
  const started = (o.now ?? Date.now)();
  const elapsed = () => (o.now ?? Date.now)() - started;
  const say = (line: string) => o.onLine?.(line);
  const settings = await o.store.read();
  if (!settings.licenseAcceptedAt) return result(1, "the Windows licensing acknowledgement is missing (/gui-setup docker-windows --accept-windows-license)", elapsed());

  let record = settings.install;
  const labels = await volumeLabels(o.runner, o.endpoint, BASE_VOLUME, o.signal);
  if (record?.state === "installed" && labels?.[LABEL_WINDOWS_INSTALL] === record.id) return result(0, `Windows is already installed (install ${record.id.slice(0, 8)})`, elapsed());
  const resume = record?.state === "installing" && labels?.[LABEL_WINDOWS_INSTALL] === record.id;
  if (!resume) {
    // Never take over Docker objects this machine's settings do not know (another Pi config dir may own them).
    if (labels) {
      return result(1, `the Docker volume ${BASE_VOLUME} exists but belongs to no install recorded here (another Pi configuration?); remove it with /gui-reset docker-windows, then run setup again`, elapsed());
    }
    const other = await containerState(o.runner, o.endpoint, INSTALL_CONTAINER, o.signal);
    if (other?.running) return result(1, `another docker-windows install (${INSTALL_CONTAINER}) is running; wait for it or remove it with /gui-reset docker-windows`, elapsed());
    say("preparing a fresh Windows install");
    if (other) {
      const stale = await removeContainer(o.runner, o.endpoint, INSTALL_CONTAINER, o.signal);
      if (stale) return result(1, `cannot remove the old install container ${INSTALL_CONTAINER}: ${stale}`, elapsed());
    }
    record = { id: randomBytes(16).toString("hex"), state: "installing", startedAt: new Date().toISOString(), image: o.image, vm: { ...o.vm }, packageVersion: o.packageVersion };
    await o.store.setInstall(record);
    await createBaseVolume(o.runner, o.endpoint, record.id, o.signal);
  }
  const current = record as WindowsInstallRecord;

  say("generating the guest SSH keys");
  const keys = await ensureKeys(o.store.dir, o.runner, { withHostKey: true, signal: o.signal });
  const oemDir = join(o.store.dir, "oem");
  const helper = await o.helper();
  await stageOem(oemDir, { keys, installId: current.id, packageVersion: o.packageVersion, helper });

  try {
    const state = await containerState(o.runner, o.endpoint, INSTALL_CONTAINER, o.signal);
    if (state?.running) {
      say("resuming the running Windows install");
    } else {
      if (state) await removeContainer(o.runner, o.endpoint, INSTALL_CONTAINER, o.signal);
      say(`starting the unattended Windows ${current.vm.version} install (usually 15–30 minutes)`);
      const args = windowsRunArgs({ role: "install", name: INSTALL_CONTAINER, ownerLabel: o.ownerLabel, installId: current.id, image: current.image, vm: current.vm, oemDir, viewer: o.viewer ?? false });
      // The account password only exists for dockurr's answer file; the guest is reached with keys only. Never stored, never in argv.
      const run = await runDocker(o.runner, o.endpoint, args, { timeoutMs: 120_000, signal: o.signal, env: { [PASSWORD_ENV]: randomBytes(18).toString("base64url") } });
      if (run.exitCode !== 0) throw new InstallError(`docker run failed (${describeFailure(run)})`, false);
    }
    await waitForGuest(o, current, keys, elapsed);
    say("Windows is configured; checking the helper files in the guest");
    const port = await publishedPort(o.runner, o.endpoint, INSTALL_CONTAINER, `${GUEST_SSH_PORT}/tcp`, o.signal);
    const hashes = await o.guest(port, keys).runScript(hashScript(GUEST_HELPER_DIR, helper.map((f) => f.path)), { timeoutMs: 60_000, signal: o.signal });
    if (hashes.exitCode !== 0) throw new InstallError(`reading the helper files in the guest failed (${describeFailure(hashes)})`, true);
    const wrong = helperMismatches(helper, parseJsonOutput<Record<string, string | null>>(hashes.stdout));
    if (wrong.length > 0) throw new InstallError(`the guest's helper files differ from this package (${wrong.slice(0, 3).join(", ")}${wrong.length > 3 ? ", …" : ""})`, true);
    say("shutting Windows down (the installed disk stays in the volume)");
    const stop = await runDocker(o.runner, o.endpoint, ["stop", "-t", String(SHUTDOWN_TIMEOUT_S), INSTALL_CONTAINER], { timeoutMs: (SHUTDOWN_TIMEOUT_S + 60) * 1000, signal: o.signal });
    if (stop.exitCode !== 0 && !/no such container/i.test(stop.stderr)) throw new InstallError(`docker stop failed (${describeFailure(stop)})`, false);
    if (await containerState(o.runner, o.endpoint, INSTALL_CONTAINER, o.signal)) await removeContainer(o.runner, o.endpoint, INSTALL_CONTAINER, o.signal);
  } catch (error) {
    const cancelled = o.signal.aborted || (error as Error)?.name === "AbortError";
    // Never leave a running VM behind; `--rm` removes the container with it.
    await removeContainer(o.runner, o.endpoint, INSTALL_CONTAINER).catch(() => undefined);
    if (cancelled) return result(1, "the Windows install was cancelled; run /gui-setup docker-windows again to resume it", elapsed());
    const discard = error instanceof InstallError && error.discard;
    if (discard) {
      await removeBaseVolumes(o.runner, o.endpoint).catch(() => undefined);
      await o.store.setInstall(undefined).catch(() => undefined);
    }
    const message = (error as Error)?.message ?? String(error);
    return result(1, `${message}${discard ? "; the unfinished install was removed, so the next /gui-setup docker-windows starts a fresh one" : "; run /gui-setup docker-windows again to resume"}`, elapsed());
  }

  await o.store.setInstall({ ...current, state: "installed", completedAt: new Date().toISOString() });
  await forgetHostPrivateKey(keys);
  await rm(oemDir, { recursive: true, force: true });
  const minutes = Math.max(1, Math.round(elapsed() / 60_000));
  return result(0, `Windows ${current.vm.version} installed in the Docker volume ${BASE_VOLUME} in about ${minutes} min (install ${current.id.slice(0, 8)})`, elapsed());
}

/** Polls the install container until the guest reports the completion marker of `record`. */
async function waitForGuest(o: InstallOptions, record: WindowsInstallRecord, keys: GuestKeys, elapsed: () => number): Promise<void> {
  const sleep = o.sleep ?? ((ms, signal) => sleepFor(ms, undefined, { signal }));
  const deadline = o.timeoutMs ?? INSTALL_TIMEOUT_MS;
  let port: number | undefined;
  let viewerShown = false;
  for (;;) {
    if (elapsed() > deadline) throw new InstallError(`the Windows install did not finish within ${Math.round(deadline / 60_000)} minutes`, true);
    await sleep(o.pollMs ?? INSTALL_POLL_MS, o.signal);
    const state = await containerState(o.runner, o.endpoint, INSTALL_CONTAINER, o.signal);
    const line = await lastLogLine(o.runner, o.endpoint, INSTALL_CONTAINER, o.signal);
    if (!state?.running) {
      throw new InstallError(`the install container stopped (${state ? `${state.status}, exit ${state.exitCode ?? "?"}` : "gone"})${line ? `; last output: ${line}` : ""}`, false);
    }
    const minutes = Math.floor(elapsed() / 60_000);
    o.onLine?.(`Windows install (${minutes} min): ${line ?? "starting"}`);
    port ??= await publishedPort(o.runner, o.endpoint, INSTALL_CONTAINER, `${GUEST_SSH_PORT}/tcp`, o.signal);
    if (o.viewer && !viewerShown) {
      viewerShown = true;
      const viewer = await publishedPort(o.runner, o.endpoint, INSTALL_CONTAINER, `${VIEWER_PORT}/tcp`, o.signal).catch(() => undefined);
      if (viewer) o.onLine?.(`watch the install at http://127.0.0.1:${viewer}/ (this machine only)`);
    }
    const probe = await o.guest(port, keys).runScript(MARKER_SCRIPT, { timeoutMs: 30_000, signal: o.signal });
    if (probe.exitCode === 0) {
      let marker: { installId?: unknown };
      try {
        marker = parseJsonOutput<{ installId?: unknown }>(probe.stdout);
      } catch {
        continue;
      }
      if (marker.installId === record.id) return;
      if (marker.installId !== undefined) throw new InstallError(`the guest belongs to another install (${String(marker.installId).slice(0, 8)})`, true);
      continue;
    }
    // Refused or reset while Windows installs: keep waiting. A wrong host key is never "not up yet".
    const failure = classifySshFailure(probe.stderr);
    if (failure === "hostkey-changed" || failure === "hostkey-unknown") throw new InstallError(`the guest's SSH server presented a host key other than the pinned one (${failure})`, true);
  }
}
