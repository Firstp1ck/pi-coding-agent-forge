/**
 * `local-linux` checks (spec §5.4). Tool checks observe the host; two probes
 * run the helper itself: `linux.xvfb` starts and stops a private Xvfb through
 * the shared display lock dir, and `linux.wayland-scrub` starts a real child
 * with the environment `launch` would give it and inspects what it saw.
 * Package installs need sudo, so every remediation is manual (the exact
 * command is shown for the detected package manager).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonChecks, compareVersions, type CommonCheckOptions } from "../../checks/common.ts";
import type { Check, CheckContext, CheckOutcome } from "../../checks/types.ts";
import type { CommandRunner, RunResult } from "../../runner/types.ts";
import { describeFailure } from "../docker/cli.ts";
import {
  ATSPI_LAUNCHER_CANDIDATES,
  detectPackageManager,
  displayLockDir,
  ensureDisplayLockDir,
  findExecutable,
  forbiddenHelperEnv,
  helperArgv,
  helperEnv,
  HOST_MODE_ENV,
  installRemediation,
  isExecutable,
  LOCAL_LINUX_HOST_SUPPORT,
  resolvePython,
  type PackageManager,
  type Which,
} from "./host.ts";

/** Free space `local-linux` needs in the temp dir (session dirs, screenshots, copies). */
export const LOCAL_LINUX_MIN_FREE_BYTES = 1024 ** 3;
export const MIN_PYTHON = "3.9";
/** Prefix of probe dirs (not the session-dir prefix, so the sweep never sees them). */
export const PROBE_DIR_PREFIX = "pi-gui-probe-";

export interface LocalCheckOptions {
  runner: CommandRunner;
  /** `PATH` lookup; default a scan of Pi's `PATH`. */
  which?: Which;
  /** File-is-executable test for fixed paths (AT-SPI launcher, `/usr/bin/python3`). */
  executable?: (path: string) => boolean;
  /** Where probe dirs and the display lock dir live; default `os.tmpdir()`. */
  tmpRoot?: string;
  uid?: number;
  /** Pi's environment, for the helper environment the scrub probe uses. */
  env?: NodeJS.ProcessEnv;
  /** Package manager for install hints; default detected from `which`. */
  packageManager?: PackageManager | null;
  common?: Partial<CommonCheckOptions>;
}

function notFound(name: string): CheckOutcome {
  return { status: "fail", observed: `${name} not found on PATH` };
}

async function tryRun(runner: CommandRunner, argv: string[], ctx: CheckContext, options: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult | undefined> {
  try {
    return await runner.run(argv, { timeoutMs: options.timeoutMs ?? 10_000, signal: ctx.signal, ...(options.env ? { env: options.env } : {}) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function lastJsonLine(text: string): Record<string, unknown> | undefined {
  const line = text.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Desktop variables a scrubbed child must not see, and the values it must see. */
export function scrubProblems(report: Record<string, unknown>): string[] {
  const seen = (report.seen ?? {}) as Record<string, string>;
  const expected = (report.expected ?? {}) as Record<string, string>;
  const problems: string[] = [];
  for (const key of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SESSION_MANAGER", "NO_AT_BRIDGE"]) {
    if (key in seen) problems.push(`${key}=${seen[key]}`);
  }
  for (const key of ["DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XAUTHORITY", "HOME"]) {
    if (!expected[key] || seen[key] !== expected[key]) problems.push(`${key} is ${JSON.stringify(seen[key])}, expected ${JSON.stringify(expected[key])}`);
  }
  const forced: Record<string, string> = { GDK_BACKEND: "x11", QT_QPA_PLATFORM: "xcb", SDL_VIDEODRIVER: "x11", ELECTRON_OZONE_PLATFORM_HINT: "x11", XDG_SESSION_TYPE: "x11" };
  for (const [key, value] of Object.entries(forced)) if (seen[key] !== value) problems.push(`${key} is ${JSON.stringify(seen[key])}, expected "${value}"`);
  if (report.tokenPresent) problems.push("the protocol token reached the child");
  if (Array.isArray(report.contractKeys) && report.contractKeys.length > 0) problems.push(`contract variables reached the child: ${report.contractKeys.join(", ")}`);
  return problems;
}

/** All `local-linux` checks: the common ones, then the host tools in dependency order. */
export function localLinuxChecks(options: LocalCheckOptions): Check[] {
  const { runner } = options;
  const which: Which = options.which ?? ((name) => findExecutable(name, options.env?.PATH ?? process.env.PATH));
  const executable = options.executable ?? isExecutable;
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const manager = options.packageManager === null ? undefined : (options.packageManager ?? detectPackageManager(which));
  const install = (tool: string, what: string) => installRemediation(tool, what, manager);
  const python = () => resolvePython(which, executable);
  const requirePython = (): string => {
    const found = python();
    if (!found) throw new Error("python3 not found");
    return found;
  };

  const withProbeDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpRoot, PROBE_DIR_PREFIX));
    try {
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const common = commonChecks("local-linux", { minFreeBytes: LOCAL_LINUX_MIN_FREE_BYTES, diskPath: tmpRoot, hostSupport: LOCAL_LINUX_HOST_SUPPORT, ...options.common });

  const pythonCheck: Check = {
    id: "linux.python",
    description: `python3 ${MIN_PYTHON} or newer (runs the helper)`,
    kind: "observe",
    required: true,
    remediation: install("python", `Python ${MIN_PYTHON} or newer`),
    async run(ctx) {
      const path = python();
      if (!path) return notFound("python3");
      const result = await tryRun(runner, [path, "-I", "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], ctx);
      if (!result) return notFound("python3");
      if (result.exitCode !== 0) return { status: "fail", observed: `${path} failed (${describeFailure(result)})` };
      const version = result.stdout.trim();
      const cmp = compareVersions(version, MIN_PYTHON);
      return { status: cmp !== undefined && cmp >= 0 ? "pass" : "fail", observed: `${version} (${path})`, facts: { "python.version": version } };
    },
  };

  const xvfb: Check = {
    id: "linux.xvfb",
    description: "Xvfb starts on a free private display",
    kind: "probe",
    required: true,
    dependsOn: ["linux.python"],
    timeoutMs: 30_000,
    remediation: install("xvfb", "Xvfb"),
    async run(ctx) {
      const path = which("Xvfb");
      if (!path) return notFound("Xvfb");
      const lockDir = ensureDisplayLockDir(displayLockDir(tmpRoot, options.uid), options.uid);
      return withProbeDir(async (dir) => {
        const result = await tryRun(runner, helperArgv(requirePython(), ["--probe", "display"]), ctx, {
          timeoutMs: 25_000,
          env: { [HOST_MODE_ENV.lockDir]: lockDir, [HOST_MODE_ENV.runtimeDir]: dir },
        });
        if (!result) return notFound("python3");
        const report = lastJsonLine(result.stdout);
        if (result.exitCode === 0 && report?.ok === true) {
          return { status: "pass", observed: `${path} started and stopped on ${String(report.display)} in ${String(report.elapsedMs)} ms` };
        }
        return { status: "fail", observed: `${path} did not start: ${String(report?.error ?? describeFailure(result))}` };
      });
    },
  };

  const xdotool: Check = {
    id: "linux.xdotool",
    description: "xdotool works (input on the private display)",
    kind: "observe",
    required: true,
    remediation: install("xdotool", "xdotool"),
    async run(ctx) {
      const result = await tryRun(runner, ["xdotool", "version"], ctx);
      if (!result) return notFound("xdotool");
      if (result.exitCode !== 0) return { status: "fail", observed: `xdotool version failed (${describeFailure(result)})` };
      const version = firstLine(result.stdout);
      return { status: "pass", observed: version, facts: { "xdotool.version": version.replace(/^xdotool version\s*/i, "") } };
    },
  };

  const xutils: Check = {
    id: "linux.xutils",
    description: "xprop and xwininfo present (window queries)",
    kind: "observe",
    required: true,
    remediation: install("xutils", "xprop and xwininfo"),
    async run() {
      const missing = ["xprop", "xwininfo"].filter((n) => !which(n));
      return missing.length ? { status: "fail", observed: `${missing.join(" and ")} not found on PATH` } : { status: "pass", observed: `${which("xprop")}, ${which("xwininfo")}` };
    },
  };

  const screenshot: Check = {
    id: "linux.screenshot",
    description: "ImageMagick present (screen capture and scaling)",
    kind: "observe",
    required: true,
    remediation: install("imagemagick", "ImageMagick"),
    async run() {
      const magick = which("magick");
      if (magick) return { status: "pass", observed: `${magick} (ImageMagick 7)` };
      const imp = which("import");
      const convert = which("convert");
      if (imp && convert) return { status: "pass", observed: `${imp}, ${convert} (ImageMagick 6)` };
      return { status: "fail", observed: "neither magick nor import and convert found on PATH" };
    },
  };

  const dbus: Check = {
    id: "linux.dbus",
    description: "D-Bus session daemon present (private bus)",
    kind: "observe",
    required: true,
    remediation: install("dbus", "the D-Bus daemon"),
    async run() {
      const daemon = which("dbus-daemon");
      const runSession = which("dbus-run-session");
      if (!daemon) return { status: "fail", observed: `dbus-daemon not found on PATH${runSession ? ` (dbus-run-session is at ${runSession})` : ""}` };
      return { status: "pass", observed: runSession ? `${daemon}, ${runSession}` : daemon };
    },
  };

  const noTree = "no accessibility tree: snapshots report coverage none, so drive apps by screenshots and coordinates";
  const atspi: Check = {
    id: "linux.atspi",
    description: "at-spi-bus-launcher present (accessibility bus)",
    kind: "observe",
    required: false,
    degrades: noTree,
    remediation: install("atspi", "AT-SPI"),
    async run() {
      const found = ATSPI_LAUNCHER_CANDIDATES.find((p) => executable(p));
      return found ? { status: "pass", observed: found } : { status: "fail", observed: `not found in ${ATSPI_LAUNCHER_CANDIDATES.join(", ")}` };
    },
  };

  const pyatspi: Check = {
    id: "linux.pyatspi",
    description: "pyatspi importable (accessibility tree)",
    kind: "observe",
    required: false,
    dependsOn: ["linux.python"],
    degrades: noTree,
    remediation: install("pyatspi", "pyatspi"),
    async run(ctx) {
      const result = await tryRun(runner, [requirePython(), "-I", "-c", "import pyatspi"], ctx, { timeoutMs: 15_000 });
      if (!result) return notFound("python3");
      return result.exitCode === 0 ? { status: "pass", observed: "import pyatspi works" } : { status: "fail", observed: `import pyatspi failed: ${firstLine(result.stderr.split("\n").slice(-2).join("\n")) || describeFailure(result)}` };
    },
  };

  const wm: Check = {
    id: "linux.wm",
    description: "openbox present (window manager)",
    kind: "observe",
    required: false,
    degrades: "no window manager: dialogs may open at the top-left corner and window activation may not work",
    remediation: install("wm", "openbox"),
    async run() {
      const found = which("openbox");
      return found ? { status: "pass", observed: found } : notFound("openbox");
    },
  };

  const fonts: Check = {
    id: "linux.fonts",
    description: "at least one font installed",
    kind: "observe",
    required: false,
    degrades: "text may render as boxes in screenshots",
    remediation: install("fonts", "a font package"),
    async run(ctx) {
      const result = await tryRun(runner, ["fc-list"], ctx);
      if (!result) return notFound("fc-list");
      const count = result.stdout.split("\n").filter((l) => l.trim()).length;
      return count > 0 ? { status: "pass", observed: `${count} font(s)` } : { status: "fail", observed: "fc-list lists no fonts" };
    },
  };

  const gtk: Check = {
    id: "linux.gtk-introspection",
    description: "PyGObject with GTK 3 (helper and smoke-test app)",
    kind: "observe",
    required: true,
    dependsOn: ["linux.python"],
    remediation: install("gtk", "PyGObject and GTK 3"),
    async run(ctx) {
      const result = await tryRun(runner, [requirePython(), "-I", "-c", "import gi; gi.require_version('Gtk', '3.0')"], ctx, { timeoutMs: 15_000 });
      if (!result) return notFound("python3");
      return result.exitCode === 0
        ? { status: "pass", observed: "gi with Gtk 3.0 available" }
        : { status: "fail", observed: `gi/Gtk 3.0 not available: ${firstLine(result.stderr.trim().split("\n").at(-1) ?? "") || describeFailure(result)}` };
    },
  };

  const scrub: Check = {
    id: "linux.wayland-scrub",
    description: "app children see only the private display and bus",
    kind: "probe",
    required: true,
    dependsOn: ["linux.python"],
    timeoutMs: 30_000,
    async run(ctx) {
      // 1. The helper's own environment never carries desktop variables, whatever Pi's holds.
      const polluted = { ...(options.env ?? process.env), DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus", XAUTHORITY: "/nonexistent", XDG_RUNTIME_DIR: "/run/user/0" };
      return withProbeDir(async (dir) => {
        const lockDir = join(dir, "locks");
        const runtimeDir = join(dir, "runtime");
        await mkdir(lockDir, { mode: 0o700 });
        await mkdir(runtimeDir, { mode: 0o700 });
        const env = helperEnv({ base: polluted, workspace: dir, runtimeDir, lockDir });
        const leaked = forbiddenHelperEnv(env);
        if (leaked.length > 0) return { status: "fail", observed: `helper environment carries ${leaked.join(", ")}` };
        // 2. A real child started the way `launch` starts apps sees only the private session,
        //    even when the helper's environment and the request try to point it at the desktop.
        const result = await tryRun(runner, helperArgv(requirePython(), ["--probe", "env"]), ctx, {
          timeoutMs: 25_000,
          env: { ...env, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", SESSION_MANAGER: "local/probe:@/tmp/.ICE-unix/1" },
        });
        if (!result) return notFound("python3");
        const report = lastJsonLine(result.stdout);
        if (!report || report.ok !== true) return { status: "fail", observed: `env probe failed: ${String(report?.error ?? describeFailure(result))}` };
        const problems = scrubProblems(report);
        if (problems.length > 0) return { status: "fail", observed: `child environment: ${problems.join("; ")}` };
        const seen = report.seen as Record<string, string>;
        return { status: "pass", observed: `child saw DISPLAY=${seen.DISPLAY}, private bus and runtime dir, no WAYLAND_DISPLAY` };
      });
    },
  };

  return [...common, pythonCheck, xvfb, xdotool, xutils, screenshot, dbus, atspi, pyatspi, wm, fonts, gtk, scrub];
}
