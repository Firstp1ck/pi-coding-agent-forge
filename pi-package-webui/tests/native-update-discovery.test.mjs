import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverNativeJobs, nativeJobBlocksUpdates, publicNativeJob } from "../lib/update/discovery.mjs";
import { persistSharedJob, sharedUpdateRoot } from "../lib/update/coordination.mjs";

const root = await mkdtemp(path.join(tmpdir(), "pi-webui-discovery-"));
const scope = { agentDir: path.join(root, "agent"), ownerPackageRoot: path.join(root, "package"), ownerBootIdentity: "boot-test" };
const record = (requested, phase, day, context = {}) => {
  const transactionId = randomUUID();
  return { transactionId, phase, lock: { token: "never-public" },
    plan: { schemaVersion: 2, transactionId, requested, createdAt: `2026-09-${day}T00:00:00.000Z`,
      context: { ...scope, ...context } }, outcome: phase,
    verifiedTargets: [{ id: requested, status: phase === "success" ? "healthy" : "unverified" }] };
};
try {
  const previousMode = process.env.NODE_ENV;
  const previousHome = process.env.PI_WEBUI_UPDATE_TEST_HOME;
  try {
    process.env.NODE_ENV = "test";
    process.env.PI_WEBUI_UPDATE_TEST_HOME = path.join(root, "outer-suite");
    const explicitHome = path.join(root, "explicit-fixture");
    const expectedRoot = path.join(explicitHome, process.platform === "win32" ? "AppData/Local/PiWebUI/updates" : ".local/state/pi-webui-updates");
    assert.equal(await sharedUpdateRoot({ home: explicitHome }), expectedRoot,
      "an outer suite's default must not put parent and fixture child in different fence domains");
  } finally {
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (previousHome === undefined) delete process.env.PI_WEBUI_UPDATE_TEST_HOME; else process.env.PI_WEBUI_UPDATE_TEST_HOME = previousHome;
  }
  assert.deepEqual(await discoverNativeJobs(root, scope), { pi: null, webui: null });
  const completed = record("pi", "success", "20");
  const partial = record("webui", "partial", "21");
  const planned = record("pi", "planned", "23");
  const unrelated = record("webui", "unknown", "23", { agentDir: path.join(root, "another-agent") });
  for (const job of [completed, partial, planned, unrelated]) await persistSharedJob(root, job);
  let found = await discoverNativeJobs(root, scope);
  assert.equal(found.pi.transactionId, completed.transactionId, "unconfirmed previews must not hide a completed job");
  assert.equal(found.webui.transactionId, partial.transactionId, "another agent directory must not contaminate discovery");
  assert.equal(found.webui.phase, "partial", "partial outcomes survive a new browser with no saved job ID");
  assert.equal(JSON.stringify(found).includes("never-public"), false, "fence authorization must never reach HTTP responses");
  assert.equal(nativeJobBlocksUpdates(found.pi), false);
  const interrupted = record("pi", "unknown", "19");
  await persistSharedJob(root, interrupted);
  found = await discoverNativeJobs(root, scope);
  assert.equal(found.pi.transactionId, interrupted.transactionId, "an older unresolved job takes priority over newer terminal results");
  assert.equal(nativeJobBlocksUpdates(found.pi), true);
  for (let index = 0; index < 1025; index++) await persistSharedJob(root, record("pi", "planned", "23"));
  found = await discoverNativeJobs(root, scope);
  assert.equal(found.pi.transactionId, interrupted.transactionId, "canceled previews do not exhaust launched-history discovery");
  const lostOwner = record("webui", "command-complete", "22", { ownerBootIdentity: "old-boot" });
  await persistSharedJob(root, lostOwner);
  found = await discoverNativeJobs(root, scope);
  assert.equal(found.webui.phase, "unknown", "discovery must not authorize another server to restart an old owner's job");
  assert.match(found.webui.error, /original update owner/);
  assert.equal(publicNativeJob({ ...partial, jobDir: "private-capsule", launcherPid: 1 }).jobDir, undefined);
  await assert.rejects(discoverNativeJobs(root, { ...scope, maxRecords: 1 }), /discovery limit/);
  const malformed = path.join(root, "jobs", `${randomUUID()}.json`);
  await writeFile(malformed, "{malformed");
  await assert.rejects(discoverNativeJobs(root, scope), SyntaxError, "unreadable history must fail closed");
  await rm(malformed);
  const directoryRecord = path.join(root, "jobs", `${randomUUID()}.json`);
  await mkdir(directoryRecord);
  await assert.rejects(discoverNativeJobs(root, scope), /linked or exceeds/, "unexpected filesystem types must not be followed");
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("native-update-discovery.test.mjs passed");
