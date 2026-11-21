/**
 * Personal `docker-windows` state (never project data, never a password):
 * the Windows licensing acknowledgement, VM size choices, and the record of
 * the base install. Stored in `<agent dir>/gui/docker-windows/settings.json`
 * (mode 0600, directory 0700) next to the guest SSH keys.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../../config/atomic.ts";
import { DEFAULT_VM, type WindowsVmSettings } from "./constants.ts";

export const SETTINGS_FILE = "settings.json";

export type InstallState = "installing" | "installed";

export interface WindowsInstallRecord {
  /** Random hex id; also the base volume's {@link LABEL_WINDOWS_INSTALL} label and the guest marker. */
  id: string;
  state: InstallState;
  /** ISO 8601. */
  startedAt: string;
  completedAt?: string;
  /** Image the base was installed with. */
  image: string;
  vm: WindowsVmSettings;
  /** Package version whose OEM files were installed. */
  packageVersion: string;
}

export interface DockerWindowsSettings {
  version: 1;
  /** ISO 8601 time of the Windows licensing acknowledgement (`--accept-windows-license` or the confirm dialog). */
  licenseAcceptedAt?: string;
  /** VM size and version for the next install (and RAM/CPU for sessions). */
  vm?: Partial<WindowsVmSettings>;
  install?: WindowsInstallRecord;
}

const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const ID_PATTERN = /^[0-9a-f]{16,64}$/;

function intIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Problem with partial VM settings, or `undefined`. */
export function vmProblem(vm: unknown): string | undefined {
  if (typeof vm !== "object" || vm === null || Array.isArray(vm)) return "vm is not an object";
  const v = vm as Record<string, unknown>;
  if (v.version !== undefined && (typeof v.version !== "string" || !VERSION_PATTERN.test(v.version))) return "vm.version is not a dockurr VERSION value (letters, digits, . _ -)";
  if (v.ramGb !== undefined && !intIn(v.ramGb, 2, 512)) return "vm.ramGb must be a whole number from 2 to 512";
  if (v.cpuCores !== undefined && !intIn(v.cpuCores, 1, 128)) return "vm.cpuCores must be a whole number from 1 to 128";
  if (v.diskGb !== undefined && !intIn(v.diskGb, 64, 4096)) return "vm.diskGb must be a whole number from 64 to 4096";
  return undefined;
}

/** Validates a settings value. */
export function settingsProblem(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "is not an object";
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return "has an unknown version";
  if (r.licenseAcceptedAt !== undefined && (typeof r.licenseAcceptedAt !== "string" || Number.isNaN(Date.parse(r.licenseAcceptedAt)))) return "has an invalid licenseAcceptedAt";
  if (r.vm !== undefined) {
    const problem = vmProblem(r.vm);
    if (problem) return `has an invalid ${problem}`;
  }
  if (r.install !== undefined) {
    const i = r.install as Record<string, unknown>;
    if (typeof i !== "object" || i === null) return "has an invalid install record";
    if (typeof i.id !== "string" || !ID_PATTERN.test(i.id)) return "has an invalid install.id";
    if (i.state !== "installing" && i.state !== "installed") return "has an invalid install.state";
    if (typeof i.startedAt !== "string" || typeof i.image !== "string" || typeof i.packageVersion !== "string") return "has an incomplete install record";
    const problem = vmProblem(i.vm);
    if (problem || typeof i.vm !== "object") return `has an invalid install.${problem ?? "vm"}`;
  }
  return undefined;
}

/** VM settings with defaults filled in. */
export function resolveVm(settings: Pick<DockerWindowsSettings, "vm">, override?: Partial<WindowsVmSettings>): WindowsVmSettings {
  return { ...DEFAULT_VM, ...settings.vm, ...override };
}

export class WindowsSettingsStore {
  readonly dir: string;
  readonly path: string;

  constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, SETTINGS_FILE);
  }

  /**
   * Current settings; a missing file is empty settings.
   *
   * @throws Error naming the file when it exists but is invalid.
   */
  async read(): Promise<DockerWindowsSettings> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
      throw new Error(`${this.path} is unreadable: ${(error as Error).message}`);
    }
    const problem = settingsProblem(raw);
    if (problem) throw new Error(`${this.path} ${problem}`);
    return raw as DockerWindowsSettings;
  }

  async update(change: (current: DockerWindowsSettings) => DockerWindowsSettings): Promise<DockerWindowsSettings> {
    const next = { ...change(await this.read()), version: 1 as const };
    for (const key of Object.keys(next) as Array<keyof DockerWindowsSettings>) if (next[key] === undefined) delete next[key];
    const problem = settingsProblem(next);
    if (problem) throw new Error(`docker-windows settings ${problem}`);
    await writeJsonAtomic(this.path, next, { mode: 0o600, dirMode: 0o700 });
    return next;
  }

  /** Records the Windows licensing acknowledgement (setup with `--accept-windows-license` or after the confirm dialog). */
  acknowledgeLicense(at: Date = new Date()): Promise<DockerWindowsSettings> {
    return this.update((s) => ({ ...s, licenseAcceptedAt: at.toISOString() }));
  }

  /** Stores VM size choices for the next install (`diskGb`, `version`) and for sessions (`ramGb`, `cpuCores`). */
  setVm(vm: Partial<WindowsVmSettings>): Promise<DockerWindowsSettings> {
    const problem = vmProblem(vm);
    if (problem) return Promise.reject(new Error(problem));
    return this.update((s) => ({ ...s, vm: { ...s.vm, ...vm } }));
  }

  setInstall(install: WindowsInstallRecord | undefined): Promise<DockerWindowsSettings> {
    return this.update((s) => ({ ...s, install }));
  }

  /** `/gui-reset docker-windows`: the settings, keys, and staged OEM files. */
  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** Text of the licensing acknowledgement (confirm dialog; `--accept-windows-license` accepts it). */
export function licenseAcknowledgementText(vm: WindowsVmSettings = DEFAULT_VM): string {
  return [
    `docker-windows downloads Windows ${vm.version} from Microsoft inside the dockurr/windows container and installs it unattended into a Docker volume on this machine.`,
    "This package and dockurr/windows do not include or grant a Windows license: you are responsible for licensing Windows and for following Microsoft's license terms.",
    `The install needs about ${vm.diskGb} GB of disk, ${vm.ramGb} GB of RAM while a VM runs, and 15–30 minutes.`,
  ].join(" ");
}
