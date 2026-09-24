import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compareWebuiVersions, migrateLegacyBootstrap } from "../lib/update/migration.mjs";
import { acquireEffectLocks, releaseEffectLocks, sharedUpdateRoot } from "../lib/update/coordination.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listenWithRetry,
  managedRuntimePaths,
  probeCandidateRuntime,
  probeStartupRestore,
  readRuntimePointer,
  rollbackRuntimePointer,
  switchRuntimePointer,
  writeRuntimePointer,
} from "../lib/update/supervisor.mjs";

const root = await mkdtemp(path.join(tmpdir(), "pi-webui-supervisor-"));
try {
  const paths = managedRuntimePaths(root);
  const makeRuntime = async (name, version) => {
    const runtimeRoot = path.join(paths.runtimesDir, name);
    const serverEntry = path.join(runtimeRoot, "bin", "pi-webui.mjs");
    await mkdir(path.dirname(serverEntry), { recursive: true });
    await writeFile(serverEntry, `if (process.argv[2] === "--candidate-probe") console.log(JSON.stringify({ok:true,version:${JSON.stringify(version)},piVersion:"9.9.9"}));\n`, "utf8");
    await writeFile(path.join(runtimeRoot, "package.json"), JSON.stringify({ name: "@firstpick/pi-package-webui", version }));
    return { runtimeRoot, serverEntry, version };
  };
  const first = await makeRuntime("first", "1.0.0");
  const second = await makeRuntime("second", "2.0.0");
  await switchRuntimePointer(root, first);
  assert.equal((await readRuntimePointer(root, "current")).version, "1.0.0");
  const bootstrapRollback = await rollbackRuntimePointer(root);
  assert.equal(bootstrapRollback.bootstrapFallback, true, "the first failed managed activation must fall back to the installed bootstrap");
  assert.equal(await readRuntimePointer(root, "current"), null);
  await switchRuntimePointer(root, first);
  await switchRuntimePointer(root, second);
  assert.equal((await readRuntimePointer(root, "current")).version, "2.0.0");
  assert.equal((await readRuntimePointer(root, "previous")).version, "1.0.0");
  await rollbackRuntimePointer(root);
  assert.equal((await readRuntimePointer(root, "current")).version, "1.0.0");
  await assert.rejects(() => writeRuntimePointer(root, "current", { runtimeRoot: path.join(root, "escape"), serverEntry: path.join(root, "escape", "server.mjs"), version: "3.0.0" }), /escapes/);
  const probe = await probeCandidateRuntime(second.serverEntry, { expectedVersion: "2.0.0", expectedPiVersion: "9.9.9" });
  assert.equal(probe.ok, true);
  assert.equal((await probeCandidateRuntime(second.serverEntry, { expectedVersion: "2.0.0", expectedPiVersion: "8.8.8" })).ok, false);
  const wrongProbe = await probeCandidateRuntime(second.serverEntry, { expectedVersion: "9.0.0" });
  assert.equal(wrongProbe.ok, false);
  const metadataOnly = await probeStartupRestore(second.serverEntry, { expectedVersion: "2.0.0", timeoutMs: 1_000 });
  assert.equal(metadataOnly.ok, false, "metadata-only candidates must fail isolated startup/restoration validation");

  assert.equal(compareWebuiVersions("1.0.0", "1.0.0-rc.2"), 1);
  assert.equal(compareWebuiVersions("1.0.0-rc.10", "1.0.0-rc.2"), 1);
  assert.equal(compareWebuiVersions("0.9.9", "1.0.0"), -1);
  await writeRuntimePointer(root, "current", first);
  const bootstrap = path.join(root, "node_modules", "@firstpick", "pi-package-webui");
  await mkdir(path.join(bootstrap, "bin"), { recursive: true });
  await writeFile(path.join(bootstrap, "bin", "pi-webui.mjs"), "// candidate stub, never executes real updates\n");
  const candidateManifest = path.join(bootstrap, "package.json");
  await writeFile(candidateManifest, JSON.stringify({ name: "@firstpick/pi-package-webui", version: "2.0.0" }));
  const rejected = await migrateLegacyBootstrap(root, bootstrap, { probe: async () => ({ ok: false }) });
  assert.equal(rejected.migrated, false);
  assert.equal(rejected.serverEntry, first.serverEntry);
  const migrated = await migrateLegacyBootstrap(root, bootstrap, { probe: async () => ({ ok: true }) });
  assert.equal(migrated.migrated, true);
  assert.equal((await readRuntimePointer(root, "current")).serverEntry, first.serverEntry, "never destroy the legacy pointer");
  const backups = await readdir(path.join(paths.root, "pointer-backups"));
  assert.equal(backups.length, 1);
  await writeFile(candidateManifest, JSON.stringify({ name: "@firstpick/pi-package-webui", version: "2.1.0" }));
  const upgraded = await migrateLegacyBootstrap(root, bootstrap, { probe: async (_, { expectedVersion }) => ({ ok: expectedVersion === "2.1.0" }) });
  assert.equal(upgraded.migrated, true, "a subsequent native upgrade remains on the validated bootstrap");
  assert.equal(JSON.parse(await readFile(path.join(paths.root, "native-migration.json"), "utf8")).version, "2.1.0");
  assert.equal((await readdir(path.join(paths.root, "pointer-backups"))).length, 1, "upgrades retain the original pointer backup");
  assert.deepEqual(JSON.parse(await readFile(path.join(paths.root, "pointer-backups", backups[0], "current.json"), "utf8")).version, "1.0.0");
  await writeFile(candidateManifest, JSON.stringify({ name: "@firstpick/pi-package-webui", version: "0.9.0" }));
  const downgrade = await migrateLegacyBootstrap(root, bootstrap, { probe: () => assert.fail("downgrade must not probe") });
  assert.equal(downgrade.migrated, false);
  assert.equal(downgrade.serverEntry, first.serverEntry);

  // The migration gate must run the candidate's real server and restore path,
  // not merely accept a version field from a stubbed metadata probe.
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const installedVersion = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;
  const functionalAgent = path.join(root, "functional-agent");
  const functionalPaths = managedRuntimePaths(functionalAgent);
  const oldRoot = path.join(functionalPaths.runtimesDir, "old");
  await mkdir(path.join(oldRoot, "bin"), { recursive: true });
  await writeFile(path.join(oldRoot, "package.json"), JSON.stringify({ name: "@firstpick/pi-package-webui", version: "0.0.1" }));
  await writeFile(path.join(oldRoot, "bin", "pi-webui.mjs"), "// old runtime retained by the fixture\n");
  await writeRuntimePointer(functionalAgent, "current", { runtimeRoot: oldRoot, serverEntry: path.join(oldRoot, "bin", "pi-webui.mjs"), version: "0.0.1" });
  const functionalCandidate = path.join(root, "functional", "node_modules", "@firstpick", "pi-package-webui");
  await mkdir(functionalCandidate, { recursive: true });
  for (const directory of ["bin", "lib", "public"]) {
    await cp(path.join(packageRoot, directory), path.join(functionalCandidate, directory), { recursive: true });
  }
  await writeFile(path.join(functionalCandidate, "package.json"), await readFile(path.join(packageRoot, "package.json")));
  const dependencies = path.join(functionalCandidate, "node_modules");
  await symlink(path.join(packageRoot, "node_modules"), dependencies, process.platform === "win32" ? "junction" : "dir");
  const actualProbe = (entry, options) => probeStartupRestore(entry, { ...options, timeoutMs: 20_000,
    piCommand: path.join(packageRoot, "tests", "fixtures", "fake-pi.mjs") });
  const functionalMigration = await migrateLegacyBootstrap(functionalAgent, functionalCandidate, { probe: actualProbe });
  assert.equal(functionalMigration.migrated, true, JSON.stringify(functionalMigration));
  assert.equal(functionalMigration.serverEntry, path.join(functionalCandidate, "bin", "pi-webui.mjs"));
  assert.equal((await readRuntimePointer(functionalAgent, "current")).version, "0.0.1", "successful migration must retain the legacy pointer");
  const isolatedCoordination = await sharedUpdateRoot({ home: root });
  const realEquivalentEffect = path.join(root, "functional");
  const verificationFence = await acquireEffectLocks(isolatedCoordination, [realEquivalentEffect], "probe-under-fence");
  try {
    const underFence = await actualProbe(path.join(functionalCandidate, "bin", "pi-webui.mjs"), { expectedVersion: installedVersion });
    assert.equal(underFence.ok, true, "probe must start and restore while the real-equivalent installed root is fenced");
  } finally { await releaseEffectLocks(verificationFence, { completionVerified: true }); } // Fixture only: no native command ran.
  await rm(dependencies);
  const missingDependencies = await migrateLegacyBootstrap(functionalAgent, functionalCandidate, { probe: actualProbe });
  assert.equal(missingDependencies.migrated, false, "candidate without its bundled dependencies cannot be selected");
  assert.equal(missingDependencies.serverEntry, path.join(oldRoot, "bin", "pi-webui.mjs"));
  assert.ok(compareWebuiVersions(installedVersion, "0.0.1") > 0);

  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = occupied.address().port;
  const replacement = createServer((_req, res) => res.end("ok"));
  setTimeout(() => occupied.close(), 180);
  const attempt = await listenWithRetry(replacement, { port, host: "127.0.0.1", attempts: 6, initialDelayMs: 50 });
  assert.ok(attempt > 1, "EADDRINUSE startup should retry with bounded backoff");
  await new Promise((resolve) => replacement.close(resolve));
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("update supervisor harness passed");
