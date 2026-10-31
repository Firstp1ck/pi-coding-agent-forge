# Checks that WinFiles.WriteAtomic never writes through an entry the app planted
# in its writable runtime dir: a symbolic or hard link at the old fixed temp name
# (session.json.tmp) pointing at an outside file must leave that file untouched.
# Compiles the real helper sources against the .NET Framework reference
# assemblies and calls the managed method; on Linux the final MoveFileExW call
# is unavailable (DllNotFoundException), which happens after the temp write.
param([string]$ReferenceDir = (Join-Path $HOME '.local/share/pi-tools/netfx-ref-net472'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$parse = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::new([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
$files = @(Get-ChildItem -LiteralPath (Join-Path $root 'helpers/windows/src') -Recurse -Filter '*.cs' -File)
$trees = foreach ($f in $files) { [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText([IO.File]::ReadAllText($f.FullName), $parse, $f.FullName) }
$refs = foreach ($n in @('mscorlib.dll', 'System.dll', 'System.Core.dll', 'UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll')) { [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile((Join-Path $ReferenceDir $n)) }
$options = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new([Microsoft.CodeAnalysis.OutputKind]::DynamicallyLinkedLibrary)
$compilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create('AtomicWriteCheck', [Microsoft.CodeAnalysis.SyntaxTree[]]@($trees), [Microsoft.CodeAnalysis.MetadataReference[]]@($refs), $options)
$stream = [IO.MemoryStream]::new()
$emitted = $compilation.Emit($stream)
if (-not $emitted.Success) { throw (($emitted.Diagnostics | ForEach-Object { $_.ToString() }) -join "`n") }
$method = [Reflection.Assembly]::Load($stream.ToArray()).GetType('PiGuiHelper.Win.WinFiles').GetMethod('WriteAtomic', [Reflection.BindingFlags]'Public,Static')
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('gui-atomic-' + [guid]::NewGuid().ToString('N'))
$passed = 0; $failed = 0
try {
  foreach ($kind in @('SymbolicLink', 'HardLink')) {
    $case = Join-Path $scratch $kind
    [IO.Directory]::CreateDirectory((Join-Path $case 'runtime')) | Out-Null
    $victim = Join-Path $case 'outside.txt'
    [IO.File]::WriteAllText($victim, 'OUTSIDE')
    $target = Join-Path $case 'runtime/session.json'
    New-Item -ItemType $kind -Path ($target + '.tmp') -Target $victim | Out-Null
    try { $method.Invoke($null, [string[]]@($target, '{"overwritten":true}')) | Out-Null } catch {
      $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
      if ($e -isnot [DllNotFoundException] -and $e -isnot [EntryPointNotFoundException]) { throw }
    }
    $record = Join-Path $case 'runtime/session.json'
    if ((Test-Path -LiteralPath $record) -and [IO.File]::ReadAllText($record) -ne '{"overwritten":true}') { $failed++; "not ok - $kind record has the wrong content" }
    if ([IO.File]::ReadAllText($victim) -eq 'OUTSIDE') { $passed++; "ok - $kind plant left the outside file untouched" } else { $failed++; "not ok - $kind plant: outside file overwritten" }
    # The plant, and on Windows (where the rename succeeds) the new record itself, are expected.
    $strays = @(Get-ChildItem -LiteralPath (Join-Path $case 'runtime') -Force | Where-Object { $_.Name -ne 'session.json.tmp' -and $_.Name -ne 'session.json' })
    if ($strays.Count -eq 0) { $passed++; "ok - $kind no temp file left after the failed rename" } else { $failed++; "not ok - $kind leftover: $($strays.Name -join ', ')" }
  }
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
"# passed $passed, failed $failed"
if ($failed -gt 0) { exit 1 }
