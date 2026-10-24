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
 * concurrent sessions. The session's long-lived process runs under
 * {@link SESSION_WRAPPER_SCRIPT}, which removes the dir on the remote host
 * whenever that process ends, also after a dropped connection.
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
 * Process selection shared by the scripts. `snapshot` records this user's
 * processes once as ` <pid>:<starttime> <cmdline and environment words> `
 * lines (NULs and newlines as spaces, so `grep -F` also works with BusyBox;
 * `<starttime>` is `/proc/<pid>/stat` field 22). `tagged` prints the
 * `<pid>:<starttime>` of the processes with a word that is the session path
 * `$1` or below it (`$1`, `$1/…`, `X=$1`, `X=$1/…`; never a mere substring, so
 * `s-a-1` does not select `s-a-12`). `withtag` prints those whose environment
 * holds exactly `PI_GUI_TAG=$1` (the helper's session tag). `same` keeps the
 * PIDs whose start time is still the recorded one, so a reused PID is never
 * signalled. The scripts' own argv never contains a full session path (it is
 * built at run time), and their own PID is skipped, so they never match
 * themselves.
 */
const TAGGED_FN = [
  'st_of() { l=; { read -r l < "/proc/$1/stat"; } 2>/dev/null; set -- ${l##*) }; [ $# -ge 20 ] && shift 19 && printf "%s" "$1"; };',
  'snapshot() { snap=$(for f in /proc/[0-9]*; do p=${f#/proc/}; [ "$p" = "$$" ] && continue; [ -O "$f" ] || continue; l=; { read -r l < "$f/stat"; } 2>/dev/null; set -- ${l##*) }; [ $# -ge 20 ] || continue; shift 19; s=$1; printf " %s:%s " "$p" "$s"; cat "$f/cmdline" "$f/environ" 2>/dev/null | tr "\\000\\n" "  "; echo " "; done); };',
  'tagged() { [ -n "$1" ] || return 0; printf "%s\\n" "$snap" | grep -F -e " $1 " -e " $1/" -e "=$1 " -e "=$1/" | cut -d " " -f 2; };',
  'withtag() { [ -n "$1" ] || return 0; printf "%s\\n" "$snap" | grep -F -e " PI_GUI_TAG=$1 " | cut -d " " -f 2; };',
  'same() { for x in "$@"; do p=${x%%:*}; [ -n "$p" ] && [ "$(st_of "$p")" = "${x#*:}" ] && printf "%s " "$p"; done; };',
].join(" ");

/**
 * JSON reader of one display lock record, for POSIX awk (BusyBox, mawk, gawk;
 * run with `LC_ALL=C`). It parses the whole record as JSON, whatever its
 * spacing or key order, and prints `s:<path>=<value>` for string and
 * `n:<path>=<value>` for number members of the top-level object and of nested
 * objects (`infra.xvfb`); only keys of `[A-Za-z0-9_]` are printed. It fails
 * (exit 1, nothing usable) on invalid JSON, a duplicate key, nesting deeper
 * than 16, a top level that is not an object, and strings holding control
 * characters or NUL, so such a record is never attributed to a session.
 * `\uXXXX` escapes (Python's default `ensure_ascii`) are decoded to UTF-8.
 * It holds no single quote, so it fits in a single-quoted shell word.
 */
const JSON_AWK = [
  String.raw`function fail() { exit 1; }`,
  String.raw`function ws() { while (p <= n && index(" \t\r\n", substr(s, p, 1)) > 0) p++; }`,
  String.raw`function hex4(   i, d, v) { v = 0; for (i = 0; i < 4; i++) { d = index("0123456789abcdef", tolower(substr(s, p + i, 1))); if (d == 0) fail(); v = v * 16 + d - 1; } p += 4; return v; }`,
  String.raw`function utf8(c) { if (c < 128) return sprintf("%c", c); if (c < 2048) return sprintf("%c%c", 192 + int(c / 64), 128 + c % 64); if (c < 65536) return sprintf("%c%c%c", 224 + int(c / 4096), 128 + int(c / 64) % 64, 128 + c % 64); return sprintf("%c%c%c%c", 240 + int(c / 262144), 128 + int(c / 4096) % 64, 128 + int(c / 64) % 64, 128 + c % 64); }`,
  String.raw`function str(   out, c, e, u, l) { if (substr(s, p, 1) != "\"") fail(); p++; out = "";`,
  String.raw`while (p <= n) { c = substr(s, p, 1); if (c == "\"") { p++; return out; }`,
  String.raw`if (c == "\\") { e = substr(s, p + 1, 1); p += 2; if (e == "\"" || e == "\\" || e == "/") { out = out e; continue; } if (e != "u") fail(); u = hex4();`,
  String.raw`if (u >= 55296 && u < 56320) { if (substr(s, p, 2) != "\\u") fail(); p += 2; l = hex4(); if (l < 56320 || l >= 57344) fail(); u = 65536 + (u - 55296) * 1024 + (l - 56320); } else if (u >= 56320 && u < 57344) fail();`,
  String.raw`if (u < 32) fail(); out = out utf8(u); continue; }`,
  String.raw`if (index(ctl, c) > 0) fail(); out = out c; p++; } fail(); }`,
  String.raw`function put(t, k, v) { o = o t ":" k "=" v "\n"; }`,
  String.raw`function value(path, emit, depth,   c, v) { if (depth > 16) fail(); ws(); c = substr(s, p, 1);`,
  String.raw`if (c == "\"") { v = str(); if (emit) put("s", path, v); return; }`,
  String.raw`if (c == "{") { obj(path, emit, depth + 1); return; }`,
  String.raw`if (c == "[") { arr(depth + 1); return; }`,
  String.raw`if (match(substr(s, p), /^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?/)) { v = substr(s, p, RLENGTH); p += RLENGTH; if (emit) put("n", path, v); return; }`,
  String.raw`if (substr(s, p, 4) == "true" || substr(s, p, 4) == "null") { p += 4; return; } if (substr(s, p, 5) == "false") { p += 5; return; } fail(); }`,
  String.raw`function obj(path, emit, depth,   k, kp, c, ok) { p++; ws(); if (substr(s, p, 1) == "}") { p++; return; }`,
  String.raw`for (;;) { ws(); k = str(); ws(); if (substr(s, p, 1) != ":") fail(); p++; kp = path == "" ? k : path "." k; ok = emit && k ~ /^[A-Za-z0-9_]+$/;`,
  String.raw`if (ok) { if (kp in seen) fail(); seen[kp] = 1; } value(kp, ok, depth); ws(); c = substr(s, p, 1); p++;`,
  String.raw`if (c == "}") return; if (c != ",") fail(); } }`,
  String.raw`function arr(depth,   c) { p++; ws(); if (substr(s, p, 1) == "]") { p++; return; } for (;;) { value("", 0, depth); ws(); c = substr(s, p, 1); p++; if (c == "]") return; if (c != ",") fail(); } }`,
  String.raw`BEGIN { for (i = 1; i < 32; i++) ctl = ctl sprintf("%c", i); }`,
  String.raw`{ s = s $0 "\n"; }`,
  String.raw`END { n = length(s); p = 1; ws(); if (substr(s, p, 1) != "{") fail(); obj("", 1, 1); ws(); if (p <= n) fail(); printf "%s", o; }`,
].join(" ");

/**
 * Display lock records (`hostmode.py`: `<root>/displays/display-<N>.lock`,
 * JSON). `readrec F` parses this user's regular lock file `F` (≤ 64 KiB, not
 * a symlink) with {@link JSON_AWK} into `$kv`; `field K` prints its string
 * member `K`, `num K` its integer member `K`, `infra_of K` the
 * `<pid>:<starttime>` of `infra.K`. `locks_of P` sets `$locks` to the lock
 * files whose `runtimeDir` is exactly `P/run`, `$tags` to their session
 * tags, and `$infra` to the `<pid>:<starttime>` of their infrastructure
 * processes (Xvfb, buses, window manager) when the record is from this boot
 * (other boots' PIDs mean nothing); the helper itself is selected by its
 * path. `lock_gone` removes each such lock once its helper is
 * dead, together with the X lock and socket of its display when the X lock
 * names the recorded Xvfb and that Xvfb is gone; a live helper or Xvfb is
 * reported as `left=` and its files stay.
 */
const LOCK_FN = [
  'boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null);',
  `json_awk='${JSON_AWK}';`,
  'readrec() { kv=; { [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; } || return 1; sz=$(wc -c < "$1" 2>/dev/null) || return 1; [ $((sz + 0)) -le 65536 ] || return 1; kv=$(LC_ALL=C awk "$json_awk" < "$1" 2>/dev/null) || { kv=; return 1; }; };',
  'field() { printf "%s\\n" "$kv" | sed -n "s/^s:$1=//p"; };',
  'num() { printf "%s\\n" "$kv" | sed -n "s/^n:$1=\\([0-9][0-9]*\\)$/\\1/p"; };',
  'infra_of() { printf "%s\\n" "$kv" | sed -n "s/^s:infra[.]$1=\\([0-9][0-9]*:[0-9][0-9]*\\)$/\\1/p"; };',
  'locks_of() { locks=; tags=; infra=; ld="$rb/displays"; { [ -d "$ld" ] && [ ! -L "$ld" ] && [ -O "$ld" ]; } || return 0;',
  'for l in "$ld"/display-*.lock; do readrec "$l" || continue; [ "$(field runtimeDir)" = "$1/run" ] || continue; locks="$locks $l";',
  't=$(field tag); case $t in ""|*[!A-Za-z0-9_-]*) ;; *) tags="$tags $t" ;; esac;',
  'if [ -n "$boot" ] && [ "$(field bootId)" = "$boot" ]; then infra="$infra $(infra_of "[A-Za-z0-9_]*")"; fi;',
  'done; };',
  'lock_gone() { for l in $locks; do readrec "$l" || continue; same_boot=; [ -n "$boot" ] && [ "$(field bootId)" = "$boot" ] && same_boot=1;',
  'h=$(field helper); if [ -n "$same_boot" ] && [ -n "$(same "$h")" ]; then echo "left=display-lock $l helper ${h%%:*} still running"; continue; fi;',
  'n=$(num display); xp=$(num xvfbPid);',
  'if [ -n "$same_boot" ] && [ -n "$n" ] && [ -n "$xp" ]; then xl=/tmp/.X$n-lock; xk=/tmp/.X11-unix/X$n;',
  'if [ -e "$xl" ] || [ -L "$xl" ]; then lp=$(tr -dc 0-9 < "$xl" 2>/dev/null); else lp=$xp; fi;',
  'if [ "$lp" = "$xp" ]; then xs=$(infra_of xvfb); if [ -n "$xs" ] && [ -n "$(same "$xs")" ]; then echo "left=display :$n Xvfb $xp still running"; continue; fi;',
  'for f in "$xl" "$xk"; do if [ -O "$f" ] && [ ! -d "$f" ]; then rm -f -- "$f" 2>/dev/null; fi; done; fi; fi;',
  'rm -f -- "$l" 2>/dev/null; if [ -e "$l" ] || [ -L "$l" ]; then echo "left=display-lock $l could not be removed"; fi;',
  'done; };',
].join(" ");

/** The session path `$rb/$name` (`rb`: resolved root) and the lock state of that session; refuses a session dir that is a symlink or not this user's directory. */
const SESSION_FN = [
  'is_session() { d="$b/$name"; if [ -L "$d" ] || { [ -e "$d" ] && { [ ! -d "$d" ] || [ ! -O "$d" ]; }; }; then return 1; fi; rb=$(cd -P -- "$b" 2>/dev/null && pwd) || return 1; tag="$rb/$name"; locks_of "$tag"; };',
  // Every process of the session: by path word (resolved and as named), by session tag, and the lock records' infrastructure.
  'pairs() { tagged "$tag"; [ "$tag" = "$d" ] || tagged "$d"; for t in $tags; do withtag "$t"; done; for x in $infra; do echo "$x"; done; };',
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
 * Removes session dirs `$2…` from every root: kills their processes (`$1` =
 * `graceful`: TERM, up to 3 s, then KILL; `fast`: KILL; see {@link TAGGED_FN}),
 * removes the dir and the display locks of its dead helper (also when the dir
 * is already gone), and removes `displays/` and the root when no session is
 * left. A session dir that is a symlink or not this user's directory is never
 * followed and nothing is selected through it. Prints `left=<kind> <id>
 * <detail>` for anything that remains.
 */
export const REMOVE_SCRIPT = [
  TAGGED_FN,
  CMDLINE_FN,
  LOCK_FN,
  SESSION_FN,
  'mode=$1; shift;',
  'for name in "$@"; do case $name in s-*) ;; *) continue ;; esac;',
  forEachRoot(
    [
      '{ [ -d "$b" ] && [ ! -L "$b" ] && [ -O "$b" ]; } || continue;',
      'if ! is_session; then echo "left=remote-dir $d is a symlink or not your directory; not touched"; continue; fi;',
      '{ [ -e "$d" ] || [ -n "$locks" ]; } || continue;',
      'snapshot; pids=$(same $(pairs));',
      'if [ -n "$(echo $pids)" ]; then',
      'if [ "$mode" = graceful ]; then kill -TERM $pids 2>/dev/null; i=0; while [ $i -lt 3 ]; do sleep 1; snapshot; pids=$(same $(pairs)); [ -z "$(echo $pids)" ] && break; i=$((i+1)); done; fi;',
      '[ -n "$(echo $pids)" ] && { kill -KILL $pids 2>/dev/null; sleep 1; };',
      "fi;",
      'rm -rf -- "$d" 2>/dev/null;',
      'if [ -e "$d" ] || [ -L "$d" ]; then echo "left=remote-dir $d could not be removed"; fi;',
      "lock_gone;",
      'snapshot; for p in $(same $(pairs)); do echo "left=remote-process $p $(cmdline "$p")"; done;',
      'set -- "$b"/s-*; if [ ! -e "$1" ]; then rmdir -- "$b/displays" 2>/dev/null; rmdir -- "$b" 2>/dev/null; fi;',
    ].join(" "),
  ),
  "done; exit 0",
].join(" ");

/**
 * Remote-owned cleanup (spec §7a.3): runs a session's long-lived process
 * (`"$@"`: the helper, or `docker run` for remote-linux-docker) and, whenever
 * it ends (stop, stdin EOF after a dropped SSH connection, heartbeat timeout,
 * crash), removes the session dir on the remote host itself, with no further
 * client call. `$1` is the resolved session dir, `$2` its name, `$3`
 * {@link REMOVE_SCRIPT}, `$4`/`$5` the Docker host and container of
 * remote-linux-docker (empty otherwise): that container is removed first,
 * since a `docker run` client that died (SIGHUP) can leave it running with
 * the dir bind-mounted. The dir is removed only when it is what
 * {@link CREATE_SCRIPT} made: named `s-*`, a real directory (not a symlink)
 * owned by the SSH user, mode 0700, holding the `owner` record. The removal
 * runs {@link REMOVE_SCRIPT} under `env -i` with only the session name in its
 * argv, so it never matches itself while it ends the session's leftover
 * processes. A dropped connection (SIGHUP, SIGPIPE) does not stop it.
 */
export const SESSION_WRAPPER_SCRIPT = [
  "pi_gui_session_wrapper=1;",
  'd=$1; n=$2; rm_script=$3; dh=$4; dc=$5; shift 5;',
  "trap : HUP PIPE;",
  '"$@"; st=$?;',
  "exec </dev/null >/dev/null 2>&1;",
  '[ -z "$dc" ] || docker --host "$dh" rm -f -- "$dc" >/dev/null 2>&1;',
  'case $n in s-*) ;; *) exit "$st" ;; esac; [ "${d##*/}" = "$n" ] || exit "$st";',
  '{ [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; } || exit "$st";',
  '[ "$(stat -c %a -- "$d" 2>/dev/null)" = 700 ] || exit "$st";',
  'grep -q "^owner=" "$d/owner" 2>/dev/null || exit "$st";',
  // REMOVE_SCRIPT finds the dir below its usual roots; an XDG root is named through XDG_RUNTIME_DIR.
  'b=${d%/*}; x=; case $b in */pi-gui-testing) x=${b%/pi-gui-testing} ;; esac;',
  'exec env -i ${PATH+"PATH=$PATH"} ${HOME+"HOME=$HOME"} ${x:+"XDG_RUNTIME_DIR=$x"} /bin/sh -c "$rm_script" sh graceful "$n"',
].join(" ");

/**
 * Argv that runs `argv` (the helper or `docker run`) under
 * {@link SESSION_WRAPPER_SCRIPT}, so the remote host removes `remote.dir`
 * (and first `docker.container`, when given) when it ends.
 */
export function sessionWrappedArgv(remote: Pick<RemoteSessionDir, "dir" | "name">, argv: readonly string[], docker?: { host: string; container: string }): string[] {
  if (argv.length === 0) throw new Error("empty argv");
  assertSafeRemotePath(remote.dir);
  if (remote.dir.split("/").at(-1) !== assertSessionName(remote.name)) throw new Error(`remote session dir ${remote.dir} does not end in ${remote.name}`);
  if (docker && (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(docker.container) || docker.host === "" || docker.host.startsWith("-"))) throw new Error(`invalid container ${JSON.stringify(docker.container)} on ${JSON.stringify(docker.host)}`);
  return ["/bin/sh", "-c", SESSION_WRAPPER_SCRIPT, "sh", remote.dir, remote.name, REMOVE_SCRIPT, docker?.host ?? "", docker?.container ?? "", ...argv];
}

/**
 * Read-only audit of session dir `$1`: prints `dir=<path>`, `lock=<path>`
 * (display locks naming it), and `process=<pid> <cmdline>` lines. A session
 * dir that is a symlink or not this user's directory is reported, never followed.
 */
export const AUDIT_SCRIPT = [
  TAGGED_FN,
  CMDLINE_FN,
  LOCK_FN,
  SESSION_FN,
  'name=$1; case $name in s-*) ;; *) exit 2 ;; esac; snapshot;',
  forEachRoot(
    [
      '{ [ -d "$b" ] && [ ! -L "$b" ] && [ -O "$b" ]; } || continue;',
      'if ! is_session; then echo "dir=$d"; continue; fi;',
      'if [ -e "$d" ]; then echo "dir=$d"; fi;',
      'for l in $locks; do echo "lock=$l"; done;',
      'for p in $(same $(pairs)); do echo "process=$p $(cmdline "$p")"; done;',
    ].join(" "),
  ),
  "exit 0",
].join(" ");

/**
 * Read-only scan of every session dir: `entry<TAB>name<TAB>path<TAB>owner<TAB>live<TAB>age`,
 * and of display locks whose session dir is gone: `lock<TAB>name<TAB>path<TAB>helper`
 * (`helper`: `alive`, or `dead` for a dead helper or one of an earlier boot), or
 * `lock<TAB>-<TAB>path<TAB>unknown` for a lock that names no session dir of this root.
 */
export const LIST_SCRIPT = [
  TAGGED_FN,
  LOCK_FN,
  'now=$(date +%s); snapshot;',
  forEachRoot(
    [
      '{ [ -d "$b" ] && [ ! -L "$b" ] && [ -O "$b" ]; } || continue;',
      'rb=$(cd -P -- "$b" 2>/dev/null && pwd) || continue;',
      'for d in "$b"/s-*; do { [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; } || continue; name=${d##*/}; tag="$rb/$name";',
      'owner=$(sed -n "s/^owner=//p" "$d/owner" 2>/dev/null | head -n 1 | tr -d "\\t\\r");',
      'locks_of "$tag"; live=0; [ -n "$(tagged "$tag")" ] && live=1; for t in $tags; do [ -n "$(withtag "$t")" ] && live=1; done;',
      'mt=$(stat -c %Y -- "$d" 2>/dev/null || echo "$now");',
      'printf "entry\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$name" "$d" "$owner" "$live" "$((now - mt))";',
      "done;",
      'ld="$rb/displays"; { [ -d "$ld" ] && [ ! -L "$ld" ] && [ -O "$ld" ]; } || continue;',
      'for l in "$ld"/display-*.lock; do readrec "$l" || continue; r=$(field runtimeDir); name=-;',
      'case $r in "$rb"/s-*/run) name=${r#"$rb"/}; name=${name%/run}; case $name in */*) name=- ;; esac ;; esac;',
      'if [ "$name" = - ]; then printf "lock\\t-\\t%s\\tunknown\\n" "$l"; continue; fi;',
      '{ [ -e "$rb/$name" ] || [ -L "$rb/$name" ]; } && continue;',
      'state=dead; if [ -n "$boot" ] && [ "$(field bootId)" = "$boot" ] && [ -n "$(same "$(field helper)")" ]; then state=alive; fi;',
      'printf "lock\\t%s\\t%s\\t%s\\n" "$name" "$l" "$state";',
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
    else if (line.startsWith("lock=")) leftovers.push({ kind: "display-lock", id: `${options.destination}:${line.slice(5)}`, detail: `display lock of session ${name}` });
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

/** A display lock whose session dir is gone (`name`), or that names no session dir of its root (`name` undefined). */
export interface RemoteLockEntry {
  name?: string;
  path: string;
  /** `alive`: its helper still runs; `dead`: gone (or from an earlier boot); `unknown`: not a lock of a session dir. */
  helper: "alive" | "dead" | "unknown";
}

/** Lists every remote session dir and every display lock left without one (read-only). @throws Error when the call fails. */
export async function listRemoteFootprint(runner: CommandRunner, signal?: AbortSignal): Promise<{ entries: RemoteSessionEntry[]; locks: RemoteLockEntry[] }> {
  const result = await runner.run(["/bin/sh", "-c", LIST_SCRIPT, "sh"], { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) throw new Error(`listing remote session dirs failed (${remoteFailure(result)})`);
  const entries: RemoteSessionEntry[] = [];
  const locks: RemoteLockEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields[0] === "lock") {
      const [, name, path, helper] = fields;
      if (!path || !/^\/[A-Za-z0-9._/@+-]*\/displays\/display-\d+\.lock$/.test(path)) continue;
      if (name !== "-" && name && NAME.test(name) && (helper === "alive" || helper === "dead")) locks.push({ name, path, helper });
      else locks.push({ path, helper: "unknown" });
      continue;
    }
    const [tag, name, path, owner, live, age] = fields;
    if (tag !== "entry" || !name || !NAME.test(name)) continue;
    entries.push({ name, path: path ?? "", owner: owner ?? "", live: live === "1", ageSeconds: Number(age) || 0 });
  }
  return { entries, locks };
}

/** Lists every remote session dir (read-only). @throws Error when the call fails. */
export async function listRemoteSessions(runner: CommandRunner, signal?: AbortSignal): Promise<RemoteSessionEntry[]> {
  return (await listRemoteFootprint(runner, signal)).entries;
}

/**
 * Display locks left without their session dir: a dead helper's lock is
 * removable (its session is gone and so is the helper that held the
 * display); a live helper's lock and a lock that names no session dir are
 * reported, never removed.
 */
export function decideLocks(locks: readonly RemoteLockEntry[]): { lock: RemoteLockEntry; action: "remove" | "report"; reason: string }[] {
  return locks.map((lock) =>
    lock.helper === "dead"
      ? { lock, action: "remove", reason: `display lock of the removed session ${lock.name}; its helper is gone` }
      : lock.helper === "alive"
        ? { lock, action: "report", reason: `display lock of the removed session ${lock.name}; its helper still runs` }
        : { lock, action: "report", reason: "display lock that names no session dir; not removed automatically" },
  );
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

/** Read-only orphan audit of the remote session dirs and of display locks left without one. */
export async function auditRemoteOrphans(runner: CommandRunner, options: { destination: string; signal?: AbortSignal; procRoot?: string }): Promise<Leftover[]> {
  const footprint = await listRemoteFootprint(runner, options.signal);
  return [
    ...decideOrphans(footprint.entries, options.procRoot)
      .filter((d) => d.action !== "keep")
      .map((d) => ({ kind: "remote-dir", id: `${options.destination}:${d.entry.path}`, detail: d.reason })),
    ...decideLocks(footprint.locks).map((d) => ({ kind: "display-lock", id: `${options.destination}:${d.lock.path}`, detail: d.reason })),
  ];
}

/**
 * Removes orphaned remote session dirs and the display locks of dead helpers
 * whose session dir is gone; reports what is not judged dead and what could not be removed.
 */
export async function sweepRemoteOrphans(runner: CommandRunner, options: { destination: string; signal?: AbortSignal; procRoot?: string }): Promise<Leftover[]> {
  const footprint = await listRemoteFootprint(runner, options.signal);
  const decisions = decideOrphans(footprint.entries, options.procRoot);
  const lockDecisions = decideLocks(footprint.locks);
  const leftovers: Leftover[] = [
    ...decisions.filter((d) => d.action === "report").map((d) => ({ kind: "remote-dir", id: `${options.destination}:${d.entry.path}`, detail: d.reason })),
    ...lockDecisions.filter((d) => d.action === "report").map((d) => ({ kind: "display-lock", id: `${options.destination}:${d.lock.path}`, detail: d.reason })),
  ];
  // Removing a gone session's name removes its dead helper's locks (REMOVE_SCRIPT).
  const doomed = [...new Set([...decisions.filter((d) => d.action === "remove").map((d) => d.entry.name), ...lockDecisions.filter((d) => d.action === "remove").map((d) => d.lock.name!)])];
  leftovers.push(...(await removeRemoteSessions(runner, doomed, { destination: options.destination, ...(options.signal ? { signal: options.signal } : {}) })));
  return leftovers;
}
