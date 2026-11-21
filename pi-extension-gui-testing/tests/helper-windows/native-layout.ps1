# Managed layout checks of the Win32 structs in helpers/windows/src/win/Native.cs.
# Nothing is called: Add-Type compiles the declarations, and Marshal.SizeOf /
# OffsetOf / PtrToStructure read the marshalled layout, which is the same on any
# host for structs without pointers. Exit code 0 when every check passes.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$types = Add-Type -Path (Join-Path $root 'helpers/windows/src/win/Native.cs') -CompilerOptions '-langversion:5' -PassThru
$assembly = $types[0].Assembly
$script:passed = 0
$script:failed = 0

function Check([bool]$ok, [string]$name) {
    if ($ok) { $script:passed++; [Console]::Out.WriteLine("ok - $name") }
    else { $script:failed++; [Console]::Out.WriteLine("not ok - $name") }
}

function TypeOf([string]$name) { $assembly.GetType('PiGuiHelper.Win.' + $name, $true) }
function Size([string]$name) { [Runtime.InteropServices.Marshal]::SizeOf([type](TypeOf $name)) }
function Offset([string]$name, [string]$field) { [int64][Runtime.InteropServices.Marshal]::OffsetOf((TypeOf $name), $field) }

# Sizes and offsets from the Windows SDK headers (minwinbase.h, fileapi.h, winnt.h).
$find = Size 'WIN32_FIND_DATA'
Check ($find -eq 592) "WIN32_FIND_DATAW is 592 bytes (got $find)"
Check ((Offset 'WIN32_FIND_DATA' 'ftCreationTime') -eq 4) 'WIN32_FIND_DATAW.ftCreationTime at offset 4'
Check ((Offset 'WIN32_FIND_DATA' 'nFileSizeHigh') -eq 28) 'WIN32_FIND_DATAW.nFileSizeHigh at offset 28'
Check ((Offset 'WIN32_FIND_DATA' 'cFileName') -eq 44) "WIN32_FIND_DATAW.cFileName at offset 44 (got $(Offset 'WIN32_FIND_DATA' 'cFileName'))"
Check ((Offset 'WIN32_FIND_DATA' 'cAlternateFileName') -eq 564) 'WIN32_FIND_DATAW.cAlternateFileName at offset 564'

$info = Size 'BY_HANDLE_FILE_INFORMATION'
Check ($info -eq 52) "BY_HANDLE_FILE_INFORMATION is 52 bytes (got $info)"
Check ((Offset 'BY_HANDLE_FILE_INFORMATION' 'VolumeSerialNumber') -eq 28) 'BY_HANDLE_FILE_INFORMATION.dwVolumeSerialNumber at offset 28'
Check ((Offset 'BY_HANDLE_FILE_INFORMATION' 'FileIndexLow') -eq 48) 'BY_HANDLE_FILE_INFORMATION.nFileIndexLow at offset 48'

$os = Size 'OSVERSIONINFOEX'
Check ($os -eq 284) "RTL_OSVERSIONINFOEXW is 284 bytes (got $os)"
Check ((Offset 'OSVERSIONINFOEX' 'wServicePackMajor') -eq 276) 'RTL_OSVERSIONINFOEXW.wServicePackMajor at offset 276'

# A native WIN32_FIND_DATAW buffer decodes to the whole file name.
$t = TypeOf 'WIN32_FIND_DATA'
$p = [Runtime.InteropServices.Marshal]::AllocHGlobal(600)
try {
    $buf = [byte[]]::new(600)
    [BitConverter]::GetBytes([uint32]0x10).CopyTo($buf, 0)
    [BitConverter]::GetBytes([uint32]0x12345678).CopyTo($buf, 32)
    [Text.Encoding]::Unicode.GetBytes('hello.txt').CopyTo($buf, 44)
    [Text.Encoding]::Unicode.GetBytes('HELLO~1.TXT').CopyTo($buf, 564)
    [Runtime.InteropServices.Marshal]::Copy($buf, 0, $p, 600)
    $value = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type]$t)
    Check ($value.cFileName -eq 'hello.txt') "cFileName decodes as hello.txt (got '$($value.cFileName)')"
    Check ($value.cAlternateFileName -eq 'HELLO~1.TXT') "cAlternateFileName decodes as HELLO~1.TXT (got '$($value.cAlternateFileName)')"
    Check ($value.dwFileAttributes -eq 0x10) 'dwFileAttributes decodes'
    Check ($value.nFileSizeLow -eq 0x12345678) 'nFileSizeLow decodes'
} finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
}

[Console]::Out.WriteLine("# passed $script:passed, failed $script:failed")
if ($script:failed -eq 0) { exit 0 } else { exit 1 }
