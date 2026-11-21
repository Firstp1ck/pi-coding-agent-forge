/**
 * `docker-windows` checks (spec §5.4): the common checks, the `docker-linux`
 * Docker checks (CLI, local endpoint, daemon, permission, rootful, version,
 * Linux containers, architecture), then the Windows-VM checks: `host.linux`,
 * `kvm.device`, `kvm.cpu`, `mem.available`, `disk.free` at Docker's data
 * root, `ports.free`, `license.ack`, `image.base` (the pinned dockurr image),
 * `isolation.inspect` (a session-shaped container breaks none of this
 * backend's rules), and `vm.installed`. Every check is read-only except the
 * two probes, which create only labelled temporary objects and remove them.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { arch as osArch } from "node:os";
import { dirname } from "node:path";
import { commonChecks, formatGb, type CommonCheckOptions } from "../../checks/common.ts";
import type { Check, CheckContext } from "../../checks/types.ts";
import type { CommandRunner, DockerEndpoint } from "../../runner/types.ts";
import { describeFailure, runDocker, type EndpointSource } from "../docker/cli.ts";
import { dockerLinuxChecks } from "../docker/checks.ts";
import {
  BASE_VOLUME,
  DOCKER_WINDOWS_HOST_SUPPORT,
  DOCKURR_CAPS,
  DOCKURR_DEVICES,
  DOCKURR_IMAGE,
  DOCKURR_IMAGE_BYTES,
  DOCKURR_TAG,
  INSTALL_DOWNLOAD_BYTES,
  INSTALL_ESTIMATED_SECONDS,
  INSTALL_TIMEOUT_MS,
  LABEL_WINDOWS_INSTALL,
  MIN_FREE_DISK_BYTES,
  MIN_HOST_RAM_BYTES,
  type WindowsVmSettings,
} from "./constants.ts";
import { imagePresent, volumeLabels } from "./docker.ts";
import { keysReady } from "./keys.ts";
import { windowsCreateArgs, windowsRunArgs } from "./run-args.ts";
import { resolveVm, type WindowsSettingsStore } from "./settings.ts";

/** Docker checks reused from `docker-linux` unchanged. */
export const REUSED_DOCKER_CHECKS = ["docker.cli", "docker.endpoint", "docker.daemon", "docker.permission", "docker.rootless", "docker.version", "docker.ostype", "docker.arch"] as const;

/** Free space still needed once the base disk is installed: session overlays grow inside the container. */
export const MIN_FREE_DISK_INSTALLED_BYTES = 16 * 1024 ** 3;

export interface WindowsCheckOptions {
  runner: CommandRunner;
  ownerLabel: () => string;
  version: string;
  store: WindowsSettingsStore;
  /** VM settings override from the backend options. */
  vm?: Partial<WindowsVmSettings>;
  image?: string;
  endpointSource?: EndpointSource;
  common?: Partial<CommonCheckOptions>;
  platform?: NodeJS.Platform;
  /** Host CPU architecture (`process.arch` names); default `os.arch()`. */
  arch?: string;
  kvmPath?: string;
  cpuinfoPath?: string;
  meminfoPath?: string;
  /** Free bytes for the user at `path` (nearest existing ancestor); default `statfs`. */
  freeBytes?: (path: string) => Promise<{ path: string; free: number }>;
  /** Binds and closes a listener on `127.0.0.1:0`; default a real `net` server. */
  loopbackProbe?: () => Promise<number>;
}

function requireEndpoint(ctx: CheckContext): DockerEndpoint {
  if (!ctx.dockerEndpoint) throw new Error("docker.endpoint did not provide an endpoint");
  return ctx.dockerEndpoint;
}

/** Free space at `path` or its nearest readable ancestor. */
export async function freeBytesAt(path: string): Promise<{ path: string; free: number }> {
  let target = path;
  for (;;) {
    try {
      const fs = await statfs(target);
      return { path: target, free: Number(fs.bavail) * Number(fs.bsize) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(target);
      if ((code !== "ENOENT" && code !== "EACCES") || parent === target) throw error;
      target = parent;
    }
  }
}

function loopbackProbe(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** `MemTotal` and `MemAvailable` from `/proc/meminfo`, in bytes. */
export function parseMeminfo(text: string): { total?: number; available?: number } {
  const kb = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  return { ...(total !== undefined ? { total } : {}), ...(available !== undefined ? { available } : {}) };
}

/** Virtualization flags in `/proc/cpuinfo` (`vmx` Intel VT-x, `svm` AMD-V). */
export function cpuVirtFlags(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    if (!/^flags\s*:/.test(line)) continue;
    for (const flag of line.split(":")[1].trim().split(/\s+/)) if (flag === "vmx" || flag === "svm") found.add(flag);
  }
  return [...found].sort();
}

interface InspectedWindowsContainer {
  HostConfig?: {
    Privileged?: boolean;
    NetworkMode?: string;
    IpcMode?: string;
    PidMode?: string;
    UsernsMode?: string;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    Devices?: { PathOnHost?: string }[] | null;
    Binds?: string[] | null;
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
    AutoRemove?: boolean;
  };
  Mounts?: { Type?: string; Source?: string; Name?: string; Destination?: string }[];
  Config?: { Env?: string[] | null; Labels?: Record<string, string> | null };
}

/** Rule violations of a session-shaped container (the backend's hard rules; see `./run-args.ts`). */
export function windowsRuleViolations(container: InspectedWindowsContainer, volume: string): string[] {
  const out: string[] = [];
  const host = container.HostConfig ?? {};
  if (host.Privileged) out.push("privileged");
  for (const mode of ["NetworkMode", "IpcMode", "PidMode", "UsernsMode"] as const) if (host[mode] === "host") out.push(`HostConfig.${mode}=host`);
  const drop = (host.CapDrop ?? []).map((c) => c.toUpperCase().replace(/^CAP_/, ""));
  if (!drop.includes("ALL")) out.push("capabilities are not dropped (no --cap-drop ALL)");
  const allowed = new Set<string>(DOCKURR_CAPS);
  for (const cap of host.CapAdd ?? []) if (!allowed.has(cap.toUpperCase().replace(/^CAP_/, ""))) out.push(`capability ${cap} added`);
  if (!(host.SecurityOpt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(o))) out.push("no-new-privileges missing");
  const devices = (host.Devices ?? []).map((d) => d.PathOnHost ?? "?").sort();
  const expected = [...DOCKURR_DEVICES].sort();
  if (devices.join(",") !== expected.join(",")) out.push(`devices ${devices.join(", ") || "none"} (expected exactly ${expected.join(", ")})`);
  for (const mount of container.Mounts ?? []) {
    if (mount.Type !== "volume" || mount.Name !== volume || mount.Destination !== "/storage") out.push(`mount ${mount.Type ?? "?"} ${mount.Source ?? mount.Name ?? "?"} → ${mount.Destination ?? "?"}`);
  }
  for (const [port, bindings] of Object.entries(host.PortBindings ?? {})) {
    for (const b of bindings ?? []) if (b.HostIp !== "127.0.0.1") out.push(`port ${port} published on ${b.HostIp || "all addresses"}`);
  }
  if (!host.AutoRemove) out.push("not --rm");
  for (const e of container.Config?.Env ?? []) {
    const name = e.split("=")[0];
    if (["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "DOCKER_HOST"].includes(name)) out.push(`environment ${name}`);
  }
  return out;
}

/** All `docker-windows` checks: the common ones, the reused Docker checks, then the Windows-VM checks. */
export function dockerWindowsChecks(options: WindowsCheckOptions): Check[] {
  const { runner, store } = options;
  const platform = options.platform ?? process.platform;
  const hostArch = options.arch ?? osArch();
  const image = options.image ?? DOCKURR_IMAGE;
  const kvm = options.kvmPath ?? "/dev/kvm";
  const free = options.freeBytes ?? freeBytesAt;
  const vmFor = async () => resolveVm(await store.read(), options.vm);

  const common = commonChecks("docker-windows", { minFreeBytes: MIN_FREE_DISK_BYTES, platform, hostSupport: DOCKER_WINDOWS_HOST_SUPPORT, ...options.common }).filter((c) => c.id !== "disk.free");
  const docker = dockerLinuxChecks({
    runner,
    ownerLabel: options.ownerLabel,
    version: options.version,
    platform: "linux",
    ...(options.endpointSource ? { endpointSource: options.endpointSource } : {}),
    ...(options.common ? { common: options.common } : {}),
  }).filter((c) => (REUSED_DOCKER_CHECKS as readonly string[]).includes(c.id));

  const hostLinux: Check = {
    id: "host.linux",
    description: "host is Linux (dockurr/windows needs KVM)",
    kind: "observe",
    required: true,
    async run() {
      return platform === "linux" ? { status: "pass", observed: "linux" } : { status: "fail", observed: `${platform}: ${DOCKER_WINDOWS_HOST_SUPPORT.otherwise}` };
    },
  };

  const kvmDevice: Check = {
    id: "kvm.device",
    description: `${kvm} exists and is readable and writable by you`,
    kind: "observe",
    required: true,
    dependsOn: ["host.linux"],
    remediation: { summary: `Add your user to the group that owns ${kvm} (usually kvm), then log out and back in`, command: ["sudo", "usermod", "-aG", "kvm", process.env.USER ?? "$USER"], manual: true },
    async run() {
      const info = await stat(kvm).catch((error: NodeJS.ErrnoException) => error);
      if (info instanceof Error) {
        return { status: "fail", observed: info.code === "ENOENT" ? `${kvm} does not exist (KVM missing: enable virtualization in the firmware, load kvm_intel or kvm_amd, or enable nested virtualization when this is a VM)` : `${kvm}: ${info.code ?? info.message}` };
      }
      if (!info.isCharacterDevice()) return { status: "fail", observed: `${kvm} is not a character device` };
      try {
        await access(kvm, constants.R_OK | constants.W_OK);
      } catch {
        return { status: "fail", observed: `${kvm} exists but is not readable and writable by you (owner uid ${info.uid}, gid ${info.gid}, mode ${(info.mode & 0o777).toString(8)})` };
      }
      return { status: "pass", observed: `${kvm} (read/write)` };
    },
  };

  const kvmCpu: Check = {
    id: "kvm.cpu",
    description: "CPU virtualization (VT-x or AMD-V) is available",
    kind: "observe",
    required: true,
    dependsOn: ["host.linux"],
    remediation: { summary: "Enable Intel VT-x or AMD-V (SVM) in the firmware settings; in a VM, enable nested virtualization", manual: true },
    async run() {
      if (hostArch === "arm64") {
        // ARM has no cpuinfo flag for it; KVM support shows as /dev/kvm (kvm.device). dockurr runs Windows on ARM there.
        const present = await stat(kvm).then(() => true, () => false);
        return present
          ? { status: "pass", observed: "arm64: hardware virtualization through /dev/kvm (Windows on ARM guest)", facts: { "kvm.arch": "arm64" } }
          : { status: "fail", observed: "arm64: no /dev/kvm, so the CPU's virtualization extensions are not available to Linux" };
      }
      if (hostArch !== "x64") return { status: "fail", observed: `${hostArch}: dockurr/windows runs on x86-64 and arm64 hosts only` };
      const text = await readFile(options.cpuinfoPath ?? "/proc/cpuinfo", "utf8");
      const flags = cpuVirtFlags(text);
      if (flags.length === 0) return { status: "fail", observed: "no vmx or svm flag in /proc/cpuinfo (virtualization off in the firmware, or a VM without nested virtualization)" };
      return { status: "pass", observed: `CPU flags ${flags.join(", ")}`, facts: { "kvm.arch": "x64" } };
    },
  };

  const memory: Check = {
    id: "mem.available",
    description: `at least ${formatGb(MIN_HOST_RAM_BYTES)} RAM and enough available for the VM`,
    kind: "observe",
    required: true,
    dependsOn: ["host.linux"],
    remediation: { summary: "Close memory-hungry programs or choose a smaller VM (ramGb, at least 4)", manual: true },
    async run() {
      const vm = await vmFor();
      const { total, available } = parseMeminfo(await readFile(options.meminfoPath ?? "/proc/meminfo", "utf8"));
      if (total === undefined || available === undefined) return { status: "fail", observed: "MemTotal or MemAvailable missing in /proc/meminfo" };
      const need = Math.max(4, vm.ramGb) * 1024 ** 3;
      const observed = `${formatGb(total)} total, ${formatGb(available)} available; the VM gets ${vm.ramGb} GB`;
      if (total < MIN_HOST_RAM_BYTES) return { status: "fail", observed: `${observed} (at least ${formatGb(MIN_HOST_RAM_BYTES)} total needed)` };
      if (available < need) return { status: "fail", observed: `${observed} (at least ${formatGb(need)} must be available)` };
      return { status: "pass", observed };
    },
  };

  const disk: Check = {
    id: "disk.free",
    description: `at least ${formatGb(MIN_FREE_DISK_BYTES)} free at Docker's data root (before the install)`,
    kind: "observe",
    required: true,
    dependsOn: ["docker.permission"],
    remediation: { summary: `Free at least ${formatGb(MIN_FREE_DISK_BYTES)} on the disk holding Docker's data root (the Windows disk and its download live there)`, manual: true },
    async run(ctx) {
      const info = await runDocker(runner, requireEndpoint(ctx), ["info", "--format", "{{.DockerRootDir}}"], { timeoutMs: 10_000, signal: ctx.signal });
      if (info.exitCode !== 0) return { status: "fail", observed: `docker info failed (${describeFailure(info)})` };
      const root = info.stdout.trim() || "/var/lib/docker";
      const installed = (await store.read()).install?.state === "installed";
      const min = installed ? MIN_FREE_DISK_INSTALLED_BYTES : MIN_FREE_DISK_BYTES;
      const measured = await free(root);
      const observed = `${formatGb(measured.free)} free at ${measured.path}${measured.path !== root ? ` (for ${root})` : ""}${installed ? "; base installed, sessions need room for their overlay" : ""}`;
      return { status: measured.free >= min ? "pass" : "fail", observed: measured.free >= min ? observed : `${observed} (at least ${formatGb(min)} needed)`, facts: { "disk.freeBytes": String(measured.free) } };
    },
  };

  const ports: Check = {
    id: "ports.free",
    description: "localhost ports can be published",
    kind: "probe",
    required: true,
    remediation: { summary: "Free a local port range or check the loopback interface (lo)", manual: true },
    async run() {
      try {
        const port = await (options.loopbackProbe ?? loopbackProbe)();
        return { status: "pass", observed: `127.0.0.1 accepts listeners (free port ${port} seen); Docker picks a free 127.0.0.1 port for each container, the web viewer is not published` };
      } catch (error) {
        return { status: "fail", observed: `cannot listen on 127.0.0.1: ${(error as Error).message}` };
      }
    },
  };

  const license: Check = {
    id: "license.ack",
    description: "you acknowledged that you are responsible for Windows licensing",
    kind: "observe",
    required: true,
    remediation: { summary: "Confirm the Windows licensing notice in /gui-setup docker-windows, or run /gui-setup docker-windows --accept-windows-license", manual: true },
    async run() {
      const settings = await store.read();
      if (!settings.licenseAcceptedAt) return { status: "fail", observed: "not acknowledged" };
      return { status: "pass", observed: `acknowledged ${settings.licenseAcceptedAt}` };
    },
  };

  const imageCheck: Check = {
    id: "image.base",
    description: `dockurr/windows ${DOCKURR_TAG} image present (pinned by digest)`,
    kind: "observe",
    required: true,
    dependsOn: ["docker.permission"],
    remediation: {
      summary: `Download dockurr/windows ${DOCKURR_TAG} (about ${Math.round(DOCKURR_IMAGE_BYTES / 1024 ** 2)} MB; it does not contain Windows)`,
      command: ["docker", "pull", image],
      downloadBytes: DOCKURR_IMAGE_BYTES,
      estimatedSeconds: 120,
      timeoutMs: 30 * 60_000,
    },
    async run(ctx) {
      const found = await imagePresent(runner, requireEndpoint(ctx), image, ctx.signal);
      if (!found.present) return { status: "fail", observed: found.detail ? `cannot inspect ${image}: ${found.detail}` : `${image} not found` };
      return { status: "pass", observed: `dockurr/windows ${DOCKURR_TAG} (${(found.id ?? "?").replace(/^sha256:/, "").slice(0, 12)}, ${found.architecture ?? "?"})`, facts: { "image.base": image } };
    },
  };

  const isolation: Check = {
    id: "isolation.inspect",
    description: "a session container breaks none of the docker-windows rules",
    kind: "probe",
    required: true,
    dependsOn: ["image.base", "docker.rootless", "kvm.device"],
    timeoutMs: 30_000,
    async run(ctx) {
      const endpoint = requireEndpoint(ctx);
      const probeId = `probe-${randomBytes(4).toString("hex")}`;
      const name = `pi-gui-testing-win-${probeId}`;
      // A throw-away volume: `docker create` would otherwise create the real base volume when it is missing.
      const volume = `pi-gui-testing-${probeId}`;
      try {
        const create = await runDocker(
          runner,
          endpoint,
          windowsCreateArgs({ role: "session", name, sessionId: probeId, ownerLabel: options.ownerLabel(), installId: "0".repeat(16), image, vm: await vmFor(), volume }),
          { timeoutMs: 15_000, signal: ctx.signal },
        );
        if (create.exitCode !== 0) return { status: "fail", observed: `docker create failed (${describeFailure(create)})` };
        const inspected = await runDocker(runner, endpoint, ["container", "inspect", name], { timeoutMs: 10_000, signal: ctx.signal });
        if (inspected.exitCode !== 0) return { status: "fail", observed: `docker inspect failed (${describeFailure(inspected)})` };
        const [container] = JSON.parse(inspected.stdout) as InspectedWindowsContainer[];
        const violations = windowsRuleViolations(container, volume);
        if (violations.length > 0) return { status: "fail", observed: violations.join("; ") };
        return { status: "pass", observed: "no rule violations: ports on 127.0.0.1 only, KVM and tun devices only, listed capabilities only (container created, never started)" };
      } finally {
        await runDocker(runner, endpoint, ["rm", "-f", name], { timeoutMs: 20_000 }).catch(() => undefined);
        await runDocker(runner, endpoint, ["volume", "rm", "-f", volume], { timeoutMs: 20_000 }).catch(() => undefined);
      }
    },
  };

  const installed: Check = {
    id: "vm.installed",
    description: `Windows is installed in the Docker volume ${BASE_VOLUME}`,
    kind: "observe",
    required: true,
    dependsOn: ["license.ack", "image.base", "kvm.device", "kvm.cpu", "mem.available"],
    remediation: {
      summary: `Install Windows unattended into the Docker volume ${BASE_VOLUME} (tooling only, no project files; about 64 GB of disk and 15–30 minutes; the OEM script adds OpenSSH Server with this machine's key and the GUI helper)`,
      // Shown before confirmation; the backend's installBase() runs it (with the password from the environment).
      command: ["docker", ...windowsRunArgs({ role: "install", name: "pi-gui-testing-windows-install", ownerLabel: "<owner>", installId: "<id>", image, vm: { version: "11", ramGb: 4, cpuCores: 2, diskGb: 64 }, oemDir: "<oem>" })],
      downloadBytes: INSTALL_DOWNLOAD_BYTES,
      estimatedSeconds: INSTALL_ESTIMATED_SECONDS,
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
    async run(ctx) {
      const settings = await store.read();
      const record = settings.install;
      const labels = await volumeLabels(runner, requireEndpoint(ctx), BASE_VOLUME, ctx.signal);
      if (!record) return { status: "fail", observed: labels ? `volume ${BASE_VOLUME} exists but no install is recorded on this machine` : "not installed" };
      if (!labels) return { status: "fail", observed: `install ${record.id.slice(0, 8)} is recorded but the volume ${BASE_VOLUME} is missing` };
      if (labels[LABEL_WINDOWS_INSTALL] !== record.id) return { status: "fail", observed: `volume ${BASE_VOLUME} belongs to another install (${labels[LABEL_WINDOWS_INSTALL] ?? "unlabelled"})` };
      if (record.state !== "installed") return { status: "fail", observed: `install ${record.id.slice(0, 8)} started ${record.startedAt} is not finished (setup resumes it)` };
      if (!(await keysReady(store.dir))) return { status: "fail", observed: "the guest SSH keys of this machine are missing; reinstall" };
      return {
        status: "pass",
        observed: `Windows ${record.vm.version} installed ${record.completedAt ?? "?"} (${record.vm.diskGb} GB disk; install ${record.id.slice(0, 8)})`,
        facts: { "windows.install": record.id },
      };
    },
  };

  return [...common, hostLinux, ...docker, kvmDevice, kvmCpu, memory, disk, ports, license, imageCheck, isolation, installed];
}
