/**
 * Windows guests of `cua`: guest paths, PowerShell quoting and encoding, the
 * helper's file set and its hash check, the contract environment, and the
 * `setup` wrapper. With PowerShell 7 available (PI_GUI_PWSH, PATH, or
 * ~/.local/share/pi-tools) every generated script is parsed by PowerShell's
 * own parser, literals round-trip, and the setup wrapper's exit codes run;
 * Windows PowerShell 5.1 itself never runs here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listTar } from "../../../../src/backends/docker/tar.ts";
import { PACKAGE_ROOT } from "../../../../src/backends/docker/package.ts";
import {
  CMD_LINE_MAX,
  encodePowerShell,
  extractScript,
  POWERSHELL,
  powershellArgv,
  prepareScript,
  probeScript,
  psLiteral,
  removeDirScript,
  removeFileScript,
  verifyScript,
  WINDOWS_GUEST_ROOT,
  windowsGuestPaths,
  windowsHelperArchive,
  windowsHelperArgv,
  windowsHelperEnv,
  windowsHelperFiles,
  windowsSetupCommand,
} from "../../../../src/backends/cua/windows.ts";
import { findPwsh } from "../../../helper-windows/client.mjs";

const PWSH = findPwsh();
const noPwsh = PWSH ? false : "pwsh not found (set PI_GUI_PWSH)";

/** The script inside a `powershellArgv` argv. */
function decoded(argv) {
  assert.equal(argv.at(-2), "-EncodedCommand");
  return Buffer.from(argv.at(-1), "base64").toString("utf16le");
}

/** PowerShell's parse errors of `script` (empty when it parses). */
function parseErrors(script) {
  const probe = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }`;
  const result = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", probe], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("guest paths: a private session dir under C:\\pi-gui-testing with a runtime dir the helper accepts", () => {
  const p = windowsGuestPaths("gui-0001");
  assert.deepEqual(p, {
    dir: "C:\\pi-gui-testing\\gui-0001",
    tools: "C:\\pi-gui-testing\\gui-0001\\tools",
    workspace: "C:\\pi-gui-testing\\gui-0001\\workspace",
    runtime: "C:\\pi-gui-testing\\gui-0001\\pi-gui-testing-gui-0001",
    helper: "C:\\pi-gui-testing\\gui-0001\\tools\\helper.ps1",
  });
  assert.ok(p.runtime.split("\\").at(-1).startsWith("pi-gui-testing-"), "helpers/windows requires the runtime dir name prefix");
  assert.throws(() => windowsGuestPaths("..\\x"), /invalid session id/);
  assert.throws(() => windowsGuestPaths("a b"), /invalid session id/);
});

test("psLiteral doubles every PowerShell quote character and refuses control characters", () => {
  assert.equal(psLiteral("C:\\a b\\c"), "'C:\\a b\\c'");
  assert.equal(psLiteral("it's"), "'it''s'");
  assert.equal(psLiteral("\u2018x\u2019\u201a\u201b"), "'\u2018\u2018x\u2019\u2019\u201a\u201a\u201b\u201b'");
  assert.equal(psLiteral('$env:X `n "q"'), "'$env:X `n \"q\"'", "no interpolation or escapes inside single quotes");
  assert.throws(() => psLiteral("a\nb"), /control characters/);
  assert.throws(() => psLiteral("a\rb"), /control characters/);
  assert.throws(() => psLiteral("a\0b"), /control characters/);
});

test("psLiteral round-trips through PowerShell's parser", { skip: noPwsh }, () => {
  const values = ["plain", "it's", "\u2018quoted\u2019 \u201alow\u201b", '$(Get-Date) `$x "dq" ;&|<>^%!', "C:\\Program Files\\x y\\", "ünïcödé ✓"];
  const script = values.map((v) => `[Console]::Out.Write(${psLiteral(v)} + [char]0)`).join("\n");
  const result = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), values);
});

test("guest commands are fixed flags plus one base64 word, safe under any command-line joining rule", () => {
  for (const argv of [powershellArgv(prepareScript("gui-1")), powershellArgv(probeScript()), powershellArgv(removeDirScript("C:\\pi-gui-testing\\gui-1"))]) {
    assert.deepEqual(argv.slice(0, POWERSHELL.length), ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
    for (const word of argv) assert.match(word, /^[A-Za-z0-9+/=.-]+$/, `no quote, space, or metacharacter: ${word.slice(0, 40)}`);
    const script = decoded(argv);
    assert.ok(script.startsWith("$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n"));
  }
  assert.throws(() => powershellArgv("x".repeat(13_000)), /too long/);
});

test("the scripts name only their own paths, as literals", () => {
  const prepare = prepareScript("gui-7");
  assert.match(prepare, /\$dir = 'C:\\pi-gui-testing\\gui-7'/);
  assert.match(prepare, /SetAccessRuleProtection\(\$true, \$false\)/, "inheritance off: no broad group can write the runtime dir");
  assert.match(prepare, /S-1-5-18/);
  assert.match(prepare, /S-1-5-32-544/);
  assert.match(prepare, /'C:\\pi-gui-testing\\gui-7\\pi-gui-testing-gui-7'/);
  assert.match(prepare, /rmdir \/s \/q \$dir/, "an old dir is removed without following links");
  assert.match(extractScript("C:\\pi-gui-testing\\gui-7\\tools.tar", "C:\\pi-gui-testing\\gui-7\\tools"), /System32\\tar\.exe'\) -x -f \$archive -C \$dir/);
  assert.equal(removeFileScript("C:\\x\\it's.tar"), "Remove-Item -LiteralPath 'C:\\x\\it''s.tar' -Force -ErrorAction SilentlyContinue");
  assert.match(removeDirScript(WINDOWS_GUEST_ROOT), /\$dir = 'C:\\pi-gui-testing'/);
  assert.throws(() => removeDirScript("C:\\Windows"), /not below/);
  assert.throws(() => removeDirScript("C:\\pi-gui-testing\\a b"), /unexpected characters/);
  assert.throws(() => removeDirScript("C:\\pi-gui-testing\\..\\x"), /unexpected characters/);
  assert.throws(() => removeDirScript("C:\\pi-gui-testing\\\\x"), /unexpected characters/);
});

test("every generated script parses in PowerShell", { skip: noPwsh }, async () => {
  const files = await windowsHelperFiles();
  const scripts = {
    prepare: prepareScript("gui-1"),
    probe: probeScript(),
    extract: extractScript("C:\\pi-gui-testing\\gui-1\\tools.tar", "C:\\pi-gui-testing\\gui-1\\tools"),
    removeDir: removeDirScript("C:\\pi-gui-testing\\gui-1"),
    removeFile: removeFileScript("C:\\pi-gui-testing\\gui-1\\tools.tar"),
    verify: verifyScript("C:\\pi-gui-testing\\gui-1\\tools", files),
    setup: decoded(windowsSetupCommand("npm ci; if ($?) { Write-Output 'done' }").split(" ")),
  };
  assert.notEqual(parseErrors("if ( {"), "", "the parser probe reports errors");
  for (const [name, script] of Object.entries(scripts)) assert.equal(parseErrors(name === "setup" ? script : decoded(powershellArgv(script))), "", `${name} parses`);
});

test("the helper file set is every file helper.ps1 compiles plus the entry and notice, with SHA-256", async () => {
  const files = await windowsHelperFiles();
  assert.equal(files.length, 17);
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("helper.ps1"));
  assert.ok(paths.includes("THIRD_PARTY_NOTICES.md"));
  const compiled = [...readFileSync(join(PACKAGE_ROOT, "helpers", "windows", "helper.ps1"), "utf8").matchAll(/'(src\\[^']+\.cs)'/g)].map((m) => m[1].replace(/\\/g, "/"));
  assert.equal(compiled.length, 15);
  for (const source of compiled) assert.ok(paths.includes(source), `${source} is deployed`);
  for (const f of files) assert.equal(f.sha256, createHash("sha256").update(readFileSync(join(PACKAGE_ROOT, "helpers", "windows", f.path))).digest("hex"));
  const tar = listTar(windowsHelperArchive(files));
  assert.deepEqual(tar.filter((e) => e.type === "dir").map((e) => e.path.replace(/\/$/, "")), ["src", "src/win"], "directories first");
  assert.deepEqual(tar.filter((e) => e.type === "file").map((e) => e.path), paths);
  const verify = verifyScript("C:\\t", files);
  for (const f of files) assert.ok(verify.includes(`'${f.path.replace(/\//g, "\\")}' = '${f.sha256.toUpperCase()}'`), f.path);
});

test("the helper starts in guest mode over -File with its contract variables only", () => {
  assert.deepEqual(windowsHelperArgv("gui-1"), ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\pi-gui-testing\\gui-1\\tools\\helper.ps1"]);
  assert.deepEqual(windowsHelperEnv("gui-1"), {
    PI_GUI_HELPER_MODE: "guest",
    PI_GUI_WORKSPACE: "C:\\pi-gui-testing\\gui-1\\workspace",
    PI_GUI_RUNTIME_DIR: "C:\\pi-gui-testing\\gui-1\\pi-gui-testing-gui-1",
    PI_GUI_ALLOW_EXEC: "1",
  });
  // Every name is in the helper's -StdinEnv allow-list (src/Policy.cs HostConfig.StdinEnvNames).
  const policy = readFileSync(join(PACKAGE_ROOT, "helpers", "windows", "src", "Policy.cs"), "utf8");
  for (const name of Object.keys(windowsHelperEnv("gui-1"))) assert.match(policy, new RegExp(`"${name}"`), name);
});

test("setup commands become encoded PowerShell for cmd.exe, bounded by cmd.exe's line limit", () => {
  const cmd = 'npm ci && echo "100%" | findstr ^x > out.txt';
  const line = windowsSetupCommand(cmd);
  assert.doesNotMatch(line, /[&|<>^"%]/, "no cmd.exe metacharacter reaches cmd.exe");
  const words = line.split(" ");
  assert.deepEqual(words.slice(0, -1), [...POWERSHELL, "-EncodedCommand"]);
  const script = decoded(words);
  assert.ok(script.includes(`\n${cmd}\n`));
  assert.match(script, /if \(\$global:LASTEXITCODE\) \{ exit \$global:LASTEXITCODE \}/);
  assert.ok(line.length < CMD_LINE_MAX);
  assert.throws(() => windowsSetupCommand("x".repeat(3_500)), /too long for a Windows guest/);
});

test("the setup wrapper exits 0, a native command's code, or 1 for a failing cmdlet", { skip: noPwsh }, () => {
  const run = (cmd) => {
    const words = windowsSetupCommand(cmd).split(" ");
    return spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-EncodedCommand", words.at(-1)], { encoding: "utf8" });
  };
  assert.equal(run("Write-Output ok").status, 0);
  assert.equal(run("sh -c 'exit 7'").status, 7);
  const failing = run("Get-Item -LiteralPath '/nonexistent/pi-gui-testing'");
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /nonexistent/);
  assert.equal(run("sh -c 'exit 3'; Write-Output 'after'").status, 3, "cmdlets after it keep the last native exit code");
  assert.equal(run("sh -c 'exit 3'; sh -c 'exit 0'").status, 0, "a failing native command does not stop the script; the last native code counts");
});
