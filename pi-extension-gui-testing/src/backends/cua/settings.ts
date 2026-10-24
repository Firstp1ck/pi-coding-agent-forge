/**
 * Personal `cua` settings recorded by `/gui-setup cua` (never secrets): the
 * billing and upload acknowledgement (`--accept-billing` or the confirm
 * dialog), the cloud the sandboxes run in, the image per target OS (Linux
 * `image`, Windows `windowsImage`), and hourly rates entered at setup when Cua
 * reports none. Stored in
 * `<agent dir>/gui/cua.json`, mode 0600. Cua's own sign-in and the cloud
 * credentials stay in the `cua` CLI's store; this package never reads them.
 */
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../../config/atomic.ts";
import { globalConfigPath } from "../../config/types.ts";
import { isCloudLocation, type CloudLocation } from "./api.ts";

/** Default image alias: Cua's Linux desktop image. */
export const DEFAULT_IMAGE = "linux";

export interface CuaSettings {
  version: 1;
  /** ISO 8601 time of the billing + upload acknowledgement. */
  billingAcceptedAt?: string;
  /** Cloud the acknowledgement covers; a different cloud needs a new one. */
  billingLocation?: CloudLocation;
  /** Cloud for sandboxes; default: the cloud `cua cloud connect --default` chose. */
  location?: CloudLocation;
  /** Image alias or registry reference; default {@link DEFAULT_IMAGE}. */
  image?: string;
  /** USD per sandbox hour entered at setup, used when Cua reports no price. */
  rateUsdPerHour?: number;
  /** Image alias or registry reference of Windows sandboxes (`--targets windows`); default `windows`. */
  windowsImage?: string;
  /** USD per Windows sandbox hour entered at setup, used when Cua reports no price for the Windows image. */
  windowsRateUsdPerHour?: number;
}

export function defaultSettingsPath(): string {
  return join(dirname(globalConfigPath()), "cua.json");
}

function validImage(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value);
}

function validRate(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000;
}

/** Validates a settings value; `undefined` fields stay unset. */
export function settingsProblem(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "is not an object";
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return "has an unknown version";
  if (r.billingAcceptedAt !== undefined && (typeof r.billingAcceptedAt !== "string" || Number.isNaN(Date.parse(r.billingAcceptedAt)))) return "has an invalid billingAcceptedAt";
  if (r.billingLocation !== undefined && !isCloudLocation(r.billingLocation)) return "has an invalid billingLocation";
  if (r.location !== undefined && !isCloudLocation(r.location)) return "has an invalid location (aws, gcp, hetzner, or modal)";
  if (r.image !== undefined && !validImage(r.image)) return "has an invalid image";
  if (r.rateUsdPerHour !== undefined && !validRate(r.rateUsdPerHour)) return "has an invalid rateUsdPerHour (0–1000)";
  if (r.windowsImage !== undefined && !validImage(r.windowsImage)) return "has an invalid windowsImage";
  if (r.windowsRateUsdPerHour !== undefined && !validRate(r.windowsRateUsdPerHour)) return "has an invalid windowsRateUsdPerHour (0–1000)";
  return undefined;
}

export class CuaSettingsStore {
  readonly path: string;

  constructor(path: string = defaultSettingsPath()) {
    this.path = path;
  }

  /**
   * Current settings; a missing file is empty settings.
   *
   * @throws Error naming the file when it exists but is invalid (never silently ignored).
   */
  async read(): Promise<CuaSettings> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
      throw new Error(`${this.path} is unreadable: ${(error as Error).message}`);
    }
    const problem = settingsProblem(raw);
    if (problem) throw new Error(`${this.path} ${problem}`);
    return raw as CuaSettings;
  }

  async update(change: Partial<Omit<CuaSettings, "version">>): Promise<CuaSettings> {
    const next: CuaSettings = { ...(await this.read()), ...change, version: 1 };
    for (const key of Object.keys(next) as Array<keyof CuaSettings>) if (next[key] === undefined) delete next[key];
    const problem = settingsProblem(next);
    if (problem) throw new Error(`cua settings ${problem}`);
    await writeJsonAtomic(this.path, next, { mode: 0o600, dirMode: 0o700 });
    return next;
  }

  /** Records the billing + upload acknowledgement for `location` (setup with `--accept-billing` or after the confirm dialog). */
  acknowledgeBilling(location: CloudLocation, at: Date = new Date()): Promise<CuaSettings> {
    return this.update({ billingAcceptedAt: at.toISOString(), billingLocation: location });
  }

  /** `/gui-reset cua`. */
  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/** Text of the setup acknowledgement (confirm dialog; `--accept-billing` accepts it). */
export function billingAcknowledgementText(location: CloudLocation, rateUsdPerHour?: number): string {
  const rate = rateUsdPerHour !== undefined ? ` at about $${rateUsdPerHour.toFixed(2)} per sandbox hour` : "";
  return [
    `Each GUI session creates one Cua sandbox in your ${location} account, which bills that account${rate} until it is deleted.`,
    "The package deletes it when the session stops and on every cleanup path; keepSandbox keeps it (and keeps billing).",
    "The project files allowed by the sync rules (secrets such as .env, keys, and credentials are always excluded) are uploaded into the sandbox for the session.",
    "Helper packages may be installed inside the sandbox; nothing is installed on this computer.",
  ].join(" ");
}
