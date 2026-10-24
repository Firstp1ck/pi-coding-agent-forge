/**
 * `remote-linux` runtime checks (spec §5.4 "Runtime: remote-linux"): the
 * `local-linux` tool checks evaluated on the remote host, a private Xvfb
 * start on a free display (never `:0`), and the helper deploy.
 */
import { randomBytes } from "node:crypto";
import { compareVersions } from "../../checks/common.ts";
import type { Check, CheckContext, CheckOutcome } from "../../checks/types.ts";
import { deployHelper } from "./deploy.ts";
import type { RemoteFacts, RemoteProbes } from "./checks.ts";
import { PACKAGES } from "./packages.ts";
import { createRemoteSessionDir, remoteFailure, removeRemoteSessions } from "./session-dir.ts";

export const MIN_REMOTE_PYTHON = "3.9";

/**
 * Starts `Xvfb` on the first free display from 90 under `env -i`, waits for
 * its socket, checks XTEST with `xdpyinfo` when installed, and stops it.
 * Prints `used=`, `display=`, `started=`, `lock=`, `xtest=`.
 */
export const XVFB_PROBE_SCRIPT = [
  'used=""; for s in /tmp/.X11-unix/X*; do [ -e "$s" ] && used="$used ${s#/tmp/.X11-unix/X}"; done; echo "used=$used";',
  'n=""; i=90; while [ $i -le 199 ]; do if [ ! -e "/tmp/.X11-unix/X$i" ] && [ ! -e "/tmp/.X$i-lock" ]; then n=$i; break; fi; i=$((i+1)); done;',
  '[ -n "$n" ] || { echo "error=no free display between :90 and :199"; exit 3; };',
  'echo "display=$n";',
  'env -i PATH="$PATH" Xvfb ":$n" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 & pid=$!;',
  'i=0; while [ $i -lt 25 ]; do [ -e "/tmp/.X11-unix/X$n" ] && break; kill -0 "$pid" 2>/dev/null || break; sleep 0.2 2>/dev/null || sleep 1; i=$((i+1)); done;',
  'if [ -e "/tmp/.X11-unix/X$n" ]; then echo started=1; else echo started=0; fi;',
  'if [ -e "/tmp/.X$n-lock" ]; then echo lock=1; else echo lock=0; fi;',
  'if command -v xdpyinfo >/dev/null 2>&1; then if env -i PATH="$PATH" DISPLAY=":$n" xdpyinfo 2>/dev/null | grep -q XTEST; then echo xtest=1; else echo xtest=0; fi; else echo xtest=unknown; fi;',
  'kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; exit 0',
].join(" ");

/** The runtime checks of `remote-linux`. */
export function remoteLinuxRuntimeChecks(probes: RemoteProbes): Check[] {
  const facts = (ctx: CheckContext) => probes.facts(ctx, "ssh.auth");
  const tool = (
    id: string,
    description: string,
    required: boolean,
    pkg: keyof typeof PACKAGES,
    test: (f: RemoteFacts) => { ok: boolean; observed: string },
    extra: Partial<Check> = {},
  ): Check => {
    const check: Check = {
      id,
      description,
      kind: "observe",
      required,
      ...extra,
      dependsOn: [...new Set(["ssh.auth", "remote.os", ...(extra.dependsOn ?? [])])],
      async run(ctx): Promise<CheckOutcome> {
        const f = await facts(ctx);
        const outcome = test(f);
        if (outcome.ok) return { status: "pass", observed: outcome.observed };
        probes.applyToolRemediation(check, f, pkg, description);
        return { status: "fail", observed: outcome.observed };
      },
    };
    return check;
  };
  const has = (f: RemoteFacts, name: string) => f.tools.get(name);

  const python = tool("remote.python", `python3 ${MIN_REMOTE_PYTHON} or newer (runs the helper)`, true, "python", (f) => {
    const version = f.values.get("python") ?? "";
    if (!version) return { ok: false, observed: "python3 not found" };
    const cmp = compareVersions(version, MIN_REMOTE_PYTHON);
    return { ok: cmp !== undefined && cmp >= 0, observed: `python3 ${version}` };
  });

  const checks: Check[] = [
    python,
    tool("linux.xvfb", "Xvfb on the remote host", true, "xvfb", (f) => (has(f, "Xvfb") ? { ok: true, observed: has(f, "Xvfb")! } : { ok: false, observed: "Xvfb not found" })),
    tool("linux.xdotool", "xdotool on the remote host", true, "xdotool", (f) => (has(f, "xdotool") ? { ok: true, observed: has(f, "xdotool")! } : { ok: false, observed: "xdotool not found" })),
    tool("linux.screenshot", "import (ImageMagick) or xwd on the remote host", true, "screenshot", (f) => {
      const found = ["import", "magick", "xwd"].find((t) => has(f, t));
      return found ? { ok: true, observed: has(f, found)! } : { ok: false, observed: "neither import nor xwd found" };
    }),
    tool("linux.dbus", "dbus-run-session on the remote host", true, "dbus", (f) => {
      const found = has(f, "dbus-run-session") ?? has(f, "dbus-daemon");
      return found ? { ok: true, observed: found } : { ok: false, observed: "dbus-run-session not found" };
    }),
    tool(
      "linux.atspi",
      "at-spi-bus-launcher on the remote host",
      false,
      "atspi",
      (f) => (has(f, "at-spi-bus-launcher") ? { ok: true, observed: has(f, "at-spi-bus-launcher")! } : { ok: false, observed: "at-spi-bus-launcher not found" }),
      { degrades: "no accessibility tree (gui_snapshot) on the remote host" },
    ),
    tool("linux.pyatspi", "python3 can import pyatspi", false, "pyatspi", (f) => ({ ok: f.values.get("pyatspi") === "1", observed: f.values.get("pyatspi") === "1" ? "import pyatspi works" : "import pyatspi fails" }), {
      degrades: "no accessibility tree (gui_snapshot) on the remote host",
      dependsOn: ["remote.python"],
    }),
    tool("linux.wm", "openbox on the remote host", false, "wm", (f) => (has(f, "openbox") ? { ok: true, observed: has(f, "openbox")! } : { ok: false, observed: "openbox not found" }), {
      degrades: "dialogs may open at odd positions",
    }),
    tool("linux.fonts", "at least one font on the remote host", false, "fonts", (f) => {
      const count = Number(f.values.get("fonts") ?? "0");
      return { ok: count >= 1, observed: `${count} font(s) (fc-list)` };
    }, { degrades: "text may render as boxes" }),
    tool("linux.gtk-introspection", "python3 can load GTK 3 through PyGObject (smoke-test app)", true, "gtk", (f) => ({ ok: f.values.get("gtk3") === "1", observed: f.values.get("gtk3") === "1" ? "gi.require_version('Gtk', '3.0') works" : "PyGObject with GTK 3 is not importable" }), {
      dependsOn: ["remote.python"],
    }),
  ];

  const xvfbCache = new WeakMap<object, Promise<Map<string, string>>>();
  const xvfbProbe = (ctx: CheckContext): Promise<Map<string, string>> => {
    const key = ctx.dependencies.get("linux.xvfb") ?? {};
    let pending = xvfbCache.get(key);
    if (!pending) {
      pending = (async () => {
        const result = await probes.oneShot().runner.run(["/bin/sh", "-c", XVFB_PROBE_SCRIPT, "sh"], { timeoutMs: 30_000, signal: ctx.signal });
        if (result.exitCode !== 0 && !result.stdout.includes("error=")) throw new Error(`Xvfb probe failed (${remoteFailure(result)})`);
        const values = new Map<string, string>();
        for (const line of result.stdout.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1).trim());
        }
        return values;
      })();
      xvfbCache.set(key, pending);
    }
    return pending;
  };

  checks.push(
    {
      id: "xvfb.start",
      description: "a private Xvfb starts on a free display",
      kind: "probe",
      required: true,
      dependsOn: ["linux.xvfb"],
      timeoutMs: 45_000,
      async run(ctx) {
        const v = await xvfbProbe(ctx);
        if (v.has("error")) return { status: "fail", observed: v.get("error")! };
        if (v.get("started") !== "1") return { status: "fail", observed: `Xvfb :${v.get("display")} did not start` };
        const xtest = v.get("xtest");
        if (xtest === "0") return { status: "fail", observed: `Xvfb :${v.get("display")} has no XTEST extension` };
        return { status: "pass", observed: `Xvfb started on :${v.get("display")}${v.get("lock") === "1" ? " with a lock file" : ""}${xtest === "unknown" ? " (xdpyinfo missing; XTEST not verified)" : ", XTEST present"}` };
      },
    },
    {
      id: "xvfb.not-host",
      description: "the private display is never one in use (never :0)",
      kind: "observe",
      required: true,
      dependsOn: ["xvfb.start", "linux.xvfb"],
      async run(ctx) {
        const v = await xvfbProbe(ctx);
        const display = v.get("display") ?? "";
        const used = (v.get("used") ?? "").split(/\s+/).filter(Boolean);
        if (display === "0" || used.includes(display)) return { status: "fail", observed: `display :${display} is in use on the remote host` };
        return { status: "pass", observed: `:${display} is free${used.length ? `; displays in use: ${used.map((d) => `:${d}`).join(" ")}` : "; no display in use"}` };
      },
    },
    {
      id: "helper.deploy",
      description: "the helper copies to a session dir intact and its package imports",
      kind: "probe",
      required: true,
      dependsOn: ["remote.session-root", "remote.python"],
      timeoutMs: 60_000,
      remediation: { summary: "Re-run /gui-setup; if it keeps failing, check free space and the remote python3", manual: true },
      async run(ctx) {
        const transport = probes.oneShot();
        const name = `s-probe-${randomBytes(4).toString("hex")}`;
        try {
          const remote = await createRemoteSessionDir(transport.runner, { name, ownerLabel: probes.options.ownerLabel(), sessionId: "probe", backend: probes.options.backend, signal: ctx.signal });
          const deployed = await deployHelper(transport, remote.tooling, { signal: ctx.signal });
          const load = await transport.runner.run(["python3", "-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import pi_gui_helper; print('ok')", remote.tooling], { timeoutMs: 20_000, signal: ctx.signal });
          if (load.exitCode !== 0 || !load.stdout.includes("ok")) return { status: "fail", observed: `the helper package does not import (${remoteFailure(load)})` };
          return { status: "pass", observed: `${deployed.files} files deployed and verified by sha256 (handshake: smoke test)` };
        } finally {
          await removeRemoteSessions(transport.runner, [name], { destination: transport.destination, mode: "fast" }).catch(() => undefined);
        }
      },
    },
  );
  return checks;
}
