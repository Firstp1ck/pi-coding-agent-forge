# Windows helper for @firstpick/pi-extension-gui-testing (protocol version 2,
# docs/protocol.md "Windows helper").
#
# Start it with Windows PowerShell 5.1 and stdio pipes:
#
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dir>\helper.ps1
#       [-StdinEnv NAME,NAME,...]   read these contract variables as the first stdin lines (values never in argv)
#       [-Probe env|desktop|job|nonelevated|uia|foreground]   one JSON line for a client check, no protocol
#
# The environment contract is documented in src/Policy.cs (HostConfig) and in
# docs/protocol.md. This script only checks the host, compiles the C# sources
# next to it with Add-Type (in memory, no network), and calls the C# entry.
# The sources stay plain C# 5 so they can later be built into a signed .exe.
param(
    [string]$StdinEnv = '',
    [string]$Probe = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Stop-Helper([string]$Message) {
    [Console]::Error.WriteLine("pi-gui-helper: $Message")
    [Environment]::Exit(1)
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Stop-Helper 'the Windows helper runs only on Windows'
}
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
    Stop-Helper "start the helper with Windows PowerShell 5.1 (powershell.exe), not PowerShell $($PSVersionTable.PSVersion)"
}
$languageMode = $ExecutionContext.SessionState.LanguageMode
if ($languageMode -ne 'FullLanguage') {
    Stop-Helper "PowerShell runs in $languageMode mode (an AppLocker or WDAC policy), which blocks Add-Type; the helper cannot run on this machine"
}

# Fixed file list: nothing else next to the script is ever compiled.
$sourceFiles = @(
    'src\Json.cs', 'src\Framing.cs', 'src\Dispatch.cs', 'src\Imaging.cs', 'src\Model.cs', 'src\Policy.cs',
    'src\Handlers.cs', 'src\HelperMain.cs',
    'src\win\Native.cs', 'src\win\WinSecurity.cs', 'src\win\WinJob.cs', 'src\win\WinDesktop.cs',
    'src\win\WinUia.cs', 'src\win\WinFiles.cs', 'src\win\WinPlatform.cs'
)
$paths = foreach ($file in $sourceFiles) {
    $path = Join-Path $PSScriptRoot $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Stop-Helper "missing helper source $path; reinstall the package" }
    $path
}

try {
    $wanted = 'System.Core', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'
    Add-Type -AssemblyName $wanted
    $references = @([AppDomain]::CurrentDomain.GetAssemblies() |
        Where-Object { $wanted -contains $_.GetName().Name } |
        ForEach-Object { $_.Location })
    # -IgnoreWarnings: Windows PowerShell 5.1 otherwise turns compiler warnings into errors.
    Add-Type -Path $paths -ReferencedAssemblies $references -IgnoreWarnings | Out-Null
} catch {
    Stop-Helper "compiling the helper failed (antivirus or application control blocking csc.exe?): $($_.Exception.Message)"
}

$code = [PiGuiHelper.Win.WinEntry]::Run($StdinEnv, $Probe, $PSVersionTable.PSVersion.ToString())
# Exit hard: worker threads may still sit in blocking UI Automation calls.
[Environment]::Exit($code)
