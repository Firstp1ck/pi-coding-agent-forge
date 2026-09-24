import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readUpdateContext } from "../bin/pi-webui-update-context.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeUpdateConfirmationText } from "../lib/update-commands.mjs";
import { createNativeUpdatePlan } from "../lib/update/native-jobs.mjs";

const root = await mkdtemp(path.join(tmpdir(), "pi-webui-update-confirm-"));
try {
  const driver = path.join(root, "fake-pi.js");
  await writeFile(driver, "// fixture only\n");
  const digest = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
  const context = await readUpdateContext({ env: process.env });
  const plan = await createNativeUpdatePlan({ requested: "pi", context: { cwd: root, agentDir: root, npmPrefix: root,
    shell: process.execPath, shellDigest: digest, nodeDigest: digest,
    settingsPath: path.join(root, "settings.json"), npmConfigFiles: [], ...context },
    targets: [{ eligible: true, id: "pi", effectRoot: root, installed: { root, version: "0.87.1" }, driver,
      command: { command: process.execPath, args: [driver, "update"] } }], refusals: ["Other installations are unproven."], });
  const text = nativeUpdateConfirmationText(plan);
  assert.match(text, /Working directory:/);
  assert.match(text, /Pi agent directory:/);
  assert.match(text, /npm prefix:/);
  assert.match(text, /lifecycle scripts/i);
  assert.match(text, /Other installations are unproven/);
  assert.match(text, /"update"/);
  assert.match(text, new RegExp(plan.digest));
  assert.doesNotMatch(text, /--ignore-scripts|--all|--extensions/);
  assert.throws(() => nativeUpdateConfirmationText({ ...plan, digest: "0".repeat(64) }), /invalid/);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("update command planning tests passed");
