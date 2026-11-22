/**
 * The `/oem` folder of the unattended install (dockurr copies it to
 * `C:\OEM` and runs its `install.bat` at the end of the install, as the
 * administrator it created). It holds tooling only, never project data:
 *
 * - `install.bat` → `pi-gui\setup.ps1` (Windows PowerShell 5.1), which
 *   installs OpenSSH Server, puts in the pinned host key and this machine's
 *   public key (administrators only), writes a key-only `sshd_config`, copies
 *   the Windows helper and the smoke app to `C:\pi-gui-testing`, turns off
 *   sleep, the lock screen, and automatic updates, deletes the host private
 *   key from `C:\OEM`, and writes `installed.json` last (the completion signal
 *   the client polls for over SSH).
 *
 * The folder is staged in `<agent dir>/gui/docker-windows/oem` (0700), bind-
 * mounted read-only into the install container, and deleted after the install.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../docker/package.ts";
import { GUEST_HELPER_DIR, GUEST_INSTALLED_MARKER, GUEST_OEM_DIR, GUEST_ROOT, GUEST_SESSIONS, GUEST_SMOKE_DIR, GUEST_USER } from "./constants.ts";
import { clientPublicKey, type GuestKeys } from "./keys.ts";
import { psQuote } from "./powershell.ts";

/** Directory of the Windows helper in this package. */
export const HELPER_SOURCE_DIR = join(PACKAGE_ROOT, "helpers", "windows");

export interface HelperFile {
  /** Relative path with `/` separators, e.g. `src/win/Native.cs`. */
  path: string;
  data: Buffer;
  sha256: string;
}

/**
 * The helper files WH lists for deployment: `helper.ps1`,
 * `THIRD_PARTY_NOTICES.md`, `src/*.cs`, `src/win/*.cs` (sorted). Nothing else
 * is deployed.
 */
export async function helperFiles(root: string = HELPER_SOURCE_DIR): Promise<HelperFile[]> {
  const names = ["helper.ps1", "THIRD_PARTY_NOTICES.md"];
  for (const sub of ["src", "src/win"]) {
    const entries = await readdir(join(root, sub), { withFileTypes: true });
    for (const e of entries) if (e.isFile() && e.name.endsWith(".cs")) names.push(`${sub}/${e.name}`);
  }
  const files: HelperFile[] = [];
  for (const path of names.sort()) {
    const data = await readFile(join(root, path));
    files.push({ path, data, sha256: createHash("sha256").update(data).digest("hex") });
  }
  return files;
}

/** One fingerprint over all helper files (path + hash), for drift and the session's deploy decision. */
export function helperFingerprint(files: readonly HelperFile[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.path}\0${f.sha256}\n`);
  return h.digest("hex");
}

/** Tiny WinForms smoke app (spec §5.5): window "Pi GUI smoke", label "Waiting" → "Pressed", button "Press me". */
export const SMOKE_APP_SCRIPT = [
  "# Smoke-test app of @firstpick/pi-extension-gui-testing (spec 5.5).",
  "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
  "$form = New-Object System.Windows.Forms.Form",
  "$form.Text = 'Pi GUI smoke'",
  "$form.ClientSize = New-Object System.Drawing.Size 320, 160",
  "$label = New-Object System.Windows.Forms.Label",
  "$label.Text = 'Waiting'",
  "$label.AutoSize = $true",
  "$label.Location = New-Object System.Drawing.Point 20, 20",
  "$button = New-Object System.Windows.Forms.Button",
  "$button.Text = 'Press me'",
  "$button.Location = New-Object System.Drawing.Point 20, 70",
  "$button.Size = New-Object System.Drawing.Size 120, 32",
  "$button.Add_Click({ $label.Text = 'Pressed' })",
  "$form.Controls.Add($label)",
  "$form.Controls.Add($button)",
  "[System.Windows.Forms.Application]::Run($form)",
  "",
].join("\r\n");

/** `sshd_config` of the guest: key login for {@link GUEST_USER} only, no forwarding of any kind. */
export function sshdConfig(user: string = GUEST_USER): string {
  return [
    "# Written by @firstpick/pi-extension-gui-testing (docker-windows).",
    "Port 22",
    "AddressFamily inet",
    "HostKey __PROGRAMDATA__/ssh/ssh_host_ed25519_key",
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitEmptyPasswords no",
    `AllowUsers ${user}`,
    "AllowTcpForwarding no",
    "AllowAgentForwarding no",
    "AllowStreamLocalForwarding no",
    "GatewayPorts no",
    "PermitTunnel no",
    "X11Forwarding no",
    "AuthorizedKeysFile .ssh/authorized_keys",
    "Subsystem sftp sftp-server.exe",
    "Match Group administrators",
    "       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys",
    "",
  ].join("\r\n");
}

/** `install.bat`: dockurr runs it at the end of the install; it only starts `setup.ps1`. */
export const INSTALL_BAT = [
  "@echo off",
  "rem Written by @firstpick/pi-extension-gui-testing (docker-windows).",
  `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${GUEST_OEM_DIR}\\setup.ps1"`,
  "",
].join("\r\n");

/** Folders that only administrators and SYSTEM may use (the helper's runtime-dir rules need this parent). */
const ADMIN_ONLY_ACL = "/inheritance:r /grant:r *S-1-5-32-544:(OI)(CI)F /grant:r *S-1-5-18:(OI)(CI)F";
/** Files that only administrators and SYSTEM may read (sshd refuses broader host-key and admin key files). */
const ADMIN_ONLY_FILE_ACL = "/inheritance:r /grant:r *S-1-5-32-544:F /grant:r *S-1-5-18:F";

/** `setup.ps1`: the guest side of the install (see the module comment). */
export function setupScript(user: string = GUEST_USER): string {
  const q = psQuote;
  return [
    "# Written by @firstpick/pi-extension-gui-testing (docker-windows). Runs once at the end of the unattended install.",
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$src = ${q(GUEST_OEM_DIR)}`,
    `$root = ${q(GUEST_ROOT)}`,
    "$log = Join-Path $src 'setup.log'",
    "function Step([string]$m) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + ' ' + $m) }",
    "function Acl([string]$path, [string]$rules) { $out = & icacls.exe $path $rules.Split(' ') 2>&1; if ($LASTEXITCODE -ne 0) { throw \"icacls $path failed: $out\" } }",
    "try {",
    "  Step 'OpenSSH Server'",
    "  $cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } | Select-Object -First 1",
    "  if (-not $cap) { throw 'the OpenSSH.Server capability is not offered by this Windows build' }",
    "  if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }",
    "  $sshDir = Join-Path $env:ProgramData 'ssh'",
    "  New-Item -ItemType Directory -Force -Path $sshDir | Out-Null",
    "  Copy-Item -LiteralPath (Join-Path $src 'ssh_host_ed25519_key') -Destination (Join-Path $sshDir 'ssh_host_ed25519_key') -Force",
    "  Copy-Item -LiteralPath (Join-Path $src 'ssh_host_ed25519_key.pub') -Destination (Join-Path $sshDir 'ssh_host_ed25519_key.pub') -Force",
    "  Copy-Item -LiteralPath (Join-Path $src 'administrators_authorized_keys') -Destination (Join-Path $sshDir 'administrators_authorized_keys') -Force",
    `  Acl (Join-Path $sshDir 'ssh_host_ed25519_key') ${q(ADMIN_ONLY_FILE_ACL)}`,
    `  Acl (Join-Path $sshDir 'administrators_authorized_keys') ${q(ADMIN_ONLY_FILE_ACL)}`,
    "  Copy-Item -LiteralPath (Join-Path $src 'sshd_config') -Destination (Join-Path $sshDir 'sshd_config') -Force",
    "  Set-Service -Name sshd -StartupType Automatic",
    "  Restart-Service -Name sshd -Force",
    "  if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {",
    "    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null",
    "  }",
    "  Step 'helper'",
    "  New-Item -ItemType Directory -Force -Path $root | Out-Null",
    `  Acl $root ${q(ADMIN_ONLY_ACL)}`,
    `  if (Test-Path -LiteralPath ${q(GUEST_HELPER_DIR)}) { Remove-Item -LiteralPath ${q(GUEST_HELPER_DIR)} -Recurse -Force }`,
    `  Copy-Item -LiteralPath (Join-Path $src 'helper') -Destination ${q(GUEST_HELPER_DIR)} -Recurse -Force`,
    `  New-Item -ItemType Directory -Force -Path ${q(GUEST_SMOKE_DIR)} | Out-Null`,
    `  Copy-Item -LiteralPath (Join-Path $src 'smoke.ps1') -Destination ${q(GUEST_SMOKE_DIR)} -Force`,
    `  New-Item -ItemType Directory -Force -Path ${q(GUEST_SESSIONS)} | Out-Null`,
    "  Step 'power and lock screen'",
    "  foreach ($setting in 'standby-timeout-ac', 'monitor-timeout-ac', 'hibernate-timeout-ac', 'disk-timeout-ac') { & powercfg.exe /change $setting 0 | Out-Null }",
    "  & powercfg.exe /hibernate off | Out-Null",
    "  & reg.exe add 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization' /v NoLockScreen /t REG_DWORD /d 1 /f | Out-Null",
    "  & reg.exe add 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop' /v ScreenSaveActive /t REG_SZ /d 0 /f | Out-Null",
    "  & reg.exe add 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' /v InactivityTimeoutSecs /t REG_DWORD /d 0 /f | Out-Null",
    "  & reg.exe add 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU' /v NoAutoUpdate /t REG_DWORD /d 1 /f | Out-Null",
    "  Step 'cleanup'",
    "  Remove-Item -LiteralPath (Join-Path $src 'ssh_host_ed25519_key') -Force",
    `  Copy-Item -LiteralPath (Join-Path $src 'install.json') -Destination ${q(GUEST_INSTALLED_MARKER)} -Force`,
    "  Step 'done'",
    "} catch {",
    "  Step ('failed: ' + $_.Exception.Message)",
    "  exit 1",
    "}",
    `# Account: ${user}`,
    "",
  ].join("\r\n");
}

export interface StageOemOptions {
  keys: GuestKeys;
  installId: string;
  packageVersion: string;
  helper: readonly HelperFile[];
}

/**
 * Writes the `/oem` folder into `dir` (replacing an earlier one): directory
 * 0700, files 0600 (read by the root-run Docker daemon only).
 *
 * @throws Error when the host key pair is missing (it is generated before the install).
 */
export async function stageOem(dir: string, options: StageOemOptions): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  const base = join(dir, "pi-gui");
  await mkdir(join(base, "helper"), { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const put = async (path: string, data: string | Buffer) => {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600 });
  };
  await put(join(dir, "install.bat"), INSTALL_BAT);
  await put(join(base, "setup.ps1"), setupScript());
  await put(join(base, "sshd_config"), sshdConfig());
  await put(join(base, "smoke.ps1"), SMOKE_APP_SCRIPT);
  await put(join(base, "install.json"), `${JSON.stringify({ installId: options.installId, packageVersion: options.packageVersion })}\r\n`);
  await put(join(base, "administrators_authorized_keys"), `${await clientPublicKey(options.keys)}\r\n`);
  await put(join(base, "ssh_host_ed25519_key"), await readFile(options.keys.hostKey));
  await put(join(base, "ssh_host_ed25519_key.pub"), await readFile(options.keys.hostPub));
  for (const file of options.helper) await put(join(base, "helper", ...file.path.split("/")), file.data);
}
