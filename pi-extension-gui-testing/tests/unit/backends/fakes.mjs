/**
 * Test doubles for the docker-linux backend: a scripted Docker CLI on top of
 * W1's FakeCommandRunner, a mapper from `docker run`/`create` argv to the
 * `docker inspect` shape, a fake helper that speaks the real framing over
 * in-memory pipes, and a tiny PNG encoder. Nothing here spawns a process.
 */
import { PassThrough } from "node:stream";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { FakeCommandRunner } from "../../../src/runner/fake.ts";

export const HOST = "unix:///var/run/docker.sock";
export const BOOT = "11111111-2222-3333-4444-555555555555";

/** Fake /proc with a boot id and processes `{pid: startTime}`. */
export function fakeProc(root, processes, bootId = BOOT) {
  mkdirSync(join(root, "sys", "kernel", "random"), { recursive: true });
  writeFileSync(join(root, "sys", "kernel", "random", "boot_id"), `${bootId}\n`);
  for (const [pid, start] of Object.entries(processes)) {
    mkdirSync(join(root, pid), { recursive: true });
    const fields = ["S", "1", ...Array.from({ length: 17 }, (_, i) => String(i)), String(start), "0", "0"];
    writeFileSync(join(root, pid, "stat"), `${pid} (pi) ${fields.join(" ")}\n`);
  }
}

const VALUE_FLAGS = new Set(["--name", "--label", "--user", "--cap-drop", "--cap-add", "--security-opt", "--network", "--tmpfs", "-v", "-e", "--shm-size", "--pull", "--ipc", "--pid", "--userns", "--device", "--entrypoint", "--cidfile"]);

/** Parses `docker [--host h] run|create …flags image [cmd…]`. */
export function parseRunArgv(argv) {
  let i = argv.indexOf("run");
  if (i === -1) i = argv.indexOf("create");
  const flags = [];
  let image;
  for (i = i + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      flags.push([arg, argv[++i]]);
    } else if (arg.startsWith("-")) {
      flags.push([arg, true]);
    } else {
      image = arg;
      break;
    }
  }
  const all = (name) => flags.filter(([f]) => f === name).map(([, v]) => v);
  const one = (name) => all(name).at(-1);
  return { flags, image, all, one, rest: argv.slice(i + 1) };
}

/** What `docker container inspect` would report for a container created from `argv`. */
export function inspectFromArgv(argv, cliEnv = {}) {
  const p = parseRunArgv(argv);
  const env = [];
  for (const e of p.all("-e")) {
    if (e.includes("=")) env.push(e);
    else if (cliEnv[e] !== undefined) env.push(`${e}=${cliEnv[e]}`);
  }
  env.push("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  const binds = p.all("-v");
  return {
    Name: `/${p.one("--name")}`,
    Config: { Env: env, Image: p.image, Labels: Object.fromEntries(p.all("--label").map((l) => l.split(/=(.*)/s).slice(0, 2))) },
    HostConfig: {
      Privileged: p.flags.some(([f]) => f === "--privileged"),
      NetworkMode: p.one("--network") ?? "bridge",
      IpcMode: p.one("--ipc") ?? "private",
      PidMode: p.one("--pid") ?? "",
      UsernsMode: p.one("--userns") ?? "",
      CapAdd: p.all("--cap-add").length ? p.all("--cap-add") : null,
      CapDrop: p.all("--cap-drop"),
      SecurityOpt: p.all("--security-opt"),
      Devices: p.all("--device").map((d) => ({ PathOnHost: d, PathInContainer: d, CgroupPermissions: "rwm" })),
      Binds: binds,
      ShmSize: p.one("--shm-size") === "512m" ? 512 * 1024 * 1024 : 64 * 1024 * 1024,
      Tmpfs: Object.fromEntries(p.all("--tmpfs").map((t) => [t.split(":")[0], t.split(":").slice(1).join(":")])),
      AutoRemove: p.flags.some(([f]) => f === "--rm"),
    },
    Mounts: binds.map((b) => ({ Type: "bind", Source: b.split(":")[0], Destination: b.split(":")[1], RW: !b.endsWith(":ro") })),
  };
}

export const HEALTHY_INFO = {
  ServerVersion: "29.9.1",
  OSType: "linux",
  Architecture: "x86_64",
  SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
};

/**
 * A FakeCommandRunner scripted as a healthy local rootful Docker 29 with the
 * base image present. Options override pieces; `state` records created
 * containers so `container inspect` answers from their argv.
 */
export function fakeDocker(overrides = {}) {
  const runner = new FakeCommandRunner();
  const state = {
    containers: new Map(),
    removed: [],
    imageMissing: overrides.imageMissing ?? false,
    imageId: overrides.imageId ?? "sha256:35eede0900000000000000000000000000000000000000000000000000000000",
  };
  const version = overrides.version ?? "0.1.0";
  const imageLabels = overrides.imageLabels ?? { "pi-gui-testing.base": "true", "pi-gui-testing.version": version, "pi-gui-testing.protocol": "1" };
  const host = (re) => new RegExp(`^docker --host ${HOST.replace(/[/.]/g, "\\$&")} ${re}`);
  runner
    .on(["docker", "--version"], { stdout: "Docker version 29.9.1, build abcdef0\n" })
    .on(["docker", "context", "inspect", "--format", "{{json .}}"], {
      stdout: `${JSON.stringify({ Name: overrides.contextName ?? "default", Endpoints: { docker: { Host: overrides.contextHost ?? HOST } } })}\n`,
    })
    .on(host("info --format"), overrides.info instanceof Error || typeof overrides.info === "function" ? overrides.info : { stdout: JSON.stringify(overrides.info ?? HEALTHY_INFO) })
    .on(host("version --format"), { stdout: `${overrides.serverVersion ?? "29.9.1"}\n` })
    .on(host("image inspect"), () =>
      state.imageMissing
        ? { exitCode: 1, stderr: "Error response from daemon: No such image: pi-gui-testing-base:0.1.0" }
        : { stdout: JSON.stringify({ Id: state.imageId, Architecture: "amd64", Config: { Labels: imageLabels } }) })
    .on(host("(ps|volume ls|network ls) "), (argv) => {
      const joined = argv.join(" ");
      if (!joined.includes(" ps ")) return { stdout: overrides.listVolumes ?? "" };
      const filter = /label=pi-gui-testing\.session(?:=(\S+))?/.exec(joined);
      const lines = [];
      for (const [name, c] of state.containers) {
        if (filter?.[1] && c.session !== filter[1]) continue;
        lines.push([c.id, name, c.session, c.owner].join("\t"));
      }
      return { stdout: [...lines, ...(overrides.extraContainers ?? [])].join("\n") };
    })
    .on(host("(rm -f|volume rm|network rm) "), (argv) => {
      const id = argv.at(-1);
      state.removed.push(id);
      for (const [name, c] of state.containers) if (name === id || c.id === id) state.containers.delete(name);
      return {};
    })
    .on(host("create "), (argv) => {
      const p = parseRunArgv(argv);
      const name = p.one("--name");
      const labels = Object.fromEntries(p.all("--label").map((l) => l.split(/=(.*)/s).slice(0, 2)));
      state.containers.set(name, { id: `id-${name}`, argv, session: labels["pi-gui-testing.session"], owner: labels["pi-gui-testing.owner"], inspect: overrides.mutateInspect ? overrides.mutateInspect(inspectFromArgv(argv)) : inspectFromArgv(argv) });
      return { stdout: `id-${name}\n` };
    })
    .on(host("container inspect "), (argv) => {
      const name = argv.at(-1);
      const container = state.containers.get(name);
      if (!container) return { exitCode: 1, stderr: `Error: No such container: ${name}` };
      return { stdout: JSON.stringify([container.inspect]) };
    })
    .on(host("run --rm --pull never --network none --name pi-gui-testing-probe"), (argv) => {
      // docker.bind-uid probe: the container touches /probe/owned in the bind-mounted dir.
      const bind = parseRunArgv(argv).all("-v").find((v) => v.endsWith(":/probe"));
      if (overrides.bindProbe) return overrides.bindProbe(argv, bind);
      writeFileSync(join(bind.split(":")[0], "owned"), "");
      return {};
    });
  return { runner, state };
}

/** Registers a running session container in `state` (what `docker run` would create). */
export function addContainer(state, argv, cliEnv) {
  const p = parseRunArgv(argv);
  const name = p.one("--name");
  const labels = Object.fromEntries(p.all("--label").map((l) => l.split(/=(.*)/s).slice(0, 2)));
  state.containers.set(name, { id: `id-${name}`, argv, session: labels["pi-gui-testing.session"], owner: labels["pi-gui-testing.owner"], inspect: inspectFromArgv(argv, cliEnv) });
}

/** Encodes RGB pixels from `pixel(x, y) → [r, g, b]` as an 8-bit RGB PNG. */
export function encodePng(width, height, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, sum]);
  };
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export const SMOKE_TREE = [
  { ref: "s1:0", role: "frame", name: "Pi GUI smoke", states: ["showing"] },
  { ref: "s1:1", role: "label", name: "Waiting", states: ["showing"], parent: "s1:0" },
  { ref: "s1:2", role: "push button", name: "Press me", states: ["showing", "focusable"], parent: "s1:0", bounds: { x: 10, y: 20, width: 80, height: 30 } },
];

/**
 * In-memory helper speaking the real framing: READY line, token-prefixed
 * JSON lines, `log` events, EOF teardown. `handlers` override methods; a
 * handler may return `{ error: { code, message } }` or a Promise.
 */
export class FakeHelperChild {
  constructor(argv, options = {}, behaviour = {}) {
    this.argv = [...argv];
    this.env = options.env ?? {};
    this.pid = behaviour.pid ?? 4242;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.requests = [];
    this.unanswered = new Set();
    this.signals = [];
    this.alive = true;
    this.behaviour = behaviour;
    this.capture = 0;
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
    const token = this.env.PI_GUI_TESTING_TOKEN;
    let buffered = "";
    this.stdin.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) if (line.startsWith(`${token} `)) void this.#handle(token, JSON.parse(line.slice(token.length + 1)));
    });
    this.stdin.on("finish", () => this.exit(0));
    behaviour.onSpawn?.(this);
    if (!behaviour.noReady) setImmediate(() => this.alive && this.stdout.write(`motd noise\nPI-GUI-TESTING-READY ${token}\n`));
  }

  running() {
    return this.alive;
  }

  kill(signal) {
    this.signals.push(signal);
    this.exit(null, signal);
  }

  exit(code, signal = null) {
    if (!this.alive) return;
    this.alive = false;
    this.stdout.end();
    this.stderr.end();
    this.resolveExit({ code, signal });
  }

  log(source, stream, data) {
    const token = this.env.PI_GUI_TESTING_TOKEN;
    this.stdout.write(`${token} ${JSON.stringify({ event: "log", stream, source, data })}\n`);
  }

  async #handle(token, request) {
    this.requests.push(request);
    const handler = this.behaviour.handlers?.[request.method] ?? DEFAULT_HANDLERS[request.method];
    let result;
    try {
      result = handler ? await handler(request.params, this) : { error: { code: "BAD_REQUEST", message: `unknown method ${request.method}` } };
    } catch (error) {
      result = { error: { code: "INTERNAL", message: error.message } };
    }
    if (result === NO_ANSWER) {
      this.unanswered.add(request.id);
      return;
    }
    if (!this.alive) return;
    if (request.method === "cancel" && this.unanswered.delete(request.params.targetId)) {
      // Like the real helper: the cancelled request answers CANCELLED.
      this.stdout.write(`${token} ${JSON.stringify({ id: request.params.targetId, ok: false, error: { code: "CANCELLED", message: "cancelled" } })}\n`);
    }
    const message = result && result.error ? { id: request.id, ok: false, error: result.error } : { id: request.id, ok: true, result };
    this.stdout.write(`${token} ${JSON.stringify(message)}\n`);
    if (request.method === "stop" || (request.method === "hello" && result?.error?.code === "PROTOCOL_MISMATCH")) setImmediate(() => this.exit(0));
  }
}

/** Returned by a handler that never answers. */
export const NO_ANSWER = Symbol("no answer");

const DEFAULT_HANDLERS = {
  hello: (params) => ({ protocol: params.protocol, helperVersion: "0.1.0", os: "linux", arch: "x86_64", capabilities: ["snapshot", "screenshot", "act"] }),
  ping: () => ({ ok: true }),
  launch: () => ({ pid: 77, windows: [{ ref: "win:0x1", title: "Pi GUI smoke", bounds: { x: 0, y: 0, width: 320, height: 160 } }] }),
  wait: () => ({ matched: true, elapsedMs: 5 }),
  snapshot: (params) => ({ snapshotId: "s1", coverage: "full", tree: SMOKE_TREE.slice(0, params.maxNodes), truncated: params.maxNodes < SMOKE_TREE.length }),
  snapshotFull: async () => {
    const { gzipSync } = await import("node:zlib");
    return { tree_gz_base64: gzipSync(JSON.stringify(SMOKE_TREE)).toString("base64") };
  },
  screenshot: (params, child) => {
    child.capture++;
    const width = 64;
    const height = 40;
    const scale = params.maxEdge && params.maxEdge < width ? params.maxEdge / width : 1;
    const png = encodePng(Math.round(width * scale), Math.round(height * scale), (x, y) => (x < 10 ? [255, 0, 0] : [y, x, 128]));
    return { captureId: `c${child.capture}`, target: params.window ?? "screen", origin: { x: 0, y: 0 }, width, height, scale, png_base64: png.toString("base64"), sha256: child.behaviour.sha?.(child.capture) ?? `sha-${child.capture}` };
  },
  act: () => ({ ok: true }),
  windows: () => ({ windows: [] }),
  exec: (params, child) => {
    child.log("setup", "stdout", `ran ${params.cmd}\n`);
    return { exitCode: 0, elapsedMs: 1 };
  },
  cancel: () => ({ ok: true }),
  stop: () => ({ ok: true, leftovers: [] }),
};

/** A Spawner whose children are {@link FakeHelperChild}s; `onSpawn` sees each argv (e.g. to register the container). */
export function fakeSpawner(behaviour = {}) {
  const children = [];
  return {
    children,
    spawn(argv, options = {}) {
      if (behaviour.spawnError) {
        const child = new FakeHelperChild(argv, options, { ...behaviour, noReady: true });
        child.pid = undefined;
        child.alive = false;
        child.stdout.end();
        child.stderr.end();
        child.resolveExit({ code: null, signal: null, error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) });
        children.push(child);
        return child;
      }
      const child = new FakeHelperChild(argv, options, behaviour);
      children.push(child);
      return child;
    },
  };
}
