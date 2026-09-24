import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readUpdateContext } from "../bin/pi-webui-update-context.mjs";
import { acquireEffectLocks, effectLockForRoot, releaseEffectLocks } from "../lib/update/coordination.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(tmpdir(), "pi-native-shell-survival-"));
const transactionId = randomUUID();
const job = path.join(root, "jobs", transactionId);
const install = path.join(root, "fake-install");
const manifest = path.join(install, "package.json");
const driver = path.join(root, "fake-cli.mjs");
const sha = (data) => createHash("sha256").update(data).digest("hex");
let safeCleanup = false;
let lock;
try {
  await mkdir(job, { recursive: true });
  await mkdir(install);
  await writeFile(manifest, JSON.stringify({ name: "fixture-package", version: "1.0.0" }));
  await writeFile(driver, `import { readFile, writeFile } from 'node:fs/promises';\nimport { setTimeout as delay } from 'node:timers/promises';\nawait delay(900);\nconst file = ${JSON.stringify(manifest)};\nconst data = JSON.parse(await readFile(file, 'utf8'));\ndata.version = '1.1.0';\nawait writeFile(file, JSON.stringify(data));\n`);
  await copyFile(path.join(source, "bin", "pi-webui-native-update-runner.mjs"), path.join(job, "runner.mjs"));
  await copyFile(path.join(source, "bin", "pi-webui-update-context.mjs"), path.join(job, "pi-webui-update-context.mjs"));
  await copyFile(path.join(source, "bin", "pi-webui-native-update-guardian.mjs"), path.join(job, "guardian.mjs"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: root };
  const bindings = await readUpdateContext({ env });
  await writeFile(path.join(job, "intent.json"), JSON.stringify({ transactionId, cwd: root,
    ...bindings, nodeDigest: sha(await readFile(process.execPath)), targets: [{ id: "pi", packageName: "fixture-package",
      beforeVersion: "1.0.0", manifestPath: manifest, driver, driverDigest: sha(await readFile(driver)),
      command: { command: process.execPath, args: [driver, "update"] } }] }));
  lock = await acquireEffectLocks(root, [install], transactionId);
  const windows = process.platform === "win32";
  const shell = windows ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/bash";
  const args = windows ? [path.join(job, "guardian.mjs")]
    : ["--noprofile", "--norc", "-c", 'exec "$PI_WEBUI_UPDATE_NODE" "$PI_WEBUI_UPDATE_RUNNER" "$PI_WEBUI_UPDATE_JOB"'];
  const executable = windows ? process.execPath : shell;
  const initiator = spawn(process.execPath, ["-e", `const { spawn } = require('node:child_process');\nconst child = spawn(${JSON.stringify(executable)}, ${JSON.stringify(args)}, { cwd: ${JSON.stringify(root)}, env: process.env, detached: true, windowsHide: true, stdio: 'ignore' });\nchild.once('spawn', () => { child.unref(); process.exit(88); });\nchild.once('error', () => process.exit(89));`], {
    cwd: root, env: { ...env, PI_WEBUI_UPDATE_NODE: process.execPath,
      PI_WEBUI_UPDATE_RUNNER: path.join(job, "runner.mjs"), PI_WEBUI_UPDATE_JOB: job,
      PI_WEBUI_UPDATE_SHELL: shell, PI_WEBUI_UPDATE_CWD: root,
      PI_WEBUI_UPDATE_PATHEXT: env.PATHEXT || env.PathExt || "" }, stdio: "ignore",
  });
  const exit = await Promise.race([new Promise((resolve) => initiator.once("exit", resolve)), delay(8_000, "timeout")]);
  assert.equal(exit, 88, "the initiating server exits abruptly after its background shell starts");
  assert.ok(await effectLockForRoot(root, install), "the effect fence remains after owner exit");
  let complete;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { complete = JSON.parse(await readFile(path.join(job, "complete.json"), "utf8")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(100);
  }
  assert.equal(complete?.transactionId, transactionId, "runner continues independently and durably completes");
  const receipt = JSON.parse(await readFile(path.join(job, "0.receipt.json"), "utf8"));
  assert.equal(receipt.status, "changed", JSON.stringify(receipt));
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).version, "1.1.0");
  assert.ok(await effectLockForRoot(root, install), "completion alone does not silently discard exclusion");
  await releaseEffectLocks(lock, { completionVerified: true });
  safeCleanup = true;
} finally {
  if (safeCleanup) await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 150 });
  else console.error(`Retained interrupted shell-survival fixture: ${root}`);
}
console.log("native-update-shell-survival.test.mjs passed");
