/**
 * `docker run` command lines of the dockurr/windows containers (spec §4.4).
 * One function builds the install and the session container, so the
 * `isolation.inspect` probe checks exactly what runs.
 *
 * Hardening that applies from `docker-linux` (§4.1): labels (role, owner,
 * session, install id), `--rm`, `--pull never`, `--cap-drop ALL` plus the
 * listed capabilities only, `no-new-privileges`, no host socket or host path
 * except the read-only OEM folder of the install, and every port published on
 * `127.0.0.1` with a port Docker picks. Not applicable: `--user` (dockurr runs
 * QEMU as root inside), `--network none` (the guest's SSH server is reached
 * through a published port), read-only workspace mounts (the workspace is
 * synced into the guest). dockurr needs `/dev/kvm` and `/dev/net/tun`.
 */
import { LABEL_OWNER, LABEL_SESSION } from "../../labels.ts";
import { BASE_VOLUME, DOCKURR_CAPS, DOCKURR_DEVICES, GUEST_SSH_PORT, GUEST_USER, LABEL_WINDOWS, LABEL_WINDOWS_INSTALL, STOP_TIMEOUT_S, VIEWER_PORT, type WindowsVmSettings } from "./constants.ts";

export const REQUIRED_WINDOWS_FLAGS = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"] as const;

/** Name of the password variable: the install container takes it from the CLI's environment, never from argv. */
export const PASSWORD_ENV = "PASSWORD";

export interface WindowsRunInput {
  role: "install" | "session";
  name: string;
  ownerLabel: string;
  installId: string;
  image: string;
  vm: WindowsVmSettings;
  /** Session containers: the session id label. */
  sessionId?: string;
  /** Install container: host directory mounted read-only at `/oem`. */
  oemDir?: string;
  /** Publish dockurr's web viewer (port 8006) on `127.0.0.1` too. Default off. */
  viewer?: boolean;
  volume?: string;
}

/**
 * dockurr environment of both roles: the VM size, the guest account, no Samba
 * share (the workspace is synced over SSH instead), no TPM (its state would
 * live in the shared base volume), and port 22 forwarded in user-mode
 * networking too. Sessions add `ARGUMENTS=-snapshot`: QEMU then writes every
 * guest disk change to a temporary overlay inside the container, and the
 * installed disk in the base volume is opened read-only.
 */
export function dockurrEnv(input: Pick<WindowsRunInput, "role" | "vm">): string[] {
  const env = [
    `VERSION=${input.vm.version}`,
    `USERNAME=${GUEST_USER}`,
    `RAM_SIZE=${input.vm.ramGb}G`,
    `CPU_CORES=${input.vm.cpuCores}`,
    `DISK_SIZE=${input.vm.diskGb}G`,
    "BOOT_MODE=windows",
    "TPM=N",
    "SAMBA=N",
    "AUTOLOGIN=Y",
    `USER_PORTS=${GUEST_SSH_PORT}`,
  ];
  if (input.role === "install") env.push("LOG=Y");
  else env.push("ARGUMENTS=-snapshot");
  return env;
}

/** `docker run` arguments (after `docker --host <h>`). Detached: the helper is reached over SSH, not on the container's stdio. */
export function windowsRunArgs(input: WindowsRunInput, extraEnv: readonly string[] = []): string[] {
  const args = [
    "run",
    "-d",
    "--rm",
    "--pull",
    "never",
    "--name",
    input.name,
    "--label",
    `${LABEL_WINDOWS}=${input.role}`,
    "--label",
    `${LABEL_WINDOWS_INSTALL}=${input.installId}`,
    "--label",
    `${LABEL_OWNER}=${input.ownerLabel}`,
  ];
  if (input.role === "session") {
    if (!input.sessionId) throw new Error("a session container needs a session id");
    args.push("--label", `${LABEL_SESSION}=${input.sessionId}`);
  }
  args.push(...REQUIRED_WINDOWS_FLAGS);
  for (const cap of DOCKURR_CAPS) args.push("--cap-add", cap);
  for (const device of DOCKURR_DEVICES) args.push("--device", device);
  args.push("--stop-timeout", String(STOP_TIMEOUT_S), "-p", `127.0.0.1::${GUEST_SSH_PORT}`);
  if (input.viewer) args.push("-p", `127.0.0.1::${VIEWER_PORT}`);
  args.push("-v", `${input.volume ?? BASE_VOLUME}:/storage`);
  if (input.role === "install") {
    if (!input.oemDir) throw new Error("the install container needs the OEM folder");
    args.push("-v", `${input.oemDir}:/oem:ro`, "-e", PASSWORD_ENV);
  }
  for (const e of [...dockurrEnv(input), ...extraEnv]) args.push("-e", e);
  args.push(input.image);
  return args;
}

/** The same configuration as `docker create`, for the inspect probe; the container is never started. */
export function windowsCreateArgs(input: WindowsRunInput): string[] {
  return ["create", ...windowsRunArgs(input).slice(2)];
}
