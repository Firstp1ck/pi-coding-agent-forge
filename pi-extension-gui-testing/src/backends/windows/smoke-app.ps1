# WinForms smoke-test app for local-windows (spec 5.5): window "Pi GUI smoke",
# label "Waiting", button "Press me". Clicking the button sets the label to
# "Pressed". Run with Windows PowerShell 5.1:
#
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File smoke-app.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Pi GUI smoke'
$form.ClientSize = New-Object System.Drawing.Size(320, 160)
$form.StartPosition = 'CenterScreen'

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Waiting'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(24, 24)

$button = New-Object System.Windows.Forms.Button
$button.Text = 'Press me'
$button.AutoSize = $true
$button.Location = New-Object System.Drawing.Point(24, 80)
$button.Add_Click({ $label.Text = 'Pressed' })

$form.Controls.Add($label)
$form.Controls.Add($button)
[System.Windows.Forms.Application]::Run($form)
