import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runUpdateJob } from "../bin/pi-webui-native-update-runner.mjs";
import { frozenUpdateEnvironment, readUpdateContext } from "../bin/pi-webui-update-context.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { executeCommand } from "../lib/update/executor.mjs";

const root = await mkdtemp(path.join(tmpdir(), "pi-webui-update-tree-"));
const sentinel = path.join(root, "descendant-sentinel.txt");
const fixture = fileURLToPath(new URL("./fixtures/update/tree-timeout-parent.mjs", import.meta.url));
try {
  const result = await executeCommand(process.execPath, [fixture, sentinel], { timeoutMs: 300, closeTimeoutMs: 5_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.closureTimedOut, false, `timed-out command should close after tree termination: ${JSON.stringify(result)}`);
  assert.deepEqual(result.args, [fixture, sentinel], "executor preserves argument arrays");
  await delay(1_100);
  await assert.rejects(access(sentinel), { code: "ENOENT" }, "a timed-out descendant must not survive to write its delayed sentinel");
  const manifestPath = path.join(root, "installed.json");
  const driver = path.join(root, "stub-update.mjs");
  await writeFile(manifestPath, JSON.stringify({ name: "fixture-package", version: "1.0.0" }));
  await writeFile(driver, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(manifestPath)}, JSON.stringify({name:"fixture-package",version:"1.1.0"})); console.log(process.env.PI_TEST_SECRET_TOKEN || "fixture only");`);
  const oldSecret = process.env.PI_TEST_SECRET_TOKEN;
  process.env.PI_TEST_SECRET_TOKEN = "fixture-secret-value-not-for-disk";
  const digest = createHash("sha256").update(await readFile(driver)).digest("hex");
  const bindings = await readUpdateContext({ env: process.env });
  await writeFile(path.join(root, "intent.json"), JSON.stringify({
    transactionId: "stub-job", cwd: root, ...bindings, npmConfigFiles: [],
    nodeDigest: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
    targets: [{ id: "fixture", packageName: "fixture-package", beforeVersion: "1.0.0", manifestPath,
      driver, driverDigest: digest, command: { command: process.execPath, args: [driver] } }],
  }));
  assert.equal((await readFile(path.join(root, "intent.json"), "utf8")).includes('"env"'), false, "secret-bearing environment is never stored in a job intent");
  const receipts = await runUpdateJob(root);
  assert.equal(receipts[0].stdout.trim(), "[redacted]", "a secret emitted by a native command must not enter a receipt");
  assert.equal((await readFile(path.join(root, "intent.json"), "utf8")).includes(process.env.PI_TEST_SECRET_TOKEN), false);
  assert.equal(receipts[0].status, "changed", "a changed manifest is not yet a healthy restart approval");
  assert.equal((await readFile(path.join(root, "complete.json"), "utf8")).includes("changed"), true);
  await assert.rejects(runUpdateJob(root), /replay is prohibited/);
  const secondJob = path.join(root, "second");
  await mkdir(secondJob);
  await writeFile(path.join(secondJob, "intent.json"), (await readFile(path.join(root, "intent.json"), "utf8")).replace("stub-job", "stub-job-2"));
  await writeFile(manifestPath, JSON.stringify({ name: "fixture-package", version: "1.0.0" }));
  await writeFile(driver, "throw new Error('changed driver')");
  const changed = await runUpdateJob(secondJob);
  assert.match(changed[0].error, /driver changed/);
  assert.equal(changed[0].status, "failed");
  const npmrc = path.join(root, "user.npmrc");
  await writeFile(npmrc, "registry=https://registry.example.invalid/\n//registry.example.invalid/:_authToken=fixture-npm-secret\n");
  const frozen = frozenUpdateEnvironment({ ...process.env, BASH_ENV: path.join(root, "startup.sh") }, root);
  assert.equal(frozen.BASH_ENV, undefined, "Bash startup must not rebind the confirmed commands");
  const config = await readUpdateContext({ env: frozen, npmConfigFiles: [npmrc] });
  assert.equal(JSON.stringify(config).includes("fixture-npm-secret"), false, "the npm routing digest must not store credentials");
  await writeFile(npmrc, "registry=https://other-registry.example.invalid/\n//registry.example.invalid/:_authToken=fixture-npm-secret\n");
  const drift = await readUpdateContext({ env: frozen, npmConfigFiles: [npmrc] });
  assert.notEqual(config.npmConfigDigest, drift.npmConfigDigest, "routing drift must invalidate confirmation");
  await writeFile(npmrc, "@firstpick:registry=https://scoped-a.example.invalid/\n");
  const scopedA = await readUpdateContext({ env: frozen, npmConfigFiles: [npmrc] });
  await writeFile(npmrc, "@firstpick:registry=https://scoped-b.example.invalid/\n");
  const scopedB = await readUpdateContext({ env: frozen, npmConfigFiles: [npmrc] });
  assert.notEqual(scopedA.npmConfigDigest, scopedB.npmConfigDigest, "scoped registry routing drift must invalidate confirmation");
  const redirected = path.join(root, "redirected-global.npmrc");
  await writeFile(redirected, "@firstpick:registry=https://redirected.example.invalid/\n");
  const redirectedContext = await readUpdateContext({ env: frozen, npmConfigFiles: [npmrc, redirected] });
  await writeFile(redirected, "@firstpick:registry=https://changed.example.invalid/\n");
  assert.notEqual(redirectedContext.npmConfigDigest, (await readUpdateContext({ env: frozen, npmConfigFiles: [npmrc, redirected] })).npmConfigDigest);
  const configJob = path.join(root, "config-drift-job");
  await mkdir(configJob);
  await writeFile(manifestPath, JSON.stringify({ name: "fixture-package", version: "1.0.0" }));
  const originalIntent = JSON.parse(await readFile(path.join(root, "intent.json"), "utf8"));
  await writeFile(path.join(configJob, "intent.json"), JSON.stringify({ ...originalIntent, transactionId: "config-drift-job",
    npmConfigFiles: [npmrc], npmConfigDigest: config.npmConfigDigest }));
  const blocked = await runUpdateJob(configJob);
  assert.equal(blocked[0].status, "failed");
  assert.match(blocked[0].error, /configuration changed/);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).version, "1.0.0", "drift must stop mutation");
  const partialJob = path.join(root, "partial-job");
  await mkdir(partialJob);
  const secondManifest = path.join(root, "independent.json");
  const failedDriver = path.join(root, "failed-driver.mjs");
  const workingDriver = path.join(root, "working-driver.mjs");
  await writeFile(failedDriver, "process.exitCode = 17;\n");
  await writeFile(workingDriver, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(secondManifest)}, JSON.stringify({name:"independent-package",version:"1.1.0"}));`);
  await writeFile(secondManifest, JSON.stringify({ name: "independent-package", version: "1.0.0" }));
  const partialIntent = { ...originalIntent, transactionId: "partial-job", targets: [
    { id: "first", packageName: "fixture-package", beforeVersion: "1.0.0", manifestPath,
      driver: failedDriver, driverDigest: createHash("sha256").update(await readFile(failedDriver)).digest("hex"),
      command: { command: process.execPath, args: [failedDriver] } },
    { id: "second", packageName: "independent-package", beforeVersion: "1.0.0", manifestPath: secondManifest,
      driver: workingDriver, driverDigest: createHash("sha256").update(await readFile(workingDriver)).digest("hex"),
      command: { command: process.execPath, args: [workingDriver] } },
  ] };
  await writeFile(path.join(partialJob, "intent.json"), JSON.stringify(partialIntent));
  const partial = await runUpdateJob(partialJob);
  assert.deepEqual(partial.map(({ status }) => status), ["failed", "changed"], "a failed native command must not suppress an independent proven target");
  assert.equal(JSON.parse(await readFile(path.join(partialJob, "complete.json"), "utf8")).receipts.length, 2);
  if (oldSecret === undefined) delete process.env.PI_TEST_SECRET_TOKEN;
  else process.env.PI_TEST_SECRET_TOKEN = oldSecret;
  console.log("update-executor-process-tree-harness.test.mjs passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
