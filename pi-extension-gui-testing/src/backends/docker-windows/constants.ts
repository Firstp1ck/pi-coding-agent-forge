/**
 * Fixed values of the `docker-windows` backend (spec §4.4): the pinned
 * `dockurr/windows` image, Docker labels and names, guest paths, VM sizes,
 * host minimums, and timeouts. Sources for the dockurr values are listed in
 * `plans/handoffs/windows-WD.md` (README, `docs/environment.md`, `src/*.sh`
 * of dockur/windows v6.06 and qemus/qemu).
 */
import type { HostSupport } from "../host-support.ts";

/** `dockurr/windows` 6.06 (2026-10-05), multi-arch index digest (amd64 + arm64) from Docker Hub. */
export const DOCKURR_TAG = "6.06";
export const DOCKURR_DIGEST = "sha256:16fd7c39a3e48bb946d29c59dc6015942e5b900a1fa5d7e5552053bfc48ee2ea";
/** Image reference every call uses: pinned by digest, so a moved tag never changes what runs. */
export const DOCKURR_IMAGE = `docker.io/dockurr/windows@${DOCKURR_DIGEST}`;
/** Compressed image size (amd64 manifest) for the pull estimate. */
export const DOCKURR_IMAGE_BYTES = 240 * 1024 ** 2;

/** Role of a Docker object of this backend: `base` (the installed-disk volume), `install` or `session` (containers). */
export const LABEL_WINDOWS = "pi-gui-testing.windows";
/** Install id of the base volume and of every container started from it. */
export const LABEL_WINDOWS_INSTALL = "pi-gui-testing.windows.install";

export type WindowsRole = "base" | "install" | "session";

/** Volume holding the installed Windows disk (tooling, no project data); kept until `/gui-reset docker-windows`. */
export const BASE_VOLUME = "pi-gui-testing-windows-base";
/** The one install container. */
export const INSTALL_CONTAINER = "pi-gui-testing-windows-install";

/** Session container name; known before the container exists, so `owner.json` lists it first. */
export function sessionContainerName(sessionId: string): string {
  return `pi-gui-testing-win-${sessionId}`;
}

/** Session ids the guest paths and container names accept. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** Windows account dockurr creates (an administrator; autologon on). Key login only. */
export const GUEST_USER = "pigui";
/** Name in `known_hosts` for the guest's pinned host key (the host port changes per container). */
export const HOST_KEY_ALIAS = "pi-gui-testing-docker-windows";

export const GUEST_ROOT = "C:\\pi-gui-testing";
export const GUEST_HELPER_DIR = `${GUEST_ROOT}\\helper`;
export const GUEST_SMOKE_DIR = `${GUEST_ROOT}\\smoke`;
export const GUEST_SMOKE_APP = `${GUEST_SMOKE_DIR}\\smoke.ps1`;
export const GUEST_SESSIONS = `${GUEST_ROOT}\\sessions`;
/** Written last by the OEM setup script: `{ installId, packageVersion }`. */
export const GUEST_INSTALLED_MARKER = `${GUEST_ROOT}\\installed.json`;
/** Where dockurr puts the `/oem` folder in the guest. */
export const GUEST_OEM_DIR = "C:\\OEM\\pi-gui";

/** Guest ports inside the container: OpenSSH and dockurr's web viewer. */
export const GUEST_SSH_PORT = 22;
export const VIEWER_PORT = 8006;

/** VM size and Windows version passed to dockurr (`VERSION`, `RAM_SIZE`, `CPU_CORES`, `DISK_SIZE`). */
export interface WindowsVmSettings {
  /** dockurr `VERSION`, e.g. `11`, `10`, `2025`. */
  version: string;
  ramGb: number;
  cpuCores: number;
  /** Fixed at install; a later change needs a reinstall. */
  diskGb: number;
}

export const DEFAULT_VM: WindowsVmSettings = { version: "11", ramGb: 4, cpuCores: 2, diskGb: 64 };

/** Host minimums (spec §5.4 `docker-windows`). */
export const MIN_HOST_RAM_BYTES = 8 * 1024 ** 3;
export const MIN_FREE_DISK_BYTES = 80 * 1024 ** 3;

/**
 * Capabilities the dockurr container gets after `--cap-drop ALL`: `NET_ADMIN`
 * and `NET_RAW` for its tap bridge, NAT rules, and dnsmasq; the rest are the
 * Docker defaults its start scripts use (file ownership, process control,
 * dnsmasq dropping privileges). `MKNOD`, `AUDIT_WRITE`, `SETFCAP`, and
 * `SYS_CHROOT` are not granted. Unverified on a real host: the e2e test decides.
 */
export const DOCKURR_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "NET_ADMIN", "NET_BIND_SERVICE", "NET_RAW", "SETGID", "SETUID", "SETPCAP"] as const;
/** Devices dockurr needs: KVM and the tun device for its tap network. Nothing else is passed. */
export const DOCKURR_DEVICES = ["/dev/kvm", "/dev/net/tun"] as const;

/** Bound for the whole unattended install (download included); a typical run takes 15–30 minutes. */
export const INSTALL_TIMEOUT_MS = 120 * 60_000;
export const INSTALL_ESTIMATED_SECONDS = 30 * 60;
/** Windows download plus install growth of the disk, for the setup estimate. */
export const INSTALL_DOWNLOAD_BYTES = 6 * 1024 ** 3;
/** Time between install progress polls. */
export const INSTALL_POLL_MS = 10_000;
/** Bound for a session's Windows boot until its SSH server answers. */
export const BOOT_TIMEOUT_MS = 6 * 60_000;
export const BOOT_POLL_MS = 3_000;
/** `docker stop` bound for the install container's ACPI shutdown. */
export const SHUTDOWN_TIMEOUT_S = 300;
/** dockurr's own wait before it forces QEMU off. */
export const STOP_TIMEOUT_S = 120;
/** Ready-line bound: the helper compiles its C# with `Add-Type` before it is ready. */
export const HELPER_READY_TIMEOUT_MS = 90_000;
/** Bound for one setup command in the guest. */
export const SETUP_COMMAND_TIMEOUT_MS = 15 * 60_000;

export const DOCKER_WINDOWS_HOST_SUPPORT: HostSupport = {
  platforms: ["linux"],
  otherwise: "docker-windows runs on Linux hosts with KVM (dockurr/windows runs Windows in QEMU); use local-windows on Windows",
};
