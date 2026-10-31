/**
 * Host picker for the remote backends (spec §4.2a "Host selection"): the
 * aliases of the user's `~/.ssh/config` (following `Include`), each resolved
 * with `ssh -G` and probed in parallel, shown in one `select()`, plus an
 * "Other host…" entry. Only the chosen alias is returned (and stored by the
 * caller), never resolved values, so later edits to `~/.ssh/config` apply.
 *
 * The package only reads `~/.ssh/config`; it never writes it and never sends
 * its contents anywhere.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createSpawnRunner } from "../runner/spawn.ts";
import type { CommandRunner } from "../runner/types.ts";
import { nameMatcher } from "../sync/patterns.ts";
import { classifySshFailure, type SshFailure } from "../transport/ssh/errors.ts";
import { assertDestination } from "../transport/ssh/quote.ts";
import { oneShotTransport } from "../transport/ssh/transport.ts";
import type { SetupUi } from "./ui.ts";

/** OpenSSH's own bound on `Include` nesting. */
const MAX_INCLUDE_DEPTH = 16;
/** Probe bounds (spec §4.2a). */
export const PROBE_CONCURRENCY = 8;
export const PROBE_TOTAL_MS = 5_000;
export const PROBE_CONNECT_TIMEOUT_S = 3;

export const OTHER_HOST = "Other host…";

export interface SshConfigFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

const realFs: SshConfigFs = {
  readFile: (path) => readFile(path, "utf8"),
  readdir: (path) => readdir(path),
};

export interface ConfigAliases {
  /** Concrete aliases in file order, without duplicates. */
  aliases: string[];
  /** Files read (the config and every included file). */
  files: string[];
  /** Files that could not be read or nesting that went too deep (never fatal). */
  problems: string[];
}

/**
 * Splits a config line into keyword and arguments (ssh_config(5)): words
 * separated by whitespace, an optional `=` after the keyword, double-quoted
 * arguments.
 */
export function tokenizeConfigLine(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return [];
  const keyword = /^([^\s=]+)\s*(?:=\s*|\s+|$)/.exec(trimmed);
  if (!keyword) return [];
  const tokens = [keyword[1]];
  const rest = trimmed.slice(keyword[0].length);
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (i >= rest.length) break;
    let token = "";
    if (rest[i] === '"') {
      const close = rest.indexOf('"', i + 1);
      token = close === -1 ? rest.slice(i + 1) : rest.slice(i + 1, close);
      i = close === -1 ? rest.length : close + 1;
    } else {
      while (i < rest.length && !/\s/.test(rest[i])) token += rest[i++];
    }
    if (token.startsWith("#")) break;
    tokens.push(token);
  }
  return tokens;
}

/** `true` for a `Host` pattern that names one concrete host (no `*`, `?`, or `!`). */
export function isConcreteAlias(pattern: string): boolean {
  return pattern.length > 0 && !/[*?!]/.test(pattern);
}

const GLOB = /[*?[]/;

/** Expands an absolute glob path like glob(3): sorted, hidden names only for patterns starting with `.`. */
export async function expandGlob(pattern: string, fs: SshConfigFs = realFs): Promise<string[]> {
  if (!GLOB.test(pattern)) return [pattern];
  const parts = pattern.split("/").filter((p, i) => p !== "" || i === 0);
  let current = [parts[0] === "" ? "/" : parts[0]];
  for (const part of parts.slice(1)) {
    const next: string[] = [];
    for (const base of current) {
      if (!GLOB.test(part)) {
        next.push(join(base, part));
        continue;
      }
      let names: string[];
      try {
        names = await fs.readdir(base);
      } catch {
        continue;
      }
      const re = nameMatcher(part);
      for (const name of names.sort()) {
        if (name.startsWith(".") && !part.startsWith(".")) continue;
        if (re.test(name)) next.push(join(base, name));
      }
    }
    current = next;
  }
  return current;
}

export interface ListAliasesOptions {
  /** Home directory; default `os.homedir()`. */
  home?: string;
  /** Config file; default `~/.ssh/config`. */
  configPath?: string;
  fs?: SshConfigFs;
}

/**
 * Collects every concrete alias from `Host` lines of the user's SSH config,
 * following `Include` (relative paths resolve against `~/.ssh`, `~` expands,
 * globs expand). A missing config yields no aliases.
 */
export async function listConfigAliases(options: ListAliasesOptions = {}): Promise<ConfigAliases> {
  const home = options.home ?? homedir();
  const sshDir = join(home, ".ssh");
  const fs = options.fs ?? realFs;
  const result: ConfigAliases = { aliases: [], files: [], problems: [] };
  const seen = new Set<string>();
  const visit = async (path: string, depth: number, required: boolean): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH) {
      result.problems.push(`${path}: Include nested deeper than ${MAX_INCLUDE_DEPTH}`);
      return;
    }
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (error) {
      if (required || (error as NodeJS.ErrnoException).code !== "ENOENT") result.problems.push(`${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
      return;
    }
    result.files.push(path);
    for (const line of text.split(/\r?\n/)) {
      const [keyword, ...args] = tokenizeConfigLine(line);
      if (!keyword) continue;
      const key = keyword.toLowerCase();
      if (key === "host") {
        for (const pattern of args) {
          if (!isConcreteAlias(pattern) || seen.has(pattern)) continue;
          seen.add(pattern);
          result.aliases.push(pattern);
        }
      } else if (key === "include") {
        for (const arg of args) {
          const expanded = arg.startsWith("~/") ? join(home, arg.slice(2)) : arg === "~" ? home : arg;
          const absolute = isAbsolute(expanded) ? expanded : join(sshDir, expanded);
          for (const file of await expandGlob(absolute, fs)) await visit(file, depth + 1, false);
        }
      }
    }
  };
  await visit(options.configPath ?? join(sshDir, "config"), 0, false);
  return result;
}

/** What `ssh -G <alias>` resolves (the fields the picker and checks show). */
export interface ResolvedHost {
  user: string;
  hostname: string;
  port: string;
  proxyJump?: string;
  identityFiles: string[];
  hostKeyAlias?: string;
  knownHostsFiles: string[];
}

/** Parses `ssh -G` output (`keyword value` lines, keywords in lower case). */
export function parseSshG(output: string): ResolvedHost {
  const values = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    values.set(key, [...(values.get(key) ?? []), match[2]]);
  }
  const one = (key: string) => values.get(key)?.[0];
  const proxyJump = one("proxyjump");
  const hostKeyAlias = one("hostkeyalias");
  const knownHosts = [...(values.get("userknownhostsfile") ?? []), ...(values.get("globalknownhostsfile") ?? [])].flatMap((v) => v.split(/\s+/)).filter(Boolean);
  return {
    user: one("user") ?? "",
    hostname: one("hostname") ?? "",
    port: one("port") ?? "22",
    ...(proxyJump && proxyJump !== "none" ? { proxyJump } : {}),
    identityFiles: values.get("identityfile") ?? [],
    ...(hostKeyAlias && hostKeyAlias !== "none" ? { hostKeyAlias } : {}),
    knownHostsFiles: knownHosts,
  };
}

/**
 * Resolves `destination` with `ssh -G` (no connection; `Match`, `Include`, and
 * wildcard defaults apply as OpenSSH applies them).
 *
 * @throws Error when `ssh -G` fails.
 */
export async function resolveHost(destination: string, runner: CommandRunner = createSpawnRunner(), signal?: AbortSignal, ssh = "ssh"): Promise<ResolvedHost> {
  assertDestination(destination);
  const result = await runner.run([ssh, "-G", "--", destination], { timeoutMs: 5_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) throw new Error(`ssh -G ${destination} failed: ${result.stderr.trim().split("\n").at(-1) ?? `exit ${result.exitCode}`}`);
  return parseSshG(result.stdout);
}

export type ProbeStatus = "ready" | "auth needed" | "host key unknown" | "host key changed" | "unreachable" | "not Linux";

export interface ProbeResult {
  status: ProbeStatus;
  /** e.g. `ready (Linux aarch64)`. */
  label: string;
  arch?: string;
}

/** Maps a probe's outcome to its label. */
export function probeLabel(result: { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }): ProbeResult {
  if (result.exitCode === 0) {
    const [os, arch] = result.stdout.trim().split(/\s+/);
    if (os === "Linux") return { status: "ready", label: `ready (Linux ${arch ?? "?"})`, ...(arch ? { arch } : {}) };
    return { status: "not Linux", label: `not Linux (${result.stdout.trim().slice(0, 40) || "unknown"})` };
  }
  if (result.timedOut || result.exitCode === null) return { status: "unreachable", label: "unreachable" };
  const failure: SshFailure = classifySshFailure(result.stderr);
  if (failure === "auth") return { status: "auth needed", label: "auth needed" };
  if (failure === "hostkey-unknown") return { status: "host key unknown", label: "host key unknown" };
  if (failure === "hostkey-changed") return { status: "host key changed", label: "host key changed" };
  if (result.exitCode === 255) return { status: "unreachable", label: "unreachable" };
  return { status: "not Linux", label: "not Linux (uname failed)" };
}

export interface HostCandidate {
  alias: string;
  resolved?: ResolvedHost;
  resolveError?: string;
  probe?: ProbeResult;
}

/** One picker line: `alias — user@hostname:port via <jump> — <status>`. */
export function candidateLabel(candidate: HostCandidate): string {
  const parts = [candidate.alias];
  const r = candidate.resolved;
  if (r) parts.push(`${r.user ? `${r.user}@` : ""}${r.hostname}:${r.port}${r.proxyJump ? ` via ${r.proxyJump}` : ""}`);
  else if (candidate.resolveError) parts.push("does not resolve");
  if (candidate.probe) parts.push(candidate.probe.label);
  return parts.join(" — ");
}

/** Runs `tasks` with at most `limit` at a time. */
async function bounded<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface DiscoverOptions extends ListAliasesOptions {
  /** Local runner for `ssh`; default the spawn runner. */
  runner?: CommandRunner;
  ssh?: string;
  /** `false` skips the connection probe. */
  probe?: boolean;
  totalMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

/**
 * Lists, resolves, and probes the config's aliases. Resolution and probes run
 * at most {@link PROBE_CONCURRENCY} at a time and all within {@link PROBE_TOTAL_MS};
 * a probe still running then is `unreachable`.
 */
export async function discoverHosts(options: DiscoverOptions = {}): Promise<{ candidates: HostCandidate[]; problems: string[] }> {
  const listed = await listConfigAliases(options);
  const runner = options.runner ?? createSpawnRunner();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("probe time is up")), options.totalMs ?? PROBE_TOTAL_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const started = Date.now();
  const total = options.totalMs ?? PROBE_TOTAL_MS;
  const candidates: HostCandidate[] = listed.aliases.map((alias) => ({ alias }));
  try {
    await bounded(candidates, options.concurrency ?? PROBE_CONCURRENCY, async (candidate) => {
      const remaining = () => Math.max(1, total - (Date.now() - started));
      try {
        candidate.resolved = await resolveHost(candidate.alias, runner, signal, options.ssh);
      } catch (error) {
        candidate.resolveError = (error as Error).message;
        if (signal.aborted) candidate.probe = { status: "unreachable", label: "unreachable" };
        return;
      }
      if (options.probe === false) return;
      if (signal.aborted) {
        candidate.probe = { status: "unreachable", label: "unreachable" };
        return;
      }
      const transport = oneShotTransport(candidate.alias, { runner, connectTimeoutS: PROBE_CONNECT_TIMEOUT_S, ...(options.ssh ? { ssh: options.ssh } : {}) });
      try {
        const result = await transport.runner.run(["uname", "-sm"], { timeoutMs: remaining(), signal });
        candidate.probe = probeLabel(result);
      } catch {
        candidate.probe = { status: "unreachable", label: "unreachable" };
      }
    });
  } finally {
    clearTimeout(timer);
  }
  return { candidates, problems: listed.problems };
}

/** What the user typed for "Other host…", as a destination OpenSSH accepts. */
export interface OtherHost {
  /** `user@host`, `host`, or `ssh://user@host:port`. */
  destination: string;
  user?: string;
  host: string;
  port?: number;
}

/**
 * Parses `user@host[:port]` (IPv6 in brackets: `user@[::1]:2222`).
 *
 * @throws Error with a user-facing message for anything else.
 */
export function parseOtherHost(text: string): OtherHost {
  const value = text.trim();
  const match = /^(?:([A-Za-z0-9._-]+)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match) throw new Error(`"${value}" is not user@host[:port]`);
  const [, user, rawHost, rawPort] = match;
  const host = rawHost.startsWith("[") ? rawHost.slice(1, -1) : rawHost;
  const port = rawPort ? Number(rawPort) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error(`port ${rawPort} is out of range`);
  const destination = port !== undefined && port !== 22 ? `ssh://${user ? `${user}@` : ""}${rawHost}:${port}` : `${user ? `${user}@` : ""}${host}`;
  assertDestination(destination);
  return { destination, host, ...(user ? { user } : {}), ...(port !== undefined ? { port } : {}) };
}

/** A `Host` block for `~/.ssh/config` that the user may add for an "Other host…" entry (shown, never written). */
export function hostBlockTemplate(other: OtherHost): string {
  const alias = /^[A-Za-z0-9-]+/.exec(other.host)?.[0] ?? "my-host";
  const lines = [`Host ${alias}`, `    HostName ${other.host}`];
  if (other.user) lines.push(`    User ${other.user}`);
  if (other.port !== undefined && other.port !== 22) lines.push(`    Port ${other.port}`);
  lines.push("    # optional: IdentityFile ~/.ssh/id_ed25519");
  return lines.join("\n");
}

export interface HostChoice {
  /** The alias or destination to store in `remote.host`. */
  host: string;
  /** For "Other host…": a `Host` block template to show the user. */
  template?: string;
  candidate?: HostCandidate;
}

export interface PickHostOptions extends DiscoverOptions {
  /** Backend id for the flag hint, e.g. `remote-linux`. */
  backend: string;
}

/**
 * The `/gui-setup` host picker. Without a UI it throws (via `ui.select`) a
 * `MissingInputError` naming `--host`.
 *
 * @returns The choice, or `undefined` when the user cancelled.
 */
export async function pickHost(ui: SetupUi, options: PickHostOptions): Promise<HostChoice | undefined> {
  const flags = [`/gui-setup ${options.backend} --host <ssh-alias-or-user@host>`];
  if (!ui.hasUI) {
    // Same error the dialog would raise, without probing anything first.
    await ui.select("Choose the SSH host", [], { flags });
    return undefined;
  }
  ui.setStatus("reading ~/.ssh/config and probing its hosts");
  let found: Awaited<ReturnType<typeof discoverHosts>>;
  try {
    found = await discoverHosts(options);
  } finally {
    ui.setStatus(undefined);
  }
  const labels = [...found.candidates.map(candidateLabel), OTHER_HOST];
  const title = found.candidates.length > 0 ? "Choose the SSH host (from ~/.ssh/config)" : "No hosts found in ~/.ssh/config; enter one";
  const choice = await ui.select(title, labels, { flags });
  if (choice === undefined) return undefined;
  const index = labels.indexOf(choice);
  if (index === -1) return undefined;
  if (index < found.candidates.length) {
    const candidate = found.candidates[index];
    return { host: candidate.alias, candidate };
  }
  const typed = await ui.input("SSH host (user@host[:port])", "user@host", { flags });
  if (typed === undefined || typed.trim() === "") return undefined;
  const other = parseOtherHost(typed);
  return { host: other.destination, template: hostBlockTemplate(other) };
}
