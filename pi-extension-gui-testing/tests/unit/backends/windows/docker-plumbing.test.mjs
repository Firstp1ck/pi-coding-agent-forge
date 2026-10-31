import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { windowsRunArgs, windowsCreateArgs, dockurrEnv } from "../../../../src/backends/docker-windows/run-args.ts";
import { DEFAULT_VM, DOCKURR_IMAGE, DOCKURR_CAPS } from "../../../../src/backends/docker-windows/constants.ts";
import { GuestSsh, guestIdentityOptions } from "../../../../src/backends/docker-windows/guest-ssh.ts";
import { assertGuestPath, cmdLine, decodeScript, encodeScript, psQuote, scriptCommand } from "../../../../src/backends/docker-windows/powershell.ts";
import { helperFiles, helperFingerprint, setupScript, sshdConfig, stageOem, INSTALL_BAT, SMOKE_APP_SCRIPT } from "../../../../src/backends/docker-windows/oem.ts";
import { ensureKeys, keyPaths, publicKeyLine } from "../../../../src/backends/docker-windows/keys.ts";
import { windowsNameProblem, windowsSafeFileSet, untarCommand, helperTarEntries } from "../../../../src/backends/docker-windows/sync.ts";
import { helperCommandLine, guestSessionPaths, createDirsScript } from "../../../../src/backends/docker-windows/session.ts";
import { fakeWindowsDocker, parseGuestSsh, parseRunArgv, PUB, windowsRoot } from "./docker-fakes.mjs";

const base = { name: "pi-gui-testing-win-s1", ownerLabel: "c1:100:5000:boot", installId: "ab".repeat(16), image: DOCKURR_IMAGE, vm: DEFAULT_VM };

test("session run argv: detached --rm, labels, 127.0.0.1-only random ports, KVM + tun only, caps dropped, overlay, no host path", () => {
  const argv = windowsRunArgs({ ...base, role: "session", sessionId: "s1" });
  const p = parseRunArgv(["docker", ...argv]);
  assert.deepEqual(argv.slice(0, 5), ["run", "-d", "--rm", "--pull", "never"]);
  assert.equal(p.image, DOCKURR_IMAGE);
  assert.match(DOCKURR_IMAGE, /^docker\.io\/dockurr\/windows@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(p.all("--label").sort(), ["pi-gui-testing.owner=c1:100:5000:boot", "pi-gui-testing.session=s1", `pi-gui-testing.windows.install=${"ab".repeat(16)}`, "pi-gui-testing.windows=session"]);
  assert.deepEqual(p.all("-p"), ["127.0.0.1::22"], "SSH only, on loopback, Docker picks the port; no web viewer");
  assert.deepEqual(p.all("--device"), ["/dev/kvm", "/dev/net/tun"]);
  assert.deepEqual(p.all("--cap-drop"), ["ALL"]);
  assert.deepEqual(p.all("--cap-add"), [...DOCKURR_CAPS]);
  assert.ok(!p.all("--cap-add").includes("SYS_ADMIN") && !p.flags.some(([f]) => f === "--privileged"));
  assert.deepEqual(p.all("--security-opt"), ["no-new-privileges"]);
  assert.deepEqual(p.all("-v"), ["pi-gui-testing-windows-base:/storage"], "only the base volume; no bind of a host path or socket");
  const env = p.all("-e");
  assert.ok(env.includes("ARGUMENTS=-snapshot"), "QEMU writes go to a temporary overlay");
  for (const e of ["SAMBA=N", "TPM=N", "BOOT_MODE=windows", "USERNAME=pigui", "RAM_SIZE=4G", "CPU_CORES=2", "DISK_SIZE=64G", "VERSION=11", "USER_PORTS=22"]) assert.ok(env.includes(e), e);
  assert.ok(!env.includes("PASSWORD"), "sessions never get a password");
  assert.equal(p.one("--stop-timeout"), "120");
});

test("install run argv: OEM folder read-only, password only by name (value from the CLI environment), no overlay; viewer on request", () => {
  const argv = windowsRunArgs({ ...base, role: "install", name: "pi-gui-testing-windows-install", oemDir: "/home/u/.pi/agent/gui/docker-windows/oem", viewer: true });
  const p = parseRunArgv(["docker", ...argv]);
  assert.ok(p.all("-v").includes("/home/u/.pi/agent/gui/docker-windows/oem:/oem:ro"));
  assert.ok(p.all("-e").includes("PASSWORD"));
  assert.ok(!p.all("-e").some((e) => e.startsWith("PASSWORD=")));
  assert.ok(!p.all("-e").includes("ARGUMENTS=-snapshot"));
  assert.ok(p.all("-e").includes("LOG=Y"));
  assert.deepEqual(p.all("-p"), ["127.0.0.1::22", "127.0.0.1::8006"]);
  assert.ok(!p.all("--label").some((l) => l.startsWith("pi-gui-testing.session=")), "the install is tooling, not a session");
  assert.throws(() => windowsRunArgs({ ...base, role: "install" }), /OEM folder/);
  assert.throws(() => windowsRunArgs({ ...base, role: "session" }), /session id/);
  assert.deepEqual(windowsCreateArgs({ ...base, role: "session", sessionId: "s1" }).slice(0, 3), ["create", "--rm", "--pull"]);
  assert.deepEqual(dockurrEnv({ role: "session", vm: { version: "2025", ramGb: 8, cpuCores: 4, diskGb: 128 } }).slice(0, 5), ["VERSION=2025", "USERNAME=pigui", "RAM_SIZE=8G", "CPU_CORES=4", "DISK_SIZE=128G"]);
});

test("guest SSH: never the user's config, agent, or known_hosts; pinned key under an alias; BatchMode and strict host keys", async (t) => {
  const r = await windowsRoot(t);
  const keys = keyPaths(r.stateDir);
  const guest = new GuestSsh({ port: 40123, keyPath: keys.clientKey, knownHostsPath: keys.knownHosts, runner: { run: async () => ({}) } });
  const argv = guest.argv("echo pi-gui-ready");
  const parsed = parseGuestSsh(argv);
  assert.equal(parsed.config, "none");
  assert.equal(parsed.port, 40123);
  assert.equal(parsed.user, "pigui");
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.identity, keys.clientKey);
  for (const [k, v] of Object.entries({ BatchMode: "yes", StrictHostKeyChecking: "yes", UpdateHostKeys: "no", IdentitiesOnly: "yes", IdentityAgent: "none", UserKnownHostsFile: keys.knownHosts, GlobalKnownHostsFile: "none", HostKeyAlias: "pi-gui-testing-docker-windows", ForwardAgent: "no", ClearAllForwardings: "yes", PasswordAuthentication: "no", ControlPath: "none" })) {
    assert.equal(parsed.options[k], v, k);
  }
  assert.throws(() => guestIdentityOptions({ port: 22, keyPath: "/k", knownHostsPath: "/a b/known_hosts" }), /whitespace/);
  assert.throws(() => guestIdentityOptions({ port: 0, keyPath: "/k", knownHostsPath: "/kh" }), /port/);
});

test("PowerShell commands reach cmd.exe only as Base64 -EncodedCommand; literals are quoted; unsafe arguments are refused", () => {
  const evil = "x' ; Remove-Item C:\\ -Recurse ; '‘";
  const command = scriptCommand(`Write-Output ${psQuote(evil)}`);
  assert.match(command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
  const script = decodeScript(command.split(" ").at(-1));
  assert.ok(script.endsWith("\nWrite-Output 'x'' ; Remove-Item C:\\ -Recurse ; ''‘‘'"), script);
  assert.ok(script.startsWith("$ErrorActionPreference = 'Stop'"));
  assert.equal(decodeScript(encodeScript("a")).endsWith("\na"), true);
  assert.throws(() => cmdLine(["tar.exe", "-C", "C:\\a b"]), /cmd\.exe would interpret/);
  assert.throws(() => cmdLine(["x", "&calc"]), /cmd\.exe/);
  assert.throws(() => cmdLine(["x", "%PATH%"]), /cmd\.exe/);
  assert.throws(() => scriptCommand("x".repeat(4000)), /limit/);
  assert.throws(() => psQuote("a\0b"), /NUL/);
  assert.throws(() => assertGuestPath("C:\\pi\\..\\Windows"), /unsafe/);
  assert.throws(() => assertGuestPath("C:\\pi gui"), /unsafe/);
  assert.equal(untarCommand("C:\\pi-gui-testing\\sessions\\s1\\workspace"), "tar.exe -x -f - -C C:\\pi-gui-testing\\sessions\\s1\\workspace");
});

test("helper start line: -File with -StdinEnv names only (no value, no token); session paths follow the helper's runtime-dir rule", () => {
  const paths = guestSessionPaths("gui-test0001");
  assert.equal(paths.runtime, "C:\\pi-gui-testing\\sessions\\gui-test0001\\pi-gui-testing-gui-test0001");
  assert.equal(paths.workspace, "C:\\pi-gui-testing\\sessions\\gui-test0001\\workspace");
  const line = helperCommandLine("C:\\pi-gui-testing\\helper", ["PI_GUI_HELPER_MODE", "PI_GUI_TESTING_TOKEN"]);
  assert.equal(line, "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\pi-gui-testing\\helper\\helper.ps1 -StdinEnv PI_GUI_HELPER_MODE,PI_GUI_TESTING_TOKEN");
  assert.throws(() => guestSessionPaths("../x"), /unsafe/);
  assert.match(createDirsScript(paths), /already exists/);
});

test("Windows file names: invalid, reserved, trailing dot/space, and case duplicates are left out and counted", () => {
  assert.equal(windowsNameProblem("src/app.ps1"), undefined);
  assert.match(windowsNameProblem("a:b.txt"), /character/);
  assert.match(windowsNameProblem("docs/CON.txt"), /reserved/);
  assert.match(windowsNameProblem("x/name."), /dot or space/);
  assert.match(windowsNameProblem("q?.md"), /character/);
  const set = {
    root: "/p",
    source: "walk",
    bytes: 6,
    excluded: [{ path: ".env", reason: "secret" }],
    entries: [
      { path: "a.txt", type: "file", size: 1, mode: 0o644 },
      { path: "A.TXT", type: "file", size: 2, mode: 0o644 },
      { path: "nul", type: "file", size: 3, mode: 0o644 },
      { path: "ok/b", type: "file", size: 0, mode: 0o644 },
    ],
  };
  const safe = windowsSafeFileSet(set);
  assert.deepEqual(safe.entries.map((e) => e.path), ["a.txt", "ok/b"]);
  assert.equal(safe.bytes, 1);
  assert.deepEqual(safe.excluded.map((e) => e.path), [".env", "A.TXT", "nul"]);
  assert.ok(safe.excluded.slice(1).every((e) => e.reason === "invalid"));
});

test("keys: generated with ssh-keygen, 0600 in a 0700 dir, reused; known_hosts pins only the host key under the alias", async (t) => {
  const r = await windowsRoot(t);
  const { runner } = fakeWindowsDocker();
  const keys = await ensureKeys(r.stateDir, runner, { withHostKey: true });
  assert.equal((await stat(r.stateDir)).mode & 0o777, 0o700);
  for (const f of [keys.clientKey, keys.clientPub, keys.hostKey, keys.hostPub, keys.knownHosts]) assert.equal((await stat(f)).mode & 0o777, 0o600, f);
  assert.equal(await readFile(keys.knownHosts, "utf8"), `pi-gui-testing-docker-windows ${PUB}\n`);
  assert.equal(runner.commands().filter((c) => c.startsWith("ssh-keygen")).length, 2);
  await ensureKeys(r.stateDir, runner, { withHostKey: true });
  assert.equal(runner.commands().filter((c) => c.startsWith("ssh-keygen")).length, 2, "existing keys are reused");
  assert.ok(runner.commands()[0].includes("-t ed25519 -N  -C"), "no passphrase, ed25519");
  assert.throws(() => publicKeyLine("ssh-rsa AAAA x"), /ssh-ed25519/);
});

test("OEM folder: tooling only (setup script, key-only sshd_config, keys, helper, smoke app, marker); 0700/0600", async (t) => {
  const r = await windowsRoot(t);
  const { runner } = fakeWindowsDocker();
  const keys = await ensureKeys(r.stateDir, runner, { withHostKey: true });
  const helper = await helperFiles(r.helperRoot);
  assert.deepEqual(helper.map((f) => f.path), ["THIRD_PARTY_NOTICES.md", "helper.ps1", "src/Json.cs", "src/win/Native.cs"]);
  assert.match(helperFingerprint(helper), /^[0-9a-f]{64}$/);
  const oem = join(r.root, "oem");
  await stageOem(oem, { keys, installId: "ab".repeat(16), packageVersion: "0.1.0", helper });
  assert.equal((await stat(oem)).mode & 0o777, 0o700);
  const listing = [];
  const walk = async (dir, rel = "") => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), path);
      else listing.push(path);
    }
  };
  await walk(oem);
  assert.deepEqual(listing.sort(), [
    "install.bat",
    "pi-gui/administrators_authorized_keys",
    "pi-gui/helper/THIRD_PARTY_NOTICES.md",
    "pi-gui/helper/helper.ps1",
    "pi-gui/helper/src/Json.cs",
    "pi-gui/helper/src/win/Native.cs",
    "pi-gui/install.json",
    "pi-gui/setup.ps1",
    "pi-gui/smoke.ps1",
    "pi-gui/ssh_host_ed25519_key",
    "pi-gui/ssh_host_ed25519_key.pub",
    "pi-gui/sshd_config",
  ]);
  for (const f of listing) assert.equal((await stat(join(oem, f))).mode & 0o777, 0o600, f);
  assert.equal(await readFile(join(oem, "pi-gui/administrators_authorized_keys"), "utf8"), `${PUB}\r\n`);
  assert.deepEqual(JSON.parse(await readFile(join(oem, "pi-gui/install.json"), "utf8")), { installId: "ab".repeat(16), packageVersion: "0.1.0" });
  assert.match(INSTALL_BAT, /powershell\.exe .*-File "C:\\OEM\\pi-gui\\setup\.ps1"/);
  const config = sshdConfig();
  for (const line of ["PasswordAuthentication no", "PubkeyAuthentication yes", "AllowUsers pigui", "AllowTcpForwarding no", "HostKey __PROGRAMDATA__/ssh/ssh_host_ed25519_key", "AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys"]) assert.ok(config.includes(line), line);
  const setup = setupScript();
  for (const part of ["Add-WindowsCapability", "administrators_authorized_keys", "/inheritance:r", "Restart-Service -Name sshd", "NoLockScreen", "powercfg.exe /hibernate off", "standby-timeout-ac", "NoAutoUpdate", "Remove-Item -LiteralPath (Join-Path $src 'ssh_host_ed25519_key')", "installed.json"]) {
    assert.ok(setup.includes(part), part);
  }
  assert.ok(setup.indexOf("installed.json") > setup.indexOf("NoLockScreen"), "the completion marker is written last");
  assert.match(SMOKE_APP_SCRIPT, /'Pi GUI smoke'[\s\S]*'Waiting'[\s\S]*'Press me'[\s\S]*'Pressed'/);
  const entries = helperTarEntries(helper);
  assert.deepEqual(entries.filter((e) => e.type === "dir").map((e) => e.path), ["src", "src/win"]);
});
