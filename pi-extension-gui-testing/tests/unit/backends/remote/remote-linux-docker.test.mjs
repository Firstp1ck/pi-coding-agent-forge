/**
 * `remote-linux-docker` with a scripted ssh whose remote side is the fake
 * Docker CLI of the docker-linux tests: every docker command goes through
 * ssh (none runs locally), the hardened run argv binds the remote session
 * dir, inspect uses remote path resolution, the build context streams over
 * ssh, teardown removes container, dir, and ControlMaster, failed starts
 * clean up, and remote orphans are judged per owner (foreign owners kept).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionError } from "../../../../src/backend.ts";
import { hasImage, hasReset } from "../../../../src/backends/capabilities.ts";
import { RemoteLinuxDockerBackend } from "../../../../src/backends/remote-linux-docker.ts";
import { AUDIT_SCRIPT, CREATE_SCRIPT, LIST_SCRIPT, REMOVE_SCRIPT } from "../../../../src/backends/remote/session-dir.ts";
import { PATH_PROBE_SCRIPT, decideDockerOrphans } from "../../../../src/backends/remote/docker.ts";
import { readTar } from "../../transport/ssh/fake-ssh.mjs";
import { FakeSsh } from "../../transport/ssh/fake-ssh.mjs";
import { addContainer, BOOT, fakeDocker, fakeProc, FakeHelperChild, HOST, parseRunArgv } from "../fakes.mjs";

const BASE = "/run/user/1000/pi-gui-testing";
const OWNER = `c1:100:5000:${BOOT}`;

/** Scripted remote: session-dir scripts, path probe, and the fake Docker CLI. */
function remoteHost(options = {}) {
  const docker = fakeDocker(options.docker ?? {});
  const dirs = new Set();
  const runner = docker.runner;
  runner
    .on((argv) => argv[0] === "/bin/sh" && argv[2] === CREATE_SCRIPT, (argv) => {
      const name = argv[4];
      if (dirs.has(name)) return { exitCode: 3, stdout: `error=cannot create ${BASE}/${name}\n` };
      dirs.add(name);
      return { stdout: [`base=${BASE}`, `dir=${BASE}/${name}`, "uid=1000", "gid=1000", "workspace_id=64768 4242", "free_kb=99999999"].join("\n") };
    })
    .on((argv) => argv[0] === "/bin/sh" && argv[2]?.endsWith(REMOVE_SCRIPT), (argv) => {
      if (options.removeFails?.()) return { exitCode: 255, stderr: "Connection refused" };
      for (const name of argv.slice(5)) dirs.delete(name);
      return {};
    })
    .on((argv) => argv[0] === "/bin/sh" && argv[2] === AUDIT_SCRIPT, (argv) => ({ stdout: dirs.has(argv[4]) ? `dir=${BASE}/${argv[4]}\n` : "" }))
    .on((argv) => argv[0] === "/bin/sh" && argv[2] === LIST_SCRIPT, () => ({ stdout: "" }))
    .on((argv) => argv[0] === "/bin/sh" && argv[2] === PATH_PROBE_SCRIPT, (argv) => ({ stdout: argv.slice(4).map((p) => `${p}\t${p}\t0`).join("\n") }))
    .on((argv) => argv[0] === "docker" && argv.includes("ps") && argv.includes("status=running"), () => ({
      stdout: [...docker.state.containers.entries()].map(([name, c]) => `${c.id}\t${name}`).join("\n"),
    }));
  const fake = new FakeSsh({
    remote: runner,
    helper: (argv, opts) => {
      const child = new FakeHelperChild(argv, opts, options.behaviour ?? {});
      addContainer(docker.state, argv, opts.env);
      const name = parseRunArgv(argv).one("--name");
      void child.exited.then(() => docker.state.containers.delete(name));
      return child;
    },
  });
  return { fake, docker, dirs };
}

async function env(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pgt-rld-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "app.py"), "print(1)\n");
  const host = remoteHost(options);
  const backend = new RemoteLinuxDockerBackend({
    ownerLabel: () => OWNER,
    host: "raspi5",
    runner: host.fake.runner,
    spawner: host.fake.spawner,
    detached: host.fake.detached,
    version: "0.1.0",
    syncMethod: "tar",
    shm: "never",
    readyTimeoutMs: 3_000,
    procRoot: options.procRoot,
  });
  const sessionDir = join(root, "pi-gui-testing-x");
  await mkdir(sessionDir, { mode: 0o700 });
  const recorded = [];
  const exitArgvs = [];
  const start = (shared = {}, extra = {}) =>
    backend.startSession({
      sessionId: "gui-dock0001",
      projectRoot: project,
      sessionDir,
      config: {
        shared: { targets: ["linux"], workspaceMode: "mount", network: "none", setup: ["npm ci"], ...shared },
        limits: { maxConcurrentSessions: 2, idleTimeoutMinutes: 15 },
        usageCheck: { warnSessionCostUsd: 1, warnDailyCostUsd: 5 },
        keepSandbox: false,
        warnings: [],
        ...extra,
      },
      ownerLabel: OWNER,
      recordResource: async (kind, id) => void recorded.push([kind, id]),
      onLog: () => {},
      signal: new AbortController().signal,
      onExitCleanup: (argv) => void exitArgvs.push(argv),
    });
  return { root, backend, ...host, start, recorded, exitArgvs, sessionDir };
}

const p0 = (argv) => parseRunArgv(argv);

test("a session runs every docker command on the remote host and binds the synced session dir", async (t) => {
  const e = await env(t);
  const session = await e.start();
  assert.equal(e.fake.local.calls.filter((c) => c.argv[0] === "docker").length, 0, "no local docker");
  const [name] = e.dirs;
  const dir = `${BASE}/${name}`;
  const run = e.fake.spawns.find((s) => s.decoded.kind === "helper");
  assert.equal(run.destination, "raspi5");
  const argv = run.decoded.argv;
  assert.deepEqual(argv.slice(0, 4), ["docker", "--host", HOST, "run"]);
  assert.deepEqual(run.decoded.session, { dir, name }, "docker run runs under the remote cleanup wrapper of the synced dir");
  assert.deepEqual(run.decoded.container, { host: HOST, name: p0(argv).one("--name") }, "the wrapper removes the session container first");
  const p = parseRunArgv(argv);
  assert.ok(p.all("-v").includes(`${dir}/workspace:/workspace:ro`));
  assert.ok(p.all("-v").includes(`${dir}/passwd:/etc/passwd:ro`));
  assert.equal(p.one("--user"), "1000:1000", "the SSH user's uid/gid");
  assert.equal(p.one("--network"), "none");
  assert.ok(p.all("-e").includes("PI_GUI_TESTING_TOKEN"), "token from the remote CLI environment");
  assert.equal(run.argv.join(" ").includes(run.env.PI_GUI_TESTING_TOKEN), false, "token not in any argv");
  assert.match(run.env.PI_GUI_TESTING_TOKEN, /^[0-9a-f]{32}$/);
  assert.ok(e.fake.files.has(`${dir}/passwd`) && e.fake.files.has(`${dir}/workspace/app.py`));
  assert.match(e.fake.files.get(`${dir}/passwd`).toString(), /app:x:1000:1000:app:\/home\/app/);
  assert.equal(session.workspacePath, "/workspace");
  assert.deepEqual(e.recorded.map(([k]) => k), ["ssh-master", "remote-dir", "container"]);
  const helper = [...e.docker.state.containers.values()][0];
  assert.ok(helper);
  const exitArgv = e.exitArgvs.at(-1);
  assert.match(exitArgv.at(-1), /docker --host "\$1" rm -f "\$2"/);

  assert.deepEqual(await session.stop(), []);
  assert.equal(e.docker.state.containers.size, 0);
  assert.equal(e.dirs.size, 0);
  assert.equal(e.fake.masters.size, 0, "ControlMaster closed");
  assert.deepEqual(await session.auditFootprint(), []);
});

test("an isolation violation found by the remote inspect fails closed and removes everything", async (t) => {
  const e = await env(t, { docker: {} });
  // Make the container report a forbidden bind (the remote docker.sock).
  const original = e.fake.helper;
  e.fake.helper = (argv, opts, record) => {
    const child = original(argv, opts, record);
    const [container] = e.docker.state.containers.values();
    container.inspect.HostConfig.Binds.push("/var/run/docker.sock:/var/run/docker.sock");
    container.inspect.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" });
    return child;
  };
  await assert.rejects(e.start(), (error) => error instanceof SessionError && error.code === "ISOLATION");
  assert.equal(e.dirs.size, 0);
  assert.equal(e.docker.state.containers.size, 0);
});

test("a remote removal failure stays attached to the failed start and is retryable", async (t) => {
  let fail = true;
  const e = await env(t, { removeFails: () => fail, behaviour: { handlers: { exec: (p) => ({ exitCode: p.cmd === "npm ci" ? 1 : 0, elapsedMs: 1 }) } } });
  const error = await e.start().catch((x) => x);
  assert.equal(error.code, "SETUP_FAILED");
  assert.match(error.message, /exited with 1 on the remote host/);
  const { startLeftovers } = await import("../../../../src/backends/start-failure.ts");
  const remnant = startLeftovers(error);
  assert.ok(remnant.leftovers.some((l) => l.kind === "remote-dir"));
  fail = false;
  assert.deepEqual(await remnant.session.stop(), []);
  assert.equal(e.dirs.size, 0);
});

test("passwordlessSudo asks the remote host, not the client", async (t) => {
  const e = await env(t);
  e.docker.runner.on(["sudo", "-n", "true"], { exitCode: 1, stderr: "sudo: a password is required" });
  assert.equal(await e.backend.passwordlessSudo(), false);
  e.docker.runner.on(["sudo", "-n", "true"], {});
  assert.equal(await e.backend.passwordlessSudo(), true);
  assert.equal(e.fake.calls.at(-1).destination, "raspi5");
  assert.equal(e.fake.local.calls.some((c) => c.argv[0] === "sudo"), false);
});

test("buildImage streams the tooling-only context over ssh to docker build on the remote host", async (t) => {
  const e = await env(t);
  let context;
  e.fake.onStream = async (decoded, input) => {
    context = { argv: decoded.argv, entries: readTar(input).map((x) => x.path) };
    return { exitCode: 0, stdout: "Successfully tagged\n" };
  };
  assert.ok(hasImage(e.backend) && hasReset(e.backend));
  const result = await e.backend.buildImage(new AbortController().signal);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(context.argv.slice(0, 4), ["docker", "--host", HOST, "build"]);
  assert.equal(context.argv.at(-1), "-");
  assert.ok(context.entries.includes("Dockerfile") && context.entries.includes("helper"));
  assert.equal(context.entries.some((p) => p.includes("app.py") && !p.startsWith("testapps/")), false, "no project files");
});

test("remote Docker orphans: dead owners of this boot are removed; foreign running containers are kept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pgt-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fakeProc(root, { 100: 5000 });
  const extra = [
    ["id-dead", "pi-gui-testing-dead", "dead", `c9:999:1:${BOOT}`].join("\t"),
    ["id-foreign", "pi-gui-testing-foreign", "foreign", "c8:5:6:other-boot"].join("\t"),
    ["id-foreign-stopped", "pi-gui-testing-stopped", "stopped", "c8:5:7:other-boot"].join("\t"),
    ["id-alive", "pi-gui-testing-alive", "alive", OWNER].join("\t"),
  ];
  const e = await env(t, { docker: { extraContainers: extra }, procRoot: root });
  e.docker.runner.on((argv) => argv[0] === "docker" && argv.includes("ps") && argv.includes("status=running"), () => ({ stdout: "id-foreign\tpi-gui-testing-foreign\nid-alive\tpi-gui-testing-alive\n" }));
  const { resolveEndpoint } = await import("../../../../src/backends/docker/cli.ts");
  const remote = e.backend.oneShot("raspi5").runner;
  const endpoint = await resolveEndpoint(remote, { source: {} });
  const decisions = Object.fromEntries((await decideDockerOrphans(remote, endpoint, { procRoot: root })).map((d) => [d.object.name, d.action]));
  assert.deepEqual(decisions, { "pi-gui-testing-dead": "remove", "pi-gui-testing-foreign": "keep", "pi-gui-testing-stopped": "report", "pi-gui-testing-alive": "keep" });
  const leftovers = await e.backend.sweepOrphans(new AbortController().signal);
  assert.ok(e.docker.state.removed.includes("id-dead"));
  assert.equal(e.docker.state.removed.includes("id-foreign"), false);
  assert.ok(leftovers.some((l) => l.id === "pi-gui-testing-stopped" && /another client/.test(l.detail)));
  const audit = await e.backend.auditOrphans(new AbortController().signal);
  assert.ok(audit.every((l) => l.id !== "pi-gui-testing-alive"));
});

/** Base images on the fake remote: `image ls` lists them, `image rm -f` removes them (and `image inspect` then misses). */
function baseImages(e, ids = ["sha256:base0001"]) {
  const images = new Set(ids);
  const removed = [];
  e.docker.runner
    .on((argv) => argv[0] === "docker" && argv.includes("image") && argv.includes("ls"), () => ({ stdout: [...images].map((i) => `${i}\n`).join("") }))
    .on((argv) => argv[0] === "docker" && argv.includes("image") && argv.includes("rm"), (argv) => {
      images.delete(argv.at(-1));
      removed.push(argv.at(-1));
      e.docker.state.imageMissing = images.size === 0;
      return {};
    });
  return { images, removed };
}

test("I: remote.purgeTooling removes the base image after the session, and the next start rebuilds it", async (t) => {
  const e = await env(t);
  const images = baseImages(e);
  const purge = { remote: { host: "raspi5", purgeTooling: true } };
  const first = await e.start({ setup: [] }, purge);
  assert.match(first.workspaceDescription, /^read-only mount of the copy synced to raspi5$/);
  assert.deepEqual(images.removed, [], "nothing is purged while the session runs");
  assert.deepEqual(await first.stop(), []);
  assert.deepEqual(images.removed, ["sha256:base0001"], "the base image is removed after the session");
  assert.equal(e.docker.state.containers.size, 0);
  assert.equal(e.dirs.size, 0);

  // The image is gone: the next start builds it on the host (the context streams over ssh) before the container starts.
  let built = 0;
  e.fake.onStream = async (decoded) => {
    if (decoded.argv.includes("build")) {
      built++;
      images.images.add("sha256:base0002");
      e.docker.state.imageMissing = false;
    }
    return { exitCode: 0, stdout: "Successfully tagged\n" };
  };
  const statuses = [];
  const second = await e.backend.startSession({ ...(await secondStart(e, purge)), onStatus: (s) => statuses.push(s) });
  assert.equal(built, 1);
  assert.ok(statuses.some((s) => /building the base image on raspi5 \(purgeTooling removed it/.test(s)));
  assert.deepEqual(await second.stop(), []);
  assert.deepEqual(images.removed, ["sha256:base0001", "sha256:base0002"]);
});

test("I: without purgeTooling the base image stays; a failed purge is reported as a leftover of the stop", async (t) => {
  const e = await env(t);
  const images = baseImages(e);
  const kept = await e.start({ setup: [] });
  assert.deepEqual(await kept.stop(), []);
  assert.deepEqual(images.removed, [], "tooling is kept by default (spec §7a.1)");

  const failing = await e.start({ setup: [] }, { remote: { host: "raspi5", purgeTooling: true } });
  e.docker.runner.on((argv) => argv[0] === "docker" && argv.includes("image") && argv.includes("rm"), { exitCode: 1, stderr: "conflict: image is being used by running container" });
  const leftovers = await failing.stop();
  assert.equal(leftovers.length, 1);
  assert.equal(leftovers[0].kind, "image");
  assert.match(leftovers[0].detail, /on raspi5: .*being used/);
  assert.deepEqual(await failing.auditFootprint(), [], "the session itself left nothing");
});

/** Start options for a second session in the same env (fresh session dir and id). */
async function secondStart(e, extra) {
  const sessionDir = join(e.root, "pi-gui-testing-y");
  await mkdir(sessionDir, { mode: 0o700 });
  const project = join(e.root, "project");
  return {
    sessionId: "gui-dock0002",
    projectRoot: project,
    sessionDir,
    config: {
      shared: { targets: ["linux"], workspaceMode: "copy", network: "none", setup: [] },
      limits: { maxConcurrentSessions: 2, idleTimeoutMinutes: 15 },
      usageCheck: { warnSessionCostUsd: 1, warnDailyCostUsd: 5 },
      keepSandbox: false,
      warnings: [],
      ...extra,
    },
    ownerLabel: OWNER,
    recordResource: async () => {},
    onLog: () => {},
    signal: new AbortController().signal,
    onExitCleanup: () => {},
  };
}
