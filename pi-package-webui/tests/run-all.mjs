import { spawnSync } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const files = (await readdir(testsDir)).filter((name) => name.endsWith(".test.mjs")).sort();
// Every test child (and any WebUI it launches) inherits a disposable update
// coordination domain. Retain ambiguous detached-job artifacts after a failure.
const coordinationHome = await mkdtemp(join(tmpdir(), "pi-webui-test-coordination-"));

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, [join(testsDir, file)], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test", PI_WEBUI_UPDATE_TEST_HOME: coordinationHome, PI_WEBUI_RPC_SUPERVISOR: "0" },
  });
  if (result.status !== 0) failures.push(`${file} (exit ${result.status ?? "signal"})`);
}

if (failures.length) {
  console.error(`\n${failures.length}/${files.length} test file(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nall ${files.length} test files passed`);
