param(
  [Parameter(Mandatory = $true)][ValidateSet('probe', 'list', 'edit')][string]$Action,
  [string]$InputPath,
  [string]$OutputPath,
  [string]$OperationsPath,
  [string]$OptionsPath,
  [string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][string]$ControlPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$exitCode = 0
$errorCode = 'BACKEND_UNAVAILABLE'
$result = $null
$excel = $null
$workbooks = $null
$controlWorkbook = $null
$workbook = $null
$ownedExcelInstance = $false
$excelProcessId = $null
$excelStartTimeUtc = $null
$sourceHashBefore = $null
$sourceHashAfter = $null
$outputFullPath = $null
$outputCreated = $false
$success = $false
$trustReason = 'Enable programmatic VBA access yourself at File > Options > Trust Center > Trust Center Settings > Macro Settings > Trust access to the VBA project object model.'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiWorkbookVbaNativeMethods {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

function Fail-Vba {
  param([string]$Code, [string]$Message)
  $script:errorCode = $Code
  throw $Message
}

function Release-Com {
  param($Object)
  if ($null -ne $Object -and [System.Runtime.InteropServices.Marshal]::IsComObject($Object)) {
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object)
  }
}

function Write-ControlFile {
  param([bool]$Owned)
  $directory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($ControlPath))
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  $payload = [ordered]@{
    workerPid = $PID
    excelPid = $excelProcessId
    excelStartTimeUtc = $excelStartTimeUtc
    owned = $Owned
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($ControlPath), $payload, (New-Object System.Text.UTF8Encoding($false)))
}

function Normalize-Code {
  param([AllowEmptyString()][string]$Code)
  return ($Code -replace "`r`n?", "`n").TrimEnd([char[]]"`n")
}

function Get-CodeHash {
  param([AllowEmptyString()][string]$Code)
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes((Normalize-Code $Code))
    return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally { $hasher.Dispose() }
}

function Get-ComponentKind {
  param([int]$Type)
  switch ($Type) {
    1 { return 'standard' }
    2 { return 'class' }
    3 { return 'form' }
    100 { return 'document' }
    default { return 'other' }
  }
}

function Test-TrustError {
  param($Exception)
  while ($null -ne $Exception) {
    if ($Exception.Message -match 'not trusted|Programmatic access' -or $Exception.HResult.ToString('X8') -eq '800A03EC') { return $true }
    $Exception = $Exception.InnerException
  }
  return $false
}

function Get-VbaProject {
  param($TargetWorkbook)
  $project = $null
  $components = $null
  try {
    $project = $TargetWorkbook.VBProject
    if ([int]$project.Protection -eq 1) { return $project }
    $components = $project.VBComponents
    $count = [int]$components.Count
    return $project
  } catch {
    Release-Com $project
    if (Test-TrustError $_.Exception) { Fail-Vba 'BACKEND_UNAVAILABLE' $trustReason }
    throw
  } finally { Release-Com $components }
}

function Get-ModuleCode {
  param($CodeModule)
  $count = [int]$CodeModule.CountOfLines
  if ($count -gt 1000000) { Fail-Vba 'LIMIT_EXCEEDED' 'Existing VBA module exceeds the read line limit.' }
  if ($count -eq 0) { return '' }
  $code = [string]$CodeModule.Lines(1, $count)
  if ($code.Length -gt 16777216) { Fail-Vba 'LIMIT_EXCEEDED' 'Existing VBA module exceeds the read size limit.' }
  return $code
}

function Read-Project {
  param($Project, [bool]$IncludeCode, [string[]]$ModuleNames, [int]$MaxCodeChars)
  if ([int]$Project.Protection -eq 1) { return [ordered]@{ protected = $true; modules = @() } }
  $components = $null
  $modules = @()
  $remaining = $MaxCodeChars
  try {
    $components = $Project.VBComponents
    if ([int]$components.Count -gt 10000) { Fail-Vba 'LIMIT_EXCEEDED' 'VBA project exceeds the module count limit.' }
    for ($i = 1; $i -le [int]$components.Count; $i++) {
      $component = $null
      $codeModule = $null
      try {
        $component = $components.Item($i)
        $codeModule = $component.CodeModule
        $code = Get-ModuleCode $codeModule
        $name = [string]$component.Name
        $info = [ordered]@{ name = $name; kind = (Get-ComponentKind ([int]$component.Type)); lineCount = [int]$codeModule.CountOfLines; codeSha256 = (Get-CodeHash $code) }
        if ($IncludeCode -and ($null -eq $ModuleNames -or $ModuleNames.Count -eq 0 -or $ModuleNames -contains $name)) {
          $length = [Math]::Min($remaining, $code.Length)
          $info['code'] = $code.Substring(0, $length)
          $info['codeTruncated'] = ($length -lt $code.Length)
          $remaining -= $length
        }
        $modules += $info
      } finally { Release-Com $codeModule; Release-Com $component }
    }
  } finally { Release-Com $components }
  return [ordered]@{ protected = $false; modules = @($modules) }
}

function Assert-SentinelNotExecuted {
  param($TargetWorkbook)
  $sheets = $null
  $sheet = $null
  $range = $null
  try {
    $sheets = $TargetWorkbook.Worksheets
    if ([int]$sheets.Count -gt 0) {
      $sheet = $sheets.Item(1)
      $range = $sheet.Range('XFD1048576')
      if ($range.Value2 -eq 'PI_SENTINEL_EXECUTED') { Fail-Vba 'VALIDATION_FAILED' 'Workbook_Open sentinel executed despite forced macro security.' }
    }
  } finally { Release-Com $range; Release-Com $sheet; Release-Com $sheets }
}

function Read-Operations {
  if (-not (Test-Path -LiteralPath $OperationsPath -PathType Leaf)) { Fail-Vba 'INVALID_ARGUMENT' 'Operations file is missing.' }
  $parsed = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($OperationsPath), [System.Text.Encoding]::UTF8))
  $operations = @($parsed)
  if ($operations.Count -eq 0) { Fail-Vba 'INVALID_ARGUMENT' 'At least one VBA operation is required.' }
  if ($operations.Count -gt 50) { Fail-Vba 'LIMIT_EXCEEDED' 'At most 50 VBA operations are allowed.' }
  $seen = @{}
  foreach ($operation in $operations) {
    $name = [string]$operation.name
    if ($name -cnotmatch '^[A-Za-z][A-Za-z0-9_]{0,30}\z') { Fail-Vba 'INVALID_ARGUMENT' 'Invalid VBA module name.' }
    if ($seen.ContainsKey($name)) { Fail-Vba 'INVALID_ARGUMENT' 'Duplicate VBA module target.' }
    $seen[$name] = $true
    if ($operation.type -cnotin @('addModule', 'replaceModuleCode', 'removeModule')) { Fail-Vba 'UNSUPPORTED_FEATURE' 'Unsupported VBA operation.' }
    $keys = if ($operation.type -eq 'addModule') { @('type', 'name', 'kind', 'code') } elseif ($operation.type -eq 'replaceModuleCode') { @('type', 'name', 'code') } else { @('type', 'name') }
    foreach ($property in $operation.PSObject.Properties.Name) {
      if ($keys -cnotcontains $property) { Fail-Vba 'INVALID_ARGUMENT' 'Unexpected VBA operation property.' }
    }
    if ($operation.type -eq 'addModule' -and $operation.kind -cnotin @('standard', 'class')) { Fail-Vba 'UNSUPPORTED_FEATURE' 'Only standard and class modules can be added.' }
    if ($operation.type -ne 'removeModule') {
      if ($operation.code -isnot [string]) { Fail-Vba 'INVALID_ARGUMENT' 'VBA code must be a string.' }
      if ([System.Text.Encoding]::UTF8.GetByteCount($operation.code) -gt 262144) { Fail-Vba 'LIMIT_EXCEEDED' 'VBA code exceeds 256 KiB.' }
      if ($operation.code -match '[^\x20-\x7e\t\r\n]') { Fail-Vba 'INVALID_ARGUMENT' 'VBA code must be printable ASCII, tabs, and newlines.' }
      if ((Normalize-Code $operation.code) -match '(?im)^[\t ]*Attribute[\t ]+VB_') { Fail-Vba 'UNSUPPORTED_FEATURE' 'Attribute VB_ lines cannot be supplied to CodeModule.' }
    }
  }
  return $operations
}

function Apply-Operations {
  param($Project, $Operations, $StoredCodeHashes)
  $components = $null
  $summaries = @()
  try {
    $components = $Project.VBComponents
    foreach ($operation in $Operations) {
      $component = $null
      $codeModule = $null
      try {
        $existing = @()
        for ($i = 1; $i -le [int]$components.Count; $i++) {
          $item = $null
          try { $item = $components.Item($i); $existing += [string]$item.Name } finally { Release-Com $item }
        }
        $name = [string]$operation.name
        $linesBefore = 0
        $linesAfter = 0
        if ($operation.type -eq 'addModule') {
          if ($existing -contains $name) { Fail-Vba 'INVALID_ARGUMENT' "VBA module already exists: $name" }
          $componentType = if ($operation.kind -eq 'standard') { 1 } else { 2 }
          $component = $components.Add($componentType)
          $component.Name = $name
          $codeModule = $component.CodeModule
          if ([int]$codeModule.CountOfLines -gt 0) { [void]$codeModule.DeleteLines(1, [int]$codeModule.CountOfLines) }
          if ($operation.code.Length -gt 0) { [void]$codeModule.AddFromString([string]$operation.code) }
          $linesAfter = [int]$codeModule.CountOfLines
        } else {
          if ($existing -notcontains $name) { Fail-Vba 'INVALID_ARGUMENT' "VBA module does not exist: $name" }
          $component = $components.Item($name)
          $kind = Get-ComponentKind ([int]$component.Type)
          if ($kind -notin @('standard', 'class', 'document')) { Fail-Vba 'UNSUPPORTED_FEATURE' 'UserForms and other component types are read-only.' }
          if ($operation.type -eq 'removeModule' -and $kind -eq 'document') { Fail-Vba 'UNSUPPORTED_FEATURE' 'Document modules cannot be removed.' }
          $codeModule = $component.CodeModule
          $linesBefore = [int]$codeModule.CountOfLines
          if ($operation.type -eq 'removeModule') {
            Release-Com $codeModule
            $codeModule = $null
            [void]$components.Remove($component)
          } else {
            if ($linesBefore -gt 0) { [void]$codeModule.DeleteLines(1, $linesBefore) }
            if ($operation.code.Length -gt 0) { [void]$codeModule.AddFromString([string]$operation.code) }
            $linesAfter = [int]$codeModule.CountOfLines
          }
        }
        if ($operation.type -ne 'removeModule') { $StoredCodeHashes[$name] = Get-CodeHash (Get-ModuleCode $codeModule) }
        $summaries += [ordered]@{ type = [string]$operation.type; name = $name; linesBefore = $linesBefore; linesAfter = $linesAfter }
      } finally { Release-Com $codeModule; Release-Com $component }
    }
  } finally { Release-Com $components }
  return $summaries
}

function Assert-ReadBack {
  param($Before, $After, $Operations, $StoredCodeHashes)
  if ($After.protected) { Fail-Vba 'VALIDATION_FAILED' 'Saved VBA project became locked.' }
  $afterMap = @{}
  foreach ($module in $After.modules) { $afterMap[$module.name] = $module }
  $targets = @{}
  foreach ($operation in $Operations) {
    $targets[$operation.name] = $true
    $actual = $afterMap[$operation.name]
    if ($operation.type -eq 'removeModule') {
      if ($null -ne $actual) { Fail-Vba 'VALIDATION_FAILED' 'Removed VBA module is still present.' }
    } else {
      if ($null -eq $actual) { Fail-Vba 'VALIDATION_FAILED' 'Edited VBA module is missing.' }
      if ($actual.codeSha256 -cne $StoredCodeHashes[$operation.name]) { Fail-Vba 'VALIDATION_FAILED' "VBA saved code differs from in-memory stored code: $($operation.name)" }
      if ($operation.type -eq 'addModule' -and $actual.kind -ne $operation.kind) { Fail-Vba 'VALIDATION_FAILED' 'Added VBA component kind changed.' }
    }
  }
  $beforeMap = @{}
  foreach ($module in $Before.modules) { $beforeMap[$module.name] = $module }
  foreach ($module in $After.modules) {
    if (-not $beforeMap.ContainsKey($module.name) -and -not $targets.ContainsKey($module.name)) { Fail-Vba 'VALIDATION_FAILED' 'Unexpected VBA module appeared after save.' }
  }
  foreach ($module in $Before.modules) {
    if ($afterMap.ContainsKey($module.name) -and $afterMap[$module.name].kind -ne $module.kind) { Fail-Vba 'VALIDATION_FAILED' 'Existing VBA component kind changed.' }
    if (-not $targets.ContainsKey($module.name)) {
      $actual = $afterMap[$module.name]
      if ($null -eq $actual -or $actual.codeSha256 -ne $module.codeSha256 -or $actual.kind -ne $module.kind) { Fail-Vba 'VALIDATION_FAILED' "Untouched VBA module changed: $($module.name)" }
    }
  }
}

try {
  if (-not [Environment]::UserInteractive) { throw 'Native Excel requires an interactive logged-in Windows user.' }
  $preExistingExcelPids = @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $excel = New-Object -ComObject Excel.Application
  $pidValue = [uint32]0
  [void][PiWorkbookVbaNativeMethods]::GetWindowThreadProcessId([IntPtr]$excel.Hwnd, [ref]$pidValue)
  $excelProcessId = [int]$pidValue
  if ($excelProcessId -le 0) { throw 'Could not identify the Excel process created for the worker.' }
  $excelProcess = Get-Process -Id $excelProcessId -ErrorAction Stop
  $excelStartTimeUtc = $excelProcess.StartTime.ToUniversalTime().ToString('o')
  $ownedExcelInstance = -not ($preExistingExcelPids -contains $excelProcessId)
  Write-ControlFile $ownedExcelInstance
  if (-not $ownedExcelInstance) { throw 'Excel COM attached to a pre-existing process; refusing to automate or terminate it.' }

  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.EnableEvents = $false
  $excel.AskToUpdateLinks = $false
  $excel.AlertBeforeOverwriting = $false
  $excel.ScreenUpdating = $false
  $excel.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
  $workbooks = $excel.Workbooks
  $controlWorkbook = $workbooks.Add()
  $excel.Calculation = -4135 # xlCalculationManual; requires an open workbook
  $excel.CalculateBeforeSave = $false
  $result = [ordered]@{ ok = $true; action = $Action; excelVersion = [string]$excel.Version; excelBuild = [string]$excel.Build; automationSecurity = 'ForceDisable'; sentinelExecuted = $false }

  if ($Action -eq 'probe') {
    $project = $null
    try {
      $project = Get-VbaProject $controlWorkbook
      $result['vbaProjectAccess'] = $true
    } catch {
      if ($_.Exception.Message -ne $trustReason) { throw }
      $result['vbaProjectAccess'] = $false
      $result['reason'] = $trustReason
    } finally { Release-Com $project }
  } else {
    $script:errorCode = 'INVALID_ARGUMENT'
    if (-not $InputPath) { Fail-Vba 'INVALID_ARGUMENT' 'InputPath is required.' }
    $inputFullPath = [System.IO.Path]::GetFullPath($InputPath)
    if (-not (Test-Path -LiteralPath $inputFullPath -PathType Leaf)) { Fail-Vba 'INVALID_ARGUMENT' 'Workbook not found.' }
    if ([System.IO.Path]::GetExtension($inputFullPath).ToLowerInvariant() -notin @('.xlsx', '.xlsm')) { Fail-Vba 'UNSUPPORTED_FEATURE' 'Only .xlsx and .xlsm sources are supported.' }
    $sourceHashBefore = (Get-FileHash -LiteralPath $inputFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or $sourceHashBefore -cne $ExpectedSha256) { Fail-Vba 'CONFLICT' 'Source changed before the VBA worker opened it.' }
    $script:errorCode = 'VALIDATION_FAILED'
    $workbook = $excel.Workbooks.Open($inputFullPath, 0, $true)
    Assert-SentinelNotExecuted $workbook
    $project = $null
    try {
      $project = Get-VbaProject $workbook
      if ($Action -eq 'list') {
        $script:errorCode = 'INVALID_ARGUMENT'
        if (-not (Test-Path -LiteralPath $OptionsPath -PathType Leaf)) { Fail-Vba 'INVALID_ARGUMENT' 'List options are missing.' }
        $options = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($OptionsPath), [System.Text.Encoding]::UTF8))
        if ($options.includeCode -isnot [bool] -or $options.maxCodeChars -lt 0 -or $options.maxCodeChars -gt 200000) { Fail-Vba 'INVALID_ARGUMENT' 'Invalid VBA list options.' }
        $script:errorCode = 'VALIDATION_FAILED'
        $result['project'] = Read-Project $project ([bool]$options.includeCode) $options.modules ([int]$options.maxCodeChars)
        $result['sourceSha256'] = $sourceHashBefore
      } else {
        $script:errorCode = 'INVALID_ARGUMENT'
        if ([int]$project.Protection -eq 1) { Fail-Vba 'UNSUPPORTED_FEATURE' 'Password-protected VBA projects cannot be edited.' }
        if (-not $OutputPath) { Fail-Vba 'INVALID_ARGUMENT' 'OutputPath is required.' }
        $outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
        if ([System.IO.Path]::GetExtension($outputFullPath).ToLowerInvariant() -ne '.xlsm' -or $outputFullPath -ieq $inputFullPath) { Fail-Vba 'INVALID_ARGUMENT' 'A distinct .xlsm staged output is required.' }
        if (Test-Path -LiteralPath $outputFullPath) { Fail-Vba 'OUTPUT_EXISTS' 'Refusing to overwrite staged output.' }
        $operations = @(Read-Operations)
        $before = Read-Project $project $false $null 0
        $storedCodeHashes = @{}
        $summaries = @(Apply-Operations $project $operations $storedCodeHashes)
        $script:errorCode = 'VALIDATION_FAILED'
        if ((Get-FileHash -LiteralPath $inputFullPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256) { Fail-Vba 'CONFLICT' 'Source changed before VBA save.' }
        if (Test-Path -LiteralPath $outputFullPath) { Fail-Vba 'OUTPUT_EXISTS' 'Staged output appeared before save.' }
        $workbook.SaveAs($outputFullPath, 52)
        $outputCreated = $true
        $result['before'] = $before
        $result['operations'] = @($summaries)
      }
    } finally { Release-Com $project }
    $script:errorCode = 'VALIDATION_FAILED'
    $workbook.Close($false)
    Release-Com $workbook
    $workbook = $null
    if ($Action -eq 'edit') {
      $excel.AutomationSecurity = 3
      $workbook = $excel.Workbooks.Open($outputFullPath, 0, $true)
      Assert-SentinelNotExecuted $workbook
      $project = $null
      try {
        $project = Get-VbaProject $workbook
        $editedNames = @($operations | Where-Object { $_.type -ne 'removeModule' } | ForEach-Object { [string]$_.name })
        $after = Read-Project $project ($editedNames.Count -gt 0) $editedNames 16777216
        Assert-ReadBack $before $after $operations $storedCodeHashes
        $result['after'] = $after
        foreach ($summary in $summaries) {
          foreach ($module in $after.modules) {
            if ($summary.name -ieq $module.name) { $summary['linesAfter'] = $module.lineCount }
          }
        }
      } finally { Release-Com $project }
      $workbook.Close($false)
      Release-Com $workbook
      $workbook = $null
      $result['outputPath'] = $outputFullPath
      $result['outputSha256'] = (Get-FileHash -LiteralPath $outputFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $sourceHashAfter = (Get-FileHash -LiteralPath $inputFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHashBefore -cne $sourceHashAfter) { Fail-Vba 'CONFLICT' 'VBA worker source hash changed.' }
    if ($Action -eq 'edit') { $result['sourceSha256Before'] = $sourceHashBefore; $result['sourceSha256After'] = $sourceHashAfter }
  }
  $success = $true
} catch {
  $exitCode = 3
  $result = [ordered]@{ ok = $false; action = $Action; code = $errorCode; error = $_.Exception.Message }
} finally {
  if ($null -ne $workbook) { try { $workbook.Close($false) } catch {}; Release-Com $workbook }
  if ($null -ne $controlWorkbook) { try { $controlWorkbook.Close($false) } catch {}; Release-Com $controlWorkbook }
  Release-Com $workbooks
  if ($null -ne $excel) {
    if ($ownedExcelInstance) {
      try { $excel.Interactive = $true } catch {}
      try { $excel.Quit() } catch {}
    }
    Release-Com $excel
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  if (-not $success -and $outputCreated) { Remove-Item -LiteralPath $outputFullPath -Force -ErrorAction SilentlyContinue }
}

$result | ConvertTo-Json -Depth 10 -Compress
exit $exitCode
