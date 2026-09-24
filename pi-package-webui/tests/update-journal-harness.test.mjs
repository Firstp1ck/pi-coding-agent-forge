import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { inspectNativeJob } from "../lib/update/native-jobs.mjs";
import { persistSharedJob } from "../lib/update/coordination.mjs";
import path from "node:path";
import {
  acquireInstallLock, createUpdateJournal, readUpdateJournal, reconcileInterruptedUpdates,
  releaseInstallLock, transferInstallLock, transitionUpdateJournal, updateStatePaths,
} from "../lib/update/journal.mjs";

const agentDir = await mkdtemp(path.join(tmpdir(), "pi-webui-update-journal-"));
const plan = (transactionId) => ({ schemaVersion: 1, transactionId, digest: "a".repeat(64), targets: [] });
try {
  let journal = await createUpdateJournal(agentDir, plan("tx-transition"));
  assert.equal(journal.state, "planned");
  journal = await transitionUpdateJournal(agentDir, "tx-transition", "applying");
  journal = await transitionUpdateJournal(agentDir, "tx-transition", "verifying", { receipts: [{ targetId: "pi", status: "success" }] });
  journal = await transitionUpdateJournal(agentDir, "tx-transition", "success");
  assert.deepEqual(journal.history.map((item) => item.state), ["planned", "applying", "verifying", "success"]);
  assert.equal((await readUpdateJournal(agentDir, "tx-transition")).state, "success");
  await assert.rejects(transitionUpdateJournal(agentDir, "tx-transition", "applying"), { code: "UPDATE_JOURNAL_TRANSITION" });

  if (process.platform !== "win32") {
    const mode = (await stat(path.join(updateStatePaths(agentDir).updatesDir, "tx-transition.json"))).mode & 0o777;
    assert.equal(mode, 0o600, "journal files should be private");
  }

  const first = await acquireInstallLock(agentDir);
  await assert.rejects(acquireInstallLock(agentDir), { code: "UPDATE_LOCKED" });
  assert.equal(await releaseInstallLock({ ...first, token: "wrong-owner" }), false);
  const transferred = await transferInstallLock(first, 424240);
  assert.equal(transferred.pid, 424240, "activation helpers should become the persisted lock owner before the parent exits");
  assert.equal(JSON.parse(await readFile(first.path, "utf8")).pid, 424240);
  assert.equal(await releaseInstallLock(transferred), true);

  const paths = updateStatePaths(agentDir);
  const old = new Date(Date.now() - 60_000).toISOString();
  await writeFile(paths.installLock, `${JSON.stringify({ schemaVersion: 1, token: "stale", pid: 424242, acquiredAt: old })}\n`, { mode: 0o600 });
  const recoveredLock = await acquireInstallLock(agentDir, { staleAfterMs: 1_000, isProcessAlive: () => false });
  assert.notEqual(recoveredLock.token, "stale", "definitely dead stale lock should be replaced");
  await releaseInstallLock(recoveredLock);

  await writeFile(paths.installLock, `${JSON.stringify({ schemaVersion: 1, token: "uncertain", pid: 424243, acquiredAt: old })}\n`, { mode: 0o600 });
  await assert.rejects(acquireInstallLock(agentDir, { staleAfterMs: 1_000, isProcessAlive: () => true }), { code: "UPDATE_LOCKED" }, "an old but live/uncertain lock must fail closed");
  await rm(paths.installLock, { force: true });

  await createUpdateJournal(agentDir, plan("tx-interrupted"));
  await transitionUpdateJournal(agentDir, "tx-interrupted", "applying");
  await transitionUpdateJournal(agentDir, "tx-interrupted", "verifying");
  await transitionUpdateJournal(agentDir, "tx-interrupted", "activating");
  const reconciled = await reconcileInterruptedUpdates(agentDir, { recover: async (entry) => ({ state: "rolled-back", error: `Recovered ${entry.transactionId}` }) });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].state, "rolled-back");
  assert.equal(reconciled[0].reconciled, true);
  assert.match(reconciled[0].error, /Recovered tx-interrupted/);
  assert.doesNotMatch(await readFile(path.join(paths.updatesDir, "tx-interrupted.json"), "utf8"), /\.tmp/);
  const privateJobDir = path.join(agentDir, "private-job");
  await mkdir(privateJobDir);
  await persistSharedJob(agentDir, { transactionId: "lost-receipt", phase: "running", jobDir: privateJobDir,
    plan: { targets: [{ id: "pi" }] }, launchedAt: new Date(Date.now() - 30_000).toISOString() });
  const interrupted = await inspectNativeJob(agentDir, "lost-receipt");
  assert.equal(interrupted.phase, "unknown", "lost runner/receipt evidence must never become completion or unlock exclusion");
  console.log("update-journal-harness.test.mjs passed");
} finally {
  await rm(agentDir, { recursive: true, force: true });
}
