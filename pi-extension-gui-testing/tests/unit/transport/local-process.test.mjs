import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnLocalProcess } from "../../../src/transport/local-process.ts";

async function output(child) {
  const chunks = [];
  child.stdout.on("data", (c) => chunks.push(c));
  await child.exited;
  return Buffer.concat(chunks).toString("utf8");
}

test("local process: only the explicit environment, cwd / by default, no inherited desktop variables", async () => {
  const before = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
  process.env.DISPLAY = ":0";
  process.env.WAYLAND_DISPLAY = "wayland-0";
  try {
    const child = spawnLocalProcess(["/bin/sh", "-c", "pwd; env"], { env: { PATH: "/usr/bin:/bin", MARKER: "yes" } });
    child.stdin.end();
    const text = await output(child);
    const [cwd, ...envLines] = text.trim().split("\n");
    assert.equal(cwd, "/");
    const names = envLines.map((l) => l.split("=")[0]);
    assert.ok(names.includes("MARKER") && names.includes("PATH"));
    for (const forbidden of ["DISPLAY", "WAYLAND_DISPLAY", "HOME", "DBUS_SESSION_BUS_ADDRESS"]) assert.ok(!names.includes(forbidden), forbidden);
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("local process: runs in its own process group; kill reaches the children; exit status and spawn errors resolve", async () => {
  const child = spawnLocalProcess(["/bin/sh", "-c", "sleep 30 & echo $!; wait"], { env: { PATH: "/usr/bin:/bin" }, cwd: "/tmp" });
  const grandchild = await new Promise((resolve) => child.stdout.once("data", (c) => resolve(Number(String(c).trim()))));
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  assert.equal(pgrp, child.pid, "process group leader");
  assert.equal(child.running(), true);
  child.kill("SIGTERM");
  const status = await child.exited;
  assert.equal(status.signal, "SIGTERM");
  assert.equal(child.running(), false);
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(grandchild, 0);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/, "the grandchild got the signal too");
  child.kill("SIGKILL"); // ignored after exit

  const missing = spawnLocalProcess(["/nonexistent/helper"], { env: {} });
  const failed = await missing.exited;
  assert.equal(failed.error?.code, "ENOENT");
  assert.throws(() => spawnLocalProcess([], { env: {} }), /empty argv/);
  assert.throws(() => spawnLocalProcess(["/bin/true"], { env: { A: 1 } }), /not a string/);
});
