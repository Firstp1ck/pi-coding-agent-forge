/**
 * Checks shared by every backend (spec §5.4 "Common"): `pi.version`,
 * `host.os`, `config.writable`, `disk.free`.
 */
import { randomBytes } from "node:crypto";
import { access, constants, open, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { globalConfigPath, type BackendId } from "../config/types.ts";
import type { Check } from "./types.ts";
import { DOCKER_LINUX_HOST_SUPPORT, type HostSupport } from "../backends/host-support.ts";

/** Minimum supported Pi version. */
export const MIN_PI_VERSION = "1.4.0";
/** Free-space minimum for `docker-linux` (spec §5.4). */
export const DOCKER_LINUX_MIN_FREE_BYTES = 5 * 1024 ** 3;

/**
 * Compares dotted numeric versions (`29.9.1`, `v1.4.0`, `29.0.0-rc1`); missing
 * parts count as 0 and a pre-release suffix is ignored.
 *
 * @returns Negative, zero, or positive like a sort comparator; `undefined` when either side has no leading number.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string) => {
    const match = /^v?(\d+(?:\.\d+)*)/.exec(v.trim());
    return match ? match[1].split(".").map(Number) : undefined;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Formats a byte count as GB with one decimal. */
export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** `pi.version`: Pi ≥ {@link MIN_PI_VERSION}. `version` is injectable for tests. */
export function piVersionCheck(version: string = VERSION, minimum: string = MIN_PI_VERSION): Check {
  return {
    id: "pi.version",
    description: `Pi ${minimum} or newer`,
    kind: "observe",
    required: true,
    remediation: { summary: `Update Pi to ${minimum} or newer`, manual: true },
    async run() {
      const cmp = compareVersions(version, minimum);
      if (cmp === undefined) return { status: "fail", observed: `unrecognised Pi version "${version}"` };
      return { status: cmp >= 0 ? "pass" : "fail", observed: version, facts: { "pi.version": version } };
    },
  };
}

/** Host platforms on which each backend of this build runs, unless its checks pass their own. */
const SUPPORTED_HOSTS: Partial<Record<BackendId, HostSupport>> = {
  "docker-linux": DOCKER_LINUX_HOST_SUPPORT,
};

/**
 * `host.os`: the backend is supported on this host (spec §4 table, restricted to what this build implements).
 *
 * @param support Host support of the backend; backends pass their registry entry's. Defaults to the built-in table.
 */
export function hostOsCheck(backend: BackendId, platform: NodeJS.Platform = process.platform, support: HostSupport | undefined = SUPPORTED_HOSTS[backend]): Check {
  return {
    id: "host.os",
    description: `${backend} is supported on this host`,
    kind: "observe",
    required: true,
    async run() {
      if (!support) return { status: "fail", observed: `${platform}: backend "${backend}" is not available yet` };
      if (support.platforms.includes(platform)) return { status: "pass", observed: platform };
      return { status: "fail", observed: `${platform}: ${support.otherwise}` };
    },
  };
}

/**
 * `config.writable`: the global config directory (or, when it does not exist
 * yet, its nearest existing ancestor) accepts a new file. Probes with a temp
 * file that is removed before returning; creates no directories.
 */
export function configWritableCheck(dir: string = dirname(globalConfigPath())): Check {
  return {
    id: "config.writable",
    description: "config directory is writable",
    kind: "probe",
    required: true,
    remediation: { summary: `Make ${dir} writable by your user`, manual: true },
    async run() {
      let target = dir;
      for (;;) {
        try {
          if ((await stat(target)).isDirectory()) break;
          return { status: "fail", observed: `${target} exists and is not a directory` };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const parent = dirname(target);
          if (parent === target) return { status: "fail", observed: `no existing ancestor of ${dir}` };
          target = parent;
        }
      }
      if (target !== dir) {
        // Writing into a foreign ancestor (e.g. $HOME) is a side effect we avoid; access() is enough there.
        try {
          await access(target, constants.W_OK | constants.X_OK);
          return { status: "pass", observed: `${dir} (will be created in ${target})` };
        } catch {
          return { status: "fail", observed: `${target} is not writable, so ${dir} cannot be created` };
        }
      }
      const probe = join(dir, `.pi-gui-testing-probe-${randomBytes(4).toString("hex")}`);
      try {
        const handle = await open(probe, "wx", 0o600);
        await handle.close();
        return { status: "pass", observed: dir };
      } catch (error) {
        return { status: "fail", observed: `${dir}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
      } finally {
        await rm(probe, { force: true });
      }
    },
  };
}

/** `disk.free`: free space available to the user at `path` (nearest existing ancestor) is at least `minBytes`. */
export function diskFreeCheck(minBytes: number, path: string = tmpdir()): Check {
  return {
    id: "disk.free",
    description: `at least ${formatGb(minBytes)} free`,
    kind: "observe",
    required: true,
    remediation: { summary: `Free at least ${formatGb(minBytes)} on the disk holding ${path}`, manual: true },
    async run() {
      let target = path;
      for (;;) {
        try {
          const fs = await statfs(target);
          const free = Number(fs.bavail) * Number(fs.bsize);
          return {
            status: free >= minBytes ? "pass" : "fail",
            observed: `${formatGb(free)} free at ${target}`,
            facts: { "disk.freeBytes": String(free) },
          };
        } catch (error) {
          const parent = dirname(target);
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === target) throw error;
          target = parent;
        }
      }
    },
  };
}

export interface CommonCheckOptions {
  /** Minimum free space for `disk.free`. */
  minFreeBytes: number;
  /** Where to measure free space (e.g. Docker's data root). Default `os.tmpdir()`. */
  diskPath?: string;
  /** Overrides for tests. */
  piVersion?: string;
  platform?: NodeJS.Platform;
  configDir?: string;
  /** Host support for `host.os`; default: the built-in table. */
  hostSupport?: HostSupport;
}

/** The four common checks for `backend`, in spec order. Backends prepend them to their own list. */
export function commonChecks(backend: BackendId, options: CommonCheckOptions): Check[] {
  return [
    piVersionCheck(options.piVersion),
    hostOsCheck(backend, options.platform, options.hostSupport ?? SUPPORTED_HOSTS[backend]),
    configWritableCheck(options.configDir),
    diskFreeCheck(options.minFreeBytes, options.diskPath),
  ];
}
