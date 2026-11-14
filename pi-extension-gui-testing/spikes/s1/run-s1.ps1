# Spike S1 harness (spec section 11): hidden-desktop fidelity on Windows.
#
# For each sample app (Tk, PySide6, WinForms, WPF, Electron with and without
# --disable-gpu) it runs
#   (a) @iiwate/pi-silent-gui 0.2.0 as-is (its Python backend CLI), and
#   (b) this package's Windows helper (helpers/windows/helper.ps1) over its protocol,
# and records per framework: launch ok, click delivered, screenshot non-black
# rate, UI Automation reachability on the private desktop, and whether the
# user's foreground window stayed unchanged. Writes s1-<time>.json and .md.
#
# Run from Windows PowerShell 5.1 on Windows 10 1809+ or 11 (see README.md):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File spikes\s1\run-s1.ps1 [-Runs 3] [-Tools both|reference|helper]
param(
    [int]$Runs = 3,
    [ValidateSet('both', 'reference', 'helper')][string]$Tools = 'both',
    [string]$Frameworks = 'tk,pyside6,winforms,wpf,electron-disable-gpu,electron-gpu',
    [string]$OutDir = '',
    [string]$SilentGuiDir = '',
    [string]$Python = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'S1 runs on Windows only' }
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'run S1 with Windows PowerShell 5.1 (powershell.exe)' }

$here = $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $here)
$apps = Join-Path $here 'apps'
$helperScript = Join-Path $repo 'helpers\windows\helper.ps1'
$powershellExe = Join-Path $PSHOME 'powershell.exe'
if (-not $OutDir) { $OutDir = Join-Path $here 'results' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$work = Join-Path $env:TEMP "pi-gui-s1-$stamp"
New-Item -ItemType Directory -Force -Path $work | Out-Null

# Pinned reference package (npm view @iiwate/pi-silent-gui@0.2.0 dist.integrity).
$SilentGuiVersion = '0.2.0'
$SilentGuiIntegrity = 'sha512-ZTOR+CqbGnTtnJKG9zj7jQo3j/Eq9ZRt/FBaDdOFX0irOnvOyfI/j/Ld8BmGcNbWlRPKJhClCTwAeuKWT1E0Pw=='

$wanted = 'System.Core', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'
Add-Type -AssemblyName $wanted
$refs = @([AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $wanted -contains $_.GetName().Name } | ForEach-Object { $_.Location })
Add-Type -Path (Join-Path $here 'S1Support.cs') -ReferencedAssemblies $refs -IgnoreWarnings | Out-Null

function Write-Step([string]$Text) { [Console]::Error.WriteLine("[s1] $Text") }

function Find-Python {
    if ($Python) { return $Python }
    foreach ($name in 'python.exe', 'py.exe') {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) {
            if ($name -eq 'py.exe') {
                $r = [PiGuiS1.S1Native]::Run($cmd.Source, @('-3', '-c', 'import sys; print(sys.executable)'), $null, $null, 30000)
                if ($r.ExitCode -eq 0) { return $r.Stdout.Trim() }
            } else {
                return $cmd.Source
            }
        }
    }
    return $null
}

function Test-PythonModule([string]$Py, [string]$Module) {
    if (-not $Py) { return $false }
    $r = [PiGuiS1.S1Native]::Run($Py, @('-c', "import $Module"), $null, $null, 60000)
    return $r.ExitCode -eq 0
}

function Get-SilentGui {
    if ($SilentGuiDir) { return (Join-Path $SilentGuiDir 'src\backend\silent_gui.py') }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { return $null }
    $dest = Join-Path $work 'silent-gui'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $r = [PiGuiS1.S1Native]::Run($env:ComSpec, @('/d', '/c', 'npm', 'pack', "@iiwate/pi-silent-gui@$SilentGuiVersion", '--pack-destination', $dest), $null, $dest, 300000)
    if ($r.ExitCode -ne 0) { Write-Step "npm pack failed: $($r.Stderr)"; return $null }
    $tgz = Get-ChildItem -LiteralPath $dest -Filter '*.tgz' | Select-Object -First 1
    $sha = [System.Security.Cryptography.SHA512]::Create()
    $stream = [System.IO.File]::OpenRead($tgz.FullName)
    try { $integrity = 'sha512-' + [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $stream.Dispose() }
    if ($integrity -ne $SilentGuiIntegrity) { throw "pi-silent-gui tarball integrity mismatch: $integrity" }
    $r = [PiGuiS1.S1Native]::Run((Join-Path $env:SystemRoot 'System32\tar.exe'), @('-xzf', $tgz.FullName, '-C', $dest), $null, $dest, 120000)
    if ($r.ExitCode -ne 0) { throw "tar failed: $($r.Stderr)" }
    return (Join-Path $dest 'package\src\backend\silent_gui.py')
}

function Wait-Marker([string]$Path, [int]$TimeoutMs = 4000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        if (Test-Path -LiteralPath $Path) { return $true }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

function ConvertFrom-LastJsonLine([string]$Text) {
    $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim() })
    if ($lines.Count -eq 0) { return $null }
    try { return ($lines[-1] | ConvertFrom-Json) } catch { return $null }
}

# ----- framework table ------------------------------------------------------

$py = Find-Python
$electronExe = Join-Path $apps 'electron\node_modules\electron\dist\electron.exe'
$electronDir = Join-Path $apps 'electron'
$all = [ordered]@{
    'tk'                   = @{ cmd = $py; args = @((Join-Path $apps 'tk_app.py')); ready = { Test-PythonModule $py 'tkinter' }; hint = 'install Python 3.10+ from python.org with Tcl/Tk' }
    'pyside6'              = @{ cmd = $py; args = @((Join-Path $apps 'pyside6_app.py')); ready = { Test-PythonModule $py 'PySide6.QtWidgets' }; hint = 'pip install PySide6==6.12.0' }
    'winforms'             = @{ cmd = $powershellExe; args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $apps 'winforms_app.ps1')); ready = { $true }; hint = '' }
    'wpf'                  = @{ cmd = $powershellExe; args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $apps 'wpf_app.ps1')); ready = { $true }; hint = '' }
    'electron-disable-gpu' = @{ cmd = $electronExe; args = @($electronDir, '--disable-gpu'); software = $true; ready = { Test-Path -LiteralPath $electronExe }; hint = 'cd spikes\s1\apps\electron; npm install' }
    'electron-gpu'         = @{ cmd = $electronExe; args = @($electronDir); software = $false; ready = { Test-Path -LiteralPath $electronExe }; hint = 'cd spikes\s1\apps\electron; npm install' }
}

# ----- (a) the reference package as-is ----------------------------------------

function Invoke-SilentGui([string]$Script, [string]$Command, $Params, [int]$TimeoutMs = 60000) {
    $json = $Params | ConvertTo-Json -Compress -Depth 6
    $env2 = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    $env2['PYTHONUTF8'] = '1'
    $env2['PYTHONIOENCODING'] = 'utf-8'
    $r = [PiGuiS1.S1Native]::Run($py, @($Script, $Command, '--json', $json), $env2, (Split-Path -Parent $Script), $TimeoutMs)
    $parsed = ConvertFrom-LastJsonLine $r.Stdout
    return [pscustomobject]@{ raw = $r; data = $parsed; ok = ($r.ExitCode -eq 0 -and $parsed -and $parsed.ok -eq $true) }
}

function Test-Reference([string]$Script, [string]$Name, $Spec) {
    $result = [ordered]@{ tool = 'pi-silent-gui'; framework = $Name; launchOk = $false; captures = 0; nonBlack = 0; clickDelivered = $false
        uia = $null; foregroundUnchanged = $null; errors = @() }
    $marker = Join-Path $work "marker-ref-$Name-$([PiGuiS1.S1Native]::RandomHex(4)).txt"
    $before = [PiGuiS1.S1Native]::Foreground()
    $spawn = Invoke-SilentGui $Script 'spawn' @{ exe = $Spec.cmd; args = $Spec.args; cwd = $apps; env = @{ S1_MARKER = $marker } }
    if (-not $spawn.ok) {
        $result.errors += "spawn: $($spawn.raw.Stdout.Trim()) $($spawn.raw.Stderr.Trim())"
        return $result
    }
    $session = $spawn.data.session_id
    $result.launchOk = $true
    try {
        Start-Sleep -Seconds 4
        $hwnd = $null; $width = 0; $height = 0
        for ($i = 0; $i -lt 3; $i++) {
            $cap = Invoke-SilentGui $Script 'capture' @{ session_id = $session }
            $result['captures'] += 1
            if ($cap.ok) {
                if (-not $cap.data.all_black) { $result['nonBlack'] += 1 }
                $hwnd = [long]$cap.data.hwnd; $width = [int]$cap.data.window.width; $height = [int]$cap.data.window.height
            } else { $result.errors += "capture: $($cap.raw.Stdout.Trim())" }
            Start-Sleep -Milliseconds 700
        }
        if ($hwnd) {
            $result.uia = [PiGuiS1.S1Native]::UiaProbe([string]$spawn.data.desktop, $hwnd, 20000)
            $click = Invoke-SilentGui $Script 'message' @{ session_id = $session; action = 'click'; x = [int][math]::Floor($width / 2); y = [int][math]::Floor($height * 0.7) }
            if (-not $click.ok) { $result.errors += "message: $($click.raw.Stdout.Trim())" }
            $result.clickDelivered = Wait-Marker $marker
        }
    } finally {
        $kill = Invoke-SilentGui $Script 'kill' @{ session_id = $session }
        if (-not $kill.ok) { $result.errors += "kill: $($kill.raw.Stdout.Trim())" }
    }
    $result.foregroundUnchanged = ($before -eq [PiGuiS1.S1Native]::Foreground())
    return $result
}

# ----- (b) this package's helper ---------------------------------------------

function Invoke-Helper($Client, [string]$Method, $Params, [int]$TimeoutMs = 60000) {
    $json = if ($null -eq $Params) { '{}' } else { $Params | ConvertTo-Json -Compress -Depth 6 }
    $line = $Client.Call($Method, $json, $TimeoutMs)
    if (-not $line) { return [pscustomobject]@{ ok = $false; error = "no answer to $Method within $TimeoutMs ms"; result = $null } }
    $r = $line | ConvertFrom-Json
    if ($r.ok) { return [pscustomobject]@{ ok = $true; error = $null; result = $r.result } }
    return [pscustomobject]@{ ok = $false; error = "$($r.error.code): $($r.error.message)"; result = $null }
}

function Test-Helper([string]$Name, $Spec) {
    $result = [ordered]@{ tool = 'helper'; framework = $Name; readyMs = -1; launchOk = $false; captures = 0; nonBlack = 0; screenNonBlack = $null
        coverage = $null; uia = $null; coordinateClick = $false; refClick = $null; stopOk = $null; leftovers = @(); exitCode = $null
        foregroundUnchanged = $null; platform = $null; errors = @() }
    $runtime = Join-Path $env:LOCALAPPDATA "Temp\pi-gui-testing-s1-$([PiGuiS1.S1Native]::RandomHex(6))"
    New-Item -ItemType Directory -Path $runtime | Out-Null
    $marker = Join-Path $work "marker-helper-$Name-$([PiGuiS1.S1Native]::RandomHex(4)).txt"
    $env2 = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    $env2['PI_GUI_HELPER_MODE'] = 'local'
    $env2['PI_GUI_WORKSPACE'] = $apps
    $env2['PI_GUI_RUNTIME_DIR'] = $runtime
    if ($Spec.ContainsKey('software') -and -not $Spec.software) { $env2['PI_GUI_WIN_SOFTWARE_RENDERING'] = '0' }
    $before = [PiGuiS1.S1Native]::Foreground()
    $client = [PiGuiS1.HelperClient]::Start($powershellExe, $helperScript, $env2, 30000)
    try {
        $result.readyMs = $client.ReadyMs
        if (-not $client.IsReady) { $result.errors += "no READY within 30 s: $($client.Stderr)"; return $result }
        $hello = Invoke-Helper $client 'hello' @{ protocol = 2; packageVersion = 's1' }
        if ($hello.ok) { $result.platform = $hello.result.platform } else { $result.errors += "hello: $($hello.error)" }
        $launch = Invoke-Helper $client 'launch' @{ cmd = $Spec.cmd; args = $Spec.args; env = @{ S1_MARKER = $marker }; cwd = $apps } 60000
        if (-not $launch.ok) { $result.errors += "launch: $($launch.error)"; return $result }
        $result.launchOk = $true
        $windows = @($launch.result.windows)
        if ($windows.Count -eq 0) {
            [void](Invoke-Helper $client 'wait' @{ for = 'window'; value = 'S1'; timeoutMs = 20000 } 30000)
            $listed = Invoke-Helper $client 'windows' $null
            if ($listed.ok) { $windows = @($listed.result.windows) }
        }
        if ($windows.Count -eq 0) { $result.errors += 'no window appeared'; return $result }
        $window = @($windows | Where-Object { $_.title -like 'S1*' } | Select-Object -First 1)
        if ($window.Count -eq 0) { $window = @($windows[0]) }
        $ref = $window[0].ref
        Start-Sleep -Seconds 2
        $shot = $null
        for ($i = 0; $i -lt 3; $i++) {
            $s = Invoke-Helper $client 'screenshot' @{ window = $ref }
            $result['captures'] += 1
            if ($s.ok) { $shot = $s.result; if (-not ($s.result.PSObject.Properties.Name -contains 'allBlack')) { $result['nonBlack'] += 1 } }
            else { $result.errors += "screenshot: $($s.error)" }
            Start-Sleep -Milliseconds 700
        }
        $screen = Invoke-Helper $client 'screenshot' @{ maxEdge = 640 }
        if ($screen.ok) { $result.screenNonBlack = -not ($screen.result.PSObject.Properties.Name -contains 'allBlack') }
        $snap = Invoke-Helper $client 'snapshot' @{ maxNodes = 5000 } 120000
        $buttonRef = $null
        if ($snap.ok) {
            $result.coverage = $snap.result.coverage
            $node = @($snap.result.tree | Where-Object { $_.name -eq 'Press me' } | Select-Object -First 1)
            $result.uia = if ($node.Count -gt 0) { 'found' } else { 'window-only' }
            if ($node.Count -gt 0) { $buttonRef = $node[0].ref }
        } else { $result.uia = "snapshot: $($snap.error)" }
        if ($shot) {
            $act = Invoke-Helper $client 'act' @{ captureId = $shot.captureId; x = [int][math]::Floor($shot.width / 2); y = [int][math]::Floor($shot.height * 0.7); action = 'click' }
            if (-not $act.ok) { $result.errors += "act (coordinates): $($act.error)" }
            $result.coordinateClick = Wait-Marker $marker
        }
        if ($buttonRef) {
            Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue
            $act = Invoke-Helper $client 'act' @{ ref = $buttonRef; action = 'click' }
            if (-not $act.ok) { $result.errors += "act (ref): $($act.error)" }
            $result.refClick = Wait-Marker $marker
        }
        $stop = Invoke-Helper $client 'stop' $null 60000
        if ($stop.ok) { $result.stopOk = $stop.result.ok; $result.leftovers = @($stop.result.leftovers) } else { $result.errors += "stop: $($stop.error)" }
    } finally {
        $result.exitCode = $client.WaitExit(30000)
        if ($result.exitCode -ne 0) { $result.errors += "helper stderr: $($client.Stderr)" }
        $client.Dispose()
        Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction SilentlyContinue
    }
    $result.foregroundUnchanged = ($before -eq [PiGuiS1.S1Native]::Foreground())
    return $result
}

# ----- run --------------------------------------------------------------------

$selected = @($Frameworks -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$silentGui = $null
$skipped = @()
if ($Tools -ne 'helper') {
    if (-not (Test-PythonModule $py 'pycaw')) { $skipped += 'pi-silent-gui: needs Python 3.10+ with pycaw (pip install pycaw)' }
    else { $silentGui = Get-SilentGui; if (-not $silentGui) { $skipped += 'pi-silent-gui: npm pack failed (needs Node.js and npm)' } }
}
$results = @()
foreach ($name in $selected) {
    if (-not $all.Contains($name)) { throw "unknown framework $name (known: $($all.Keys -join ', '))" }
    $spec = $all[$name]
    if (-not $spec.cmd -or -not (& $spec.ready)) { $skipped += "${name}: $($spec.hint)"; continue }
    for ($run = 1; $run -le $Runs; $run++) {
        if ($silentGui) {
            Write-Step "$name run ${run}: pi-silent-gui"
            $r = Test-Reference $silentGui $name $spec; $r['run'] = $run; $results += [pscustomobject]$r
        }
        if ($Tools -ne 'reference') {
            Write-Step "$name run ${run}: helper"
            $r = Test-Helper $name $spec; $r['run'] = $run; $results += [pscustomobject]$r
        }
    }
}

# ----- report -----------------------------------------------------------------

function Get-Rate($Rows, [scriptblock]$Pick) {
    $values = @($Rows | ForEach-Object { & $Pick $_ } | Where-Object { $null -ne $_ })
    if ($values.Count -eq 0) { return 'n/a' }
    $hits = @($values | Where-Object { $_ -eq $true }).Count
    return "$hits/$($values.Count)"
}

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$dpi = 'unknown'
try { $dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction Stop).AppliedDPI } catch { }
$defender = $null
try { $mp = Get-MpComputerStatus -ErrorAction Stop; $defender = [ordered]@{ realTime = $mp.RealTimeProtectionEnabled; engine = $mp.AMEngineVersion } } catch { $defender = 'unavailable' }
$report = [ordered]@{
    spike = 'S1'; createdAt = (Get-Date).ToUniversalTime().ToString('o'); runs = $Runs
    machine = [ordered]@{ os = if ($os) { "$($os.Caption) $($os.Version)" } else { [Environment]::OSVersion.VersionString }
        arch = $env:PROCESSOR_ARCHITECTURE; powershell = $PSVersionTable.PSVersion.ToString(); python = $py; defender = $defender
        dpi = $dpi }
    reference = "@iiwate/pi-silent-gui@$SilentGuiVersion"; skipped = $skipped; results = $results
}
$jsonPath = Join-Path $OutDir "s1-$stamp.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$md = New-Object System.Text.StringBuilder
[void]$md.AppendLine("# S1 results ($stamp UTC)")
[void]$md.AppendLine('')
[void]$md.AppendLine("Machine: $($report.machine.os), $($report.machine.arch), PowerShell $($report.machine.powershell), DPI $($report.machine.dpi). Runs per framework: $Runs.")
[void]$md.AppendLine('')
[void]$md.AppendLine('| Framework | Tool | Launch | Click (coords) | Click (ref) | Non-black window captures | UIA on private desktop | Coverage | Foreground unchanged | READY ms (median) |')
[void]$md.AppendLine('|---|---|---|---|---|---|---|---|---|---|')
foreach ($group in ($results | Group-Object framework, tool)) {
    $rows = @($group.Group)
    $first = $rows[0]
    $captures = ($rows | Measure-Object captures -Sum).Sum
    $nonBlack = ($rows | Measure-Object nonBlack -Sum).Sum
    $uia = (@($rows | ForEach-Object { $_.uia }) | Group-Object | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', '
    $coords = if ($first.tool -eq 'helper') { Get-Rate $rows { param($r) $r.coordinateClick } } else { Get-Rate $rows { param($r) $r.clickDelivered } }
    $refClick = if ($first.tool -eq 'helper') { Get-Rate $rows { param($r) $r.refClick } } else { 'n/a' }
    $coverage = if ($first.tool -eq 'helper') { (@($rows | ForEach-Object { $_.coverage }) | Select-Object -Unique) -join ', ' } else { 'n/a' }
    $ready = 'n/a'
    if ($first.tool -eq 'helper') {
        $times = @($rows | Where-Object { $_.readyMs -ge 0 } | ForEach-Object { $_.readyMs } | Sort-Object)
        if ($times.Count -gt 0) { $ready = $times[[int][math]::Floor(($times.Count - 1) / 2)] }
    }
    [void]$md.AppendLine("| $($first.framework) | $($first.tool) | $(Get-Rate $rows { param($r) $r.launchOk }) | $coords | $refClick | $nonBlack/$captures | $uia | $coverage | $(Get-Rate $rows { param($r) $r.foregroundUnchanged }) | $ready |")
}
[void]$md.AppendLine('')
if ($skipped.Count -gt 0) {
    [void]$md.AppendLine('Skipped:')
    [void]$md.AppendLine('')
    foreach ($s in $skipped) { [void]$md.AppendLine("- $s") }
    [void]$md.AppendLine('')
}
$errors = @($results | Where-Object { @($_.errors).Count -gt 0 })
if ($errors.Count -gt 0) {
    [void]$md.AppendLine('Errors (first per run):')
    [void]$md.AppendLine('')
    foreach ($e in $errors) {
        $text = (@($e.errors)[0] -replace '\s+', ' ')
        if ($text.Length -gt 300) { $text = $text.Substring(0, 300) + '...' }
        [void]$md.AppendLine("- $($e.framework) / $($e.tool) / run $($e.run): $text")
    }
    [void]$md.AppendLine('')
}
[void]$md.AppendLine("Raw data: s1-$stamp.json. Decision rules: spikes/s1/README.md.")
$mdPath = Join-Path $OutDir "s1-$stamp.md"
Set-Content -LiteralPath $mdPath -Value $md.ToString() -Encoding UTF8
Write-Step "wrote $jsonPath and $mdPath"
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
