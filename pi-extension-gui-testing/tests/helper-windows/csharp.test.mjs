// Runs the C#-level checks of the Windows helper through PowerShell 7:
// CoreTests.cs (pure core, C# 5), the managed layout check of the Win32
// structs (native-layout.ps1), and the compile check of every source,
// including the Win32 and UI Automation layers, against the .NET Framework
// 4.7.2 reference assemblies (PI_GUI_NETFX_REF, default
// ~/.local/share/pi-tools/netfx-ref-net472). Nothing Windows-specific runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HERE, findPwsh } from "./client.mjs";

const PWSH = findPwsh();
const REF = process.env.PI_GUI_NETFX_REF ?? join(homedir(), ".local", "share", "pi-tools", "netfx-ref-net472");

function run(script, args = []) {
  return spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-File", join(HERE, script), ...args], { encoding: "utf8", timeout: 120000 });
}

test("C# core unit tests pass at C# 5", { skip: PWSH ? false : "pwsh not found" }, () => {
  const result = run("run-core-tests.ps1");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# passed \d+, failed 0/);
});

test("every helper source compiles against .NET Framework 4.7.2 at C# 5", {
  skip: !PWSH ? "pwsh not found" : existsSync(join(REF, "mscorlib.dll")) ? false : `no reference assemblies in ${REF}`,
}, () => {
  const result = run("compile-check.ps1", ["-ReferenceDir", REF]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /0 errors, success=True/);
});

test("Win32 struct layouts match the Windows SDK (WIN32_FIND_DATAW, BY_HANDLE_FILE_INFORMATION, RTL_OSVERSIONINFOEXW)", { skip: PWSH ? false : "pwsh not found" }, () => {
  const result = run("native-layout.ps1");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# passed \d+, failed 0/);
});
