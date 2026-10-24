# Compile check of every Windows helper source (including the Win32 and UI
# Automation layers) against the .NET Framework 4.7.2 reference assemblies at
# C# 5, the language level of Windows PowerShell 5.1's Add-Type. Runs on any
# host with PowerShell 7, which ships Roslyn. Nothing is executed: the
# assembly is emitted to memory only.
#
#   pwsh -NoProfile -File tests/helper-windows/compile-check.ps1 -ReferenceDir <dir with mscorlib.dll, System.dll,
#        System.Core.dll, UIAutomationClient.dll, UIAutomationTypes.dll, WindowsBase.dll>
#
# The reference assemblies come from the NuGet package
# Microsoft.NETFramework.ReferenceAssemblies.net472 (build/.NETFramework/v4.7.2).
param([Parameter(Mandatory = $true)][string]$ReferenceDir)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$srcDir = Join-Path $root 'helpers/windows/src'
$files = @(Get-ChildItem -LiteralPath $srcDir -Recurse -Filter '*.cs' -File | Sort-Object FullName)
$parse = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::new([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
$trees = foreach ($f in $files) {
    $text = [System.IO.File]::ReadAllText($f.FullName)
    foreach ($ch in $text.ToCharArray()) {
        if ([int]$ch -gt 127) { throw "$($f.FullName) holds a non-ASCII character; keep sources ASCII (PowerShell 5.1 compiles them with the ANSI code page)" }
    }
    [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($text, $parse, $f.FullName)
}
$names = 'mscorlib.dll', 'System.dll', 'System.Core.dll', 'UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'
$refs = foreach ($n in $names) {
    $p = Join-Path $ReferenceDir $n
    if (-not (Test-Path -LiteralPath $p)) { throw "missing reference assembly $p" }
    [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile($p)
}
$options = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new([Microsoft.CodeAnalysis.OutputKind]::DynamicallyLinkedLibrary)
$compilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create('PiGuiHelperCheck', [Microsoft.CodeAnalysis.SyntaxTree[]]@($trees),
    [Microsoft.CodeAnalysis.MetadataReference[]]@($refs), $options)
$stream = [System.IO.MemoryStream]::new()
$result = $compilation.Emit($stream)
$errors = 0
foreach ($d in $result.Diagnostics) {
    if ($d.Severity -eq [Microsoft.CodeAnalysis.DiagnosticSeverity]::Error) { $errors++ }
    if ($d.Severity -ge [Microsoft.CodeAnalysis.DiagnosticSeverity]::Warning) { [Console]::Out.WriteLine($d.ToString()) }
}
[Console]::Out.WriteLine("compile-check: $($files.Count) files, $errors errors, success=$($result.Success)")
if ($result.Success) { exit 0 } else { exit 1 }
