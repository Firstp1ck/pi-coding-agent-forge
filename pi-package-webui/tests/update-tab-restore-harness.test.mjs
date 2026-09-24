import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRestoreFile, probeStartupRestore, readRestoreFileOnce } from "../lib/update/supervisor.mjs";

const root = await mkdtemp(path.join(tmpdir(), "pi-webui-restore-"));
try {
  const tabs = Array.from({ length: 130 }, (_, index) => ({ id: `tab-${index + 1}`, index: index + 1, title: `Tab ${index + 1}`, cwd: root, sessionFile: path.join(root, `${index + 1}.jsonl`) }));
  const handoff = await createRestoreFile(root, tabs);
  assert.equal(handoff.count, 130, "private restore handoff must support at least 125 tabs");
  const restored = await readRestoreFileOnce(handoff.file, root);
  assert.equal(restored.length, 130);
  assert.equal(restored[124].id, "tab-125");
  await assert.rejects(() => access(handoff.file), /ENOENT/, "restore handoff must be deleted after its first read");

  const outside = path.join(root, "outside.json");
  await writeFile(outside, JSON.stringify({ schemaVersion: 1, tabs: [] }));
  await assert.rejects(() => readRestoreFileOnce(outside, root), /outside the private temp root/);
  await access(outside);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version;
  const probe = await probeStartupRestore(path.join(packageRoot, "bin", "pi-webui.mjs"), {
    expectedVersion: version, timeoutMs: 20_000, piCommand: path.join(packageRoot, "tests", "fixtures", "fake-pi.mjs"),
  });
  assert.equal(probe.ok, true, JSON.stringify(probe));
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("update tab restore harness passed");
