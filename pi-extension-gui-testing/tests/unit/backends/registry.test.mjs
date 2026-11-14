import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasDrift,
  hasImage,
  hasOrphanAuditGate,
  hasReset,
  hasRunner,
  hasSmoke,
  hasSweepAvailability,
  IMAGE_CHECK_ID,
  sweepAllowed,
} from "../../../src/backends/capabilities.ts";
import { DockerLinuxBackend } from "../../../src/backends/docker-linux.ts";
import { DOCKER_LINUX_HOST_SUPPORT } from "../../../src/backends/host-support.ts";
import { BackendRegistry, DEFAULT_REGISTRY } from "../../../src/backends/registry.ts";
import { hostOsCheck } from "../../../src/checks/common.ts";
import { BACKEND_DESCRIPTIONS } from "../../../src/commands/commands.ts";
import { IMPLEMENTED_BACKENDS } from "../../../src/config/types.ts";
import { fakeBackendEntry } from "./fake-backend.mjs";

const bare = { id: "local-linux", checks: () => [], startSession: async () => ({}), auditOrphans: async () => [], sweepOrphans: async () => [] };
const ctx = { ownerLabel: () => "c:1:2:b", runtimeOptions: {} };

test("F: the default registry matches IMPLEMENTED_BACKENDS and holds docker-linux's description, host support, and targets", () => {
  assert.deepEqual(DEFAULT_REGISTRY.ids, [...IMPLEMENTED_BACKENDS]);
  assert.equal(DEFAULT_REGISTRY.defaultId, "docker-linux");
  const docker = DEFAULT_REGISTRY.entry("docker-linux");
  assert.equal(docker.hostSupport, DOCKER_LINUX_HOST_SUPPORT);
  assert.deepEqual(docker.targets, ["linux"]);
  assert.equal(BACKEND_DESCRIPTIONS["docker-linux"], docker.description);
  assert.deepEqual(DEFAULT_REGISTRY.ids, ["docker-linux", "local-linux", "remote-linux", "remote-linux-docker", "cua", "local-windows", "docker-windows"]);
  // Every known backend id is registered now; the "not available" text still names the registry's backends.
  assert.match(DEFAULT_REGISTRY.notAvailableMessage("macos-x"), /backend "macos-x" is not available yet; available: docker-linux, local-linux, remote-linux, remote-linux-docker, cua, local-windows, docker-windows/);
  assert.deepEqual(DEFAULT_REGISTRY.entry("cua").targets, ["linux", "windows"]);
  assert.deepEqual(DEFAULT_REGISTRY.entry("local-windows").targets, ["windows"]);
  assert.deepEqual(DEFAULT_REGISTRY.entry("docker-windows").targets, ["windows"]);
  assert.deepEqual(DEFAULT_REGISTRY.entry("local-windows").hostSupport.platforms, ["win32"]);
  assert.deepEqual(DEFAULT_REGISTRY.entry("docker-windows").hostSupport.platforms, ["linux"]);
});

test("F: the docker-linux factory merges the M1 option names, backendOptions, and the context's tmpRoot; creating runs nothing", async () => {
  const calls = [];
  const runner = { run: async (argv) => (calls.push(argv), { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 0 }) };
  let onPath = 0;
  const backend = DEFAULT_REGISTRY.create("docker-linux", {
    ownerLabel: () => "c:1:2:b",
    tmpRoot: "/tmp/x",
    runtimeOptions: { docker: { runner, version: "9.9.9" }, backendOptions: { "docker-linux": { version: "1.2.3" } }, dockerOnPath: async () => (onPath++, true) },
  });
  assert.ok(backend instanceof DockerLinuxBackend);
  assert.equal(backend.runner, runner);
  assert.equal(backend.version, "1.2.3", "backendOptions win over the M1 name");
  assert.equal(await backend.sweepAvailable({ startup: true }), true);
  assert.equal(onPath, 1);
  assert.deepEqual(calls, []);
});

test("F: a registry rejects duplicates, emptiness, unknown ids, and factories that return another backend", () => {
  const { entry } = fakeBackendEntry();
  assert.throws(() => new BackendRegistry([entry, entry]), /registered twice/);
  assert.throws(() => new BackendRegistry([]), /at least one backend/);
  const registry = new BackendRegistry([entry]);
  assert.deepEqual(registry.ids, ["local-linux"]);
  assert.equal(registry.defaultId, "local-linux");
  assert.throws(() => registry.create("cua", ctx), /backend "cua" is not available yet; available: local-linux/);
  const liar = new BackendRegistry([{ ...entry, id: "remote-linux" }]);
  assert.throws(() => liar.create("remote-linux", ctx), /backend factory for "remote-linux" returned "local-linux"/);
});

test("F: the factory gets backendOptions[id] as ctx.options", () => {
  const { entry, calls } = fakeBackendEntry();
  new BackendRegistry([entry]).create("local-linux", { ...ctx, runtimeOptions: { backendOptions: { "local-linux": { answer: 42 }, cua: { other: true } } } });
  assert.deepEqual(calls.ctx.options, { answer: 42 });
});

test("F: capability guards recognise docker-linux and reject a bare backend", async () => {
  const docker = new DockerLinuxBackend({ ownerLabel: () => "c:1:2:b", version: "0.1.0", dockerOnPath: async () => false });
  for (const guard of [hasImage, hasDrift, hasReset, hasSweepAvailability, hasOrphanAuditGate, hasRunner]) assert.equal(guard(docker), true, guard.name);
  assert.equal(hasSmoke(docker), false, "docker-linux uses the default smoke app");
  for (const guard of [hasImage, hasDrift, hasReset, hasSweepAvailability, hasOrphanAuditGate, hasRunner, hasSmoke]) assert.equal(guard(bare), false, guard.name);
  assert.equal(IMAGE_CHECK_ID, "image.base");
  assert.equal(docker.orphanAuditReady([{ id: "docker.permission", status: "pass" }]), true);
  assert.equal(docker.orphanAuditReady([{ id: "docker.permission", status: "fail" }]), false);
  assert.match(docker.resetNote, /Docker itself is yours and stays installed/);

  // Partial or wrongly typed members do not count.
  assert.equal(hasImage({ ...bare, imageTag: "x", buildImage() {} }), false);
  assert.equal(hasDrift({ ...bare, currentVersions() {} }), false, "needs version too");
  assert.equal(hasReset({ ...bare, resetSummary: "s" }), false);
  assert.equal(hasReset({ ...bare, resetSummary: "s", resetNote: "n", resetData: "nope" }), false);
  assert.equal(hasRunner({ ...bare, runner: {} }), false);

  assert.equal(await sweepAllowed(bare, { startup: true }), true, "no gate: always swept");
  assert.equal(await sweepAllowed(docker, { startup: true }), false);
  assert.equal(await sweepAllowed({ ...bare, sweepAvailable: () => Promise.reject(new Error("x")) }, { startup: false }), false);
});

test("F: host.os takes the registry's host support for any backend", async () => {
  const run = (check) => check.run({});
  assert.equal((await run(hostOsCheck("local-linux", "linux", { platforms: ["linux"], otherwise: "only Linux" }))).status, "pass");
  assert.deepEqual(await run(hostOsCheck("local-linux", "darwin", { platforms: ["linux"], otherwise: "only Linux" })), { status: "fail", observed: "darwin: only Linux" });
  assert.match((await run(hostOsCheck("local-linux", "linux"))).observed, /not available yet/, "without support it stays unavailable");
  assert.equal((await run(hostOsCheck("docker-linux", "linux"))).status, "pass", "built-in table unchanged");
});
