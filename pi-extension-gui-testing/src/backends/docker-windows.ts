/**
 * `docker-windows` backend (spec §4.4, milestone M4): Windows apps in a
 * Windows VM that `dockurr/windows` runs under QEMU/KVM in a local Docker
 * container on a Linux host.
 *
 * - Setup installs Windows once, unattended, into the labelled Docker volume
 *   `pi-gui-testing-windows-base` (tooling only, kept until `/gui-reset`);
 *   the OEM script adds OpenSSH Server with this machine's generated key, a
 *   pinned host key, and the Windows helper (`./docker-windows/install.ts`).
 * - Each session boots a new container from that disk with a copy-on-write
 *   overlay that is discarded with the container, publishes the guest's SSH
 *   port on `127.0.0.1` only, syncs the workspace into the guest, and runs
 *   the helper over SSH in `guest` mode (`./docker-windows/session.ts`).
 * - Setup needs the user's acknowledgement that they are responsible for
 *   Windows licensing (`license.ack`).
 *
 * Creating the backend runs nothing.
 */
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { SessionError, type Backend, type Session, type SessionStartOptions } from "../backend.ts";
import type { DriftCapability, ImageCapability, OrphanAuditGate, ResetCapability, RunnerCapability, SmokeCapability, SweepAvailability, SweepContext } from "./capabilities.ts";
import type { CommonCheckOptions } from "../checks/common.ts";
import type { Check, CheckResult } from "../checks/types.ts";
import type { BackendId, ResolvedConfig } from "../config/types.ts";
import { globalConfigPath } from "../config/types.ts";
import { DEFAULT_PROC_ROOT } from "../cleanup/identity.ts";
import { PROTOCOL_VERSION, type Leftover } from "../protocol.ts";
import { createSpawnRunner } from "../runner/spawn.ts";
import type { CommandRunner, DockerEndpoint, RunResult } from "../runner/types.ts";
import { buildFileSet } from "../sync/fileset.ts";
import { controlLocation, type ControlLocation } from "../transport/ssh/options.ts";
import type { DetachedRunner } from "../transport/ssh/stream.ts";
import { TextTail } from "../framing/log-event.ts";
import { parseDockerCliVersion } from "./docker/checks.ts";
import { describeFailure, dockerArgv, dockerOnPath, resolveEndpoint, runDocker, type EndpointSource } from "./docker/cli.ts";
import { packageVersion } from "./docker/package.ts";
import { createSpawner, runWithInput, type Spawner } from "./docker/process.ts";
import { stopAfterFailedStart } from "./start-failure.ts";
import { dockerWindowsChecks } from "./docker-windows/checks.ts";
import {
  BASE_VOLUME,
  DOCKER_WINDOWS_HOST_SUPPORT,
  DOCKURR_IMAGE,
  GUEST_SMOKE_APP,
  INSTALL_CONTAINER,
  LABEL_WINDOWS_INSTALL,
  SESSION_ID_PATTERN,
  SETUP_COMMAND_TIMEOUT_MS,
  sessionContainerName,
  type WindowsVmSettings,
} from "./docker-windows/constants.ts";
import { baseDiskStamp, containerState, listRoleContainers, removeContainer, removeBaseVolumes, volumeLabels } from "./docker-windows/docker.ts";
import { auditWindowsOrphans, containerOwnerLiveness, sweepWindowsOrphans } from "./docker-windows/footprint.ts";
import { GuestSsh } from "./docker-windows/guest-ssh.ts";
import { installBase } from "./docker-windows/install.ts";
import { keyPaths, keysReady, type GuestKeys } from "./docker-windows/keys.ts";
import { helperFiles, HELPER_SOURCE_DIR, type HelperFile } from "./docker-windows/oem.ts";
import { POWERSHELL } from "./docker-windows/powershell.ts";
import { DockerWindowsSession, stagingRootFor } from "./docker-windows/session.ts";
import { licenseAcknowledgementText, resolveVm, WindowsSettingsStore, type DockerWindowsSettings } from "./docker-windows/settings.ts";

export { DOCKER_WINDOWS_HOST_SUPPORT };

/** `network: "none"` cannot be honoured: the guest's SSH server is reached through a published port of the container's network. */
export const NETWORK_NONE_MESSAGE =
  'docker-windows cannot run with "network": "none": the Windows guest is reached over SSH through a port of the container network, and an app elevated in the guest could undo a guest firewall rule. Use docker-linux or local-windows for offline tests, or remove "network": "none" from .pi/gui.json';

export interface DockerWindowsOptions {
  /** Owner label of this extension instance (`<clientId>:<pid>:<startTime>:<bootId>`). */
  ownerLabel: () => string;
  /** Directory of the global config (`<agent dir>/gui`); state lives in `<configDir>/docker-windows`. */
  configDir?: string;
  runner?: CommandRunner;
  spawner?: Spawner;
  /** Starts the guest SSH ControlMaster; default the real detached runner. */
  detached?: DetachedRunner;
  version?: string;
  endpointSource?: EndpointSource;
  procRoot?: string;
  common?: Partial<CommonCheckOptions>;
  platform?: NodeJS.Platform;
  arch?: string;
  kvmPath?: string;
  cpuinfoPath?: string;
  meminfoPath?: string;
  freeBytes?: (path: string) => Promise<{ path: string; free: number }>;
  loopbackProbe?: () => Promise<number>;
  /** VM settings over the stored ones (tests, or a future setup flag). */
  vm?: Partial<WindowsVmSettings>;
  /** Publish dockurr's web viewer on `127.0.0.1` (install and sessions). Default off. */
  viewer?: boolean;
  /** Image reference; default the pinned {@link DOCKURR_IMAGE}. */
  image?: string;
  /** Windows helper source dir; default the package's `helpers/windows`. */
  helperRoot?: string;
  /** Root for the ControlMaster fallback dir (long session paths). Default `/tmp`. */
  shortControlRoot?: string;
  bootTimeoutMs?: number;
  bootPollMs?: number;
  installPollMs?: number;
  installTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** Test-only: shortened helper heartbeat timeout. */
  heartbeatTimeoutMs?: number;
  setupTimeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Clock of the install bound (tests). */
  now?: () => number;
  dockerOnPath?: () => Promise<boolean>;
}

/** Setup output kept for a failed setup command's message (characters). */
const SETUP_TAIL_CHARS = 4 * 1024;

export class DockerWindowsBackend
  implements Backend, ImageCapability, DriftCapability, ResetCapability, SweepAvailability, OrphanAuditGate, RunnerCapability, SmokeCapability
{
  readonly id: BackendId = "docker-windows";
  readonly runner: CommandRunner;
  readonly spawner: Spawner;
  readonly version: string;
  readonly store: WindowsSettingsStore;
  readonly #o: DockerWindowsOptions;
  #helper?: Promise<HelperFile[]>;

  constructor(options: DockerWindowsOptions) {
    this.#o = options;
    this.runner = options.runner ?? createSpawnRunner();
    this.spawner = options.spawner ?? createSpawner();
    this.version = options.version ?? packageVersion();
    this.store = new WindowsSettingsStore(join(options.configDir ?? dirname(globalConfigPath()), "docker-windows"));
  }

  /** The dockurr image reference (pinned by digest). */
  get imageTag(): string {
    return this.#o.image ?? DOCKURR_IMAGE;
  }

  get #procRoot(): string {
    return this.#o.procRoot ?? DEFAULT_PROC_ROOT;
  }

  #helperFiles(): Promise<HelperFile[]> {
    this.#helper ??= helperFiles(this.#o.helperRoot ?? HELPER_SOURCE_DIR);
    return this.#helper;
  }

  endpoint(signal?: AbortSignal): Promise<DockerEndpoint> {
    return resolveEndpoint(this.runner, { signal, source: this.#o.endpointSource, platform: "linux" });
  }

  #guest(port: number, keys: GuestKeys, control?: ControlLocation): GuestSsh {
    return new GuestSsh({
      port,
      keyPath: keys.clientKey,
      knownHostsPath: keys.knownHosts,
      runner: this.runner,
      spawner: this.spawner,
      ...(this.#o.detached ? { detached: this.#o.detached } : {}),
      ...(control ? { control } : {}),
    });
  }

  checks(): Check[] {
    return dockerWindowsChecks({
      runner: this.runner,
      ownerLabel: this.#o.ownerLabel,
      version: this.version,
      store: this.store,
      image: this.imageTag,
      ...(this.#o.vm ? { vm: this.#o.vm } : {}),
      ...(this.#o.endpointSource ? { endpointSource: this.#o.endpointSource } : {}),
      ...(this.#o.common ? { common: this.#o.common } : {}),
      ...(this.#o.platform ? { platform: this.#o.platform } : {}),
      ...(this.#o.arch ? { arch: this.#o.arch } : {}),
      ...(this.#o.kvmPath ? { kvmPath: this.#o.kvmPath } : {}),
      ...(this.#o.cpuinfoPath ? { cpuinfoPath: this.#o.cpuinfoPath } : {}),
      ...(this.#o.meminfoPath ? { meminfoPath: this.#o.meminfoPath } : {}),
      ...(this.#o.freeBytes ? { freeBytes: this.#o.freeBytes } : {}),
      ...(this.#o.loopbackProbe ? { loopbackProbe: this.#o.loopbackProbe } : {}),
    });
  }

  // ---- licensing and VM settings (setup plumbing, see the WD handoff) ----

  /**
   * Whether the licensing notice was acknowledged, and its text for the
   * confirm dialog; `pending` VM settings (setup flags not stored yet) are shown as if stored.
   */
  async licenseStatus(pending?: Partial<WindowsVmSettings>): Promise<{ acknowledged: boolean; text: string }> {
    const settings = await this.store.read();
    const vm = resolveVm({ vm: { ...settings.vm, ...pending } }, this.#o.vm);
    return { acknowledged: settings.licenseAcceptedAt !== undefined, text: licenseAcknowledgementText(vm) };
  }

  /** Records the acknowledgement (`--accept-windows-license` or the confirm dialog). */
  async acknowledgeLicense(): Promise<void> {
    await this.store.acknowledgeLicense();
  }

  /** Stores VM settings for the next install (`version`, `diskGb`) and for sessions (`ramGb`, `cpuCores`). */
  async setVm(vm: Partial<WindowsVmSettings>): Promise<DockerWindowsSettings> {
    return this.store.setVm(vm);
  }

  /**
   * The remediation of `vm.installed`: installs (or resumes installing)
   * Windows into the base volume. `onLine` gets progress lines.
   */
  async installBase(signal: AbortSignal, onLine?: (line: string) => void): Promise<RunResult> {
    const settings = await this.store.read();
    return installBase({
      runner: this.runner,
      endpoint: await this.endpoint(signal),
      store: this.store,
      ownerLabel: this.#o.ownerLabel(),
      image: this.imageTag,
      packageVersion: this.version,
      vm: resolveVm(settings, this.#o.vm),
      ...(this.#o.viewer ? { viewer: true } : {}),
      helper: () => this.#helperFiles(),
      guest: (port, keys) => this.#guest(port, keys),
      ...(this.#o.installPollMs !== undefined ? { pollMs: this.#o.installPollMs } : {}),
      ...(this.#o.installTimeoutMs !== undefined ? { timeoutMs: this.#o.installTimeoutMs } : {}),
      ...(this.#o.sleep ? { sleep: this.#o.sleep } : {}),
      ...(this.#o.now ? { now: this.#o.now } : {}),
      signal,
      ...(onLine ? { onLine } : {}),
    });
  }

  /**
   * Remediations this backend runs itself (setup plumbing): `vm.installed`
   * → {@link installBase}, `image.base` → {@link buildImage}. `undefined` for
   * other checks (their command runs through the runner).
   */
  remediate(checkId: string, signal: AbortSignal, onLine?: (line: string) => void): Promise<RunResult> | undefined {
    if (checkId === "vm.installed") return this.installBase(signal, onLine);
    if (checkId === "image.base") return this.buildImage(signal, onLine);
    return undefined;
  }

  // ---- ImageCapability: the dockurr image (no build: a pinned pull) ----

  async buildImage(signal: AbortSignal, onLine?: (line: string) => void): Promise<RunResult> {
    const endpoint = await this.endpoint(signal);
    return runWithInput(this.spawner, dockerArgv(endpoint, ["pull", this.imageTag]), Buffer.alloc(0), { timeoutMs: 30 * 60_000, signal, ...(onLine ? { onLine } : {}) });
  }

  async removeBaseImages(signal: AbortSignal): Promise<{ removed: string[]; leftovers: Leftover[] }> {
    const endpoint = await this.endpoint(signal);
    const result = await runDocker(this.runner, endpoint, ["image", "rm", this.imageTag], { timeoutMs: 120_000, signal });
    if (result.exitCode === 0) return { removed: [this.imageTag], leftovers: [] };
    if (/no such image/i.test(result.stderr)) return { removed: [], leftovers: [] };
    return { removed: [], leftovers: [{ kind: "image", id: this.imageTag, detail: describeFailure(result) }] };
  }

  // ---- DriftCapability ----

  async currentVersions(signal?: AbortSignal): Promise<Record<string, string>> {
    const endpoint = await this.endpoint(signal);
    const versions: Record<string, string> = {
      "package.version": this.version,
      "pi.version": this.#o.common?.piVersion ?? PI_VERSION,
      protocol: String(PROTOCOL_VERSION),
      "image.base": this.imageTag,
    };
    const cli = await this.runner.run(["docker", "--version"], { timeoutMs: 10_000, ...(signal ? { signal } : {}) });
    if (cli.exitCode !== 0) throw new Error(`docker --version failed (${describeFailure(cli)})`);
    const cliVersion = parseDockerCliVersion(cli.stdout);
    if (cliVersion) versions["docker.cli"] = cliVersion;
    const server = await runDocker(this.runner, endpoint, ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000, ...(signal ? { signal } : {}) });
    if (server.exitCode !== 0) throw new Error(`docker version failed (${describeFailure(server)})`);
    versions["docker.server"] = server.stdout.trim();
    const record = (await this.store.read()).install;
    const labels = await volumeLabels(this.runner, endpoint, BASE_VOLUME, signal);
    versions["windows.install"] = record?.state === "installed" && labels?.[LABEL_WINDOWS_INSTALL] === record.id ? record.id : "(missing)";
    return versions;
  }

  // ---- sessions ----

  async startSession(options: SessionStartOptions): Promise<Session> {
    const { signal, config } = options;
    const shared = config.shared;
    if (!SESSION_ID_PATTERN.test(options.sessionId)) throw new Error(`session id ${JSON.stringify(options.sessionId)} cannot be used as a container name`);
    if (shared.network === "none") throw new Error(NETWORK_NONE_MESSAGE);
    const settings = await this.store.read();
    if (!settings.licenseAcceptedAt) throw new Error("docker-windows: the Windows licensing acknowledgement is missing; run /gui-setup docker-windows");
    const record = settings.install;
    if (record?.state !== "installed") throw new Error("docker-windows: Windows is not installed yet; run /gui-setup docker-windows (an unattended install of 15–30 minutes)");
    if (!(await keysReady(this.store.dir))) throw new Error("docker-windows: this machine's guest SSH keys are missing; reinstall with /gui-reset docker-windows and /gui-setup docker-windows");
    const endpoint = await this.endpoint(signal);
    const labels = await volumeLabels(this.runner, endpoint, BASE_VOLUME, signal);
    if (labels?.[LABEL_WINDOWS_INSTALL] !== record.id) throw new Error(`docker-windows: the base volume ${BASE_VOLUME} is missing or belongs to another install; run /gui-setup docker-windows`);
    // One VM at a time on the base disk: QEMU opens it read-only, but dockurr still keeps small state files in that volume.
    for (const other of await listRoleContainers(this.runner, endpoint, "session", signal)) {
      if (containerOwnerLiveness(other, this.#procRoot) !== "dead") {
        throw new Error(`docker-windows runs one session at a time and ${other.name} is still running; stop it with gui_stop (or /gui-cleanup docker-windows when its Pi is gone)`);
      }
    }
    if (await containerState(this.runner, endpoint, INSTALL_CONTAINER, signal)) throw new Error("docker-windows: the Windows install is still running; finish /gui-setup docker-windows first");

    options.onStatus?.("collecting the workspace files (sync rules apply)");
    const fileSet = await buildFileSet(options.projectRoot, { allow: shared.sync?.allow, deny: shared.sync?.deny, runner: this.runner, signal });
    const helper = await this.#helperFiles();
    const baseStamp = await baseDiskStamp(this.runner, endpoint, this.imageTag, signal);
    const keys = keyPaths(this.store.dir);
    const control = await controlLocation(options.sessionDir, this.#o.shortControlRoot);
    const commands = shared.setup ?? [];
    const setupTail = new TextTail(SETUP_TAIL_CHARS);
    const name = sessionContainerName(options.sessionId);
    const session = new DockerWindowsSession({
      id: options.sessionId,
      backend: this.id,
      runner: this.runner,
      endpoint,
      packageVersion: this.version,
      onLog: (event) => {
        if (event.source === "setup") setupTail.push(typeof event.data === "string" ? event.data : String(event.data));
        options.onLog(event);
      },
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      name,
      ownerLabel: options.ownerLabel,
      installId: record.id,
      image: this.imageTag,
      vm: resolveVm(settings, { ...this.#o.vm, diskGb: record.vm.diskGb, version: record.vm.version }),
      ...(this.#o.viewer ? { viewer: true } : {}),
      keys,
      control,
      guest: (port, k, c) => this.#guest(port, k, c),
      fileSet,
      stagingRoot: stagingRootFor(options.sessionDir),
      helper,
      baseStamp,
      allowExec: commands.length > 0,
      ...(this.#o.bootTimeoutMs !== undefined ? { bootTimeoutMs: this.#o.bootTimeoutMs } : {}),
      ...(this.#o.bootPollMs !== undefined ? { bootPollMs: this.#o.bootPollMs } : {}),
      ...(this.#o.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.#o.readyTimeoutMs } : {}),
      ...(this.#o.heartbeatTimeoutMs !== undefined ? { heartbeatTimeoutMs: this.#o.heartbeatTimeoutMs } : {}),
      ...(this.#o.sleep ? { sleep: this.#o.sleep } : {}),
    });
    // The exit handler and owner.json know the container before it exists (spec §7a.2).
    options.onExitCleanup?.(session.forceRemoveArgv());
    await options.recordResource("container", name);
    try {
      await session.prepare(signal);
      await session.start(signal);
      const timeoutMs = this.#o.setupTimeoutMs ?? SETUP_COMMAND_TIMEOUT_MS;
      for (const [index, cmd] of commands.entries()) {
        options.onStatus?.(`setup ${index + 1}/${commands.length} in the Windows guest: ${cmd}`);
        const result = await session.request("exec", { cmd, cwd: session.workspacePath!, env: { ...(shared.deps?.env ?? {}) }, timeoutMs }, { signal, timeoutMs: timeoutMs + 30_000 });
        if (result.exitCode !== 0) {
          const tail = setupTail.text.trim().slice(-2000);
          throw new SessionError("SETUP_FAILED", `setup command ${JSON.stringify(cmd)} exited with ${result.exitCode} in the Windows guest${tail ? `; last output:\n${tail}` : ""}`);
        }
      }
      // The Windows helper has no dependency cache (WH handoff §6), so `windows-<arch>` entries are never used.
      if (commands.length > 0) session.depsCache = { state: "off", detail: "the Windows helper has no dependency cache yet; setup ran in this session" };
    } catch (error) {
      await stopAfterFailedStart(session, error);
      throw error;
    }
    return session;
  }

  // ---- sweep, audit, reset ----

  /**
   * At Pi startup only when this machine ever set up docker-windows (its
   * state dir exists) and a `docker` executable is on PATH; on demand
   * whenever `docker` is on PATH. Runs no command.
   */
  async sweepAvailable(context: SweepContext): Promise<boolean> {
    if (context.startup) {
      const used = await stat(this.store.dir).then(() => true, () => false);
      if (!used) return false;
    }
    return (this.#o.dockerOnPath ?? (() => dockerOnPath(undefined, "linux")))().catch(() => false);
  }

  orphanAuditReady(results: readonly CheckResult[]): boolean {
    return results.some((r) => r.id === "docker.permission" && r.status === "pass");
  }

  async auditOrphans(signal: AbortSignal): Promise<Leftover[]> {
    return auditWindowsOrphans(this.runner, await this.endpoint(signal), { signal, procRoot: this.#procRoot });
  }

  async sweepOrphans(signal: AbortSignal): Promise<Leftover[]> {
    return sweepWindowsOrphans(this.runner, await this.endpoint(signal), { signal, procRoot: this.#procRoot });
  }

  readonly resetSummary =
    "Stops its sessions and removes the installed Windows disk (Docker volume pi-gui-testing-windows-base), the dockurr/windows image, this machine's guest SSH keys, the licensing acknowledgement, the verified state, and the backend choice. Docker and KVM stay as they are.";
  readonly resetNote = "system packages: setup installs none for docker-windows; Docker and KVM are yours and stay as they are";

  /** `/gui-reset docker-windows`: install container, base volume, image, keys and settings. */
  async resetData(signal: AbortSignal): Promise<{ lines: string[]; leftovers: Leftover[] }> {
    const lines: string[] = [];
    const leftovers: Leftover[] = [];
    let endpoint: DockerEndpoint;
    try {
      endpoint = await this.endpoint(signal);
    } catch (error) {
      return { lines, leftovers: [{ kind: "volume", id: BASE_VOLUME, detail: (error as Error).message }] };
    }
    const install = await removeContainer(this.runner, endpoint, INSTALL_CONTAINER, signal).catch((e: Error) => e.message);
    if (install) leftovers.push({ kind: "container", id: INSTALL_CONTAINER, detail: install });
    try {
      const volumes = await removeBaseVolumes(this.runner, endpoint, signal);
      lines.push(`removed ${volumes.removed.length} Windows base volume(s)`);
      for (const f of volumes.failed) leftovers.push({ kind: "volume", id: f.name, detail: `${f.detail} (a running docker-windows session still uses it?)` });
    } catch (error) {
      leftovers.push({ kind: "volume", id: BASE_VOLUME, detail: (error as Error).message });
    }
    const images = await this.removeBaseImages(signal).catch((e: Error) => ({ removed: [], leftovers: [{ kind: "image", id: this.imageTag, detail: e.message }] }));
    if (images.removed.length > 0) lines.push("removed the dockurr/windows image");
    leftovers.push(...images.leftovers);
    if (leftovers.length === 0) {
      await this.store.remove();
      lines.push("removed the guest SSH keys and docker-windows settings");
    } else {
      // Keep the keys while a volume that trusts them may still exist.
      lines.push("kept the guest SSH keys and settings because something above could not be removed");
    }
    return { lines, leftovers };
  }

  // ---- SmokeCapability ----

  /** The tiny WinForms app the install put into the base (spec §5.5). */
  smokeApp(): { cmd: string; args: string[] } {
    return { cmd: "powershell.exe", args: [...POWERSHELL.slice(1), "-File", GUEST_SMOKE_APP] };
  }

  /** The smoke session needs the container network (the guest is reached over a published port). */
  smokeConfig(base: ResolvedConfig): ResolvedConfig {
    return { ...base, shared: { ...base.shared, targets: ["windows"], network: "default" } };
  }
}
