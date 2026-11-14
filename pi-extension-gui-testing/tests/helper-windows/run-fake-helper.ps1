# Runs the Windows helper's protocol core with the scripted fake platform
# (FakePlatform.cs) instead of the Win32 layer. Test-only: the production entry
# is helpers/windows/helper.ps1. The core is compiled at C# 5, the language
# level of Windows PowerShell 5.1's Add-Type, so newer syntax fails here too.
param([string]$StdinEnv = '', [string]$Probe = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sources = @(Get-ChildItem -LiteralPath (Join-Path $root 'helpers/windows/src') -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
$sources += (Join-Path $PSScriptRoot 'FakePlatform.cs')
Add-Type -Path $sources -CompilerOptions '-langversion:5' | Out-Null
$code = [PiGuiHelper.Tests.FakeEntry]::Main($StdinEnv, $Probe)
[Environment]::Exit($code)
