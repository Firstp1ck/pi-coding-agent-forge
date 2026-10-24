/**
 * Host facts of the `local-linux` backend (spec §4.2): where the helper and
 * the smoke app live, which Python runs them, the shared display lock dir,
 * and the exact environment the helper starts with. Nothing here starts a
 * process; lookups are `PATH` scans on the file system.
 */
import { accessSync, constants, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { HEARTBEAT_TIMEOUT_TEST_ENV, TOKEN_ENV } from "../../protocol.ts";
import { DESKTOP_ENV } from "../../transport/local-process.ts";
import { PACKAGE_ROOT } from "../docker/package.ts";
import type { HostSupport } from "../host-support.ts";

export const LOCAL_LINUX_HOST_SUPPORT: HostSupport = {
  platforms: ["linux"],
  otherwise: "local-linux runs on Linux hosts only; use docker-linux, a remote Linux host, or cua instead",
};

/** The helper entrypoint, run in place from the installed package (host mode). */
export const HELPER_PATH = join(PACKAGE_ROOT, "helpers", "linux", "helper");
/** The bundled GTK 3 smoke app (spec §5.5). */
export const SMOKE_APP_PATH = join(PACKAGE_ROOT, "testapps", "gtk3-smoke", "app.py");

/** Host-mode contract variables (`helpers/linux/pi_gui_helper/hostmode.py`). */
export const HOST_MODE_ENV = {
  mode: "PI_GUI_HELPER_MODE",
  workspace: "PI_GUI_WORKSPACE",
  runtimeDir: "PI_GUI_RUNTIME_DIR",
  lockDir: "PI_GUI_DISPLAY_LOCK_DIR",
  allowExec: "PI_GUI_ALLOW_EXEC",
  tag: "PI_GUI_TAG",
} as const;

/** First display number the helper may claim; `:0` … `:89` are never used. */
export const FIRST_DISPLAY = 90;

/** Variables copied from Pi's environment into the helper's. Nothing else is inherited. */
export const PASSED_ENV = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "USER", "LOGNAME"] as const;

/** Variables that must never reach the helper from Pi's environment (R5). */
export const NEVER_PASSED_ENV = ["DISPLAY", ...DESKTOP_ENV, "SESSION_MANAGER", "XDG_SESSION_TYPE"] as const;

export const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Longest Unix socket path Linux accepts (`sun_path` holds 108 bytes including the terminating NUL). */
export const MAX_SOCKET_PATH = 107;
/** Deepest socket the session creates below its runtime dir: AT-SPI's bus for the highest display. */
export const DEEPEST_SOCKET = ["xdg", "at-spi", "bus_599"] as const;

export interface HelperEnvInput {
  /** Pi's environment; only {@link PASSED_ENV} is read. */
  base?: NodeJS.ProcessEnv;
  workspace: string;
  runtimeDir: string;
  lockDir: string;
  /** Test-only shortened heartbeat timeout. */
  heartbeatTimeoutMs?: number;
  /** `local-linux` never sets it: the helper then refuses `exec`. */
  allowExec?: boolean;
}

/**
 * The complete environment of the host-mode helper, without the token
 * (`HelperSession` adds it). Built from an allow-list, so the host's
 * `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XAUTHORITY`, … can
 * never be passed, whatever Pi's environment holds.
 */
export function helperEnv(input: HelperEnvInput): Record<string, string> {
  const base = input.base ?? process.env;
  const env: Record<string, string> = {};
  for (const key of PASSED_ENV) {
    const value = base[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  env.PATH ??= DEFAULT_PATH;
  env[HOST_MODE_ENV.mode] = "host";
  env[HOST_MODE_ENV.workspace] = input.workspace;
  env[HOST_MODE_ENV.runtimeDir] = input.runtimeDir;
  env[HOST_MODE_ENV.lockDir] = input.lockDir;
  if (input.allowExec) env[HOST_MODE_ENV.allowExec] = "1";
  if (input.heartbeatTimeoutMs !== undefined) env[HEARTBEAT_TIMEOUT_TEST_ENV] = String(input.heartbeatTimeoutMs);
  return env;
}

/** Names in `env` that must not be there: desktop variables or the protocol token. */
export function forbiddenHelperEnv(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).filter((key) => (NEVER_PASSED_ENV as readonly string[]).includes(key) || key === TOKEN_ENV);
}

/** Argv that runs the helper with `python` (isolated, no bytecode written into the package). */
export function helperArgv(python: string, extra: readonly string[] = []): string[] {
  return [python, "-I", "-B", HELPER_PATH, ...extra];
}

/** `true` when `path` is an executable regular file (or a link to one). */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return !lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** First executable `name` on `path`, like `command -v`; absolute names are checked as they are. */
export function findExecutable(name: string, path: string = process.env.PATH ?? DEFAULT_PATH, executable: (p: string) => boolean = isExecutable): string | undefined {
  if (isAbsolute(name)) return executable(name) ? name : undefined;
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

export type Which = (name: string) => string | undefined;

/** The interpreter for the helper and the smoke app: the system `/usr/bin/python3`, else `python3` on PATH (distro `gi`/`pyatspi` live with the system one). */
export function resolvePython(which: Which = (n) => findExecutable(n), executable: (p: string) => boolean = isExecutable): string | undefined {
  return executable("/usr/bin/python3") ? "/usr/bin/python3" : which("python3");
}

/** AT-SPI launcher locations, the same list the helper searches. */
export const ATSPI_LAUNCHER_CANDIDATES = [
  "/usr/libexec/at-spi-bus-launcher",
  "/usr/lib/at-spi2-core/at-spi-bus-launcher",
  "/usr/lib/at-spi-bus-launcher",
] as const;

/** Shared display lock dir of this user (spec §4.2 "free display number from a lock dir"). */
export function displayLockDir(tmpRoot: string = tmpdir(), uid: number = process.getuid?.() ?? 0): string {
  return join(tmpRoot, `pi-gui-displays-${uid}`);
}

/**
 * Creates the lock dir (mode 0700) or checks the existing one: a real
 * directory owned by `uid` that nobody else can write.
 *
 * @throws Error naming the problem (e.g. another user created it first).
 */
export function ensureDisplayLockDir(dir: string, uid: number = process.getuid?.() ?? 0): string {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`display lock dir ${dir} is not a directory`);
  if (info.uid !== uid) throw new Error(`display lock dir ${dir} belongs to uid ${info.uid}, not ${uid}; remove it or set TMPDIR to a private directory`);
  if ((info.mode & 0o022) !== 0) throw new Error(`display lock dir ${dir} is writable by other users (mode ${(info.mode & 0o777).toString(8)})`);
  return dir;
}

/** Display number of an X display string (`:0`, `:1.0`, `localhost:10.0`), or `undefined`. */
export function displayNumber(display: string | undefined): number | undefined {
  const match = display ? /:(\d+)(?:\.\d+)?$/.exec(display.trim()) : null;
  return match ? Number(match[1]) : undefined;
}

export type PackageManager = "pacman" | "apt" | "dnf" | "zypper";

/** The first known package manager on PATH, for install hints. */
export function detectPackageManager(which: Which): PackageManager | undefined {
  if (which("pacman")) return "pacman";
  if (which("apt-get")) return "apt";
  if (which("dnf")) return "dnf";
  if (which("zypper")) return "zypper";
  return undefined;
}

/** Package names per tool (spec §5.4 local-linux remediation). */
export const PACKAGES: Record<string, Record<PackageManager, string[]>> = {
  xvfb: { pacman: ["xorg-server-xvfb"], apt: ["xvfb"], dnf: ["xorg-x11-server-Xvfb"], zypper: ["xorg-x11-server-Xvfb"] },
  xdotool: { pacman: ["xdotool"], apt: ["xdotool"], dnf: ["xdotool"], zypper: ["xdotool"] },
  xutils: { pacman: ["xorg-xprop", "xorg-xwininfo"], apt: ["x11-utils"], dnf: ["xprop", "xwininfo"], zypper: ["xprop", "xwininfo"] },
  imagemagick: { pacman: ["imagemagick"], apt: ["imagemagick"], dnf: ["ImageMagick"], zypper: ["ImageMagick"] },
  dbus: { pacman: ["dbus"], apt: ["dbus-daemon", "dbus-bin"], dnf: ["dbus-daemon", "dbus-tools"], zypper: ["dbus-1"] },
  atspi: { pacman: ["at-spi2-core"], apt: ["at-spi2-core"], dnf: ["at-spi2-core"], zypper: ["at-spi2-core"] },
  pyatspi: { pacman: ["python-atspi"], apt: ["python3-pyatspi"], dnf: ["python3-pyatspi"], zypper: ["python3-pyatspi"] },
  wm: { pacman: ["openbox"], apt: ["openbox"], dnf: ["openbox"], zypper: ["openbox"] },
  fonts: { pacman: ["ttf-dejavu"], apt: ["fonts-dejavu-core"], dnf: ["dejavu-sans-fonts"], zypper: ["dejavu-fonts"] },
  python: { pacman: ["python"], apt: ["python3"], dnf: ["python3"], zypper: ["python3"] },
  gtk: { pacman: ["python-gobject", "gtk3"], apt: ["python3-gi", "gir1.2-gtk-3.0"], dnf: ["python3-gobject", "gtk3"], zypper: ["python3-gobject-Gdk", "typelib-1_0-Gtk-3_0"] },
};

const INSTALL: Record<PackageManager, string[]> = {
  pacman: ["sudo", "pacman", "-S", "--needed"],
  apt: ["sudo", "apt-get", "install"],
  dnf: ["sudo", "dnf", "install"],
  zypper: ["sudo", "zypper", "install"],
};

const MANAGER_LABEL: Record<PackageManager, string> = { pacman: "Arch", apt: "Debian/Ubuntu", dnf: "Fedora", zypper: "openSUSE" };

/** The install command for `tool` with `manager`. */
export function installCommand(tool: string, manager: PackageManager): string[] {
  return [...INSTALL[manager], ...PACKAGES[tool][manager]];
}

/**
 * A package-install remediation. It needs sudo, so it is always manual: the
 * user runs it. With a detected package manager the exact command is shown;
 * otherwise the summary names the packages of every supported distribution.
 */
export function installRemediation(tool: string, what: string, manager: PackageManager | undefined): { summary: string; command?: string[]; needsSudo: true; manual: true } {
  if (manager) return { summary: `Install ${what} (${MANAGER_LABEL[manager]} package ${PACKAGES[tool][manager].join(" ")})`, command: installCommand(tool, manager), needsSudo: true, manual: true };
  const hints = (Object.keys(MANAGER_LABEL) as PackageManager[]).map((m) => `${m} ${PACKAGES[tool][m].join(" ")}`).join(", ");
  return { summary: `Install ${what} with your package manager (${hints})`, needsSudo: true, manual: true };
}
