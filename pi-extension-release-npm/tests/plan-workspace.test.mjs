import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflows = [path.join(packageRoot, "release-workflow.sh"), path.join(packageRoot, "../dev/scripts/release-workflow.sh")];
const root = await mkdtemp(path.join(os.tmpdir(), "release-plan-workspace-"));

async function write(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function shell(file, content) {
  await write(file, `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`);
  await chmod(file, 0o755);
}

try {
  for (const [index, workflow] of workflows.entries()) {
    for (const scenario of ["ordinary", "bundled", "hooks", "local", "failed", "empty"]) {
      const fixture = path.join(root, `${index}-${scenario}`);
      const repo = path.join(fixture, "repo");
      const tools = path.join(fixture, "tools");
      const target = path.join(repo, "candidate");
      const log = path.join(fixture, "publish-root.log");
      const manifest = { name: "@test/candidate", version: "1.0.0" };
      if (scenario === "hooks") manifest.scripts = { prepack: "node ../sibling/resource.js" };
      if (scenario === "local") manifest.dependencies = { sibling: "file:../sibling" };
      if (scenario === "bundled") {
        manifest.dependencies = { "@test/bundle": "1.0.0" };
        manifest.bundledDependencies = ["@test/bundle"];
      }
      await write(path.join(target, "package.json"), JSON.stringify(manifest));
      await write(path.join(target, "index.js"), "original candidate\n");
      await write(path.join(target, "node_modules/@test/bundle/package.json"), '{"name":"@test/bundle","version":"1.0.0"}');
      await write(path.join(target, "node_modules/transitive/index.js"), "installed dependency\n");
      await write(path.join(target, ".git/config"), "candidate git data\n");
      await write(path.join(repo, "sibling/resource.js"), "sibling resource\n");
      await write(path.join(repo, ".git/config"), "repository git data\n");
      await write(path.join(repo, "node_modules/ancestor/index.js"), "ancestor dependency\n");
      await write(path.join(repo, ".npmrc"), "registry=https://registry.npmjs.org/\n");
      await write(path.join(repo, "package.json"), '{"private":true}');
      // More than one ordinary candidate must survive selective preparation.
      await write(path.join(repo, "second/package.json"), '{"name":"@test/second","version":"1.0.0"}');
      await write(path.join(repo, "second/index.js"), "second candidate\n");
      await shell(path.join(tools, "release-workflow.sh"), (await readFile(workflow, "utf8")).replace(/^#![^\n]*\n/, ""));
      await shell(path.join(tools, "check-publish-readiness.sh"), "exit 0");
      await shell(path.join(tools, "bump-package-versions.sh"), `
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --candidate-targets-file ]]; then
    if [[ "$SCENARIO" == empty ]]; then : > "$2"; else printf 'candidate\\n' > "$2"; fi
    if [[ "$SCENARIO" == ordinary ]]; then printf 'second\\n' >> "$2"; fi
    shift 2
  else shift; fi
done
`);
      await shell(path.join(tools, "publish-packages.sh"), `
node -e 'console.log(require("path").resolve(process.argv[1]))' "$PI_NPM_PACKAGES_ROOT" > "$PUBLISH_ROOT_LOG"
test -f "$PI_NPM_PACKAGES_ROOT/candidate/index.js"
test -f "$PI_NPM_PACKAGES_ROOT/.npmrc"
if [[ "$SCENARIO" == hooks || "$SCENARIO" == local ]]; then
  test -f "$PI_NPM_PACKAGES_ROOT/sibling/resource.js"
  test -f "$PI_NPM_PACKAGES_ROOT/node_modules/ancestor/index.js"
  test -f "$PI_NPM_PACKAGES_ROOT/.git/config"
else
  test ! -e "$PI_NPM_PACKAGES_ROOT/sibling"
  test ! -e "$PI_NPM_PACKAGES_ROOT/node_modules"
  test ! -e "$PI_NPM_PACKAGES_ROOT/.git"
  test ! -e "$PI_NPM_PACKAGES_ROOT/candidate/.git"
fi
if [[ "$SCENARIO" == bundled || "$SCENARIO" == hooks || "$SCENARIO" == local ]]; then
  test -f "$PI_NPM_PACKAGES_ROOT/candidate/node_modules/@test/bundle/package.json"
  test -f "$PI_NPM_PACKAGES_ROOT/candidate/node_modules/transitive/index.js"
else
  test ! -e "$PI_NPM_PACKAGES_ROOT/candidate/node_modules"
fi
if [[ "$SCENARIO" == ordinary ]]; then test -f "$PI_NPM_PACKAGES_ROOT/second/index.js"; fi
printf 'changed in temporary workspace\\n' > "$PI_NPM_PACKAGES_ROOT/candidate/index.js"
if [[ "$SCENARIO" == failed ]]; then exit 7; fi
`);
      const result = spawnSync("bash", [path.join(tools, "release-workflow.sh"), "--plan", "--all", "--no-strict-auth"], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, PI_NPM_PACKAGES_ROOT: repo, SCENARIO: scenario, PUBLISH_ROOT_LOG: log },
      });
      assert.equal(result.status, scenario === "failed" ? 7 : 0, `${index}/${scenario}: ${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
      assert.equal(await readFile(path.join(target, "index.js"), "utf8"), "original candidate\n");
      if (scenario === "empty") {
        assert.match(result.stdout, /No publish candidates detected/);
        assert.doesNotMatch(result.stdout, /Copying release candidate/);
        await assert.rejects(access(log));
      } else {
        assert.match(result.stdout, /Release progress: Cleaning up temporary workspace/);
        const temporaryWorkspace = (await readFile(log, "utf8")).trim();
        await assert.rejects(access(temporaryWorkspace), "temporary workspace must be removed after success and failure");
        if (scenario === "hooks" || scenario === "local") assert.match(result.stdout, /Preparing full workspace/);
        else assert.match(result.stdout, /Copying release candidate candidate/);
      }
    }
  }
  console.log("plan-workspace.test.mjs passed (repository and bundled workflows)");
} finally {
  await rm(root, { recursive: true, force: true });
}
