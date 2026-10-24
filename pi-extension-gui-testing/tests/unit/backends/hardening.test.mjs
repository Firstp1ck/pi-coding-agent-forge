import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISPLAY_PATTERN, ELECTRON_SHM_SIZE, FORBIDDEN_ENV, FORBIDDEN_MOUNT_PATHS, NON_HOST_MODES, REQUIRED_RUN_FLAGS } from "../../../src/hardening.ts";
import { bindSources, forbiddenBindReason, hardRuleViolations, resolveHostPath } from "../../../src/backends/docker/inspect.ts";
import { mkdir as mkdirp, symlink } from "node:fs/promises";
import { containerName, dockerCreateArgs, dockerRunArgs, identityFiles, isChromiumLike, shmSizeFor, writeIdentityFiles } from "../../../src/backends/docker/run-args.ts";
import { inspectFromArgv, parseRunArgv } from "./fakes.mjs";

/** Path probe without touching the host: a symlink map and a set of socket paths. */
function probe(links = {}, sockets = []) {
  return {
    realpath: (p) => links[p] ?? p,
    isSocket: (p) => sockets.includes(p),
  };
}
const plain = probe({ "/var/run": "/run" });

function sessionInput(overrides = {}) {
  return {
    sessionId: "gui-1234abcd",
    ownerLabel: "c1:100:5000:boot",
    image: "pi-gui-testing-base:0.1.0",
    uid: 1234,
    gid: 2345,
    sessionDir: "/tmp/pi-gui-testing-abc",
    workspace: { source: "/home/u/project", readOnly: true },
    network: "default",
    ...overrides,
  };
}

const compliant = () => inspectFromArgv(["docker", "--host", "unix:///var/run/docker.sock", ...dockerRunArgs(sessionInput())], { PI_GUI_TESTING_TOKEN: "f".repeat(32) });

test("the production docker run argv satisfies every hard rule", () => {
  assert.deepEqual(hardRuleViolations(compliant(), plain), []);
  for (const network of ["default", "none"]) {
    for (const shmSize of [undefined, ELECTRON_SHM_SIZE]) {
      const argv = dockerRunArgs(sessionInput({ network, shmSize, workspace: { source: "/tmp/pi-gui-testing-abc/workspace", readOnly: false } }));
      assert.deepEqual(hardRuleViolations(inspectFromArgv(argv), plain), [], `${network} ${shmSize}`);
    }
  }
});

test("docker run argv: helper entrypoint container, labels, uid-owned tmpfs layout, read-only identity files, token without value", () => {
  const args = dockerRunArgs(sessionInput({ heartbeatTimeoutMs: 3000, shmSize: "512m", network: "none" }));
  assert.deepEqual(args.slice(0, 3), ["run", "-i", "--rm"]);
  const p = parseRunArgv(["docker", ...args]);
  assert.equal(p.image, "pi-gui-testing-base:0.1.0");
  assert.deepEqual(p.rest, [], "no CMD: the image entrypoint (tini → helper) runs");
  assert.equal(p.one("--name"), containerName("gui-1234abcd"));
  assert.deepEqual(p.all("--label"), ["pi-gui-testing.session=gui-1234abcd", "pi-gui-testing.owner=c1:100:5000:boot"]);
  assert.equal(p.one("--user"), "1234:2345");
  assert.equal(p.one("--pull"), "never");
  for (let i = 0; i < REQUIRED_RUN_FLAGS.length; i += 2) assert.ok(args.join(" ").includes(`${REQUIRED_RUN_FLAGS[i]} ${REQUIRED_RUN_FLAGS[i + 1]}`));
  assert.equal(p.one("--network"), "none");
  assert.equal(p.one("--shm-size"), "512m");
  const tmpfs = Object.fromEntries(p.all("--tmpfs").map((t) => [t.split(":")[0], t.split(":")[1]]));
  assert.deepEqual(Object.keys(tmpfs).sort(), ["/deps", "/home/app", "/run/user/1234", "/scratch", "/tmp"]);
  for (const options of Object.values(tmpfs)) assert.match(options, /uid=1234,gid=2345,mode=\d+/);
  assert.match(tmpfs["/run/user/1234"], /mode=0700/);
  assert.match(tmpfs["/deps"], /exec/);
  assert.deepEqual(p.all("-v"), [
    "/tmp/pi-gui-testing-abc/passwd:/etc/passwd:ro",
    "/tmp/pi-gui-testing-abc/group:/etc/group:ro",
    "/home/u/project:/workspace:ro",
  ]);
  const env = p.all("-e");
  assert.ok(env.includes("PI_GUI_TESTING_TOKEN"), "token name only; the value comes from the CLI environment");
  assert.ok(!env.some((e) => e.startsWith("PI_GUI_TESTING_TOKEN=")));
  assert.ok(env.includes("HOME=/home/app"));
  assert.ok(env.includes("XDG_RUNTIME_DIR=/run/user/1234"));
  assert.ok(env.includes("PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS=3000"));
  assert.ok(!env.some((e) => /^(DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS)/.test(e)));
  assert.ok(!dockerRunArgs(sessionInput()).includes("--network"), "default network leaves Docker's bridge");
  assert.ok(!dockerRunArgs(sessionInput()).some((a) => a.startsWith("PI_GUI_TESTING_HEARTBEAT")), "no test override in production");
  assert.deepEqual(dockerCreateArgs(sessionInput()).slice(0, 3), ["create", "-i", "--rm"]);
  assert.deepEqual(dockerCreateArgs(sessionInput()).slice(1), dockerRunArgs(sessionInput()).slice(1));
});

test("identity files map the host uid/gid (also uid 0 and non-1000 ids)", async (t) => {
  assert.deepEqual(identityFiles(4321, 8765), {
    passwd: "root:x:0:0:root:/root:/usr/sbin/nologin\napp:x:4321:8765:app:/home/app:/bin/sh\n",
    group: "root:x:0:\napp:x:8765:\n",
  });
  assert.equal(identityFiles(0, 0).passwd, "root:x:0:0:root:/home/app:/bin/sh\n");
  const dir = await mkdtemp(join(tmpdir(), "gui-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeIdentityFiles(dir, 4321, 8765);
  assert.match(await readFile(join(dir, "passwd"), "utf8"), /app:x:4321:8765/);
});

test("Electron/Chromium launches get --shm-size 512m; others keep Docker's default", () => {
  assert.equal(shmSizeFor("./node_modules/.bin/electron", [".", "--no-sandbox"]), "512m");
  assert.equal(shmSizeFor("npx", ["electron", "."]), "512m");
  assert.equal(shmSizeFor("node", ["node_modules/electron/cli.js", "."]), "512m");
  assert.equal(shmSizeFor("chromium", []), "512m");
  assert.equal(shmSizeFor("python3", ["app.py"]), undefined);
  assert.equal(shmSizeFor("npm", ["start"]), undefined, "npm start launches are not detected (documented limitation)");
  assert.equal(isChromiumLike(undefined), false);
});

function violate(mutate) {
  const inspect = compliant();
  mutate(inspect);
  return hardRuleViolations(inspect, plain);
}

test("isolation.inspect rejects every hard-rule violation (spec §4.1 list, one negative per rule)", () => {
  const cases = [
    ["privileged", (i) => (i.HostConfig.Privileged = true)],
    ["privileged", (i) => delete i.HostConfig.Privileged],
    ...NON_HOST_MODES.map((mode) => ["host-mode", (i) => (i.HostConfig[mode] = "host")]),
    ["capabilities", (i) => (i.HostConfig.CapAdd = ["NET_ADMIN"])],
    ["capabilities", (i) => (i.HostConfig.CapDrop = ["NET_RAW"])],
    ["capabilities", (i) => (i.HostConfig.CapDrop = null)],
    ["no-new-privileges", (i) => (i.HostConfig.SecurityOpt = [])],
    ["no-new-privileges", (i) => (i.HostConfig.SecurityOpt = ["no-new-privileges:false"])],
    ["devices", (i) => (i.HostConfig.Devices = [{ PathOnHost: "/dev/kvm" }])],
    ["devices", (i) => (i.HostConfig.DeviceRequests = [{ Driver: "nvidia" }])],
    ["devices", (i) => (i.HostConfig.DeviceCgroupRules = ["c 1:3 mr"])],
    ...FORBIDDEN_MOUNT_PATHS.map((path) => ["forbidden-mount", (i) => i.HostConfig.Binds.push(`${path}:/x:ro`)]),
    ["forbidden-mount", (i) => i.HostConfig.Binds.push("/tmp:/x:ro")],
    ["forbidden-mount", (i) => i.HostConfig.Binds.push("/:/host:ro")],
    ["forbidden-mount", (i) => i.HostConfig.Binds.push("/tmp/.X11-unix/X0:/tmp/.X11-unix/X0")],
    ["forbidden-mount", (i) => i.HostConfig.Binds.push("/run/user/1000:/run/user/1000")],
    ["forbidden-mount", (i) => i.HostConfig.Binds.push("/run/containerd:/c")],
    ["forbidden-mount", (i) => i.Mounts.push({ Type: "bind", Source: "/var/run" })],
    ["forbidden-mount", (i) => (i.HostConfig.Mounts = [{ Type: "bind", Source: "/run/dbus" }])],
    ["docker-socket", (i) => i.HostConfig.Binds.push("/var/run/docker.sock:/var/run/docker.sock")],
    ["docker-socket", (i) => i.HostConfig.Binds.push("/home/u/.docker/run/docker.sock:/d.sock")],
    ...FORBIDDEN_ENV.map((name) => ["forbidden-env", (i) => i.Config.Env.push(`${name}=x`)]),
    ["display", (i) => i.Config.Env.push("DISPLAY=:0.0")],
    ["display", (i) => i.Config.Env.push("DISPLAY=host:0")],
    ["display", (i) => i.Config.Env.push("DISPLAY=unix:0")],
  ];
  for (const [rule, mutate] of cases) {
    const violations = violate(mutate);
    assert.ok(violations.some((v) => v.rule === rule), `${rule} via ${mutate}: ${JSON.stringify(violations)}`);
  }
  assert.deepEqual(violate((i) => i.Config.Env.push("DISPLAY=:99")), []);
  assert.ok(DISPLAY_PATTERN.test(":1"));
});

test("several violations are all reported, not only the first", () => {
  const violations = violate((i) => {
    i.HostConfig.Privileged = true;
    i.HostConfig.NetworkMode = "host";
    i.HostConfig.PidMode = "host";
    i.Config.Env.push("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus");
  });
  assert.deepEqual(violations.map((v) => v.rule).sort(), ["forbidden-env", "host-mode", "host-mode", "privileged"]);
});

test("bind sources are judged after resolving symlinks and when they are sockets", () => {
  const links = probe({ "/home/u/innocent": "/tmp/.X11-unix", "/home/u/dsock": "/run/docker.sock", "/var/run": "/run" }, ["/home/u/project/agent.sock"]);
  assert.equal(forbiddenBindReason("/home/u/innocent", links).rule, "forbidden-mount");
  assert.equal(forbiddenBindReason("/home/u/dsock", links).rule, "docker-socket");
  assert.match(forbiddenBindReason("/home/u/project/agent.sock", links).observed, /Unix socket/);
  assert.equal(forbiddenBindReason("/home/u/project", links), undefined);
  // A private dir below a user's runtime dir (e.g. TMPDIR there) is allowed; the runtime dir itself is not.
  assert.equal(forbiddenBindReason("/run/user/1000/pi-gui-testing-x/passwd", links), undefined);
  assert.equal(forbiddenBindReason("/run/user/1000", links).rule, "forbidden-mount");
  assert.deepEqual(bindSources({ HostConfig: { Binds: ["named-volume:/data", "/a:/b:ro"] }, Mounts: [{ Type: "volume", Source: "/var/lib/docker/volumes/x" }, { Type: "bind", Source: "/c" }] }), ["/a", "/c"]);
});

test("host path resolution follows links whose targets do not exist", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gui-resolve-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink("/nonexistent-pi-gui/.X11-unix", join(dir, "dangling"));
  await mkdirp(join(dir, "real"));
  await symlink(join(dir, "real"), join(dir, "hop"));
  await symlink(join(dir, "hop", "missing"), join(dir, "chain"));
  assert.equal(resolveHostPath(join(dir, "dangling")), "/nonexistent-pi-gui/.X11-unix");
  assert.equal(resolveHostPath(join(dir, "chain")), join(await (await import("node:fs/promises")).realpath(dir), "real", "missing"));
  await symlink("/tmp/.X11-unix", join(dir, "x11"));
  assert.equal(forbiddenBindReason(join(dir, "x11")).rule, "forbidden-mount");
});
