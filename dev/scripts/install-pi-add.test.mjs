import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "install-pi-add.sh");
const fixtureRoot = mkdtempSync(join(tmpdir(), "install pi add test-"));

function writeExecutable(path, content) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function runInstallerResult(env) {
  return spawnSync("bash", [scriptPath, "--non-interactive"], {
    cwd: fixtureRoot,
    env,
    encoding: "utf8",
  });
}

function runInstaller(env) {
  const result = runInstallerResult(env);
  assert.equal(result.status, 0, `installer failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

try {
  const packageName = "@fixture/pi-extension-example";
  const packageVersion = "1.2.3";
  const packagesRoot = join(fixtureRoot, "packages");
  const packageDir = join(packagesRoot, "pi-extension-example");
  const agentDir = join(fixtureRoot, "agent");
  const installedPackageDir = join(agentDir, "npm", "node_modules", "@fixture", "pi-extension-example");
  const fakeBin = join(fixtureRoot, "bin");
  const installLog = join(fixtureRoot, "pi-install.log");

  mkdirSync(packageDir, { recursive: true });
  mkdirSync(installedPackageDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName, version: packageVersion }), "utf8");
  writeFileSync(join(installedPackageDir, "package.json"), JSON.stringify({ name: packageName, version: packageVersion }), "utf8");

  writeExecutable(
    join(fakeBin, "npm"),
    `#!/usr/bin/env bash\nif [[ "$1" == "view" ]]; then printf '${packageVersion}\\n'; exit 0; fi\nif [[ "$1" == "root" && "$2" == "-g" ]]; then printf '%s\\n' '${join(fixtureRoot, "legacy").replaceAll("\\", "/")}'; exit 0; fi\nexit 1\n`,
  );
  writeExecutable(
    join(fakeBin, "pi"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${installLog.replaceAll("\\", "/")}'\nprintf 'verbose successful npm output\\n'\nif [[ "\${PI_TEST_INSTALL_FAILURE:-0}" == "1" ]]; then\n  printf 'simulated npm failure\\n' >&2\n  exit 23\nfi\n`,
  );

  const env = {
    ...process.env,
    PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`,
    PI_CODING_AGENT_DIR: agentDir,
    PI_NPM_PACKAGES_ROOT: packagesRoot,
  };

  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }), "utf8");
  const unregisteredOutput = runInstaller(env);
  assert.match(unregisteredOutput, /Packages requiring Pi registration: 1/);
  assert.match(unregisteredOutput, /\[PASS\].*registering with Pi/);
  assert.doesNotMatch(unregisteredOutput, /verbose successful npm output/);
  assert.equal(readFileSync(installLog, "utf8").trim(), `install npm:${packageName}`);

  rmSync(installLog);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [`npm:${packageName}`] }), "utf8");
  const stringConfiguredOutput = runInstaller(env);
  assert.match(stringConfiguredOutput, /Packages requiring Pi registration: 0/);
  assert.match(stringConfiguredOutput, /Already up to date .*: 1/);
  assert.equal(existsSync(installLog), false, "configured package should not be reinstalled");

  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [{ source: `npm:${packageName}@${packageVersion}`, extensions: [] }] }),
    "utf8",
  );
  const objectConfiguredOutput = runInstaller(env);
  assert.match(objectConfiguredOutput, /Packages requiring Pi registration: 0/);
  assert.equal(existsSync(installLog), false, "pinned object-form package should be recognized as configured");

  rmSync(installedPackageDir, { recursive: true, force: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }), "utf8");
  const freshInstallOutput = runInstaller(env);
  assert.match(freshInstallOutput, /Packages requiring Pi registration: 1/);
  assert.match(freshInstallOutput, /registering with Pi at 1\.2\.3/);
  assert.equal(readFileSync(installLog, "utf8").trim(), `install npm:${packageName}`);

  rmSync(installLog);
  const failedResult = runInstallerResult({ ...env, PI_TEST_INSTALL_FAILURE: "1" });
  const failedOutput = `${failedResult.stdout}\n${failedResult.stderr}`;
  assert.equal(failedResult.status, 1, `failed install should produce exit code 1\n${failedOutput}`);
  assert.match(failedOutput, /\[FAILED\].*exit code 23/);
  assert.match(failedOutput, /Failed installs: 1/);
  assert.match(failedOutput, /simulated npm failure/);
  assert.match(failedOutput, /Completed with 1 failed package/);

  console.log("install-pi-add registration checks passed");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
