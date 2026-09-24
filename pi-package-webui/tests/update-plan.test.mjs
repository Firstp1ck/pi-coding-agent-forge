import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readUpdateContext } from "../bin/pi-webui-update-context.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { affectedActivePiDependency, createNativeUpdatePlan, inspectNativeJob, launchNativeUpdate, validateNativePlan } from "../lib/update/native-jobs.mjs";
import { discoverNativeJobs } from "../lib/update/discovery.mjs";
import { acknowledgeUpdateFence, effectLockForRoot, persistSharedJob, readSharedJob, registerUpdateParticipant,
  releaseEffectLocks, sharedUpdateRoot, unregisterUpdateParticipant } from "../lib/update/coordination.mjs";
import { assertActionableUpdatePlan, assertPlanIdentity, assertUpdatePlanDigest, createUpdatePlan, digestUpdatePlan } from "../lib/update/plan.mjs";

const ownerRoot = path.resolve("tmp", "agent", "npm", "node_modules");
let movingLatest = "2.0.0";
let resolutions = 0;
const identity = { canonicalId: "pi:/agent/pi-cli.js", version: "1.0.0" };
const plan = await createUpdatePlan({
  transactionId: "moving-latest",
  createdAt: "2026-08-07T00:00:00.000Z",
  registry: "https://registry.example.invalid/",
  identities: [identity],
  candidates: [{
    id: "pi",
    kind: "pi",
    packageName: "@earendil-works/pi-coding-agent",
    identityId: identity.canonicalId,
    currentVersion: "1.0.0",
    requested: "latest",
    owner: { manager: "npm", ownerRoot, packageRoot: path.join(ownerRoot, "@earendil-works", "pi-coding-agent") },
    commandForVersion: async (exact, registry) => ({ command: "npm", args: ["install", `@earendil-works/pi-coding-agent@${exact}`, "--registry", registry] }),
  }, {
    id: "optional:statsCommand",
    kind: "optional",
    packageName: "@firstpick/pi-extension-stats",
    identityId: identity.canonicalId,
    currentVersion: "1.0.0",
    requested: "latest",
    owner: { manager: "pi", ownerRoot, packageRoot: path.join(ownerRoot, "@firstpick", "pi-extension-stats"), optional: true, piOwned: true },
    commandForVersion: async (exact) => ({ command: "pi", args: ["install", `npm:@firstpick/pi-extension-stats@${exact}`] }),
  }, {
    id: "source-addon",
    packageName: "example-source-addon",
    currentVersion: "1.0.0",
    owner: { manager: "npm", ownerRoot, packageRoot: path.resolve("source"), sourceCheckout: true },
    commandForVersion: () => assert.fail("refused targets must not get commands"),
  }],
  resolveExactTarget: async ({ requested }) => {
    resolutions += 1;
    assert.equal(requested, "latest");
    return { version: movingLatest, metadata: { integrity: "sha512-fixture" } };
  },
});
assert.equal(resolutions, 2);
assert.equal(plan.targets[0].targetVersion, "2.0.0");
assert.deepEqual(plan.targets[0].command.args, ["install", "@earendil-works/pi-coding-agent@2.0.0", "--registry", "https://registry.example.invalid/"]);
assert.deepEqual(plan.targets[1].command.args, ["install", "npm:@firstpick/pi-extension-stats@2.0.0"], "Pi-owned optional packages should retain exact targets inside the same digest-bound plan");
assert.equal(plan.refusals[0].code, "source");
assertUpdatePlanDigest(plan, plan.digest);
assert.equal(plan.digest, digestUpdatePlan(plan));
assertPlanIdentity(plan.targets[0], identity);
assert.equal(assertActionableUpdatePlan(plan), true);
const refusedOnlyPlan = await createUpdatePlan({
  transactionId: "refused-only",
  createdAt: "2026-08-07T00:00:00.000Z",
  registry: "https://registry.example.invalid/",
  identities: [],
  candidates: [{ id: "pi", packageName: "@earendil-works/pi-coding-agent", owner: { manager: "unknown" } }],
  resolveExactTarget: () => assert.fail("refused plans must not resolve moving targets"),
});
assert.throws(() => assertActionableUpdatePlan(refusedOnlyPlan), { code: "UPDATE_PLAN_NO_TARGETS", statusCode: 409 });

movingLatest = "3.0.0";
assert.equal(plan.targets[0].targetVersion, "2.0.0", "confirmation remains bound to the originally resolved exact target");
assert.throws(() => assertUpdatePlanDigest({ ...plan, targets: [{ ...plan.targets[0], targetVersion: movingLatest }] }, plan.digest), { code: "UPDATE_PLAN_DIGEST_MISMATCH" });
assert.throws(() => assertPlanIdentity(plan.targets[0], { canonicalId: "pi:/different/cli.js" }), { code: "UPDATE_IDENTITY_CHANGED" });
const fixture = await mkdtemp(path.join(tmpdir(), "pi-webui-native-plan-"));
try {
  const driver = path.join(fixture, "stub-cli.js");
  await writeFile(driver, "// read-only stub driver; never invoke a real updater\n");
  const confirmed = await readUpdateContext({ env: process.env });
  const nodeDigest = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
  const native = await createNativeUpdatePlan({ requested: "pi", context: {
    cwd: fixture, agentDir: fixture, shell: process.execPath, shellDigest: nodeDigest, nodeDigest,
    settingsPath: path.join(fixture, "settings.json"), npmConfigFiles: [], ...confirmed,
  },
    targets: [{ eligible: true, id: "pi", driver, installed: { root: fixture, version: "0.87.1" }, effectRoot: fixture,
      command: { command: process.execPath, args: [driver, "update"] } }], });
  validateNativePlan(native, native.digest);
  assert.deepEqual(native.targets[0].command.args.slice(-1), ["update"]);
  await persistSharedJob(fixture, { transactionId: native.transactionId, plan: native, phase: "planned" });
  assert.equal((await inspectNativeJob(fixture, native.transactionId)).phase, "planned");
  assert.throws(() => validateNativePlan({ ...native, requested: "webui" }, native.digest), /changed/);
  await assert.rejects(createNativeUpdatePlan({ requested: "webui", context: { cwd: fixture, agentDir: fixture }, targets: [{ eligible: true, id: "pi" }] }), /Combined/);

  const globalEffect = path.join(fixture, "global");
  const bundledRoot = path.join(globalEffect, "node_modules", "@earendil-works", "pi-coding-agent");
  const webuiEffect = [{ id: "webui:npm-global", effectRoot: globalEffect, status: "unchanged" }];
  assert.equal(affectedActivePiDependency({ active: { piRoot: bundledRoot } }, webuiEffect), webuiEffect[0],
    "a WebUI command may change its hoisted active Pi dependency even with an unchanged WebUI version");
  assert.equal(affectedActivePiDependency({ active: { piRoot: path.join(fixture, "separate-path-pi") } }, webuiEffect), null,
    "distinct PATH Pi must not be reloaded after unrelated WebUI mutation");
  assert.equal(affectedActivePiDependency({ active: { piRoot: path.join(fixture, "explicit-pi") } }, webuiEffect), null,
    "distinct explicitly selected Pi must not be reloaded after unrelated WebUI mutation");
  assert.equal(affectedActivePiDependency({ active: { piRoot: bundledRoot } }, [{ ...webuiEffect[0], status: "failed" }]), null,
    "failed WebUI effects cannot authorize an active Pi reload");
  const stateRoot = await sharedUpdateRoot({ home: fixture });
  const effectRoot = path.join(fixture, "separate-installation");
  await mkdir(effectRoot);
  const participant = await registerUpdateParticipant(stateRoot, { kind: "server", roots: [effectRoot] });
  const launchPlan = await createNativeUpdatePlan({ requested: "pi", context: { ...native.context,
    cwd: stateRoot, shell: process.execPath, ownerPackageRoot: fixture },
    targets: [{ eligible: true, id: "pi", driver, installed: { root: effectRoot, version: "0.87.1" }, effectRoot,
      command: { command: process.execPath, args: [driver, "update"] } }], });
  await persistSharedJob(stateRoot, { transactionId: launchPlan.transactionId, plan: launchPlan, phase: "planned" });
  let spawned = null;
  const mockSpawn = (shell, args, options) => {
    spawned = { shell, args, options };
    const child = new EventEmitter();
    child.pid = 12345;
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const acknowledge = setInterval(async () => {
    const lock = await effectLockForRoot(stateRoot, effectRoot);
    if (lock) await acknowledgeUpdateFence(participant, { token: lock.token, effects: [effectRoot] }, true);
  }, 20);
  try {
    const launched = await launchNativeUpdate(launchPlan, launchPlan.digest, { stateRoot, spawnImpl: mockSpawn,
      env: { ...process.env, PI_FIXTURE_API_TOKEN: "private-secret-only-in-memory" },
      requiredParticipants: [{ kind: "server", token: participant.token }] });
    assert.equal(launched.phase, "running");
    assert.equal(spawned.shell, process.execPath, "the confirmed executable must be used, not a PATH lookup");
    assert.equal(spawned.options.detached, true, "the guardian or Bash must survive the server");
    assert.equal(spawned.options.stdio, "ignore", "the background job must not depend on server streams");
    if (process.platform === "win32") {
      assert.equal(spawned.args[0], path.join(stateRoot, "jobs", launchPlan.transactionId, "guardian.mjs"));
      assert.equal(spawned.options.env.PI_WEBUI_UPDATE_SHELL, process.execPath);
    } else assert.deepEqual(spawned.args.slice(0, 2), ["--noprofile", "--norc"]);
    assert.equal(spawned.options.env.PI_FIXTURE_API_TOKEN, "private-secret-only-in-memory");
    const job = await readSharedJob(stateRoot, launchPlan.transactionId);
    const intentText = await readFile(path.join(job.jobDir, "intent.json"), "utf8");
    assert.equal(intentText.includes("private-secret-only-in-memory"), false, "intent must not durably copy the launch environment");
    assert.equal(JSON.parse(intentText).env, undefined);
    await readFile(path.join(job.jobDir, "pi-webui-update-context.mjs"));
    if (process.platform === "win32") {
      await readFile(path.join(job.jobDir, "guardian.mjs"));
      await writeFile(path.join(job.jobDir, "guardian-launch-failed.json"), JSON.stringify({
        transactionId: launchPlan.transactionId, guardianPid: launched.launcherPid, noShellStarted: true,
      }));
      assert.equal((await inspectNativeJob(stateRoot, launchPlan.transactionId)).phase, "launch-failed",
        "a guardian's proven pre-shell failure can be finalized without claiming command completion");
    }
    await releaseEffectLocks(job.lock, { completionVerified: true }); // The fixture spawn never launched a native command.
    await persistSharedJob(stateRoot, { ...job, phase: "failed", outcome: "failed" });
    const failedPlan = await createNativeUpdatePlan({ requested: "pi", context: { ...native.context,
      cwd: stateRoot, shell: process.execPath, ownerPackageRoot: fixture },
      targets: [{ eligible: true, id: "pi", driver, installed: { root: effectRoot, version: "0.87.1" }, effectRoot,
        command: { command: process.execPath, args: [driver, "update"] } }] });
    const refusedSpawn = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", Object.assign(new Error("fixture shell refusal"), { code: "EACCES" })));
      return child;
    };
    await assert.rejects(launchNativeUpdate(failedPlan, failedPlan.digest, { stateRoot,
      spawnImpl: refusedSpawn, env: process.env, requiredParticipants: [{ kind: "server", token: participant.token }] }),
      /fixture shell refusal/);
    assert.equal((await inspectNativeJob(stateRoot, failedPlan.transactionId)).phase, "failed");
    assert.equal((await discoverNativeJobs(stateRoot, { agentDir: failedPlan.context.agentDir,
      ownerPackageRoot: fixture })).pi.phase, "failed", "a proven pre-spawn failure permits a fresh confirmation");
    assert.equal(await effectLockForRoot(stateRoot, effectRoot), null);
  } finally {
    clearInterval(acknowledge);
    await unregisterUpdateParticipant(participant);
  }
} finally { await rm(fixture, { recursive: true, force: true }); }
console.log("update-plan.test.mjs passed");
