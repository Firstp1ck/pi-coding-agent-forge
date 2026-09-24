import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { managedRuntimePaths, probeStartupRestore, readRuntimePointer } from "./supervisor.mjs";

const WEBUI = "@firstpick/pi-package-webui";
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const digest = (text) => createHash("sha256").update(text).digest("hex");

export function compareWebuiVersions(left, right) {
  const a = VERSION.exec(String(left || ""));
  const b = VERSION.exec(String(right || ""));
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff) return Math.sign(diff);
  }
  if (!a[4] && !b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const ac = a[4].split(".");
  const bc = b[4].split(".");
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    if (ac[i] === undefined) return -1;
    if (bc[i] === undefined) return 1;
    const x = ac[i], y = bc[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

async function privateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => {});
  } finally { await rm(temporary, { force: true }); }
}

async function candidateBootstrap(bootstrapRoot) {
  const root = path.resolve(bootstrapRoot);
  if (!(await lstat(root)).isDirectory()) throw new Error("Installed Web UI is linked or not a package directory.");
  const resolved = await realpath(root);
  if (resolved !== root || !root.split(path.sep).includes("node_modules")) throw new Error("Bootstrap is not a proven npm package root.");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const entry = path.join(root, "bin", "pi-webui.mjs");
  if (manifest.name !== WEBUI || !VERSION.test(manifest.version) || !(await stat(entry)).isFile() || await realpath(entry) !== entry) {
    throw new Error("Installed Web UI package name, version or server entry is unproven.");
  }
  return { root, entry, version: manifest.version };
}

async function pointerSnapshot(paths) {
  const current = await readFile(paths.currentPointer, "utf8");
  const previous = await readFile(paths.previousPointer, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return { current, previous, currentHash: digest(current), previousHash: digest(previous || "") };
}

/** Never discard pointers or runtime trees; the marker only changes bootstrap selection. */
export async function migrateLegacyBootstrap(agentDir, bootstrapRoot, { probe = probeStartupRestore } = {}) {
  const pointer = await readRuntimePointer(agentDir, "current");
  if (!pointer) return { migrated: false, serverEntry: path.join(bootstrapRoot, "bin", "pi-webui.mjs"), reason: "no-legacy-pointer" };
  const paths = managedRuntimePaths(agentDir);
  const legacy = { migrated: false, serverEntry: pointer.serverEntry, reason: "legacy-fallback" };
  try {
    const bootstrap = await candidateBootstrap(bootstrapRoot);
    const legacyManifest = JSON.parse(await readFile(path.join(path.dirname(path.dirname(pointer.serverEntry)), "package.json"), "utf8"));
    if (legacyManifest.name !== WEBUI || legacyManifest.version !== pointer.version) return { ...legacy, reason: "legacy-pointer-version-unproven" };
    const comparison = compareWebuiVersions(bootstrap.version, pointer.version);
    if (comparison === null || comparison < 0) return { ...legacy, reason: "downgrade-or-unproven-version" };
    const snapshot = await pointerSnapshot(paths);
    const markerFile = path.join(paths.root, "native-migration.json");
    let marker;
    try { marker = JSON.parse(await readFile(markerFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") return { ...legacy, reason: "migration-marker-invalid" }; }
    if (marker && (marker.schemaVersion !== 1 || marker.currentHash !== snapshot.currentHash ||
      marker.previousHash !== snapshot.previousHash || marker.bootstrapRoot !== bootstrap.root ||
      !path.isAbsolute(marker.backups || "") || compareWebuiVersions(bootstrap.version, marker.version) === null)) {
      return { ...legacy, reason: "migration-marker-mismatch" };
    }
    if (marker && compareWebuiVersions(bootstrap.version, marker.version) < 0) {
      return { ...legacy, reason: "downgrade-below-accepted-version" };
    }
    const health = await probe(bootstrap.entry, { expectedVersion: bootstrap.version });
    if (!health?.ok) return { ...legacy, reason: "startup-or-restore-validation-failed" };
    if ((await candidateBootstrap(bootstrapRoot)).version !== bootstrap.version ||
        (await pointerSnapshot(paths)).currentHash !== snapshot.currentHash ||
        (await pointerSnapshot(paths)).previousHash !== snapshot.previousHash) {
      return { ...legacy, reason: "candidate-or-pointer-changed-during-probe" };
    }
    if (!marker) {
      const backups = path.join(paths.root, "pointer-backups", randomUUID());
      await mkdir(backups, { recursive: true, mode: 0o700 });
      await privateJson(path.join(backups, "current.json"), JSON.parse(snapshot.current));
      await privateJson(path.join(backups, "previous.json"), snapshot.previous ? JSON.parse(snapshot.previous) : { absent: true });
      marker = { schemaVersion: 1, bootstrapRoot: bootstrap.root, version: bootstrap.version,
        currentHash: snapshot.currentHash, previousHash: snapshot.previousHash, backups };
      await privateJson(markerFile, marker);
    } else if (marker.version !== bootstrap.version) {
      await privateJson(markerFile, { ...marker, version: bootstrap.version });
    }
    return { migrated: true, serverEntry: bootstrap.entry, reason: "validated-equal-or-newer", legacyEntry: pointer.serverEntry };
  } catch (error) { return { ...legacy, reason: `validation-failed: ${String(error?.message || error).slice(0, 160)}` }; }
}
