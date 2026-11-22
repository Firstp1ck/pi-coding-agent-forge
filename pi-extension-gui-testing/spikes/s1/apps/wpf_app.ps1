# S1 sample app (WPF, hosted by Windows PowerShell 5.1): a label over a large
# "Press me" button. The click sets the label to "Pressed" and writes the
# S1_MARKER file when that variable is set. WPF renders with the GPU unless
# hardware acceleration is turned off per user; S1 measures what that means
# for screenshots on a private desktop.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$window = New-Object System.Windows.Window
$window.Title = 'S1 WPF'
$window.WindowStartupLocation = 'Manual'
$window.Left = 80
$window.Top = 80
$window.Width = 480
$window.Height = 320
$grid = New-Object System.Windows.Controls.Grid
$top = New-Object System.Windows.Controls.RowDefinition
$top.Height = New-Object System.Windows.GridLength(1, 'Star')
$bottom = New-Object System.Windows.Controls.RowDefinition
$bottom.Height = New-Object System.Windows.GridLength(3, 'Star')
$grid.RowDefinitions.Add($top)
$grid.RowDefinitions.Add($bottom)
$label = New-Object System.Windows.Controls.Label
$label.Content = 'Not pressed'
$label.HorizontalContentAlignment = 'Center'
$label.VerticalContentAlignment = 'Center'
[System.Windows.Controls.Grid]::SetRow($label, 0)
$button = New-Object System.Windows.Controls.Button
$button.Content = 'Press me'
[System.Windows.Controls.Grid]::SetRow($button, 1)
$button.Add_Click({
    $label.Content = 'Pressed'
    if ($env:S1_MARKER) { [System.IO.File]::WriteAllText($env:S1_MARKER, "pressed`n") }
})
$grid.Children.Add($label) | Out-Null
$grid.Children.Add($button) | Out-Null
$window.Content = $grid
$app = New-Object System.Windows.Application
$app.Run($window) | Out-Null
