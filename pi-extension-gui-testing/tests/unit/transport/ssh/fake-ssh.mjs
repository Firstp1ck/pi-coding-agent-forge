/**
 * Test doubles for the SSH transport:
 *
 * - `decodeShellWords` / `decodeRemote` turn the remote command line that
 *   `SshTransport` builds back into argv, cwd, and env (the inverse of
 *   `shellQuote` + the `/bin/sh -c` wrapper), so fakes can answer by argv;
 * - `FakeSsh` is a scripted `ssh`: a local CommandRunner, Spawner, and
 *   DetachedRunner whose remote commands go to an inner FakeCommandRunner;
 * - `loopbackSsh` writes an `ssh` executable that runs the remote command on
 *   this machine in a sandbox (`XDG_RUNTIME_DIR`, `HOME`, a fake `id`), so the
 *   real remote scripts run without sshd.
 */
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";

/** Splits a command line written by `shellQuote` (single quotes, `"'"`, `"\\"`, bare words). */
export function decodeShellWords(line) {
  const words = [];
  let word = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word ??= "";
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) throw new Error(`unbalanced quote in ${line}`);
      word += line.slice(i + 1, close);
      i = close;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && j + 1 < line.length && '\\"$`'.includes(line[j + 1])) j++;
        word += line[j];
      }
      i = j;
    } else if (ch === "\\") {
      word += line[++i];
    } else word += ch;
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * Decodes a remote command line: `{ kind: "run", argv, cwd?, env }` for
 * `runner.run`, `{ kind: "helper", argv, keys }` for `spawnHelper`, or
 * `{ kind: "raw", argv }` for anything else.
 */
export function decodeRemote(command) {
  const words = decodeShellWords(command);
  if (words[0] !== "/bin/sh" || words[1] !== "-c" || words[3] !== "sh") return { kind: "raw", argv: words };
  const script = words[2];
  let args = words.slice(4);
  if (script.includes("exec env -i")) {
    const keys = [...script.matchAll(/read -r (\w+)/g)].map((m) => m[1]);
    // The remote session wrapper (session-dir.ts): `argv` is the wrapped command, `session` the dir it removes.
    if (args[0] === "/bin/sh" && args[1] === "-c" && args[2]?.startsWith("pi_gui_session_wrapper=1;") && args[3] === "sh") {
      return { kind: "helper", argv: args.slice(9), keys, script, session: { dir: args[4], name: args[5] }, ...(args[8] ? { container: { host: args[7], name: args[8] } } : {}), wrapped: args };
    }
    return { kind: "helper", argv: args, keys, script };
  }
  if (!script.startsWith("unset DISPLAY")) return { kind: "raw", argv: words, script, args };
  let cwd;
  if (script.includes('cd -- "$1"')) {
    cwd = args[0];
    args = args.slice(1);
  }
  const env = {};
  if (script.includes('exec env "$@"')) {
    while (args.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
      const [k, ...v] = args.shift().split("=");
      env[k] = v.join("=");
    }
  }
  return { kind: "run", argv: args, ...(cwd !== undefined ? { cwd } : {}), env };
}

/** Splits an `ssh` argv into its `-o` options, flags, destination, and command. */
export function parseSshArgv(argv) {
  const options = {};
  const flags = [];
  let i = 1;
  let op;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") {
      const [k, ...v] = argv[++i].split("=");
      options[k] = v.join("=");
    } else if (a === "-O") op = argv[++i];
    else if (a === "--") {
      i++;
      break;
    } else if (a.startsWith("-")) flags.push(a);
    else break;
  }
  return { options, flags, op, destination: argv[i], command: argv.slice(i + 1).join(" ") };
}

const ok = (extra = {}) => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1, ...extra });

/** Minimal tar reader (ustar + PAX `path`/`linkpath`) for the fake remote file system. */
export function readTar(buffer) {
  const entries = [];
  let offset = 0;
  let pax = {};
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const field = (s, l) => block.subarray(s, s + l).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(block[156]);
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      for (const rec of data.toString("utf8").split("\n").filter(Boolean)) {
        const body = rec.slice(rec.indexOf(" ") + 1);
        const eq = body.indexOf("=");
        pax[body.slice(0, eq)] = body.slice(eq + 1);
      }
      continue;
    }
    const prefix = field(345, 155);
    const name = pax.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    entries.push({ path: name.replace(/\/$/, ""), type: type === "5" ? "dir" : type === "2" ? "symlink" : "file", mode: parseInt(field(100, 8), 8), linkTarget: pax.linkpath ?? field(157, 100), data: Buffer.from(data) });
    pax = {};
  }
  return entries;
}

/**
 * A local stand-in for `ssh … <helper command>`: reads the environment
 * preamble (one line per key of the decoded command) from stdin, then starts
 * `factory(argv, { env }, record)` (e.g. a FakeHelperChild) and forwards the
 * rest of stdin to it. `record.env` receives the decoded environment.
 */
export function preambleChild(record, factory) {
  const stdin = new PassThrough();
  const keys = record.decoded.keys;
  let buffered = Buffer.alloc(0);
  let child;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  const handle = {
    pid: 7000 + Math.floor(Math.random() * 1000),
    stdin,
    stdout,
    stderr,
    exited,
    running: () => (child ? child.running() : true),
    kill: (signal) => (child ? child.kill(signal) : resolveExit({ code: null, signal })),
  };
  const start = () => {
    const text = buffered.toString("utf8");
    const lines = text.split("\n");
    const env = Object.fromEntries(keys.map((k, i) => [k, lines[i]]));
    record.env = env;
    const rest = Buffer.from(lines.slice(keys.length).join("\n"), "utf8");
    child = factory(record.decoded.argv, { env }, record);
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.exited.then((s) => resolveExit(s));
    if (rest.length) child.stdin.write(rest);
    stdin.on("data", (chunk) => child.stdin.write(chunk));
    stdin.on("end", () => child.stdin.end());
  };
  const first = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.toString("utf8").split("\n").length > keys.length) {
      stdin.off("data", first);
      start();
    }
  };
  if (keys.length === 0) setImmediate(start);
  else stdin.on("data", first);
  return handle;
}

/**
 * A scripted `ssh` for unit tests. `remote` answers decoded remote argv
 * (rules as in FakeCommandRunner; later rules win). `files` is the fake
 * remote file system that tar uploads fill and `sha256sum` reads.
 */
export class FakeSsh {
  constructor(options = {}) {
    this.remote = options.remote ?? new FakeCommandRunner();
    this.calls = [];
    this.spawns = [];
    this.masters = new Map();
    this.files = new Map();
    /** Every extracted tar entry by absolute remote path (files, dirs, symlinks). */
    this.entries = new Map();
    this.unreachable = new Map(options.unreachable ?? []);
    this.helper = options.helper;
    this.masterFailure = options.masterFailure;
    this.local = new FakeCommandRunner();
    this.remote.on(["true"], {});
    this.remote.on((argv) => argv[0] === "sha256sum", (argv, opts) => {
      const lines = [];
      for (const path of argv.slice(2)) {
        const data = this.files.get(`${opts.cwd}/${path}`);
        if (data === undefined) return { exitCode: 1, stderr: `sha256sum: ${path}: No such file or directory` };
        lines.push(`${createHash("sha256").update(data).digest("hex")}  ${path}`);
      }
      return { stdout: `${lines.join("\n")}\n` };
    });
    const self = this;
    this.runner = {
      async run(argv, opts) {
        if (!argv[0].endsWith("ssh")) return self.local.run(argv, opts);
        const parsed = parseSshArgv(argv);
        const call = { argv: [...argv], ...parsed, decoded: parsed.command ? decodeRemote(parsed.command) : undefined, input: opts.input };
        self.calls.push(call);
        if (opts.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (argv.includes("-V")) return ok({ stderr: "OpenSSH_10.3p1, fake\n" });
        if (argv.includes("-G")) return self.local.run(argv, opts);
        const control = parsed.options.ControlPath;
        if (parsed.op === "check") return self.masters.get(control) ? ok({ stderr: "Master running (pid=1)\n" }) : ok({ exitCode: 255, stderr: `Control socket connect(${control}): No such file or directory\n` });
        if (parsed.op === "exit") {
          const had = self.masters.get(control);
          self.masters.delete(control);
          return had ? ok({ stderr: "Exit request sent.\n" }) : ok({ exitCode: 255, stderr: "Control socket connect: No such file or directory\n" });
        }
        const down = self.unreachable.get(parsed.destination);
        if (down) return ok({ exitCode: 255, stderr: `${down}\n` });
        const decoded = call.decoded;
        const remoteArgv = decoded.kind === "run" ? decoded.argv : decoded.argv;
        return self.remote.run(remoteArgv, { ...opts, ...(decoded.cwd !== undefined ? { cwd: decoded.cwd } : {}), env: decoded.env ?? {} });
      },
    };
    this.detached = {
      async run(argv) {
        const parsed = parseSshArgv(argv);
        self.calls.push({ argv: [...argv], ...parsed, master: true });
        const down = self.unreachable.get(parsed.destination) ?? self.masterFailure;
        if (down) return ok({ exitCode: 255, stderr: `${down}\n` });
        self.masters.set(parsed.options.ControlPath, true);
        return ok();
      },
    };
    this.spawner = {
      spawn(argv, opts = {}) {
        const parsed = parseSshArgv(argv);
        const decoded = decodeRemote(parsed.command);
        const record = { argv: [...argv], ...parsed, decoded, localEnv: opts.env ?? {} };
        self.spawns.push(record);
        // A helper-style spawn without environment (e.g. `docker build -`) is a plain stream.
        if (decoded.kind === "helper" && decoded.keys.length > 0) return self.#helperChild(record);
        return self.#streamChild(record);
      },
    };
  }

  /** Remote argv of every recorded `runner.run` call, joined with spaces. */
  remoteCommands() {
    return this.calls.filter((c) => c.decoded).map((c) => c.decoded.argv.join(" "));
  }

  #helperChild(record) {
    return preambleChild(record, this.helper);
  }

  #streamChild(record) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks = [];
    let alive = true;
    let resolveExit;
    const exited = new Promise((r) => (resolveExit = r));
    const decoded = record.decoded;
    stdin.on("data", (c) => chunks.push(c));
    stdin.on("end", async () => {
      const input = Buffer.concat(chunks);
      record.input = input;
      let status = { code: 0, signal: null };
      const down = this.unreachable.get(record.destination);
      if (down) {
        stderr.write(`${down}\n`);
        status = { code: 255, signal: null };
      } else if (decoded.kind === "run" && decoded.argv.join(" ").includes("tar -x -f -")) {
        for (const entry of readTar(input)) {
          this.entries.set(`${decoded.cwd}/${entry.path}`, entry);
          if (entry.type === "file") this.files.set(`${decoded.cwd}/${entry.path}`, entry.data);
        }
        record.tar = readTar(input);
      } else if (this.onStream) {
        const result = await this.onStream(decoded, input, record);
        if (result?.stdout) stdout.write(result.stdout);
        status = { code: result?.exitCode ?? 0, signal: null };
      }
      alive = false;
      stdout.end();
      stderr.end();
      resolveExit(status);
    });
    return { pid: 8000 + this.spawns.length, stdin, stdout, stderr, exited, running: () => alive, kill: (signal) => (alive && ((alive = false), stdout.end(), stderr.end(), resolveExit({ code: null, signal }))) };
  }
}

/**
 * Writes `<sandbox>/bin/ssh`, a loopback `ssh` that runs the remote command
 * here under `/bin/sh -c` (as sshd runs it under the login shell), with
 * `XDG_RUNTIME_DIR`, `HOME`, and a fake `id` (uid/gid 4242424) inside the
 * sandbox, so remote scripts never touch the real `/tmp/pi-gui-testing-<uid>`.
 * `<sandbox>/unreachable` makes every connection fail with exit 255.
 *
 * @returns `{ ssh, xdg, home, log }`.
 */
export async function loopbackSsh(sandbox, options = {}) {
  const bin = join(sandbox, "bin");
  const fakebin = join(sandbox, "fakebin");
  const xdg = join(sandbox, "xdg");
  const home = join(sandbox, "home");
  for (const dir of [bin, fakebin, xdg, home]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const log = join(sandbox, "ssh.log");
  const shell = options.loginShell ?? "/bin/sh";
  await writeFile(
    join(fakebin, "id"),
    `#!/bin/sh\ncase "$1" in -u|-g) echo 4242424 ;; *) exec /usr/bin/id "$@" ;; esac\n`,
  );
  await chmod(join(fakebin, "id"), 0o755);
  const script = `#!/bin/sh
export XDG_RUNTIME_DIR='${xdg}' HOME='${home}' PATH='${fakebin}':"$PATH"
printf '%s\\n' "$*" >> '${log}'
control=""; master=no; op=""
while [ $# -gt 0 ]; do
  case $1 in
    -o) shift; case $1 in ControlPath=*) control=\${1#ControlPath=} ;; ControlMaster=yes) master=yes ;; esac ;;
    -O) shift; op=$1 ;;
    -V) echo "OpenSSH_10.3p1 loopback" >&2; exit 0 ;;
    -G) shift; [ "$1" = -- ] && shift; printf 'user tester\\nhostname %s\\nport 22\\n' "$1"; exit 0 ;;
    --) shift; break ;;
    -*) ;;
    *) break ;;
  esac
  shift
done
dest=$1; shift
case $op in
  check) if [ -e "$control" ]; then echo "Master running (pid=1)" >&2; exit 0; fi; echo "Control socket connect($control): No such file or directory" >&2; exit 255 ;;
  exit) if [ -e "$control" ]; then rm -f "$control"; echo "Exit request sent." >&2; exit 0; fi; exit 255 ;;
esac
if [ -f '${sandbox}/unreachable' ]; then echo "ssh: connect to host $dest port 22: Connection refused" >&2; exit 255; fi
if [ "$master" = yes ]; then : > "$control"; exit 0; fi
cd "$HOME" || exit 1
exec ${shell} -c "$*"
`;
  const ssh = join(bin, "ssh");
  await writeFile(ssh, script);
  await chmod(ssh, 0o755);
  return { ssh, xdg, home, log, fakebin };
}
