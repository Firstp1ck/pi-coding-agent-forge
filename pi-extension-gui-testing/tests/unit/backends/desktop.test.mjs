/**
 * M1c: docker-linux on Docker Desktop hosts (macOS, Windows), simulated on
 * this Linux host by injecting the platform, environment, and runner output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../../../src/checks/runner.ts";
import { dockerLinuxChecks } from "../../../src/backends/docker/checks.ts";
import { dockerOnPath, EndpointError, resolveEndpoint } from "../../../src/backends/docker/cli.ts";
import {
  containerUser,
  daemonSourceToHost,
  desktopRootProblem,
  hostPathForms,
  listingFingerprint,
  listingIdentityCommand,
  sameHostPath,
  WINDOWS_CONTAINER_UID,
} from "../../../src/backends/docker/desktop.ts";
import { bindSources, hardRuleViolations, splitBind, workspaceMountProblem } from "../../../src/backends/docker/inspect.ts";
import { projectRootProblem } from "../../../src/backends/docker/workspace.ts";
import { FakeCommandRunner } from "../../../src/runner/fake.ts";
import { fakeDocker, HEALTHY_INFO } from "./fakes.mjs";

const MAC_SOCKET = "unix:///Users/me/.docker/run/docker.sock";
const WIN_PIPE = "npipe:////./pipe/dockerDesktopLinuxEngine";
const WIN_ENV = {
  USERPROFILE: "C:\\Users\\me",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  ProgramData: "C:\\ProgramData",
  SystemRoot: "C:\\Windows",
};
const identityProbe = { realpath: (p) => p, isSocket: () => false };

function contextRunner(name, host) {
  return new FakeCommandRunner().on(["docker", "context", "inspect", "--format", "{{json .}}"], { stdout: `${JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } })}\n` });
}

test("endpoint: macOS accepts Docker Desktop's socket; Windows accepts only a local named pipe; remote endpoints fail with the Desktop remedy", async () => {
  assert.deepEqual(await resolveEndpoint(contextRunner("desktop-linux", MAC_SOCKET), { source: {}, platform: "darwin" }), { context: "desktop-linux", host: MAC_SOCKET });
  for (const pipe of [WIN_PIPE, "npipe:////./pipe/docker_engine"]) {
    assert.deepEqual(await resolveEndpoint(contextRunner("desktop-linux", pipe), { source: {}, platform: "win32" }), { context: "desktop-linux", host: pipe });
  }
  await assert.rejects(resolveEndpoint(contextRunner("desktop-linux", "npipe:////buildhost/pipe/docker_engine"), { source: {}, platform: "win32" }), (e) => e instanceof EndpointError && /only a local Docker Desktop engine on a named pipe/.test(e.message) && /docker context use desktop-linux/.test(e.message));
  await assert.rejects(resolveEndpoint(contextRunner("desktop-linux", MAC_SOCKET), { source: {}, platform: "win32" }), /named pipe/);
  await assert.rejects(resolveEndpoint(contextRunner("remote", "tcp://10.0.0.5:2376"), { source: {}, platform: "darwin" }), /only a local Docker daemon on a unix:\/\/ socket is supported\. Run: docker context use desktop-linux/);
  await assert.rejects(resolveEndpoint(new FakeCommandRunner(), { source: { dockerHost: "ssh://me@box" }, platform: "win32" }), /DOCKER_HOST points to ssh:\/\/me@box; .*Unset DOCKER_HOST/);
  // Linux (and the remote backends, which pass no platform) keep the M1 rule: a pipe is not local there.
  await assert.rejects(resolveEndpoint(contextRunner("x", WIN_PIPE), { source: {} }), /Run: docker context use default/);
});

test("docker on PATH: Windows looks for PATHEXT names without an execute bit; POSIX needs one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gui-desktop-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "docker.exe"), "");
  assert.equal(await dockerOnPath(`C:\\nowhere;${dir}`, "win32", ".COM;.EXE"), true);
  assert.equal(await dockerOnPath(dir, "win32", ".BAT"), false);
  assert.equal(await dockerOnPath(dir, "linux"), false);
  await writeFile(join(dir, "docker"), "");
  assert.equal(await dockerOnPath(dir, "darwin"), false, "not executable");
  await chmod(join(dir, "docker"), 0o755);
  assert.equal(await dockerOnPath(dir, "darwin"), true);
});

test("container user: your UID/GID on macOS, a fixed 1000:1000 on Windows (no POSIX ids there)", () => {
  assert.deepEqual(containerUser("win32"), { uid: WINDOWS_CONTAINER_UID, gid: 1000 });
  assert.deepEqual(containerUser("darwin", { uid: 501, gid: 20 }), { uid: 501, gid: 20 });
  assert.deepEqual(containerUser("darwin"), { uid: process.getuid(), gid: process.getgid() });
});

test("path forms: Desktop's VM forms map back to the shared host path", () => {
  assert.equal(daemonSourceToHost("win32", "/run/desktop/mnt/host/c/Users/me/proj"), "C:\\Users\\me\\proj");
  assert.equal(daemonSourceToHost("win32", "/host_mnt/d/work"), "D:\\work");
  assert.equal(daemonSourceToHost("win32", "C:/Users/me/proj"), "C:\\Users\\me\\proj");
  assert.equal(daemonSourceToHost("win32", "/var/run/docker.sock"), "/var/run/docker.sock", "VM-internal paths stay");
  assert.equal(daemonSourceToHost("darwin", "/host_mnt/Users/me/proj"), "/Users/me/proj");
  for (const form of ["C:\\Users\\me\\proj", "c:\\users\\me\\proj", "C:/Users/me/proj", "/c/Users/me/proj", "/run/desktop/mnt/host/c/Users/me/proj"]) {
    assert.ok(sameHostPath("win32", form, "C:\\Users\\me\\proj"), form);
  }
  assert.ok(!sameHostPath("win32", "C:\\Users\\me\\other", "C:\\Users\\me\\proj"));
  assert.ok(hostPathForms("darwin", "/var/folders/ab/T/pi-gui-testing-x").includes("/private/var/folders/ab/T/pi-gui-testing-x"));
  assert.ok(sameHostPath("darwin", "/host_mnt/private/var/folders/ab/T/x", "/var/folders/ab/T/x"));
  assert.ok(!sameHostPath("darwin", "/Users/me/other", "/Users/me/proj"));
  assert.ok(!sameHostPath("linux", "/host_mnt/srv/proj", "/srv/proj"), "Linux keeps exact equality");
});

test("isolation rules on Windows: drive-letter binds are parsed and judged; Desktop state and the Docker socket are forbidden", () => {
  assert.deepEqual(splitBind("C:\\Users\\me\\proj:/workspace:ro"), { source: "C:\\Users\\me\\proj", target: "/workspace" });
  assert.deepEqual(splitBind("/srv/proj:/workspace:ro"), { source: "/srv/proj", target: "/workspace" });
  const rules = { platform: "win32", env: WIN_ENV };
  const base = { HostConfig: { Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Binds: [] }, Mounts: [] };
  const inspect = (binds, mounts = []) => ({ ...base, HostConfig: { ...base.HostConfig, Binds: binds }, Mounts: mounts });
  const ok = inspect(["C:\\Users\\me\\AppData\\Local\\Temp\\pi-gui-testing-x\\passwd:/etc/passwd:ro", "C:\\Users\\me\\proj:/workspace:ro"], [{ Type: "bind", Source: "/run/desktop/mnt/host/c/Users/me/proj", Destination: "/workspace" }]);
  assert.deepEqual(bindSources(ok).sort(), ["/run/desktop/mnt/host/c/Users/me/proj", "C:\\Users\\me\\AppData\\Local\\Temp\\pi-gui-testing-x\\passwd", "C:\\Users\\me\\proj"].sort());
  assert.deepEqual(hardRuleViolations(ok, identityProbe, rules), [], "a VM-form source under /run is the shared host path, not /run");
  assert.equal(workspaceMountProblem(ok, "C:\\Users\\me\\proj", "/workspace", "win32"), undefined);
  assert.match(workspaceMountProblem(ok, "C:\\Users\\me\\elsewhere", "/workspace", "win32"), /expected C:\\Users\\me\\elsewhere/);
  const bad = hardRuleViolations(inspect(["C:\\Users\\me\\.docker:/x", "C:\\Users\\me\\AppData\\Local\\Docker\\run:/y", "C:\\Windows\\System32:/z", "/var/run/docker.sock:/var/run/docker.sock"]), identityProbe, rules);
  assert.deepEqual(bad.map((v) => v.rule), ["forbidden-mount", "forbidden-mount", "forbidden-mount", "docker-socket"]);
  assert.match(bad[0].observed, /touches C:\\Users\\me\\.docker/);
});

test("isolation rules on macOS: /host_mnt sources are judged as host paths; Docker Desktop's own state is forbidden", () => {
  const rules = { platform: "darwin", home: "/Users/me" };
  const inspect = (source) => ({ HostConfig: { Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Binds: [`${source}:/workspace:ro`] }, Mounts: [{ Type: "bind", Source: source, Destination: "/workspace" }] });
  assert.deepEqual(hardRuleViolations(inspect("/host_mnt/Users/me/proj"), identityProbe, rules), []);
  assert.equal(workspaceMountProblem(inspect("/host_mnt/Users/me/proj"), "/Users/me/proj", "/workspace", "darwin"), undefined);
  for (const source of ["/Users/me/.docker/run", "/Users/me/Library/Containers/com.docker.docker/Data", "/host_mnt/Users/me/.docker", "/private/var/run"]) {
    assert.ok(hardRuleViolations(inspect(source), identityProbe, rules).some((v) => v.rule === "forbidden-mount"), source);
  }
});

test("project roots: Windows refuses drive roots, share roots, the profile and its ancestors, and Desktop's dirs; macOS refuses home and Desktop's dirs", () => {
  const win = { platform: "win32", env: WIN_ENV };
  for (const [root, reason] of [
    ["C:\\", /drive root/],
    ["D:/", /drive root/],
    ["\\\\server\\share", /network share root/],
    ["C:\\Users\\me", /your user profile or contains it/],
    ["C:\\Users", /your user profile or contains it/],
    ["c:\\users\\ME", /your user profile/],
    ["C:\\Users\\me\\AppData\\Local\\Docker\\wsl", /inside C:\\Users\\me\\AppData\\Local\\Docker/],
    ["C:\\Windows\\Temp", /inside C:\\Windows/],
  ]) {
    assert.match(projectRootProblem(root, identityProbe, "C:\\Users\\me", win) ?? "", reason, root);
  }
  assert.equal(projectRootProblem("C:\\Users\\me\\src\\app", identityProbe, "C:\\Users\\me", win), undefined);
  const mac = { platform: "darwin", home: "/Users/me" };
  assert.match(projectRootProblem("/Users/me", identityProbe, "/Users/me", mac), /home directory/);
  assert.match(projectRootProblem("/Users", identityProbe, "/Users/me", mac), /home directory or contains it/);
  assert.match(projectRootProblem("/Users/me/.docker", identityProbe, "/Users/me", mac), /\.docker/);
  assert.equal(projectRootProblem("/Users/me/src/app", identityProbe, "/Users/me", mac), undefined);
  assert.equal(desktopRootProblem("linux", "/"), undefined, "Linux keeps the M1 rules only");
});

test("workspace identity on Desktop: a listing fingerprint that the container-side ls | sha256sum reproduces", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gui-desktop-ls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, "Zeta.txt"), "");
  await writeFile(join(dir, "alpha"), "");
  await writeFile(join(dir, "ümlaut"), "");
  const fingerprint = await listingFingerprint(dir);
  const command = listingIdentityCommand(fingerprint);
  assert.equal(command, `[ "$(LC_ALL=C ls -A1 /workspace | sha256sum)" = '${fingerprint}  -' ]`);
  // The same test against the real directory with GNU ls: exit 0 for this dir, 1 after a change.
  const { spawnSync } = await import("node:child_process");
  const sh = (cmd) => spawnSync("sh", ["-c", cmd.replace("/workspace", dir)], { encoding: "utf8" }).status;
  assert.equal(sh(command), 0);
  await writeFile(join(dir, "new"), "");
  assert.equal(sh(command), 1);
  assert.throws(() => listingIdentityCommand("'; rm -rf / #"), /invalid listing fingerprint/);
});

async function runDesktopChecks(t, platform, docker, extra = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "gui-desktop-checks-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { runner, state } = fakeDocker(docker);
  const checks = dockerLinuxChecks({
    runner,
    ownerLabel: () => "c1:100:5000:win32-boot-1700000000",
    version: "0.1.0",
    tmpRoot: tmp,
    endpointSource: {},
    platform,
    common: { piVersion: "1.4.0", configDir: tmp, minFreeBytes: 1, diskPath: tmp },
    ...extra,
  });
  const results = await runChecks(checks, { runner, backend: "docker-linux", projectRoot: tmp, signal: new AbortController().signal });
  return { byId: Object.fromEntries(results.map((r) => [r.id, r])), runner, state, checks };
}

const DESKTOP_INFO = { ...HEALTHY_INFO, OperatingSystem: "Docker Desktop", Name: "docker-desktop", Architecture: "aarch64" };

test("checks on macOS Docker Desktop: host.os passes, rootful-in-VM note, bind-uid owned by you through file sharing", async (t) => {
  const { byId, runner } = await runDesktopChecks(t, "darwin", { contextName: "desktop-linux", contextHost: MAC_SOCKET, info: DESKTOP_INFO });
  for (const [id, result] of Object.entries(byId)) assert.notEqual(result.status, "fail", `${id}: ${result.observed}`);
  assert.equal(byId["host.os"].observed, "darwin");
  assert.match(byId["docker.endpoint"].observed, /unix:\/\/\/Users\/me\/\.docker\/run\/docker\.sock \(context desktop-linux\)/);
  assert.match(byId["docker.rootless"].observed, /^rootful inside Docker Desktop's Linux VM/);
  assert.match(byId["docker.bind-uid"].observed, /owned by uid \d+ \(Docker Desktop file sharing maps it to you\)/);
  assert.ok(runner.commands().every((c) => !c.startsWith("docker --host") || c.startsWith(`docker --host ${MAC_SOCKET} `)), "every call uses the resolved socket");
});

test("checks on Windows Docker Desktop: npipe endpoint, uid 1000 container user, bind-uid by creation, Desktop remediations", async (t) => {
  const { byId, runner, checks } = await runDesktopChecks(t, "win32", { contextName: "desktop-linux", contextHost: WIN_PIPE, info: DESKTOP_INFO }, { env: WIN_ENV });
  for (const [id, result] of Object.entries(byId)) assert.notEqual(result.status, "fail", `${id}: ${result.observed}`);
  assert.equal(byId["host.os"].observed, "win32");
  assert.match(byId["docker.endpoint"].observed, /npipe:\/\/\/\/\.\/pipe\/dockerDesktopLinuxEngine/);
  assert.match(byId["docker.bind-uid"].observed, /Windows has no POSIX owner; the container runs as uid 1000/);
  const probe = runner.commands().find((c) => c.includes("pi-gui-testing-probe") && c.includes(" run "));
  assert.match(probe, /--user 1000:1000/);
  const remediation = Object.fromEntries(checks.map((c) => [c.id, c.remediation?.summary]));
  assert.match(remediation["docker.cli"], /Install Docker Desktop/);
  assert.match(remediation["docker.daemon"], /Start Docker Desktop/);
  assert.match(remediation["docker.permission"], /docker-users group/);
  assert.match(remediation["docker.endpoint"], /docker context use desktop-linux/);
  assert.equal(checks.find((c) => c.id === "docker.daemon").remediation.command, undefined, "no sudo systemctl on Windows");
});

test("checks on Desktop still fail closed: a rootless engine, a remote context, and a missing shared file", async (t) => {
  const rootless = await runDesktopChecks(t, "darwin", { contextName: "desktop-linux", contextHost: MAC_SOCKET, info: { ...DESKTOP_INFO, SecurityOptions: ["name=rootless"] } });
  assert.equal(rootless.byId["docker.rootless"].status, "fail");
  const remote = await runDesktopChecks(t, "win32", { contextName: "cloud", contextHost: "tcp://1.2.3.4:2376" });
  assert.equal(remote.byId["docker.endpoint"].status, "fail");
  assert.match(remote.byId["docker.endpoint"].observed, /docker context use desktop-linux/);
  const unshared = await runDesktopChecks(t, "darwin", { contextName: "desktop-linux", contextHost: MAC_SOCKET, info: DESKTOP_INFO, bindProbe: () => ({}) });
  assert.equal(unshared.byId["docker.bind-uid"].status, "fail");
  assert.match(unshared.byId["docker.bind-uid"].observed, /allow Docker Desktop's file sharing/);
});

test("sessions on Desktop: the container runs on the resolved socket/pipe, as the right user, and /workspace is checked by listing", async (t) => {
  const { fakeEnv } = await import("./env.mjs");
  const { createGuiTools } = await import("../../../src/tools/tools.ts");
  for (const [platform, host, shared, user] of [
    ["darwin", MAC_SOCKET, {}, `${process.getuid()}:${process.getgid()}`],
    ["win32", WIN_PIPE, { workspaceMode: "copy" }, "1000:1000"],
  ]) {
    const env = await fakeEnv(t, {
      shared,
      docker: { contextName: "desktop-linux", contextHost: host, info: DESKTOP_INFO, backend: { platform, ...(platform === "win32" ? { env: WIN_ENV } : {}) } },
    });
    const tools = Object.fromEntries(createGuiTools(env.runtime).map((tool) => [tool.name, tool]));
    const launched = await tools.gui_launch.execute("call", {}, undefined, undefined, env.ctx());
    const child = env.spawner.children[0];
    assert.equal(child.argv.slice(0, 3).join(" "), `docker --host ${host}`, platform);
    assert.equal(child.argv[child.argv.indexOf("--user") + 1], user, platform);
    const identity = child.requests.find((r) => r.method === "exec");
    assert.match(identity.params.cmd, /^\[ "\$\(LC_ALL=C ls -A1 \/workspace \| sha256sum\)" = '[0-9a-f]{64} {2}-' \]$/, `${platform}: listing identity instead of device/inode`);
    await tools.gui_stop.execute("call", { session: launched.details.session }, undefined, undefined, env.ctx());
  }
});

test("a session on macOS refuses a project root that is the home directory (it holds Docker Desktop's state)", async (t) => {
  const { fakeEnv } = await import("./env.mjs");
  const { realpathSync } = await import("node:fs");
  const { DockerLinuxBackend } = await import("../../../src/backends/docker-linux.ts");
  const env = await fakeEnv(t, { docker: { contextName: "desktop-linux", contextHost: MAC_SOCKET, info: DESKTOP_INFO } });
  const backend = new DockerLinuxBackend({ ownerLabel: () => "x:1:1:darwin-x", runner: env.runner, spawner: env.spawner, endpointSource: {}, version: "0.1.0", platform: "darwin", home: realpathSync(env.project) });
  const options = { sessionId: "gui-deadbeef", projectRoot: env.project, sessionDir: env.tmp, config: (await env.runtime.config(env.project)).resolved, ownerLabel: "x:1:1:darwin-x", recordResource: async () => {}, onLog() {}, signal: new AbortController().signal };
  await assert.rejects(backend.startSession(options), /home directory or contains it/);
  assert.equal(env.spawner.children.length, 0, "refused before any container");
});
