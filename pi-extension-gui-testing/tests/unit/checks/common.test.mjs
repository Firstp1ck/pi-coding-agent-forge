import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commonChecks,
  compareVersions,
  configWritableCheck,
  diskFreeCheck,
  DOCKER_LINUX_MIN_FREE_BYTES,
  hostOsCheck,
  piVersionCheck,
} from "../../../src/checks/common.ts";

const ctx = { signal: new AbortController().signal, backend: "docker-linux", dependencies: new Map(), projectRoot: "/p" };

test("compareVersions handles prefixes, missing parts, suffixes, and garbage", () => {
  assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
  assert.ok(compareVersions("v1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("29", "29.0.1") < 0);
  assert.equal(compareVersions("29.0.0-rc1", "29.0"), 0);
  assert.equal(compareVersions("unknown", "1"), undefined);
});

test("pi.version passes from 1.4.0 and records the version as a fact", async () => {
  assert.deepEqual(await piVersionCheck("1.4.0").run(ctx), { status: "pass", observed: "1.4.0", facts: { "pi.version": "1.4.0" } });
  assert.equal((await piVersionCheck("1.3.9").run(ctx)).status, "fail");
  assert.equal((await piVersionCheck("dev").run(ctx)).status, "fail");
  assert.equal((await piVersionCheck().run(ctx)).status, "pass", "the installed Pi is ≥ 1.4.0");
});

test("host.os: docker-linux on Linux, and (M1c) on macOS and Windows with Docker Desktop; other hosts and backends refused", async () => {
  assert.equal((await hostOsCheck("docker-linux", "linux").run(ctx)).status, "pass");
  assert.equal((await hostOsCheck("docker-linux", "darwin").run(ctx)).status, "pass");
  assert.equal((await hostOsCheck("docker-linux", "win32").run(ctx)).status, "pass");
  const bsd = await hostOsCheck("docker-linux", "freebsd").run(ctx);
  assert.equal(bsd.status, "fail");
  assert.match(bsd.observed, /freebsd: docker-linux runs on Linux \(Docker Engine\), macOS, and Windows \(Docker Desktop with Linux containers\)/);
  assert.match((await hostOsCheck("cua", "linux").run(ctx)).observed, /not available yet/);
});

test("config.writable probes the dir with a temp file it removes, or the nearest existing ancestor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-writable-test-"));
  t.after(async () => {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const check = configWritableCheck(root);
  assert.equal(check.kind, "probe");
  assert.deepEqual(await check.run(ctx), { status: "pass", observed: root });
  assert.deepEqual(await readdir(root), [], "probe file removed");

  const nested = await configWritableCheck(join(root, "agent", "gui")).run(ctx);
  assert.equal(nested.status, "pass");
  assert.match(nested.observed, /will be created in/);
  assert.deepEqual(await readdir(root), [], "no directories created");

  await writeFile(join(root, "file"), "");
  assert.equal((await configWritableCheck(join(root, "file")).run(ctx)).status, "fail");

  if (process.getuid?.() !== 0) {
    await chmod(root, 0o500);
    assert.equal((await configWritableCheck(root).run(ctx)).status, "fail");
    assert.equal((await configWritableCheck(join(root, "missing")).run(ctx)).status, "fail");
  }
});

test("disk.free compares statfs free space with the minimum", async () => {
  const low = await diskFreeCheck(1, tmpdir()).run(ctx);
  assert.equal(low.status, "pass");
  assert.match(low.observed, /GB free at/);
  assert.ok(Number(low.facts["disk.freeBytes"]) > 0);
  assert.equal((await diskFreeCheck(Number.MAX_SAFE_INTEGER, tmpdir()).run(ctx)).status, "fail");
  assert.equal((await diskFreeCheck(1, join(tmpdir(), "does", "not", "exist")).run(ctx)).status, "pass", "falls back to an existing ancestor");
});

test("commonChecks returns the four common checks in spec order", () => {
  const checks = commonChecks("docker-linux", { minFreeBytes: DOCKER_LINUX_MIN_FREE_BYTES });
  assert.deepEqual(checks.map((c) => c.id), ["pi.version", "host.os", "config.writable", "disk.free"]);
  assert.ok(checks.every((c) => c.required));
  assert.equal(DOCKER_LINUX_MIN_FREE_BYTES, 5 * 1024 ** 3);
});
