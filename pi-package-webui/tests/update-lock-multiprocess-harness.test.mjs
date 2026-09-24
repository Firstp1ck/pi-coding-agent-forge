import assert from "node:assert/strict";
import { acquireEffectLocks, acknowledgeUpdateFence, affectedParticipants, assertEffectAdmission, createUpdateAdmissionCounter, releaseEffectLocks, registerUpdateParticipant, sharedUpdateRoot, unregisterUpdateParticipant } from "../lib/update/coordination.mjs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireInstallLock, releaseInstallLock } from "../lib/update/journal.mjs";

if (process.argv[2] === "--contender") {
  const root = process.argv[3];
  const holdMs = Number.parseInt(process.argv[4], 10);
  try {
    const lock = await acquireInstallLock(root);
    process.stdout.write("acquired\n");
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await releaseInstallLock(lock);
    process.exit(0);
  } catch (error) {
    process.stdout.write(`${error.code || "error"}\n`);
    process.exit(error.code === "UPDATE_LOCKED" ? 2 : 3);
  }
}

function contender(root, holdMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--contender", root, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => resolve({ code, output }));
  });
}

const root = await mkdtemp(path.join(tmpdir(), "pi-webui-lock-process-"));
try {
  const firstPromise = contender(root, 700);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = await contender(root, 0);
  const first = await firstPromise;
  assert.equal(first.code, 0, first.output);
  assert.equal(second.code, 2, second.output);
  assert.match(second.output, /UPDATE_LOCKED/);

  const stateRoot = await sharedUpdateRoot({ home: root });
  const effect = path.join(root, "global", "node_modules");
  await mkdir(effect, { recursive: true });
  const server = await registerUpdateParticipant(stateRoot, { kind: "server", roots: [effect] });
  const supervisor = await registerUpdateParticipant(stateRoot, { kind: "rpc-supervisor", roots: [effect] });
  const admitted = createUpdateAdmissionCounter();
  const finishUnpublishedTab = admitted.begin();
  const job = await acquireEffectLocks(stateRoot, [effect, effect], "one");
  assert.equal((await affectedParticipants(stateRoot, job)).length, 2);
  await acknowledgeUpdateFence(server, job, admitted.idle);
  assert.equal((await affectedParticipants(stateRoot, job)).find((owner) => owner.token === server.token).ack.idle, false,
    "a lock cannot admit the update while an admitted tab is still unpublished");
  await assert.rejects(assertEffectAdmission(stateRoot, [effect]), { code: "UPDATE_FENCED" },
    "the tab must recheck the fence before publishing its Pi child");
  finishUnpublishedTab();
  await acknowledgeUpdateFence(server, job, admitted.idle);
  await acknowledgeUpdateFence(supervisor, job, false);
  assert.equal((await affectedParticipants(stateRoot, job)).every((owner) => owner.ack.idle), false);
  assert.equal(job.files.length, 1, "aliased declarations must not duplicate physical mutation");
  await assert.rejects(acquireEffectLocks(stateRoot, [effect], "two"), { code: "UPDATE_FENCED" });
  await assert.rejects(assertEffectAdmission(stateRoot, [effect]), { code: "UPDATE_FENCED" });
  await assert.rejects(releaseEffectLocks(job), /completion/);
  await releaseEffectLocks(job, { completionVerified: true });
  await assertEffectAdmission(stateRoot, [effect]);
  const nested = path.join(effect, "@firstpick", "pi-package-webui");
  await mkdir(nested, { recursive: true });
  const descendant = await registerUpdateParticipant(stateRoot, { kind: "server", roots: [nested] });
  const parentLock = await acquireEffectLocks(stateRoot, [effect], "parent");
  assert.equal((await affectedParticipants(stateRoot, parentLock)).length, 3, "nested consumers must acknowledge their ancestor effect");
  await assert.rejects(assertEffectAdmission(stateRoot, [nested]), { code: "UPDATE_FENCED" });
  await assert.rejects(acquireEffectLocks(stateRoot, [nested], "child"), { code: "UPDATE_FENCED" });
  await releaseEffectLocks(parentLock, { completionVerified: true });
  const childLock = await acquireEffectLocks(stateRoot, [nested], "child");
  await assert.rejects(assertEffectAdmission(stateRoot, [effect]), { code: "UPDATE_FENCED" });
  await assert.rejects(acquireEffectLocks(stateRoot, [effect], "parent-again"), { code: "UPDATE_FENCED" });
  await releaseEffectLocks(childLock, { completionVerified: true });
  const activePi = path.join(root, "explicit-active-pi");
  const pathPi = path.join(root, "separate-path-pi");
  await Promise.all([mkdir(activePi), mkdir(pathPi)]);
  const explicitOwner = await registerUpdateParticipant(stateRoot, { kind: "server", roots: [activePi, pathPi] });
  const pathOwner = await registerUpdateParticipant(stateRoot, { kind: "server", roots: [pathPi] });
  const releaseRestart = admitted.begin();
  const explicitLock = await acquireEffectLocks(stateRoot, [activePi], "explicit-pi-update");
  assert.deepEqual((await affectedParticipants(stateRoot, explicitLock)).map(({ token }) => token), [explicitOwner.token],
    "a different PATH Pi cannot stand in for an explicitly active installation");
  await acknowledgeUpdateFence(explicitOwner, explicitLock, admitted.idle);
  assert.equal((await affectedParticipants(stateRoot, explicitLock))[0].ack.idle, false,
    "restart lease acquired before handoff must block idle acknowledgment during its await");
  await assert.rejects(assertEffectAdmission(stateRoot, [activePi]), { code: "UPDATE_FENCED" },
    "ordinary restart must recheck admission before launching the successor");
  releaseRestart();
  await releaseEffectLocks(explicitLock, { completionVerified: true });
  await unregisterUpdateParticipant(explicitOwner);
  await unregisterUpdateParticipant(pathOwner);
  await unregisterUpdateParticipant(descendant);
  await unregisterUpdateParticipant(server);
  await unregisterUpdateParticipant(supervisor);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("update lock multiprocess harness passed");
