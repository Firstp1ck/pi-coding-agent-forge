# Runs CoreTests.cs against the Windows helper's pure core (no Win32 layer),
# compiled at C# 5 like Windows PowerShell 5.1's Add-Type. Exit code 0 when
# every check passes. Works with PowerShell 7 on any host.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sources = @(Get-ChildItem -LiteralPath (Join-Path $root 'helpers/windows/src') -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
$sources += (Join-Path $PSScriptRoot 'CoreTests.cs')
Add-Type -Path $sources -CompilerOptions '-langversion:5' | Out-Null
[Environment]::Exit([PiGuiHelper.Tests.CoreTests]::Main())
