# S1 sample app (WinForms, hosted by Windows PowerShell 5.1): a label over a
# large "Press me" button. The click sets the label to "Pressed" and writes the
# S1_MARKER file when that variable is set.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'S1 WinForms'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(80, 80)
$form.Size = New-Object System.Drawing.Size(480, 320)
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Press me'
$button.Dock = 'Fill'
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Not pressed'
$label.Dock = 'Top'
$label.Height = 70
$label.TextAlign = 'MiddleCenter'
$button.Add_Click({
    $label.Text = 'Pressed'
    if ($env:S1_MARKER) { [System.IO.File]::WriteAllText($env:S1_MARKER, "pressed`n") }
})
$form.Controls.Add($button)
$form.Controls.Add($label)
[System.Windows.Forms.Application]::Run($form)
