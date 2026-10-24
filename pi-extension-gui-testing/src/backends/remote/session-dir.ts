/**
 * Remote session dirs (spec §7a.3): created fresh per session in the first
 * usable session root, removed on every exit path together with every
 * process that carries the dir's path in its command line or environment,
 * and audited read-only afterwards over a fresh connection.
 *
 * Session roots, in order: `$XDG_RUNTIME_DIR/pi-gui-testing` (tmpfs, wiped on
 * logout), `/tmp/pi-gui-testing-<uid>`, `~/.cache/pi-gui-testing-tmp`. A root
 * must be a real directory (not a symlink) owned by the SSH user, mode 0700,
 * on a file system that allows execution; paths with characters outside
 * `[A-Za-z0-9._/@+-]` are skipped. A session dir is `<root>/s-<id>-<rand>`
 * (mode 0700) holding `owner` (the client owner label, for remote sweeps),
 * `tooling/` (the helper), `workspace/` (the synced project), and `run/`
 * (helper runtime files). `<root>/displays` holds display locks shared by
 * concurrent sessions.
 *
 * All scripts are POSIX sh with their inputs as positional parameters.
 */
import { randomBytes } from "node:crypto";
import { ownerLiveness, readBootId, DEFAULT_PROC_ROOT } from "../../cleanup/identity.ts";
import { parseOwnerLabel, type OwnerLiveness } from "../../owner.ts";
import type { Leftover } from "../../protocol.ts";
import type { CommandRunner, RunResult } from "../../runner/types.ts";
import { assertSafeRemotePath, shScript } from "../../transport/ssh/quote.ts";

/** Prefix of every remote session dir name. */
export const REMOTE_SESSION_PREFIX = "s-";
/** A foreign client's session dir with no process left is swept after this age (seconds). */
export const FOREIGN_ORPHAN_AGE_S = 24 * 3600;

const NAME = /^s-[A-Za-z0-9._-]{1,80}$/;

/** A new session dir name for `sessionId` (random suffix, so names never repeat). */
export function remoteSessionName(sessionId: string): string {
  const clean = sessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "session";
  return `${REMOTE_SESSION_PREFIX}${clean}-${randomBytes(4).toString("hex")}`;
}

/** @throws Error for a name this module did not make. */
export function assertSessionName(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid remote session name ${JSON.stringify(name)}`);
  return name;
}

/** Shell loop over the candidate roots, filtered to safe absolute paths; the body sees `$b`. */
function forEachRoot(body: string): string {
  return [
    'for b in ${XDG_RUNTIME_DIR:+"$XDG_RUNTIME_DIR/pi-gui-testing"} "/tmp/pi-gui-testing-$(id -u)" ${HOME:+"$HOME/.cache/pi-gui-testing-tmp"}; do',
    "case $b in /*) ;; *) continue ;; esac;",
    "case $b in *[!A-Za-z0-9._/@+-]*|*/../*|*/..) continue ;; esac;",
    body,
    "done;",
  ].join(" ");
}

/**
 * `snapshot` records this user's processes once as `<pid> <cmdline and
 * environment>` lines (NULs and newlines as spaces, so `grep -F` also works
 * with BusyBox); `tagged` prints the PIDs whose line contains `$1`. The
 * script's own argv never contains a full session path (it is built at run
 * time), and its own PID is skipped, so it never matches itself.
 */
const TAGGED_FN = [
  'snapshot() { snap=$(for f in /proc/[0-9]*; do p=${f#/proc/}; [ "$p" = "$$" ] && continue; [ -O "$f" ] || continue; printf "%s " "$p"; cat "$f/cmdline" "$f/environ" 2>/dev/null | tr "\\000\\n" "  "; echo; done); };',
  'tagged() { [ -n "$1" ] || return 0; printf "%s\\n" "$snap" | grep -F -e "$1" | cut -d " " -f 1; };',
].join(" ");

const CMDLINE_FN = 'cmdline() { tr "\\000" " " < "/proc/$1/cmdline" 2>/dev/null | cut -c1-200; };';

/** Creates the session dir; prints `key=value` lines. `$1` name, `$2` owner label, `$3` session id, `$4` backend, `$5` created-at. */
export const CREATE_SCRIPT = [
  'name=$1; case $name in s-*) ;; *) echo "error=bad name"; exit 2 ;; esac;',
  forEachRoot(
    [
      'parent=${b%/*}; [ -d "$parent" ] || mkdir -p -m 0700 -- "$parent" 2>/dev/null || continue;',
      'mkdir -m 0700 -- "$b" 2>/dev/null;',
      '{ [ -d "$b" ] && [ ! -L "$b" ] && [ -O "$b" ]; } || { echo "skipped=$b (not a directory of yours)"; continue; };',
      'chmod 0700 -- "$b" 2>/dev/null || continue;',
      'probe="$b/.exec-probe-$$"; printf "#!/bin/sh\\nexit 0\\n" > "$probe" 2>/dev/null && chmod 0700 -- "$probe" && "$probe" 2>/dev/null; ok=$?; rm -f -- "$probe";',
      '[ "$ok" = 0 ] || { echo "noexec=$b"; continue; };',
      'mkdir -m 0700 -- "$b/displays" 2>/dev/null;',
      'd="$b/$name"; mkdir -m 0700 -- "$d" || { echo "error=cannot create $d"; exit 3; };',
      'mkdir -m 0700 -- "$d/run" "$d/workspace" "$d/tooling" || { echo "error=cannot populate $d"; exit 3; };',
      'printf "owner=%s\\nsession=%s\\nbackend=%s\\ncreated=%s\\n" "$2" "$3" "$4" "$5" > "$d/owner" || { echo "error=cannot write $d/owner"; exit 3; };',
      'rb=$(cd -P -- "$b" && pwd) || exit 3; rd=$(cd -P -- "$d" && pwd) || exit 3;',
      'echo "base=$rb"; echo "dir=$rd"; echo "uid=$(id -u)"; echo "gid=$(id -g)";',
      'echo "workspace_id=$(stat -c "%d %i" -- "$d/workspace")";',
      'df -Pk -- "$d" 2>/dev/null | awk "NR==2 {print \\"free_kb=\\" \\$4}";',
      "exit 0;",
    ].join(" "),
  ),
  'echo "error=no usable session root (tried \\$XDG_RUNTIME_DIR/pi-gui-testing, /tmp/pi-gui-testing-$(id -u), ~/.cache/pi-gui-testing-tmp)"; exit 4',
].join(" ");

/**
 * Removes session dirs `$2…` from every root: kills their tagged processes
 * (`$1` = `graceful`: TERM, up to 3 s, then KILL; `fast`: KILL), removes the
 * dir, and removes `displays/` and the root when no session is left. Prints
 * `left=<kind> <id> <detail>` for anything that remains.
 */
export const REMOVE_SCRIPT = [
  TAGGED_FN,
  CMDLINE_FN,
  'mode=$1; shift;',
  'for name in "$@"; do case $name in s-*) ;; *) continue ;; esac;',
  forEachRoot(
    [
      '{ [ -d "$b" ] && [ ! -L "$b" ] && [ -O "$b" ]; } || continue;',
      'd="$b/$name"; { [ -e "$d" ] || [ -L "$d" ]; } || continue;',
      'tag=$(cd -P -- "$d" 2>/dev/null && pwd) || tag=$d;',
      'snapshot; pids=$(tagged "$tag"); [ "$tag" = "$d" ] || pids="$pids $(tagged "$d")";',
      'if [ -n "$(echo $pids)" ]; then',
      'if [ "$mode" = graceful ]; then kill -TERM $pids 2>/dev/null; i=0; while [ $i -lt 3 ]; do sleep 1; snapshot; pids=$(tagged "$tag"); [ -z "$pids" ] && break; i=$((i+1)); done; fi;',
      '[ -n "$(echo $pids)" ] && { kill -KILL $pids 2>/dev/null; sleep 1; };',
      "fi;",
      'rm -rf -- "$d" 2>/dev/null;',
      'if [ -e "$d" ] || [ -L "$d" ]; then echo "left=remote-dir $d could not be removed"; fi;',
      'snapshot; for p in $(tagged "$tag"); do echo "left=remote-process $p $(cmdline "$p")"; done;',
      'set -- "$b"/s-*; if [ ! -e "$1" ]; then rmdir -- "$b/displays" 2>/dev/null; rmdir -- "$b" 2>/dev/null; fi;',
    ].join(" "),
  ),
  "done; exit 0",
].join(" ");

/** Read-only audit of session dir `$1`: prints `dir=<path>` and `process=<pid> <cmdline>` lines. */
export const AUDIT_SCRIPT = [
  TAGGED_FN,
  CMDLINE_FN,
  'name=$1; case $name in s-*) ;; *) exit 2 ;; esac; snapshot;',
  forEachRoot(
    [
      '{ [ -d "$b" ] && [ ! -L "$b" ] && [ -O "$b" ]; } || continue;',
      'd="$b/$name"; if [ -e "$d" ] || [ -L "$d" ]; then echo "dir=$d"; fi;',
      'tag=$(cd -P -- "$d" 2>/dev/null && pwd) || tag=$d;',
      'for p in $(tagged "$tag"); do echo "process=$p $(cmdline "$p")"; done;',
    ].join(" "),
  ),
  "exit 0",
].join(" ");

/** Read-only scan of every session dir: `entry<TAB>name<TAB>path<TAB>owner<TAB>live<TAB>age`. */
export const LIST_SCRIPT = [
  TAGGED_FN,
  'now=$(date +%s); snapshot;',
  forEachRoot(
    [
      '{ [ -d "$b" ] && [ ! -L "$b" ] && [ -O "$b" ]; } || continue;',
      'for d in "$b"/s-*; do { [ -d "$d" ] && [ ! -L "$d" ]; } || continue;',
      'owner=$(sed -n "s/^owner=//p" "$d/owner" 2>/dev/null | head -n 1 | tr -d "\\t\\r");',
      'tag=$(cd -P -- "$d" 2>/dev/null && pwd) || tag=$d;',
      'if [ -n "$(tagged "$tag")" ]; then live=1; else live=0; fi;',
      'mt=$(stat -c %Y -- "$d" 2>/dev/null || echo "$now");',
      'printf "entry\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "${d##*/}" "$d" "$owner" "$live" "$((now - mt))";',
      "done;",
    ].join(" "),
  ),
  "exit 0",
].join(" ");

/** What {@link createRemoteSessionDir} made. */
export interface RemoteSessionDir {
  name: string;
  /** Resolved session root. */
  base: string;
  /** Resolved session dir. */
  dir: string;
  workspace: string;
  tooling: string;
  run: string;
  displays: string;
  uid: number;
  gid: number;
  /** `<dev> <ino>` of the workspace dir. */
  workspaceId: string;
  /** Free space at the session dir (KiB), when `df` reported it. */
  freeKb?: number;
}

function keyValues(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && !map.has(line.slice(0, eq))) map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return map;
}

/** One-line description of a failed remote call. */
export function remoteFailure(result: RunResult): string {
  if (result.timedOut) return `timed out after ${result.durationMs} ms`;
  const tail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-2).join(" ").slice(-300);
  return `${result.exitCode === null ? `killed by ${result.signal}` : `exit ${result.exitCode}`}${tail ? `: ${tail}` : ""}`;
}

export interface CreateRemoteDirOptions {
  name: string;
  ownerLabel: string;
  sessionId: string;
  backend: string;
  signal?: AbortSignal;
  now?: () => Date;
}

/**
 * Creates the session dir on the remote host.
 *
 * @throws Error naming the reason (no usable root, unsafe paths, connection failure).
 */
export async function createRemoteSessionDir(runner: CommandRunner, options: CreateRemoteDirOptions): Promise<RemoteSessionDir> {
  assertSessionName(options.name);
  if (!/^[A-Za-z0-9:._-]*$/.test(options.ownerLabel)) throw new Error("invalid owner label");
  const created = (options.now?.() ?? new Date()).toISOString();
  const result = await runner.run(["/bin/sh", "-c", CREATE_SCRIPT, "sh", options.name, options.ownerLabel, options.sessionId.replace(/[^A-Za-z0-9._-]/g, ""), options.backend, created], {
    timeoutMs: 30_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const values = keyValues(result.stdout);
  if (result.exitCode !== 0 || !values.has("dir")) {
    throw new Error(`cannot create the remote session dir: ${values.get("error") ?? remoteFailure(result)}${values.has("noexec") ? ` (no exec on ${values.get("noexec")})` : ""}`);
  }
  const base = assertSafeRemotePath(values.get("base")!);
  const dir = assertSafeRemotePath(values.get("dir")!);
  if (dir !== `${base}/${options.name}`) throw new Error(`remote session dir ${dir} is not inside its root ${base}`);
  const uid = Number(values.get("uid"));
  const gid = Number(values.get("gid"));
  const workspaceId = values.get("workspace_id") ?? "";
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw new Error("the remote host did not report the SSH user's uid/gid");
  if (!/^\d+ \d+$/.test(workspaceId)) throw new Error(`the remote host reported no workspace identity (${JSON.stringify(workspaceId)})`);
  const freeKb = Number(values.get("free_kb"));
  return {
    name: options.name,
    base,
    dir,
    workspace: `${dir}/workspace`,
    tooling: `${dir}/tooling`,
    run: `${dir}/run`,
    displays: `${base}/displays`,
    uid,
    gid,
    workspaceId,
    ...(Number.isFinite(freeKb) && values.has("free_kb") ? { freeKb } : {}),
  };
}

/** Argv (for any runner) removing session dirs `names`. */
export function removeArgv(names: readonly string[], mode: "graceful" | "fast" = "graceful"): string[] {
  for (const name of names) assertSessionName(name);
  return ["/bin/sh", "-c", REMOVE_SCRIPT, "sh", mode, ...names];
}

/** The remote command line removing `names` (for exit cleanup argv). */
export function removeCommand(names: readonly string[], mode: "graceful" | "fast" = "fast"): string {
  return shScript(REMOVE_SCRIPT, [mode, ...names.map(assertSessionName)]);
}

function leftoverLines(stdout: string, prefix: string): Leftover[] {
  const out: Leftover[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    const [kind, id, ...detail] = rest.split(" ");
    if (kind && id) out.push({ kind, id, ...(detail.length ? { detail: detail.join(" ").slice(0, 300) } : {}) });
  }
  return out;
}

/**
 * Removes session dirs and their processes. Returns what is left; a failed
 * connection leaves one entry per dir.
 */
export async function removeRemoteSessions(runner: CommandRunner, names: readonly string[], options: { destination: string; signal?: AbortSignal; mode?: "graceful" | "fast" } ): Promise<Leftover[]> {
  if (names.length === 0) return [];
  let result: RunResult;
  try {
    result = await runner.run(removeArgv(names, options.mode ?? "graceful"), { timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    return names.map((name) => ({ kind: "remote-dir", id: `${options.destination}:${name}`, detail: `removal failed: ${(error as Error).message}` }));
  }
  if (result.exitCode !== 0) return names.map((name) => ({ kind: "remote-dir", id: `${options.destination}:${name}`, detail: `removal failed (${remoteFailure(result)})` }));
  return leftoverLines(result.stdout, "left=").map((l) => ({ ...l, id: `${options.destination}:${l.id}` }));
}

/** Read-only audit of one session dir: the dir and its tagged processes. A failed call is one leftover. */
export async function auditRemoteSession(runner: CommandRunner, name: string, options: { destination: string; signal?: AbortSignal }): Promise<Leftover[]> {
  let result: RunResult;
  try {
    result = await runner.run(["/bin/sh", "-c", AUDIT_SCRIPT, "sh", assertSessionName(name)], { timeoutMs: 30_000, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    return [{ kind: "audit", id: `${options.destination}:${name}`, detail: `remote audit failed: ${(error as Error).message}` }];
  }
  if (result.exitCode !== 0) return [{ kind: "audit", id: `${options.destination}:${name}`, detail: `remote audit failed (${remoteFailure(result)})` }];
  const leftovers: Leftover[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("dir=")) leftovers.push({ kind: "remote-dir", id: `${options.destination}:${line.slice(4)}` });
    else if (line.startsWith("process=")) {
      const [pid, ...cmd] = line.slice(8).split(" ");
      leftovers.push({ kind: "remote-process", id: `${options.destination}:${pid}`, detail: cmd.join(" ").slice(0, 200) || `session ${name}` });
    }
  }
  return leftovers;
}

export interface RemoteSessionEntry {
  name: string;
  path: string;
  owner: string;
  /** A process still carries the dir's path. */
  live: boolean;
  ageSeconds: number;
}

/** Lists every remote session dir (read-only). @throws Error when the call fails. */
export async function listRemoteSessions(runner: CommandRunner, signal?: AbortSignal): Promise<RemoteSessionEntry[]> {
  const result = await runner.run(["/bin/sh", "-c", LIST_SCRIPT, "sh"], { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) throw new Error(`listing remote session dirs failed (${remoteFailure(result)})`);
  const entries: RemoteSessionEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    const [tag, name, path, owner, live, age] = line.split("\t");
    if (tag !== "entry" || !name || !NAME.test(name)) continue;
    entries.push({ name, path: path ?? "", owner: owner ?? "", live: live === "1", ageSeconds: Number(age) || 0 });
  }
  return entries;
}

export type RemoteOwnerState = OwnerLiveness | "foreign";

/**
 * Who owns a remote session dir, judged on this client: an owner label from
 * this boot is judged by PID and start time; a label from another boot or
 * another client machine is `foreign`; a missing label is `unknown`.
 */
export function remoteOwnerState(owner: string, procRoot: string = DEFAULT_PROC_ROOT): RemoteOwnerState {
  const label = parseOwnerLabel(owner);
  if (!label) return "unknown";
  const boot = readBootId(procRoot);
  if (!boot) return "unknown";
  if (label.bootId !== boot) return "foreign";
  return ownerLiveness(label, procRoot);
}

export interface OrphanDecision {
  entry: RemoteSessionEntry;
  /** `remove`: orphan, swept; `report`: reported, never removed automatically; `keep`: live, exempt. */
  action: "remove" | "report" | "keep";
  reason: string;
}

/**
 * Decides per entry (spec §7a.3, §7a.4): dirs of dead owners of this client
 * are orphans; a foreign owner's dir is an orphan only when no process
 * carries its path and it is older than {@link FOREIGN_ORPHAN_AGE_S}; live
 * owners are exempt; unknown owners are reported only.
 */
export function decideOrphans(entries: readonly RemoteSessionEntry[], procRoot: string = DEFAULT_PROC_ROOT): OrphanDecision[] {
  return entries.map((entry) => {
    const state = remoteOwnerState(entry.owner, procRoot);
    if (state === "alive") return { entry, action: "keep", reason: "owner alive" };
    if (state === "dead") return { entry, action: "remove", reason: "owner gone" };
    if (state === "foreign") {
      if (entry.live) return { entry, action: "keep", reason: "owned by another client; its processes still run" };
      if (entry.ageSeconds > FOREIGN_ORPHAN_AGE_S) return { entry, action: "remove", reason: `owned by another client, no process left, ${Math.floor(entry.ageSeconds / 3600)} h old` };
      return { entry, action: "report", reason: "owned by another client or an earlier boot; not removed automatically before it is a day old" };
    }
    return { entry, action: "report", reason: entry.owner ? `owner label "${entry.owner.slice(0, 80)}" cannot be judged; not removed automatically` : "no owner record; not removed automatically" };
  });
}

/** Read-only orphan audit of the remote session dirs. */
export async function auditRemoteOrphans(runner: CommandRunner, options: { destination: string; signal?: AbortSignal; procRoot?: string }): Promise<Leftover[]> {
  const decisions = decideOrphans(await listRemoteSessions(runner, options.signal), options.procRoot);
  return decisions
    .filter((d) => d.action !== "keep")
    .map((d) => ({ kind: "remote-dir", id: `${options.destination}:${d.entry.path}`, detail: d.reason }));
}

/** Removes orphaned remote session dirs; reports the ones that are not judged dead and what could not be removed. */
export async function sweepRemoteOrphans(runner: CommandRunner, options: { destination: string; signal?: AbortSignal; procRoot?: string }): Promise<Leftover[]> {
  const decisions = decideOrphans(await listRemoteSessions(runner, options.signal), options.procRoot);
  const leftovers: Leftover[] = decisions
    .filter((d) => d.action === "report")
    .map((d) => ({ kind: "remote-dir", id: `${options.destination}:${d.entry.path}`, detail: d.reason }));
  const doomed = decisions.filter((d) => d.action === "remove").map((d) => d.entry.name);
  leftovers.push(...(await removeRemoteSessions(runner, doomed, { destination: options.destination, ...(options.signal ? { signal: options.signal } : {}) })));
  return leftovers;
}
