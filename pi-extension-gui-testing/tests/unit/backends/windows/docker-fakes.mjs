/**
 * Test doubles for `docker-windows`: one FakeCommandRunner that plays a
 * rootful Docker 29 with dockurr containers, `ssh-keygen`, and `ssh` to the
 * Windows guest (it decodes the `-EncodedCommand` PowerShell scripts and
 * answers from a small guest model), plus a spawner for the streaming `ssh`
 * calls (tar into the guest, the helper with its `-StdinEnv` preamble) and a
 * detached runner for the ControlMaster. Nothing here spawns a process.
 */
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { decodeScript } from "../../../../src/backends/docker-windows/powershell.ts";
import { FakeHelperChild, HEALTHY_INFO } from "../fakes.mjs";
import { readTar } from "../../transport/ssh/fake-ssh.mjs";

export const HOST = "unix:///var/run/docker.sock";
export const OWNER = "c1:100:5000:boot";
export const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake";

const ok = (extra = {}) => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1, ...extra });
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The parts of `ssh … -- 127.0.0.1 <command>`. */
export function parseGuestSsh(argv) {
  const dash = argv.indexOf("--");
  const options = {};
  for (let i = 1; i < dash; i++) if (argv[i] === "-o") {
    const [k, ...v] = argv[++i].split("=");
    options[k] = v.join("=");
  }
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i > -1 && i < dash ? argv[i + 1] : undefined;
  };
  const command = argv.slice(dash + 2).join(" ");
  const encoded = /-EncodedCommand (\S+)/.exec(command)?.[1];
  return { options, port: Number(flag("-p")), user: flag("-l"), identity: flag("-i"), config: flag("-F"), op: flag("-O"), host: argv[dash + 1], command, script: encoded ? decodeScript(encoded) : undefined };
}

const VALUE_FLAGS = new Set(["--name", "--label", "--cap-drop", "--cap-add", "--security-opt", "--network", "-v", "-e", "-p", "--pull", "--device", "--entrypoint", "--stop-timeout"]);

/** Parses `docker [--host h] run|create ...flags image [cmd...]` with the flags dockurr containers use. */
export function parseRunArgv(argv) {
  let i = argv.indexOf("run");
  if (i === -1) i = argv.indexOf("create");
  const flags = [];
  let image;
  for (i = i + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) flags.push([arg, argv[++i]]);
    else if (arg.startsWith("-")) flags.push([arg, true]);
    else {
      image = arg;
      break;
    }
  }
  const all = (name) => flags.filter(([f]) => f === name).map(([, v]) => v);
  return { flags, image, all, one: (name) => all(name).at(-1), rest: argv.slice(i + 1) };
}

const sha = (data) => createHash("sha256").update(data).digest("hex");

/**
 * Fake Docker + guest. `opts`:
 * - `imageMissing`, `volume` ({ labels } or undefined), `stamp`, `bootAfter` (failed boot probes before success),
 * - `markerAfter` (marker polls before the install marker appears), `installStops` (install container exits),
 * - `guestHelper`: `"match"` (default) or `"differ"`, `info` (docker info JSON override), `rootDir`.
 */
export function fakeWindowsDocker(opts = {}) {
  const runner = new FakeCommandRunner();
  const state = {
    containers: new Map(),
    volumes: new Map(opts.volume ? [["pi-gui-testing-windows-base", { labels: opts.volume.labels ?? {} }]] : []),
    imageMissing: opts.imageMissing ?? false,
    stamp: opts.stamp ?? "data.img 68719476736 1700000000",
    stampChanges: opts.stampChanges ?? false,
    removed: [],
    ports: 40000,
    bootProbes: 0,
    markerPolls: 0,
    masters: new Set(),
    guestFiles: new Map(),
    scripts: [],
    tars: [],
    helpers: [],
    installId: undefined,
    helperFiles: opts.helperFiles ?? [],
  };
  const host = (re) => new RegExp(`^docker --host ${escape(HOST)} ${re}`);
  const container = (name) => state.containers.get(name);
  runner
    .on(["docker", "--version"], { stdout: "Docker version 29.9.1, build abcdef0\n" })
    .on(["docker", "context", "inspect", "--format", "{{json .}}"], { stdout: `${JSON.stringify({ Name: "default", Endpoints: { docker: { Host: HOST } } })}\n` })
    .on(host("info --format \\{\\{json \\.\\}\\}"), { stdout: JSON.stringify(opts.info ?? HEALTHY_INFO) })
    .on(host("info --format \\{\\{\\.DockerRootDir\\}\\}"), { stdout: `${opts.rootDir ?? "/var/lib/docker"}\n` })
    .on(host("version --format"), { stdout: "29.9.1\n" })
    .on(host("image inspect "), () => (state.imageMissing ? { exitCode: 1, stderr: "Error response from daemon: No such image: dockurr/windows" } : { stdout: JSON.stringify({ Id: "sha256:" + "cd".repeat(32), Architecture: "amd64" }) }))
    .on(host("image rm "), (argv) => (state.imageMissing ? { exitCode: 1, stderr: "Error: No such image" } : ((state.imageMissing = true), state.removed.push(argv.at(-1)), {})))
    .on(host("volume inspect "), (argv) => {
      const v = state.volumes.get(argv.at(-1));
      return v ? { stdout: `${JSON.stringify(v.labels)}\n` } : { exitCode: 1, stderr: `Error response from daemon: get ${argv.at(-1)}: no such volume` };
    })
    .on(host("volume create "), (argv) => {
      const labels = Object.fromEntries(parseRunArgv(["docker", "run", ...argv.slice(5)]).all("--label").map((l) => l.split(/=(.*)/s).slice(0, 2)));
      state.volumes.set(argv.at(-1), { labels });
      return { stdout: `${argv.at(-1)}\n` };
    })
    .on(host("volume ls -q"), () => ({ stdout: [...state.volumes].filter(([, v]) => v.labels["pi-gui-testing.windows"] === "base").map(([n]) => n).join("\n") }))
    .on(host("volume rm -f "), (argv) => {
      if (opts.volumeBusy) return { exitCode: 1, stderr: "Error response from daemon: remove pi-gui-testing-windows-base: volume is in use" };
      state.volumes.delete(argv.at(-1));
      state.removed.push(argv.at(-1));
      return {};
    })
    .on(host("run -d --rm "), (argv) => {
      const p = parseRunArgv(argv);
      const name = p.one("--name");
      const labels = Object.fromEntries(p.all("--label").map((l) => l.split(/=(.*)/s).slice(0, 2)));
      state.containers.set(name, { name, argv, labels, running: true, port: ++state.ports, viewerPort: ++state.ports, env: {} });
      if (labels["pi-gui-testing.windows"] === "install") state.installId = labels["pi-gui-testing.windows.install"];
      return { stdout: `id-${name}\n` };
    })
    .on(host("run --rm --pull never --network none "), () => {
      const stamp = state.stamp;
      if (state.stampChanges) state.stamp = "data.img 68719476736 1700009999";
      return { stdout: `${stamp}\n` };
    })
    .on(host("create "), (argv) => {
      const p = parseRunArgv(argv);
      const name = p.one("--name");
      state.containers.set(name, { name, argv, labels: {}, running: false, created: true });
      return { stdout: `id-${name}\n` };
    })
    .on(host("container inspect --format"), (argv) => {
      const c = container(argv.at(-1));
      if (!c) return { exitCode: 1, stderr: `Error: No such container: ${argv.at(-1)}` };
      return { stdout: JSON.stringify({ Running: c.running, Status: c.running ? "running" : "exited", ExitCode: c.running ? 0 : 1 }) };
    })
    .on(host("container inspect pi-gui-testing-win-probe"), (argv) => {
      const c = container(argv.at(-1));
      if (!c) return { exitCode: 1, stderr: "Error: No such container" };
      return { stdout: JSON.stringify([opts.mutateInspect ? opts.mutateInspect(inspectWindows(c.argv)) : inspectWindows(c.argv)]) };
    })
    .on(host("port "), (argv) => {
      const c = container(argv.at(-2));
      if (!c) return { exitCode: 1, stderr: "Error: No such container" };
      const port = argv.at(-1) === "8006/tcp" ? c.viewerPort : c.port;
      return { stdout: opts.publishedOn ? `${opts.publishedOn}:${port}\n` : `127.0.0.1:${port}\n` };
    })
    .on(host("logs --tail 20 "), () => ({ stdout: "\x1b[1m❯ Windows started successfully\x1b[0m\n" }))
    .on(host("ps -a --no-trunc --filter label=pi-gui-testing.windows="), (argv) => {
      const role = /label=pi-gui-testing\.windows=(\w+)/.exec(argv.join(" "))[1];
      const lines = [...state.containers.values()]
        .filter((c) => c.labels["pi-gui-testing.windows"] === role)
        .map((c) => [`id-${c.name}`, c.name, c.labels["pi-gui-testing.session"] ?? "", c.labels["pi-gui-testing.owner"] ?? "", c.labels["pi-gui-testing.windows.install"] ?? "", c.running ? "running" : "exited"].join("\t"));
      return { stdout: [...lines, ...(opts.extraContainers?.[role] ?? [])].join("\n") };
    })
    .on(host("rm -f "), (argv) => {
      const id = argv.at(-1).replace(/^id-/, "");
      state.removed.push(argv.at(-1));
      state.containers.delete(id);
      return {};
    })
    .on(host("stop -t "), (argv) => {
      state.containers.delete(argv.at(-1));
      return {};
    })
    .on((argv) => argv[0] === "ssh-keygen", async (argv) => {
      const path = argv[argv.indexOf("-f") + 1];
      await writeFile(path, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n");
      await writeFile(`${path}.pub`, `${PUB} ${argv[argv.indexOf("-C") + 1]}\n`);
      return {};
    })
    .on((argv) => argv[0] === "ssh", (argv) => guestCall(state, opts, argv));
  const spawner = {
    children: [],
    spawn(argv) {
      const parsed = parseGuestSsh(argv);
      const child = parsed.command.includes("helper.ps1") ? helperChild(state, opts, parsed) : tarChild(state, opts, parsed);
      this.children.push({ argv, parsed, child });
      return child;
    },
  };
  const detached = {
    async run(argv) {
      const parsed = parseGuestSsh(argv);
      state.masters.add(parsed.options.ControlPath);
      return ok();
    },
  };
  return { runner, state, spawner, detached };
}

/** What `docker container inspect` reports for a dockurr container created from `argv`. */
export function inspectWindows(argv) {
  const p = parseRunArgv(argv);
  const ports = {};
  for (const spec of p.all("-p")) {
    const [ip, hostPort, containerPort] = spec.split(":");
    ports[`${containerPort}/tcp`] = [{ HostIp: ip, HostPort: hostPort }];
  }
  return {
    HostConfig: {
      Privileged: false,
      NetworkMode: "bridge",
      IpcMode: "private",
      PidMode: "",
      UsernsMode: "",
      CapAdd: p.all("--cap-add"),
      CapDrop: p.all("--cap-drop"),
      SecurityOpt: p.all("--security-opt"),
      Devices: p.all("--device").map((d) => ({ PathOnHost: d, PathInContainer: d })),
      PortBindings: ports,
      AutoRemove: p.flags.some(([f]) => f === "--rm"),
    },
    Mounts: p.all("-v").map((v) => {
      const [source, dest] = v.split(":");
      return source.startsWith("/") ? { Type: "bind", Source: source, Destination: dest } : { Type: "volume", Name: source, Destination: dest };
    }),
    Config: { Env: p.all("-e").filter((e) => e.includes("=")), Labels: Object.fromEntries(p.all("--label").map((l) => l.split(/=(.*)/s).slice(0, 2))) },
  };
}

function guestCall(state, opts, argv) {
  const parsed = parseGuestSsh(argv);
  if (parsed.op === "check") return state.masters.has(parsed.options.ControlPath) ? ok() : ok({ exitCode: 255, stderr: "Control socket connect: No such file or directory\n" });
  if (parsed.op === "exit") return (state.masters.delete(parsed.options.ControlPath), ok());
  const c = [...state.containers.values()].find((x) => x.port === parsed.port && x.running);
  if (!c) return ok({ exitCode: 255, stderr: "ssh: connect to host 127.0.0.1 port 22: Connection refused\n" });
  if (opts.hostKeyChanged) return ok({ exitCode: 255, stderr: "@@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.\n" });
  if (parsed.command === "echo pi-gui-ready") {
    if (state.bootProbes++ < (opts.bootAfter ?? 0)) return ok({ exitCode: 255, stderr: "kex_exchange_identification: read: Connection reset by peer\n" });
    return ok({ stdout: "pi-gui-ready\r\n" });
  }
  const script = parsed.script ?? "";
  state.scripts.push(script);
  if (script.includes("installed.json")) {
    if (state.markerPolls++ < (opts.markerAfter ?? 0)) return ok({ exitCode: 255, stderr: "kex_exchange_identification: Connection closed by remote host\n" });
    const id = opts.foreignMarker ?? c.labels["pi-gui-testing.windows.install"];
    return ok({ stdout: `${JSON.stringify({ installId: id, packageVersion: "0.1.0" })}\r\n` });
  }
  if (script.includes("Get-FileHash")) {
    const dir = /Join-Path '([^']+)' \$p/.exec(script)[1];
    const out = {};
    for (const f of state.helperFiles) {
      const deployed = state.guestFiles.get(`${dir}\\${f.path.replace(/\//g, "\\")}`);
      const installed = dir.endsWith("\\helper") && dir.startsWith("C:\\pi-gui-testing\\helper");
      out[f.path] = deployed ? sha(deployed) : installed && (opts.guestHelper ?? "match") === "match" ? f.sha256 : null;
    }
    return ok({ stdout: `${JSON.stringify(out)}\r\n` });
  }
  if (script.includes("New-Item -ItemType Directory")) return opts.mkdirFails ? ok({ exitCode: 1, stderr: "New-Item : access denied\r\n" }) : ok({ stdout: '{"ok":true}\r\n' });
  return ok({ exitCode: 1, stderr: `fake guest: unknown script ${script.slice(0, 80)}` });
}

function tarChild(state, opts, parsed) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks = [];
  let alive = true;
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  stdin.on("data", (c) => chunks.push(c));
  stdin.on("end", () => {
    const dir = /-C (\S+)/.exec(parsed.command)?.[1];
    const entries = readTar(Buffer.concat(chunks));
    state.tars.push({ dir, command: parsed.command, entries });
    for (const e of entries) if (e.type === "file") state.guestFiles.set(`${dir}\\${e.path.replace(/\//g, "\\")}`, e.data);
    alive = false;
    if (opts.tarFails) stderr.write("tar.exe: Error opening archive\n");
    stdout.end();
    stderr.end();
    resolveExit({ code: opts.tarFails ? 1 : 0, signal: null });
  });
  return { pid: 9100, stdin, stdout, stderr, exited, running: () => alive, kill: (signal) => alive && ((alive = false), stdout.end(), stderr.end(), resolveExit({ code: null, signal })) };
}

function helperChild(state, opts, parsed) {
  const names = /-StdinEnv (\S+)/.exec(parsed.command)[1].split(",");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let child;
  let buffered = "";
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  const record = { command: parsed.command, names, env: undefined };
  state.helpers.push(record);
  const handle = {
    pid: 9200,
    stdin,
    stdout,
    stderr,
    exited,
    running: () => (child ? child.running() : true),
    kill: (signal) => (child ? child.kill(signal) : resolveExit({ code: null, signal })),
  };
  const onData = (chunk) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    if (lines.length <= names.length) return;
    stdin.off("data", onData);
    const env = Object.fromEntries(names.map((n, i) => [n, lines[i]]));
    record.env = env;
    child = new FakeHelperChild(["helper.ps1"], { env }, { handlers: { hello: windowsHello(opts), ...opts.handlers } });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.exited.then((s) => resolveExit(s));
    const rest = lines.slice(names.length).join("\n");
    if (rest) child.stdin.write(rest);
    stdin.on("data", (c) => child.stdin.write(c));
    stdin.on("end", () => child.stdin.end());
  };
  stdin.on("data", onData);
  return handle;
}

export function windowsHello(opts = {}) {
  return (params) => ({
    protocol: params.protocol,
    helperVersion: "0.1.0",
    os: "windows",
    arch: "x64",
    platform: "Windows 10.0.26100 x64; .NET Framework 4.0.30319.42000; PowerShell 5.1.26100.1",
    capabilities: opts.capabilities ?? ["snapshot", "screenshot", "act", "a11y-uia", "desktop-private"],
  });
}

/** Temp root with a config dir, a project, and a client session dir. */
export async function windowsRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "gui-dockwin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "agent", "gui");
  const project = join(root, "project");
  const sessionDir = join(root, "session");
  const helperRoot = join(root, "helper");
  await mkdir(project, { recursive: true });
  await mkdir(sessionDir, { mode: 0o700 });
  await mkdir(join(helperRoot, "src", "win"), { recursive: true });
  await writeFile(join(helperRoot, "helper.ps1"), "param()\r\n");
  await writeFile(join(helperRoot, "THIRD_PARTY_NOTICES.md"), "MIT\n");
  await writeFile(join(helperRoot, "src", "Json.cs"), "class A {}\n");
  await writeFile(join(helperRoot, "src", "win", "Native.cs"), "class B {}\n");
  await writeFile(join(project, "app.ps1"), "Write-Output hi\n");
  return { root, configDir, project, sessionDir, helperRoot, stateDir: join(configDir, "docker-windows") };
}

export function config(shared = {}) {
  return {
    shared: { targets: ["windows"], workspaceMode: "mount", network: "default", ...shared },
    limits: { maxConcurrentSessions: 2, idleTimeoutMinutes: 15 },
    usageCheck: { warnSessionCostUsd: 1, warnDailyCostUsd: 5 },
    keepSandbox: false,
    warnings: [],
  };
}

export { ok };
