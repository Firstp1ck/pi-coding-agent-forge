import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_LOCK_DIR, SessionLeases } from "../../../../src/backends/docker-windows/lease.ts";
import { createOwnerIdentity } from "../../../../src/cleanup/identity.ts";
import { formatOwnerLabel } from "../../../../src/owner.ts";

const OWNER = formatOwnerLabel(createOwnerIdentity());
const want = (n) => ({ owner: OWNER, session: `gui-lease00${n}`, container: `pi-gui-testing-win-gui-lease00${n}` });

async function leaseDir(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "pi-gui-lease-"));
  t.after(async () => {
    await fs.chmod(join(dir, LEASE_LOCK_DIR), 0o700).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Fails every write of a lock release marker (`.lock.<n>.free`) under `dir` while `active()`. */
function failReleaseMarkers(dir, active) {
  const original = fs.writeFile;
  let failures = 0;
  fs.writeFile = async function (path, ...rest) {
    if (active() && String(path).startsWith(join(dir, LEASE_LOCK_DIR)) && String(path).endsWith(".free")) {
      failures++;
      throw Object.assign(new Error("EIO: injected lock release failure"), { code: "EIO" });
    }
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  return {
    failures: () => failures,
    restore() {
      fs.writeFile = original;
      syncBuiltinESMExports();
    },
  };
}

test("a lock release that fails after the lease was written gives the admission back (review WG5, seat B)", async (t) => {
  const dir = await leaseDir(t);
  const leases = new SessionLeases(dir, { lockTimeoutMs: 500 });
  let failing = true;
  const fault = failReleaseMarkers(dir, () => failing);
  t.after(() => fault.restore());
  const error = await leases.acquire(want(1), async () => {}).then(
    () => assert.fail("acquire returned a handle"),
    (e) => e,
  );
  assert.match(error.message, /session lock .* could not be released \(EIO: injected lock release failure\); this start was given back/);
  assert.ok(fault.failures() >= 3);
  assert.deepEqual(await leases.read(), { state: "none" }, "no lease is left behind, even while the marker still cannot be written");
  failing = false;
  // The disk recovered: the next admission settles the owed lock release and is admitted.
  const handle = await leases.acquire(want(2), async () => {});
  assert.equal((await leases.read()).lease.session, "gui-lease002");
  await handle.release();
  assert.deepEqual(await leases.read(), { state: "none" });
});

test("a lock dir that turns read-only after publication does not strand the lease (review WG5, seat A)", async (t) => {
  const dir = await leaseDir(t);
  const leases = new SessionLeases(dir, { lockTimeoutMs: 200 });
  const lockDir = join(dir, LEASE_LOCK_DIR);
  let first;
  try {
    await leases.acquire(want(1), async () => {
      await fs.chmod(lockDir, 0o500);
    });
    first = "admitted";
  } catch (error) {
    first = error.message;
  } finally {
    await fs.chmod(lockDir, 0o700);
  }
  assert.match(first, /could not be released .*this start was given back/);
  const read = await leases.read();
  // The lease file lives outside the read-only lock dir, so it is removed; were it left, its token is no longer held.
  assert.ok(read.state === "none" || leases.judge(read.lease, OWNER) === "abandoned", JSON.stringify(read));
  const handle = await leases.acquire(want(2), async () => {});
  await handle.release();
});
