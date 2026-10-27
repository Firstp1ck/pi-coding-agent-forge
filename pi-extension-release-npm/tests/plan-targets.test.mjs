import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflows = [path.join(packageRoot, "release-workflow.sh"), path.join(packageRoot, "../dev/scripts/release-workflow.sh")];
const root = await mkdtemp(path.join(os.tmpdir(), "release-plan-targets-"));

async function shell(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`);
  await chmod(file, 0o755);
}

try {
  for (const [index, workflow] of workflows.entries()) {
    const tools = path.join(root, String(index));
    const log = path.join(tools, "bump-args.log");
    await shell(path.join(tools, "release-workflow.sh"), (await readFile(workflow, "utf8")).replace(/^#![^\n]*\n/, ""));
    await shell(path.join(tools, "check-publish-readiness.sh"), "exit 0");
    await shell(path.join(tools, "publish-packages.sh"), "exit 0");
    // Record the packages the bump planner was asked to plan; report no candidates.
    await shell(path.join(tools, "bump-package-versions.sh"), `
while [[ $# -gt 0 ]]; do
  case "$1" in
    --targets-file) cat "$2" > "$BUMP_LOG"; shift 2 ;;
    --target) printf 'target=%s\n' "$2" > "$BUMP_LOG"; shift 2 ;;
    --candidate-targets-file) : > "$2"; shift 2 ;;
    *) shift ;;
  esac
done
`);
    const run = (args) => spawnSync("bash", [path.join(tools, "release-workflow.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, BUMP_LOG: log, PI_NPM_PACKAGES_ROOT: root },
    });

    let result = run(["--plan", "--targets", "pkg-a,pkg-b"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(log, "utf8")).trim(), "pkg-a\npkg-b");

    result = run(["--plan", "--all"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(log, "utf8")).trim(), "target=all");

    result = run(["--publish", "--targets", "pkg-a"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--targets is only supported with --plan/);
  }
  console.log("plan targets tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
