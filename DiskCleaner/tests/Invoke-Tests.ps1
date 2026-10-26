<#
.SYNOPSIS
    Runs the DiskCleaner test suites, each in its own PowerShell process.

.DESCRIPTION
    Engine  - deletion rules in a sandbox (no UI, no prompts).
    GUI     - drives the real window with an isolated profile. The mouse moves for about a
              minute; covered steps are reported as SKIP. Images go to %TEMP%\DiskCleanerTests.
    Admin   - opt-in; asks for UAC once (twice with -ElevateButton).
    No suite touches real user files, other apps' windows, or saved settings.

.EXAMPLE
    .\tests\Invoke-Tests.ps1
    Engine and GUI (light theme).

.EXAMPLE
    .\tests\Invoke-Tests.ps1 -Exe .\dist\DiskCleaner.exe
    Same suites against the built exe (build it first with build\Build-Exe.ps1).

.EXAMPLE
    .\tests\Invoke-Tests.ps1 -Theme Light, Dark -Admin -ElevateButton
    Everything, including the administrator checks and the "Restart as administrator" button.
#>
param(
    [switch]$SkipGui,
    [ValidateSet('Light', 'Dark')]
    [string[]]$Theme = 'Light',
    [switch]$Admin,
    [switch]$ElevateButton,
    [string]$Exe # run the Engine (command line), GUI and admin suites against DiskCleaner.exe
)
$exeArgs = if ($Exe) { @('-Exe', (Resolve-Path $Exe).Path) } else { @() }

$suites = [System.Collections.Generic.List[object]]::new()
$suites.Add(@{ Name = 'Engine'; Args = $exeArgs; File = 'Test-Engine.ps1' })
if (-not $SkipGui) { foreach ($t in $Theme) { $suites.Add(@{ Name = "GUI ($t)"; File = 'Test-Gui.ps1'; Args = @('-Theme', $t) + $exeArgs }) } }
if ($Admin -or $ElevateButton) { $suites.Add(@{ Name = 'Admin'; File = 'Test-Admin.ps1'; Args = @(if ($ElevateButton) { '-ElevateButton' }) + $exeArgs }) }

$failed = @()
foreach ($s in $suites) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $s.File) @($s.Args)
    if ($LASTEXITCODE) { $failed += $s.Name }
    Write-Host ''
}
if ($failed) { Write-Host "Failed suites: $($failed -join ', ')" -ForegroundColor Red; exit 1 }
Write-Host 'All suites passed.' -ForegroundColor Green
