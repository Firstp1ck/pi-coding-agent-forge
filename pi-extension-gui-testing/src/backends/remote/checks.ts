/**
 * Checks of the remote backends (spec §5.4): client and connection checks,
 * then the remote platform, resources, file system, and sync over the
 * verified connection, then the backend's runtime checks
 * (`./linux-checks.ts`, `./docker-checks.ts`).
 *
 * Every SSH call uses BatchMode and a connect timeout; nothing prompts and no
 * password is ever handled. Remediations that need the user (installing a
 * key, accepting a host key, sudo with a password) are manual and show the
 * exact command. Probe checks create only a labelled probe session dir on the
 * remote (`s-probe-*`, owner label of this client) and remove it before
 * returning; the remote sweep catches it otherwise.
 */
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { commonChecks, type CommonCheckOptions } from "../../checks/common.ts";
import type { Check, CheckContext, CheckOutcome, CheckResult } from "../../checks/types.ts";
import type { BackendId } from "../../config/types.ts";
import type { CommandRunner, RunResult } from "../../runner/types.ts";
import { buildFileSet } from "../../sync/fileset.ts";
import { secretMatch } from "../../sync/patterns.ts";
import { WorkspaceSync, type SyncMethod } from "../../sync/transport/workspace-sync.ts";
import { listConfigAliases, resolveHost, type ResolvedHost } from "../../setup/hosts.ts";
import { classifySshFailure, sshErrorLine, sshRemediation } from "../../transport/ssh/errors.ts";
import { SHORT_CONTROL_DIR_PREFIX } from "../../transport/ssh/options.ts";
import { assertDestination } from "../../transport/ssh/quote.ts";
import { SshTransport, type SshTransportOptions } from "../../transport/ssh/transport.ts";
import { PROBE_DIR_PREFIX } from "../docker/checks.ts";
import { REMOTE_HOST_SUPPORT } from "./host.ts";
import { isPackageManager, manualInstallCommand, PACKAGES, remoteInstallCommand, type PackageManager } from "./packages.ts";
import { createRemoteSessionDir, remoteFailure, removeRemoteSessions, type RemoteSessionDir } from "./session-dir.ts";

/** Client free space needed for sync staging (spec §5.4 `disk.free`). */
export const REMOTE_CLIENT_MIN_FREE_BYTES = 1024 ** 3;
/** `remote-linux`: free space at the session root. */
export const REMOTE_LINUX_MIN_FREE_BYTES = 2 * 1024 ** 3;
export const REMOTE_MIN_MEM_BYTES = 2 * 1024 ** 3;
export const REMOTE_WARN_MEM_BYTES = 4 * 1024 ** 3;
export const LATENCY_LIMIT_MS = 300;

export interface RemoteCheckOptions {
  backend: BackendId;
  /** The chosen SSH alias; checks that need it fail (or are blocked) without one. */
  host: string | undefined;
  /** Local runner (`ssh`, `ssh-add`, `ssh-keygen`, `rsync`). */
  runner: CommandRunner;
  /** Options for every transport (fakes in tests). */
  transport: Omit<SshTransportOptions, "destination" | "control">;
  ownerLabel: () => string;
  version: string;
  home?: string;
  tmpRoot?: string;
  ssh?: string;
  common?: Partial<CommonCheckOptions>;
  syncMethod?: "auto" | SyncMethod;
  /** Parent of the short ControlMaster dir of the multiplex probe; default `/tmp`. */
  shortControlRoot?: string;
}

/** Facts printed by {@link PLATFORM_SCRIPT}. */
export interface RemoteFacts {
  values: Map<string, string>;
  tools: Map<string, string>;
}

/** One SSH call that reports the remote platform, resources, and tools as `key=value` lines. */
export const PLATFORM_SCRIPT = [
  'echo "os=$(uname -s)"; echo "arch=$(uname -m)";',
  'if [ -r /etc/os-release ]; then echo "distro=$(sed -n "s/^ID=//p" /etc/os-release | tr -d "\\"" | head -n 1)"; echo "distro_version=$(sed -n "s/^VERSION_ID=//p" /etc/os-release | tr -d "\\"" | head -n 1)"; echo "distro_name=$(sed -n "s/^PRETTY_NAME=//p" /etc/os-release | tr -d "\\"" | head -n 1)"; fi;',
  'for pm in pacman apt-get dnf zypper apk; do if command -v "$pm" >/dev/null 2>&1; then echo "pm=$pm"; break; fi; done;',
  'awk "/^MemTotal:/ {print \\"mem_kb=\\" \\$2}" /proc/meminfo 2>/dev/null;',
  'echo "cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 0)";',
  'echo "nofile=$(ulimit -n 2>/dev/null)"; echo "nproc=$(ulimit -u 2>/dev/null)";',
  'if sudo -n true >/dev/null 2>&1; then echo sudo=1; else echo sudo=0; fi;',
  'echo "path=$PATH"; echo "uid=$(id -u)";',
  'for t in Xvfb xdotool xwd import convert magick dbus-run-session dbus-daemon at-spi-bus-launcher openbox fc-list xdpyinfo python3 rsync docker tar sha256sum mktemp stat; do p=$(command -v "$t" 2>/dev/null) && echo "tool.$t=$p"; done;',
  'for a in /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher /usr/libexec/at-spi2-core/at-spi-bus-launcher /usr/lib/at-spi-bus-launcher /usr/lib/at-spi2/at-spi-bus-launcher; do if [ -x "$a" ]; then echo "tool.at-spi-bus-launcher=$a"; break; fi; done;',
  'if command -v python3 >/dev/null 2>&1; then',
  'echo "python=$(python3 -I -c "import sys; print(\\"%d.%d.%d\\" % sys.version_info[:3])" 2>/dev/null)";',
  'if python3 -I -c "import gi; gi.require_version(\\"Gtk\\", \\"3.0\\")" >/dev/null 2>&1; then echo gtk3=1; else echo gtk3=0; fi;',
  'if python3 -I -c "import pyatspi" >/dev/null 2>&1; then echo pyatspi=1; else echo pyatspi=0; fi;',
  "fi;",
  'if command -v fc-list >/dev/null 2>&1; then echo "fonts=$(fc-list 2>/dev/null | wc -l | tr -d " ")"; fi;',
  'if command -v timeout >/dev/null 2>&1 && [ -n "${SHELL:-}" ]; then echo "login_path=$(timeout 5 "$SHELL" -lc "echo \\"\\$PATH\\"" </dev/null 2>/dev/null | tail -n 1)"; fi;',
  "exit 0",
].join(" ");

/** Parses {@link PLATFORM_SCRIPT} output. */
export function parseFacts(stdout: string): RemoteFacts {
  const values = new Map<string, string>();
  const tools = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.startsWith("tool.")) {
      if (!tools.has(key.slice(5))) tools.set(key.slice(5), value);
    } else if (!values.has(key)) values.set(key, value);
  }
  return { values, tools };
}

/** Caches one promise per dependency result object (a new check run gets new objects, so a fresh value). */
function memoBy<T>(): (key: CheckResult | undefined, make: () => Promise<T>) => Promise<T> {
  const cache = new WeakMap<CheckResult, Promise<T>>();
  return (key, make) => {
    if (!key) return make();
    let pending = cache.get(key);
    if (!pending) {
      pending = make();
      cache.set(key, pending);
    }
    return pending;
  };
}

/** Free-text one-liner of a remote result. */
function failureText(result: RunResult): string {
  return sshErrorLine(result.stderr) || remoteFailure(result);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** `true` when the file exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface ToolRemediation {
  summary: string;
  pm?: PackageManager;
  packages: string[];
  sudo: boolean;
}

/**
 * Shared state of one `checks()` list: memoised remote calls, keyed on the
 * dependency results of the current run.
 */
export class RemoteProbes {
  readonly options: RemoteCheckOptions;
  readonly #resolved = memoBy<ResolvedHost>();
  readonly #connect = memoBy<RunResult>();
  readonly #facts = memoBy<RemoteFacts>();
  readonly #root = memoBy<{ remote?: RemoteSessionDir; error?: string; noexec?: string }>();
  readonly #mux = memoBy<{ ok: boolean; observed: string; latencies: number[] }>();

  constructor(options: RemoteCheckOptions) {
    this.options = options;
  }

  get ssh(): string {
    return this.options.ssh ?? "ssh";
  }

  get home(): string {
    return this.options.home ?? homedir();
  }

  /** The host, validated; throws when none is chosen (the check then fails with the message). */
  host(): string {
    const host = this.options.host;
    if (!host) throw new Error(`no SSH host chosen; run /gui-setup ${this.options.backend} --host <ssh-alias>`);
    return assertDestination(host);
  }

  oneShot(destination: string = this.host()): SshTransport {
    return new SshTransport({ destination, ...this.options.transport, ...(this.options.ssh ? { ssh: this.options.ssh } : {}) });
  }

  resolved(ctx: CheckContext, key = "ssh.config"): Promise<ResolvedHost> {
    return this.#resolved(ctx.dependencies.get(key), () => resolveHost(this.host(), this.options.runner, ctx.signal, this.ssh));
  }

  /** `true` over a fresh connection (StrictHostKeyChecking=yes, BatchMode). */
  connect(ctx: CheckContext, key = "ssh.config"): Promise<RunResult> {
    return this.#connect(ctx.dependencies.get(key), () => this.oneShot().runner.run(["true"], { timeoutMs: 10_000, signal: ctx.signal }));
  }

  facts(ctx: CheckContext, key: string): Promise<RemoteFacts> {
    return this.#facts(ctx.dependencies.get(key), async () => {
      const result = await this.oneShot().runner.run(["/bin/sh", "-c", PLATFORM_SCRIPT, "sh"], { timeoutMs: 30_000, signal: ctx.signal });
      if (result.exitCode !== 0) throw new Error(`reading the remote platform failed (${failureText(result)})`);
      return parseFacts(result.stdout);
    });
  }

  /** Creates and removes a probe session dir; reports the root. */
  sessionRoot(ctx: CheckContext, key: string): Promise<{ remote?: RemoteSessionDir; error?: string }> {
    return this.#root(ctx.dependencies.get(key), async () => {
      const transport = this.oneShot();
      const name = `s-probe-${randomBytes(4).toString("hex")}`;
      try {
        const remote = await createRemoteSessionDir(transport.runner, { name, ownerLabel: this.options.ownerLabel(), sessionId: "probe", backend: this.options.backend, signal: ctx.signal });
        const left = await removeRemoteSessions(transport.runner, [name], { destination: transport.destination, signal: ctx.signal, mode: "fast" });
        if (left.length > 0) return { remote, error: `probe dir was created but not removed: ${left.map((l) => l.id).join(", ")}` };
        return { remote };
      } catch (error) {
        await removeRemoteSessions(transport.runner, [name], { destination: transport.destination, mode: "fast" }).catch(() => undefined);
        return { error: (error as Error).message };
      }
    });
  }

  /** Opens a ControlMaster in a short temp dir, checks it, measures 5 round trips, and closes it. */
  multiplex(ctx: CheckContext, key: string): Promise<{ ok: boolean; observed: string; latencies: number[] }> {
    return this.#mux(ctx.dependencies.get(key), async () => {
      const dir = await mkdtemp(join(this.options.shortControlRoot ?? "/tmp", SHORT_CONTROL_DIR_PREFIX));
      const transport = new SshTransport({ destination: this.host(), control: { path: join(dir, "s") }, ...this.options.transport, ...(this.options.ssh ? { ssh: this.options.ssh } : {}) });
      try {
        await transport.open(ctx.signal, 15_000);
        if (!(await transport.masterRunning(ctx.signal))) return { ok: false, observed: "the ControlMaster did not answer ssh -O check", latencies: [] };
        const latencies: number[] = [];
        for (let i = 0; i < 5; i++) {
          const started = Date.now();
          const result = await transport.runner.run(["true"], { timeoutMs: 5_000, signal: ctx.signal });
          if (result.exitCode !== 0) return { ok: false, observed: `a call through the ControlMaster failed (${failureText(result)})`, latencies };
          latencies.push(Date.now() - started);
        }
        return { ok: true, observed: `ControlMaster works (median ${median(latencies)} ms per call)`, latencies };
      } catch (error) {
        return { ok: false, observed: (error as Error).message, latencies: [] };
      } finally {
        await transport.close();
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  /** Remediation for a missing remote tool, given the platform facts. */
  toolRemediation(facts: RemoteFacts, tool: keyof typeof PACKAGES, summary: string): ToolRemediation {
    const pmValue = facts.values.get("pm");
    const pm = isPackageManager(pmValue) ? pmValue : undefined;
    const packages = PACKAGES[tool][pm ?? "apt-get"];
    return { summary, ...(pm ? { pm } : {}), packages, sudo: facts.values.get("sudo") === "1" };
  }

  /** Sets `check.remediation` for a missing tool: automated with passwordless sudo, otherwise the command to run by hand. */
  applyToolRemediation(check: Check, facts: RemoteFacts, tool: keyof typeof PACKAGES, what: string): void {
    const fix = this.toolRemediation(facts, tool, what);
    const host = this.host();
    if (fix.pm && fix.sudo) {
      check.remediation = { summary: `Install ${fix.packages.join(" ")} on ${host} (${what}) with passwordless sudo`, command: remoteInstallCommand(host, fix.pm, fix.packages, this.ssh), needsSudo: true, timeoutMs: 15 * 60_000 };
    } else {
      check.remediation = {
        summary: `Install ${fix.packages.join(" ")} on ${host} (${what})${fix.pm ? "" : " with its package manager (not detected)"}; run yourself: ${manualInstallCommand(host, fix.pm, fix.packages)}`,
        manual: true,
      };
    }
  }
}

/** Probe-dir names and contents for `sync.roundtrip`. */
const ROUNDTRIP_FILES: Record<string, { content: string; mode: number }> = {
  "hello.txt": { content: "hello\n", mode: 0o644 },
  "ünïcødé ✓.txt": { content: "unicode ✓\n", mode: 0o644 },
  "bin/run.sh": { content: "#!/bin/sh\necho ok\n", mode: 0o755 },
};
const ROUNDTRIP_LINK = { path: "link-to-hello", target: "hello.txt" };

/** Client, connection, platform, resource, file-system, and sync checks shared by both remote backends. */
export function remoteBaseChecks(probes: RemoteProbes, options: { minRemoteFreeBytes?: number } = {}): Check[] {
  const o = probes.options;
  const runner = o.runner;
  const common = commonChecks(o.backend, { minFreeBytes: REMOTE_CLIENT_MIN_FREE_BYTES, hostSupport: REMOTE_HOST_SUPPORT, ...o.common });

  const localSsh: Check = {
    id: "local.ssh",
    description: "OpenSSH client on PATH",
    kind: "observe",
    required: true,
    remediation: { summary: "Install the OpenSSH client (for example openssh-client or openssh); setup never installs it for you", manual: true },
    async run(ctx) {
      let result: RunResult;
      try {
        result = await runner.run([probes.ssh, "-V"], { timeoutMs: 5_000, signal: ctx.signal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "fail", observed: "ssh not found on PATH" };
        throw error;
      }
      const version = (result.stderr.trim() || result.stdout.trim()).split("\n")[0];
      if (result.exitCode !== 0 || !/OpenSSH/i.test(version)) return { status: "fail", observed: `ssh -V: ${version || `exit ${result.exitCode}`} (OpenSSH needed)` };
      return { status: "pass", observed: version, facts: { "ssh.client": version.split(/[ ,]/)[0] } };
    },
  };

  const localRsync: Check = {
    id: "local.rsync",
    description: "rsync on PATH (incremental syncs)",
    kind: "observe",
    required: false,
    degrades: "every sync is a full tar copy instead of an incremental rsync",
    remediation: { summary: "Install rsync on this machine for incremental syncs", manual: true },
    async run(ctx) {
      const result = await runner.run(["rsync", "--version"], { timeoutMs: 5_000, signal: ctx.signal }).catch(() => undefined);
      if (result?.exitCode !== 0) return { status: "fail", observed: "rsync not found; the built-in tar stream is used instead" };
      return { status: "pass", observed: result.stdout.split("\n")[0].trim() };
    },
  };

  const config: Check = {
    id: "ssh.config",
    description: "SSH host chosen and resolvable with ssh -G",
    kind: "observe",
    required: true,
    dependsOn: ["local.ssh"],
    async run(ctx) {
      if (!o.host) {
        config.remediation = { summary: `Choose a host: /gui-setup ${o.backend} --host <alias from ~/.ssh/config>, or run /gui-setup ${o.backend} with a UI to pick one`, manual: true };
        return { status: "fail", observed: "no SSH host chosen" };
      }
      const listed = await listConfigAliases({ home: probes.home });
      let resolved: ResolvedHost;
      try {
        resolved = await probes.resolved(ctx, "local.ssh");
      } catch (error) {
        config.remediation = { summary: `Fix the Host entry for ${o.host} in ~/.ssh/config (ssh -G ${o.host} must work)`, manual: true };
        return { status: "fail", observed: (error as Error).message };
      }
      const known = listed.aliases.includes(o.host);
      const problems = listed.problems.length ? `; config problems: ${listed.problems.slice(0, 3).join("; ")}` : "";
      return {
        status: "pass",
        observed: `${o.host} → ${resolved.user ? `${resolved.user}@` : ""}${resolved.hostname}:${resolved.port}${resolved.proxyJump ? ` via ${resolved.proxyJump}` : ""}${known ? "" : " (not a Host alias in ~/.ssh/config)"}${problems}`,
        facts: { "remote.host": o.host },
      };
    },
  };

  const sshKey: Check = {
    id: "local.sshkey",
    description: "an SSH key in the agent or ~/.ssh",
    kind: "observe",
    required: true,
    dependsOn: ["local.ssh"],
    remediation: { summary: "Create a key yourself (choose a passphrase): ssh-keygen -t ed25519, then install it on the host with ssh-copy-id <host>", manual: true },
    async run(ctx) {
      const agent = await runner.run(["ssh-add", "-l"], { timeoutMs: 5_000, signal: ctx.signal }).catch(() => undefined);
      if (agent?.exitCode === 0 && agent.stdout.trim()) return { status: "pass", observed: `${agent.stdout.trim().split("\n").length} key(s) in the SSH agent` };
      const candidates = new Set<string>();
      if (o.host) {
        const resolved = await resolveHost(o.host, runner, ctx.signal, probes.ssh).catch(() => undefined);
        for (const file of resolved?.identityFiles ?? []) candidates.add(file.startsWith("~/") ? join(probes.home, file.slice(2)) : file);
      }
      for (const name of ["id_ed25519", "id_ecdsa", "id_rsa", "id_ed25519_sk", "id_ecdsa_sk"]) candidates.add(join(probes.home, ".ssh", name));
      for (const file of candidates) if (await exists(file)) return { status: "pass", observed: `key file ${file}` };
      return { status: "fail", observed: "no key in the agent and no key file in ~/.ssh" };
    },
  };

  const hostKey: Check = {
    id: "ssh.hostkey",
    description: "host key already known (StrictHostKeyChecking=yes)",
    kind: "observe",
    required: true,
    dependsOn: ["ssh.config"],
    async run(ctx) {
      const result = await probes.connect(ctx);
      const failure = result.exitCode === 0 ? undefined : classifySshFailure(result.stderr);
      if (failure === "hostkey-unknown" || failure === "hostkey-changed") {
        hostKey.remediation = { summary: sshRemediation(failure, probes.host()), manual: true };
        return { status: "fail", observed: sshErrorLine(result.stderr) || "host key verification failed" };
      }
      if (failure === "resolve" || failure === "unreachable" || result.timedOut) {
        hostKey.remediation = { summary: sshRemediation(result.timedOut ? "unreachable" : failure!, probes.host()), manual: true };
        return { status: "fail", observed: result.timedOut ? "no connection within 10 s" : sshErrorLine(result.stderr) };
      }
      return { status: "pass", observed: "host key verified against known_hosts" };
    },
  };

  const auth: Check = {
    id: "ssh.auth",
    description: "key login without a password (BatchMode=yes)",
    kind: "observe",
    required: true,
    dependsOn: ["ssh.hostkey", "ssh.config"],
    async run(ctx) {
      const result = await probes.connect(ctx);
      if (result.exitCode === 0) return { status: "pass", observed: `ssh ${probes.host()} true works without a prompt` };
      const failure = classifySshFailure(result.stderr);
      auth.remediation = { summary: sshRemediation(failure, probes.host()), manual: true };
      return { status: "fail", observed: sshErrorLine(result.stderr) || remoteFailure(result) };
    },
  };

  const jump: Check = {
    id: "ssh.jump",
    description: "every ProxyJump host is reachable",
    kind: "observe",
    required: true,
    dependsOn: ["ssh.config"],
    timeoutMs: 30_000,
    async run(ctx) {
      const resolved = await probes.resolved(ctx);
      if (!resolved.proxyJump) return { status: "pass", observed: "no ProxyJump" };
      const hops = resolved.proxyJump.split(",").map((h) => h.trim()).filter(Boolean);
      for (const hop of hops) {
        let destination: string;
        try {
          const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(hop);
          destination = assertDestination(m?.[3] ? `ssh://${m[1] ? `${m[1]}@` : ""}${m[2]}:${m[3]}` : hop);
        } catch (error) {
          return { status: "fail", observed: `ProxyJump ${hop}: ${(error as Error).message}` };
        }
        const result = await probes.oneShot(destination).runner.run(["true"], { timeoutMs: 10_000, signal: ctx.signal });
        if (result.exitCode !== 0) {
          jump.remediation = { summary: `jump host ${hop}: ${sshRemediation(classifySshFailure(result.stderr), hop)}`, manual: true };
          return { status: "fail", observed: `jump host ${hop}: ${failureText(result)}` };
        }
      }
      return { status: "pass", observed: `ProxyJump ${hops.join(", ")} reachable` };
    },
  };

  const multiplex: Check = {
    id: "ssh.multiplex",
    description: "ControlMaster connection sharing works",
    kind: "probe",
    required: false,
    degrades: "every call opens its own SSH connection (slower)",
    dependsOn: ["ssh.auth"],
    timeoutMs: 30_000,
    async run(ctx) {
      const mux = await probes.multiplex(ctx, "ssh.auth");
      return { status: mux.ok ? "pass" : "fail", observed: mux.observed };
    },
  };

  const cleanStdout: Check = {
    id: "ssh.clean-stdout",
    description: "non-interactive SSH commands print nothing extra",
    kind: "observe",
    required: false,
    degrades: "shell rc output is mixed into command output (the helper protocol tolerates it)",
    remediation: { summary: "Make the remote shell rc files quiet for non-interactive shells (print only when interactive)", manual: true },
    dependsOn: ["ssh.auth", "ssh.config"],
    async run(ctx) {
      const result = await probes.connect(ctx);
      const out = result.stdout.trim();
      if (out === "") return { status: "pass", observed: "no output" };
      return { status: "fail", observed: `ssh ${probes.host()} true printed ${JSON.stringify(out.slice(0, 80))}` };
    },
  };

  const latency: Check = {
    id: "ssh.latency",
    description: `median round trip under ${LATENCY_LIMIT_MS} ms`,
    kind: "probe",
    required: false,
    degrades: "slow interaction",
    dependsOn: ["ssh.auth"],
    timeoutMs: 30_000,
    async run(ctx) {
      const mux = await probes.multiplex(ctx, "ssh.auth");
      if (mux.latencies.length === 0) return { status: "fail", observed: `not measured (${mux.observed})` };
      const value = median(mux.latencies);
      return { status: value < LATENCY_LIMIT_MS ? "pass" : "fail", observed: `median ${value} ms over ${mux.latencies.length} calls` };
    },
  };

  const facts = (ctx: CheckContext) => probes.facts(ctx, "ssh.auth");
  /** Platform checks read the shared facts of the `ssh.auth` run. */
  const platform = (id: string, description: string, required: boolean, run: (f: RemoteFacts, ctx: CheckContext) => CheckOutcome | Promise<CheckOutcome>, extra: Partial<Check> = {}): Check => {
    const check: Check = {
      id,
      description,
      kind: "observe",
      required,
      ...extra,
      // The shared facts are memoised on the `ssh.auth` result, so every platform check lists it.
      dependsOn: [...new Set(["ssh.auth", ...(extra.dependsOn ?? [])])],
      run: async (ctx) => run(await facts(ctx), ctx),
    };
    return check;
  };

  const os = platform("remote.os", "remote host runs Linux", true, (f) => {
    const value = f.values.get("os") ?? "";
    return { status: value === "Linux" ? "pass" : "fail", observed: value || "unknown", facts: { "remote.os": value } };
  });

  const arch = platform(
    "remote.arch",
    "remote architecture is x86_64 or aarch64",
    true,
    (f) => {
      const value = f.values.get("arch") ?? "";
      if (value === "x86_64" || value === "aarch64") return { status: "pass", observed: value, facts: { "remote.arch": value } };
      if (value === "armv7l" || value === "armv6l") return { status: "warn", observed: `${value} (32-bit ARM: limited app support)`, facts: { "remote.arch": value } };
      return { status: "fail", observed: `${value || "unknown"} is not supported` };
    },
    { remediation: { summary: "Use a 64-bit OS image on the remote host (x86_64 or aarch64)", manual: true }, dependsOn: ["remote.os"] },
  );

  const distro = platform(
    "remote.distro",
    "distribution and package manager detected",
    true,
    (f) => {
      const name = f.values.get("distro_name") || f.values.get("distro") || "";
      const pm = f.values.get("pm");
      if (!name) return { status: "fail", observed: "/etc/os-release not readable" };
      if (!pm) return { status: "warn", observed: `${name}; no known package manager (remediations list package names only)` };
      return { status: "pass", observed: `${name} (${pm})`, facts: { "remote.distro": `${f.values.get("distro") ?? ""} ${f.values.get("distro_version") ?? ""}`.trim() } };
    },
    { dependsOn: ["remote.os"] },
  );

  const pathCheck = platform(
    "remote.path",
    "non-interactive SSH PATH finds the login shell's tools",
    true,
    (f) => {
      const path = (f.values.get("path") ?? "").split(":").filter(Boolean);
      const login = (f.values.get("login_path") ?? "").split(":").filter(Boolean);
      if (login.length === 0) return { status: "pass", observed: `PATH ${path.join(":") || "(empty)"}; login shell PATH not readable, not compared` };
      const missing = login.filter((dir) => !path.includes(dir) && dir.startsWith("/"));
      if (missing.length === 0) return { status: "pass", observed: "same directories as a login shell" };
      const needed = ["Xvfb", "xdotool", "python3", "docker", "tar"].filter((t) => !f.tools.has(t));
      if (needed.length === 0) return { status: "pass", observed: `login shell adds ${missing.join(":")}; no needed tool is missing` };
      pathCheck.remediation = { summary: `Add ${missing.join(":")} to PATH for non-interactive SSH sessions (e.g. in ~/.ssh/environment with PermitUserEnvironment, or the shell rc read by non-interactive shells)`, manual: true };
      return { status: "fail", observed: `missing on the SSH PATH: ${needed.join(", ")}; a login shell also searches ${missing.join(":")}` };
    },
    { dependsOn: ["remote.os"] },
  );

  const pinned: Check = {
    id: "remote.hostkey-pinned",
    description: "host key fingerprint recorded",
    kind: "observe",
    required: true,
    dependsOn: ["ssh.auth"],
    async run(ctx) {
      const resolved = await probes.resolved(ctx, "ssh.auth");
      const name = resolved.hostKeyAlias ?? (resolved.port === "22" ? resolved.hostname : `[${resolved.hostname}]:${resolved.port}`);
      const lines: string[] = [];
      for (const file of resolved.knownHostsFiles) {
        const path = file.startsWith("~/") ? join(probes.home, file.slice(2)) : file;
        if (!(await exists(path))) continue;
        const result = await runner.run(["ssh-keygen", "-F", name, "-f", path], { timeoutMs: 5_000, signal: ctx.signal }).catch(() => undefined);
        if (result?.exitCode !== 0) continue;
        for (const line of result.stdout.split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (!line.startsWith("#") && parts.length >= 3) lines.push(`${parts[parts.length - 2]} ${parts[parts.length - 1]}`);
        }
      }
      if (lines.length === 0) return { status: "warn", observed: `${name} is verified by OpenSSH but has no plain known_hosts entry to pin (certificate or other source); OpenSSH still refuses a changed key` };
      const pin = createHash("sha256").update([...new Set(lines)].sort().join("\n")).digest("hex").slice(0, 32);
      return { status: "pass", observed: `${lines.length} key(s) for ${name} pinned; a changed key fails the connection`, facts: { "remote.hostkey": pin } };
    },
  };

  const sudo = platform(
    "remote.sudo",
    "passwordless sudo on the remote host",
    false,
    (f) => (f.values.get("sudo") === "1" ? { status: "pass", observed: "sudo -n works" } : { status: "fail", observed: "sudo needs a password or is not available" }),
    { degrades: "remote package installs are shown as commands for you to run", dependsOn: ["remote.os"] },
  );

  const mem = platform(
    "remote.mem",
    "at least 2 GB of memory",
    true,
    (f) => {
      const bytes = Number(f.values.get("mem_kb")) * 1024;
      if (!Number.isFinite(bytes) || bytes <= 0) return { status: "fail", observed: "MemTotal not readable" };
      const gb = `${(bytes / 1024 ** 3).toFixed(1)} GB`;
      if (bytes < REMOTE_MIN_MEM_BYTES) return { status: "fail", observed: `${gb} total` };
      return { status: bytes < REMOTE_WARN_MEM_BYTES ? "warn" : "pass", observed: `${gb} total${bytes < REMOTE_WARN_MEM_BYTES ? " (below 4 GB: large apps may be slow)" : ""}` };
    },
    { dependsOn: ["remote.os"] },
  );

  const cpu = platform(
    "remote.cpu",
    "at least 2 CPU cores",
    false,
    (f) => {
      const cpus = Number(f.values.get("cpus"));
      return { status: cpus >= 2 ? "pass" : "fail", observed: `${Number.isFinite(cpus) ? cpus : "?"} core(s)` };
    },
    { degrades: "slow builds and app starts", dependsOn: ["remote.os"] },
  );

  const limits = platform(
    "remote.limits",
    "open-file and process limits are not tiny",
    false,
    (f) => {
      const nofile = f.values.get("nofile") ?? "";
      const nproc = f.values.get("nproc") ?? "";
      const ok = (value: string, min: number) => value === "unlimited" || Number(value) >= min;
      return { status: ok(nofile, 1024) && (nproc === "" || ok(nproc, 256)) ? "pass" : "fail", observed: `ulimit -n ${nofile || "?"}, -u ${nproc || "?"}` };
    },
    { degrades: "Electron and Chromium apps may fail to start", dependsOn: ["remote.os"] },
  );

  const coreutils = platform(
    "remote.coreutils",
    "tar, sha256sum, mktemp, and stat on the remote host",
    true,
    (f) => {
      const missing = ["tar", "sha256sum", "mktemp", "stat"].filter((t) => !f.tools.has(t));
      if (missing.length === 0) return { status: "pass", observed: "all present" };
      probes.applyToolRemediation(coreutils, f, "coreutils", "file copy and verification");
      return { status: "fail", observed: `missing: ${missing.join(", ")}` };
    },
    { dependsOn: ["remote.os"] },
  );

  const sessionRoot: Check = {
    id: "remote.session-root",
    description: "a private session root can be created and removed",
    kind: "probe",
    required: true,
    dependsOn: ["remote.coreutils"],
    timeoutMs: 45_000,
    async run(ctx) {
      const root = await probes.sessionRoot(ctx, "remote.coreutils");
      if (!root.remote) return { status: "fail", observed: root.error ?? "no usable session root" };
      if (root.error) return { status: "fail", observed: root.error };
      return { status: "pass", observed: `${root.remote.base} (mode 0700, owned by uid ${root.remote.uid})` };
    },
  };

  const exec: Check = {
    id: "remote.exec",
    description: "programs can run from the session root (not noexec)",
    kind: "observe",
    required: true,
    dependsOn: ["remote.session-root", "remote.coreutils"],
    remediation: { summary: "Mount the session root without noexec, or make $XDG_RUNTIME_DIR or ~/.cache usable", manual: true },
    async run(ctx) {
      const root = await probes.sessionRoot(ctx, "remote.coreutils");
      return root.remote ? { status: "pass", observed: `a script ran from ${root.remote.base}` } : { status: "fail", observed: root.error ?? "no root allows execution" };
    },
  };

  const rsyncRemote = platform(
    "remote.rsync",
    "rsync on the remote host (incremental syncs)",
    false,
    (f) => {
      if (f.tools.has("rsync")) return { status: "pass", observed: f.tools.get("rsync")! };
      probes.applyToolRemediation(rsyncRemote, f, "rsync", "incremental syncs");
      return { status: "fail", observed: "rsync not found on the remote host; the tar stream is used" };
    },
    { degrades: "every sync is a full tar copy", dependsOn: ["remote.os", "local.rsync"] },
  );

  const roundtrip: Check = {
    id: "sync.roundtrip",
    description: "a test tree (symlink, unicode name, executable bit) syncs intact",
    kind: "probe",
    required: true,
    dependsOn: ["remote.session-root"],
    timeoutMs: 90_000,
    async run(ctx) {
      const tmpRoot = o.tmpRoot ?? tmpdir();
      const local = await mkdtemp(join(tmpRoot, PROBE_DIR_PREFIX));
      const staging = await mkdtemp(join(tmpRoot, PROBE_DIR_PREFIX));
      const transport = probes.oneShot();
      const name = `s-probe-${randomBytes(4).toString("hex")}`;
      try {
        const expected = new Map<string, string>();
        for (const [path, file] of Object.entries(ROUNDTRIP_FILES)) {
          await mkdir(join(local, path, ".."), { recursive: true });
          await writeFile(join(local, path), file.content);
          await chmod(join(local, path), file.mode);
          expected.set(path, createHash("sha256").update(file.content).digest("hex"));
        }
        await symlink(ROUNDTRIP_LINK.target, join(local, ROUNDTRIP_LINK.path));
        const set = await buildFileSet(local);
        const remote = await createRemoteSessionDir(transport.runner, { name, ownerLabel: o.ownerLabel(), sessionId: "probe", backend: o.backend, signal: ctx.signal });
        const sync = new WorkspaceSync({ transport, stagingRoot: staging, remoteDir: remote.workspace, localRunner: runner, ...(o.syncMethod ? { method: o.syncMethod } : {}) });
        const report = await sync.sync(set, ctx.signal);
        const files = [...expected.keys()];
        const verify = await transport.runner.run(
          ["/bin/sh", "-c", 'sha256sum -- "$@"; printf "link=%s\\n" "$(readlink link-to-hello)"; if [ -x bin/run.sh ]; then echo exec=1; else echo exec=0; fi', "sh", ...files],
          { cwd: remote.workspace, timeoutMs: 20_000, signal: ctx.signal },
        );
        if (verify.exitCode !== 0) return { status: "fail", observed: `verification on the remote host failed (${failureText(verify)})` };
        const problems: string[] = [];
        for (const [path, hash] of expected) if (!verify.stdout.includes(`${hash}  ${path}`)) problems.push(`${path} differs`);
        if (!verify.stdout.includes(`link=${ROUNDTRIP_LINK.target}`)) problems.push("symlink target differs");
        if (!verify.stdout.includes("exec=1")) problems.push("executable bit lost");
        if (problems.length > 0) return { status: "fail", observed: `${report.method}: ${problems.join(", ")}` };
        return { status: "pass", observed: `${report.files} entries via ${report.method}, checksums match`, facts: { "sync.method": report.method } };
      } finally {
        await removeRemoteSessions(transport.runner, [name], { destination: transport.destination, mode: "fast" }).catch(() => undefined);
        await rm(local, { recursive: true, force: true });
        await rm(staging, { recursive: true, force: true });
      }
    },
  };

  const exclusions: Check = {
    id: "sync.exclusions",
    description: "a dry run of the project's sync lists no secret files",
    kind: "observe",
    required: true,
    timeoutMs: 60_000,
    async run(ctx) {
      const set = await buildFileSet(ctx.projectRoot, { runner, signal: ctx.signal });
      const leaked = set.entries.filter((e) => secretMatch(e.path));
      if (leaked.length > 0) return { status: "fail", observed: `would sync secret-looking files: ${leaked.slice(0, 5).map((e) => e.path).join(", ")} (bug: please report)` };
      const secrets = set.excluded.filter((e) => e.reason === "secret").length;
      return { status: "pass", observed: `${set.entries.length} files would sync (${set.source}); ${set.excluded.length} excluded, ${secrets} of them by the secret patterns` };
    },
  };

  const checks = [...common, localSsh, localRsync, config, sshKey, hostKey, auth, jump, multiplex, cleanStdout, latency, os, arch, distro, pathCheck, pinned, sudo, mem, cpu, limits, coreutils, sessionRoot, exec, rsyncRemote, roundtrip, exclusions];
  if (options.minRemoteFreeBytes !== undefined) {
    const min = options.minRemoteFreeBytes;
    checks.push({
      id: "remote.disk",
      description: `at least ${(min / 1024 ** 3).toFixed(0)} GB free at the session root`,
      kind: "observe",
      required: true,
      dependsOn: ["remote.session-root", "remote.coreutils"],
      async run(ctx) {
        const root = await probes.sessionRoot(ctx, "remote.coreutils");
        const kb = root.remote?.freeKb;
        if (kb === undefined) return { status: "fail", observed: "free space at the session root not reported" };
        const bytes = kb * 1024;
        return { status: bytes >= min ? "pass" : "fail", observed: `${(bytes / 1024 ** 3).toFixed(1)} GB free at ${root.remote!.base}` };
      },
    });
  }
  return checks;
}
