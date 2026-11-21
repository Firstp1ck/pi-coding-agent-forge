import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DepsCache, defaultDepsCacheRoot, LOCK_STALE_MS, projectHash } from "../../../src/deps/store.ts";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const KEY = (n) => createHash("sha256").update(String(n)).digest("hex");

async function cacheRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "gui-deps-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function store(cache, ref, data) {
  const writer = await cache.beginStore(ref);
  assert.ok(!("skipped" in writer), writer.skipped);
  await writer.write(data);
  await writer.commit({ size: data.length, sha256: sha(data) });
}

test("default location follows XDG_CACHE_HOME, else ~/.cache", () => {
  assert.equal(defaultDepsCacheRoot({ XDG_CACHE_HOME: "/x/cache" }, "/home/u"), "/x/cache/pi-extension-gui-testing/deps");
  assert.equal(defaultDepsCacheRoot({ XDG_CACHE_HOME: "relative" }, "/home/u"), "/home/u/.cache/pi-extension-gui-testing/deps");
  assert.equal(defaultDepsCacheRoot({}, "/home/u"), "/home/u/.cache/pi-extension-gui-testing/deps");
});

test("store then lookup: layout, private modes, sidecar format, verified hit", async (t) => {
  const root = await cacheRoot(t);
  const cache = new DepsCache({ root: join(root, "deps") });
  const project = await projectHash(root);
  assert.match(project, /^[0-9a-f]{16}$/);
  const ref = cache.entry(project, "linux", "x86_64", KEY(1));
  assert.equal(ref.archive, join(root, "deps", project, "linux-x86_64", `${KEY(1)}.tar.gz`));
  assert.deepEqual(await cache.lookup(ref), { miss: true });
  const data = randomBytes(10_000);
  await store(cache, ref, data);
  assert.equal((await stat(join(root, "deps"))).mode & 0o777, 0o700);
  assert.equal((await stat(ref.archive)).mode & 0o777, 0o600);
  assert.equal(await readFile(ref.sidecar, "utf8"), `${sha(data)}  ${KEY(1)}.tar.gz\n`);
  assert.deepEqual(await readdir(ref.dir), [`${KEY(1)}.sha256`, `${KEY(1)}.tar.gz`], "no temp file or lock remains");
  const found = await cache.lookup(ref);
  assert.deepEqual(found, { hit: { ref, size: data.length, sha256: sha(data) } });
  assert.throws(() => cache.entry(project, "linux", "../x", KEY(1)), /invalid cache target/);
  assert.throws(() => cache.entry(project, "linux", "x86_64", "nothex"), /invalid cache key/);
});

test("a corrupted entry (hash mismatch, missing archive) is discarded and reported as a miss", async (t) => {
  const root = await cacheRoot(t);
  const cache = new DepsCache({ root });
  const ref = cache.entry("0123456789abcdef", "linux", "x86_64", KEY(2));
  await store(cache, ref, Buffer.from("good archive bytes"));
  await writeFile(ref.archive, "flipped archive bytes");
  const corrupted = await cache.lookup(ref);
  assert.equal(corrupted.miss, true);
  assert.match(corrupted.discarded, /SHA-256 mismatch; the entry was removed/);
  assert.deepEqual(await readdir(ref.dir), []);

  await store(cache, ref, Buffer.from("again"));
  await rm(ref.archive);
  assert.match((await cache.lookup(ref)).discarded, /archive missing/);
  assert.deepEqual(await readdir(ref.dir), []);
});

test("commit refuses data that does not match what the helper announced, and stores nothing", async (t) => {
  const root = await cacheRoot(t);
  const cache = new DepsCache({ root });
  const ref = cache.entry("0123456789abcdef", "linux", "x86_64", KEY(3));
  const writer = await cache.beginStore(ref);
  await writer.write(Buffer.from("abc"));
  await assert.rejects(writer.commit({ size: 3, sha256: sha("abd") }), /the helper announced 3 bytes/);
  assert.deepEqual(await readdir(ref.dir), []);
  const small = new DepsCache({ root, maxBytes: 4 });
  const bounded = await small.beginStore(ref);
  await assert.rejects(bounded.write(Buffer.alloc(5)), /larger than the cache limit/);
  await bounded.abort();
  assert.deepEqual(await readdir(ref.dir), []);
});

test("LRU eviction removes the least recently used entries first and keeps the one just stored", async (t) => {
  const root = await cacheRoot(t);
  let now = 1_700_000_000_000;
  const cache = new DepsCache({ root, maxBytes: 2500, now: () => now });
  const refs = [1, 2, 3].map((n) => cache.entry(n === 3 ? "fedcba9876543210" : "0123456789abcdef", "linux", "x86_64", KEY(n)));
  for (const [i, ref] of refs.entries()) {
    await store(cache, ref, randomBytes(1000));
    now += 1000;
    await cache.touch(ref);
  }
  // Entry 1 was used most recently, so entry 2 is the oldest now.
  now += 1000;
  await cache.touch(refs[0]);
  assert.deepEqual(await cache.usage(), { entries: 3, bytes: 3000 });
  const evicted = await cache.evict(refs[2]);
  assert.deepEqual(evicted.removed.map((r) => r.key), [KEY(2)]);
  assert.equal(evicted.bytes, 2000);
  assert.ok("hit" in (await cache.lookup(refs[0])));
  assert.ok("hit" in (await cache.lookup(refs[2])));
  const tiny = new DepsCache({ root, maxBytes: 500, now: () => now });
  const all = await tiny.evict(refs[2]);
  assert.deepEqual(all.removed.map((r) => r.key), [KEY(1), KEY(3)], "the kept entry goes last");
  assert.deepEqual(await tiny.usage(), { entries: 0, bytes: 0 });
});

test("concurrent writers: one stores, the other skips; readers never see a torn entry", async (t) => {
  const root = await cacheRoot(t);
  const a = new DepsCache({ root });
  const b = new DepsCache({ root });
  const ref = a.entry("0123456789abcdef", "linux", "x86_64", KEY(4));
  const [wa, wb] = await Promise.all([a.beginStore(ref), b.beginStore(ref)]);
  const winners = [wa, wb].filter((w) => !("skipped" in w));
  const losers = [wa, wb].filter((w) => "skipped" in w);
  assert.equal(winners.length, 1);
  assert.match(losers[0].skipped, /another Pi session is storing this entry/);
  const data = randomBytes(50_000);
  await winners[0].write(data.subarray(0, 20_000));
  // A reader during the write sees no entry (and removes nothing: the writer holds the lock).
  assert.deepEqual(await b.lookup(ref), { miss: true });
  await winners[0].write(data.subarray(20_000));
  await winners[0].commit({ size: data.length, sha256: sha(data) });
  assert.deepEqual((await b.lookup(ref)).hit.sha256, sha(data));

  // Many writers of different entries at once never mix their files.
  const many = await Promise.all(
    [5, 6, 7, 8].map(async (n) => {
      const r = a.entry("0123456789abcdef", "linux", "x86_64", KEY(n));
      const payload = randomBytes(30_000 + n);
      await store(n % 2 ? a : b, r, payload);
      return { r, payload };
    }),
  );
  for (const { r, payload } of many) assert.equal((await a.lookup(r)).hit.sha256, sha(payload));
});

test("a stale lock of a crashed writer is taken over; a fresh one is respected", async (t) => {
  const root = await cacheRoot(t);
  let now = Date.now();
  const cache = new DepsCache({ root, now: () => now });
  const ref = cache.entry("0123456789abcdef", "linux", "x86_64", KEY(9));
  const crashed = await cache.beginStore(ref);
  assert.ok(!("skipped" in crashed));
  assert.ok("skipped" in (await cache.beginStore(ref)));
  // A corrupt-looking entry under a fresh lock is left alone.
  await writeFile(ref.sidecar, `${"0".repeat(64)}  ${KEY(9)}.tar.gz\n`);
  await writeFile(ref.archive, "partial");
  assert.match((await cache.lookup(ref)).discarded, /another session is writing it/);
  const old = new Date(now - LOCK_STALE_MS - 1000);
  await utimes(ref.lock, old, old);
  const next = await cache.beginStore(ref);
  assert.ok(!("skipped" in next), "stale lock taken over");
  await next.write(Buffer.from("fresh"));
  await next.commit({ size: 5, sha256: sha("fresh") });
  assert.equal((await cache.lookup(ref)).hit.size, 5);
  await crashed.abort();
});

test("clear() removes the whole cache and reports what it held", async (t) => {
  const root = await cacheRoot(t);
  const cache = new DepsCache({ root: join(root, "deps") });
  await store(cache, cache.entry("0123456789abcdef", "linux", "aarch64", KEY(10)), Buffer.alloc(100));
  assert.deepEqual(await cache.clear(), { entries: 1, bytes: 100 });
  await assert.rejects(stat(join(root, "deps")), { code: "ENOENT" });
  assert.deepEqual(await cache.clear(), { entries: 0, bytes: 0 });
});
