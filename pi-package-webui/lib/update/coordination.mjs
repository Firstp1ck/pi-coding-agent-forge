import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, readdir, rename, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/;
const tokenFor = (root) => createHash("sha256").update(root).digest("hex");

async function privateDirectory(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // A symlinked coordination root could move locks into a target being replaced.
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("Update coordination root is not a physical directory.");
  if (process.platform !== "win32") {
    await chmod(root, 0o700);
    const info = await lstat(root);
    if (info.uid !== process.getuid()) throw new Error("Update coordination directory is not owned by this OS user.");
  }
  return root;
}

export async function sharedUpdateRoot({ home, platform = process.platform } = {}) {
  // An explicit fixture home must agree with its child processes, even when
  // the outer test runner supplies a different default isolation directory.
  const testHome = (process.env.NODE_ENV === "test" || process.env.PI_WEBUI_STARTUP_PROBE === "1") &&
    process.env.PI_WEBUI_UPDATE_TEST_HOME;
  if (home === undefined) {
    home = testHome && path.resolve(testHome).startsWith(`${path.resolve(tmpdir())}${path.sep}`)
      ? testHome : userInfo().homedir;
  }
  const root = platform === "win32"
    ? path.join(home, "AppData", "Local", "PiWebUI", "updates")
    : path.join(home, ".local", "state", "pi-webui-updates");
  return privateDirectory(path.resolve(root));
}

async function canonicalEffects(roots, stateRoot) {
  const canonical = [...new Set(await Promise.all(roots.map((root) => realpath(root))))].sort();
  if (!canonical.length) throw new Error("An update must have at least one proven physical effect root.");
  for (const root of canonical) {
    const relative = path.relative(root, stateRoot);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("Update coordination must remain outside every affected installation.");
    }
  }
  return canonical;
}

async function exclusiveJson(file, value) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await exclusiveJson(temporary, value);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export function effectLockPath(stateRoot, canonicalRoot) {
  return path.join(stateRoot, "effects", `${tokenFor(canonicalRoot)}.lock`);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function overlaps(left, right) { return inside(left, right) || inside(right, left); }

async function activeEffectLocks(stateRoot) {
  let entries = [];
  try { entries = await readdir(path.join(stateRoot, "effects")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const locks = [];
  for (const name of entries.filter((entry) => entry.endsWith(".lock"))) {
    const lock = JSON.parse(await readFile(path.join(stateRoot, "effects", name), "utf8"));
    if (!path.isAbsolute(lock.canonicalRoot) || !IDENTIFIER.test(lock.transactionId)) throw new Error("Effect fence is unreadable; manual recovery is required.");
    locks.push(lock);
  }
  return locks;
}

export async function assertEffectAdmission(stateRoot, roots) {
  const effects = await canonicalEffects(roots, stateRoot);
  let acquisitionHeld = false;
  try { await lstat(path.join(stateRoot, "effects", "acquire.guard")); acquisitionHeld = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (acquisitionHeld || (await activeEffectLocks(stateRoot)).some((lock) => effects.some((effect) => overlaps(effect, lock.canonicalRoot)))) {
    throw Object.assign(new Error("An affected installation is fenced for an update or recovery."), { code: "UPDATE_FENCED" });
  }
}

/** A crashed owner cannot release locks: only observed command receipts permit release. */
export async function acquireEffectLocks(stateRoot, roots, transactionId) {
  if (!IDENTIFIER.test(transactionId)) throw new TypeError("invalid transaction id");
  const effects = await canonicalEffects(roots, stateRoot);
  await mkdir(path.join(stateRoot, "effects"), { recursive: true, mode: 0o700 });
  // Serializing acquisition also prevents parent/child effect roots from
  // entering concurrently before either lock file becomes visible.
  const guard = path.join(stateRoot, "effects", "acquire.guard");
  let guardHandle;
  try { guardHandle = await open(guard, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw Object.assign(new Error("Update admission is held or recovery is required."), { code: "UPDATE_FENCED" });
    throw error;
  }
  const token = randomUUID();
  const acquired = [];
  try {
    if ((await activeEffectLocks(stateRoot)).some((lock) => effects.some((effect) => overlaps(effect, lock.canonicalRoot)))) {
      throw Object.assign(new Error("An affected installation is already fenced."), { code: "UPDATE_FENCED" });
    }
    for (const root of effects) {
      const file = effectLockPath(stateRoot, root);
      await exclusiveJson(file, { token, transactionId, canonicalRoot: root, at: new Date().toISOString() });
      acquired.push(file);
    }
    return Object.freeze({ token, transactionId, effects, files: acquired });
  } catch (error) {
    for (const file of acquired) await rm(file, { force: true });
    if (error?.code === "EEXIST") throw Object.assign(new Error("An affected installation is already fenced."), { code: "UPDATE_FENCED" });
    throw error;
  } finally {
    await guardHandle.close();
    await rm(guard);
  }
}

export async function releaseEffectLocks(lock, { completionVerified = false } = {}) {
  if (!completionVerified) throw new Error("Cannot release effects before command completion is verified.");
  for (const file of lock.files) {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved.token !== lock.token || saved.transactionId !== lock.transactionId) throw new Error("Update effect lock changed owner.");
  }
  for (const file of lock.files) await rm(file);
}

export async function persistSharedJob(stateRoot, job) {
  if (!IDENTIFIER.test(job?.transactionId)) throw new TypeError("invalid transaction id");
  await mkdir(path.join(stateRoot, "jobs"), { recursive: true, mode: 0o700 });
  await atomicJson(path.join(stateRoot, "jobs", `${job.transactionId}.json`), job);
}

export async function registerUpdateParticipant(stateRoot, { kind, roots, pid = process.pid } = {}) {
  if (!["server", "rpc-supervisor"].includes(kind)) throw new TypeError("unknown update participant");
  const canonicalRoots = await canonicalEffects(roots, stateRoot);
  const token = randomUUID();
  const file = path.join(stateRoot, "participants", `${token}.json`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await exclusiveJson(file, { token, kind, pid, canonicalRoots, registeredAt: new Date().toISOString(), ack: null });
  return Object.freeze({ token, kind, pid, file, canonicalRoots });
}

export async function acknowledgeUpdateFence(participant, lock, idle) {
  if (!participant || !lock) return;
  if (!participant.canonicalRoots.some((root) => lock.effects.some((effect) => overlaps(effect, root)))) return;
  await atomicJson(participant.file, { token: participant.token, kind: participant.kind, pid: participant.pid,
    canonicalRoots: participant.canonicalRoots, ack: { lockToken: lock.token, idle: idle === true, at: new Date().toISOString() } });
}

export async function effectLockForRoot(stateRoot, root) {
  const canonical = await realpath(root);
  const matching = (await activeEffectLocks(stateRoot)).filter((lock) => overlaps(canonical, lock.canonicalRoot));
  if (matching.length > 1) throw new Error("Multiple overlapping update fences require manual recovery.");
  return matching[0] || null;
}

export async function unregisterUpdateParticipant(participant) {
  if (!participant) return;
  const current = JSON.parse(await readFile(participant.file, "utf8"));
  if (current.token !== participant.token || current.pid !== participant.pid) throw new Error("Update participant changed identity.");
  await rm(participant.file);
}

export async function affectedParticipants(stateRoot, lock) {
  let entries = [];
  try { entries = await readdir(path.join(stateRoot, "participants")); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const participants = [];
  for (const entry of entries.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
    let participant;
    try { participant = JSON.parse(await readFile(path.join(stateRoot, "participants", entry), "utf8")); }
    catch { throw new Error("Update participant state is unreadable; recovery is required."); }
    if (participant.canonicalRoots?.some((root) => lock.effects.some((effect) => overlaps(effect, root)))) participants.push(participant);
  }
  return participants;
}

export function createUpdateAdmissionCounter() {
  let pending = 0;
  return {
    begin() {
      pending++;
      let closed = false;
      return () => { if (!closed) { pending--; closed = true; } };
    },
    get idle() { return pending === 0; },
  };
}

export async function readSharedJob(stateRoot, transactionId) {
  if (!IDENTIFIER.test(transactionId)) throw new TypeError("invalid transaction id");
  try { return JSON.parse(await readFile(path.join(stateRoot, "jobs", `${transactionId}.json`), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
