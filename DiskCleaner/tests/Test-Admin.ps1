# Test-Admin.ps1 - administrator mode. Asks for UAC once; twice with -ElevateButton.
#   * Admin window: badge, no Restart button, no "Needs admin" rows.
#   * Admin dry run of every group (nothing is deleted).
#   * Windows Update / BITS are stopped only while files are deleted, then restored. Their state is
#     sampled every 20 ms (the System event log does not always record service changes). Only a
#     sandbox folder is cleaned; services started just for the test are stopped again.
param(
    [switch]$ElevateButton, # also test the app's "Restart as administrator" button
    [switch]$Elevated,      # internal: the elevated half
    [string]$ResultFile,    # internal: where the elevated half writes its results
    [int]$GuiPid,           # internal: elevated window opened by the Restart button
    [string]$Exe            # test DiskCleaner.exe instead of the script
)
. (Join-Path $PSScriptRoot 'Common.ps1')

function Get-ExistingGui([int]$ProcessId) {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    $byPid = [Windows.Automation.PropertyCondition]::new($UIA::ProcessIdProperty, $proc.Id)
    $win = Wait-Until { $UIA::RootElement.FindFirst($TreeScope::Children, $byPid) } 'the Disk Cleaner window'
    [void](Wait-Until { Find-Visible $win 'Scan finished*' } 'the first scan')
    [pscustomobject]@{ Process = $proc; Window = $win; Hwnd = [IntPtr]$win.Current.NativeWindowHandle }
}

if (-not $Elevated) {
    Write-Host 'Admin tests' -ForegroundColor Cyan
    $settingsStamp = Get-RealSettingsStamp
    if ($ElevateButton) {
        $gui = $null
        try {
            # Isolated profile: the Restart button saves settings before relaunching.
            $gui = Start-Gui (New-IsolatedProfile) -Exe $Exe
            [DiskCleanerTests.Win]::BringToFront($gui.Hwnd)
            Write-Host '  Clicking "Restart as administrator" - approve the UAC prompt.' -ForegroundColor Yellow
            Invoke-Element (Find-Visible $gui.Window 'Restart as administrator' $ControlType::Button)
            $new = Wait-Until { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $gui.Process.Id -and $_.MainWindowTitle -eq 'Disk Cleaner' } } 'the elevated window' 180
            Assert-True 'Restart button opens a new window' ([bool]$new) "pid $($new.Id)"
            Assert-True 'Restart button closes the old window' ($gui.Process.WaitForExit(10000))
            $GuiPid = $new.Id
        } catch {
            Add-Result 'Restart as administrator' FAIL $_.Exception.Message
            Stop-Gui $gui
        }
    }

    $ResultFile = Join-Path $TestRoot 'admin-results.json'
    Remove-Item $ResultFile -ErrorAction SilentlyContinue
    Write-Host '  Starting the elevated part - approve the UAC prompt.' -ForegroundColor Yellow
    try {
        Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList (
            "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated -ResultFile `"$ResultFile`" -GuiPid $GuiPid" + $(if ($Exe) { " -Exe `"$Exe`"" }))
    } catch {
        Add-Result 'Elevation' FAIL $_.Exception.Message
    }
    if (Test-Path $ResultFile) {
        # Windows PowerShell's ConvertFrom-Json emits a JSON array as one object; assign it, then enumerate.
        $elevatedResults = Get-Content $ResultFile -Raw | ConvertFrom-Json
        foreach ($r in $elevatedResults) { Add-Result $r.Test $r.Outcome $r.Detail }
    } elseif (-not ($Results | Where-Object Test -eq 'Elevation')) {
        Add-Result 'Elevated part' FAIL 'no results were written'
    }
    Assert-True "User's real settings were not touched" ((Get-RealSettingsStamp) -eq $settingsStamp)
    Remove-TestDirectory (Join-Path $TestRoot 'profile')
    exit (Complete-Test 'Admin')
}

# ---- Elevated half ----------------------------------------------------------------
Assert-True 'Running as administrator' (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators'))

# 1. Admin window (reuse the one opened by the Restart button, if any)
$gui = $null
try {
    $gui = if ($GuiPid) { Get-ExistingGui $GuiPid }
    if (-not $gui) { $gui = Start-Gui -Exe $Exe }
    $win = $gui.Window
    Assert-True 'Window shows the Administrator badge' ([bool](Find-Visible $win 'Administrator' $ControlType::Text))
    $restart = @($win.FindAll($TreeScope::Descendants, [Windows.Automation.PropertyCondition]::new($UIA::NameProperty, 'Restart as administrator')))
    Assert-True 'Restart button is removed, also for screen readers' ($restart.Count -eq 0)
    $needsAdmin = @($win.FindAll($TreeScope::Descendants, [Windows.Automation.PropertyCondition]::new($UIA::NameProperty, 'Needs admin')))
    Assert-True 'No category is marked "Needs admin"' ($needsAdmin.Count -eq 0) "found $($needsAdmin.Count)"
    Save-WindowImage $gui (Join-Path $TestRoot 'admin-window.png')
} catch {
    Add-Result 'Admin window' FAIL $_.Exception.Message
} finally {
    Stop-Gui $gui
}

# 2. Admin dry run of every group
try {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot 'DiskCleaner.ps1') -AiApps -DevCaches -Deep 2>&1 | Out-String
    Assert-True 'CLI runs elevated' ($out -match 'admin: True')
    Assert-True 'CLI scans system categories' ($out -match 'WindowsTemp\s+Core' -and $out -notmatch 'needs admin')
    Assert-True 'CLI dry run deletes nothing' ($out -match 'Dry run only')
    if ($Exe) {
        # Same dry run through the command line embedded in the exe (output redirected to a file).
        $exeOut = Join-Path $TestRoot 'admin-exe-out.txt'
        $p = Start-Process $Exe -ArgumentList '--cli -AiApps -DevCaches -Deep' -Wait -PassThru -NoNewWindow -RedirectStandardOutput $exeOut
        $text = Get-Content $exeOut -Raw
        Remove-Item $exeOut -ErrorAction SilentlyContinue
        Assert-True 'Exe CLI runs elevated' ($text -match 'admin: True')
        Assert-True 'Exe CLI scans system categories' ($text -match 'WindowsTemp\s+Core' -and $text -notmatch 'needs admin')
        Assert-True 'Exe CLI dry run exits 0 and deletes nothing' ($p.ExitCode -eq 0 -and $text -match 'Dry run only') "exit $($p.ExitCode)"
    }
} catch {
    Add-Result 'Admin dry run' FAIL $_.Exception.Message
}

# 3. Services around deletion
$services = 'wuauserv', 'bits'
$sandbox = Join-Path $TestRoot 'service-sandbox'
$startedForTest = @()
try {
    . (Join-Path $ProjectRoot 'DiskCleaner.Core.ps1')
    Remove-TestDirectory $sandbox
    foreach ($i in 1..3) { New-TestFile "$sandbox\old$i.bin" 4096 10 }
    $initial = @{}; foreach ($n in $services) { $initial[$n] = [string](Get-Service $n).Status }
    # The cleaner only stops services that are running; start them so that path is exercised.
    $startedForTest = @($services | Where-Object { $initial[$_] -ne 'Running' })
    foreach ($n in $startedForTest) { Start-Service $n }

    $sync = [hashtable]::Synchronized(@{ Run = $true; Log = [Collections.ArrayList]::Synchronized([Collections.ArrayList]::new()) })
    $monitor = [PowerShell]::Create()
    [void]$monitor.AddScript({
        param($Sync, $Names)
        $controllers = $Names | ForEach-Object { [System.ServiceProcess.ServiceController]::new($_) }
        $last = @{}
        while ($Sync.Run) {
            foreach ($c in $controllers) {
                $c.Refresh()
                $s = [string]$c.Status
                if ($last[$c.ServiceName] -ne $s) { $last[$c.ServiceName] = $s; [void]$Sync.Log.Add("$($c.ServiceName) $s") }
            }
            Start-Sleep -Milliseconds 20
        }
    }).AddArgument($sync).AddArgument($services)
    $handle = $monitor.BeginInvoke()
    Start-Sleep -Seconds 1

    $cat = New-Category ServiceTest Core @($sandbox) 'service test' -Services $services
    $targets = New-TargetList -Categories @($cat) -IsAdmin $true -CutoffUtc ([DateTime]::UtcNow.AddDays(-1))
    $progress = [hashtable]::Synchronized(@{})
    [void]$sync.Log.Add('START')
    [void](Invoke-Clean -Targets $targets.ToArray() -Categories @($cat) -Threads 4 -Progress $progress)
    [void]$sync.Log.Add('END')
    Start-Sleep -Milliseconds 500
    $sync.Run = $false
    [void]$monitor.EndInvoke($handle)

    $log = @($sync.Log)
    $start = [array]::IndexOf($log, 'START'); $end = [array]::IndexOf($log, 'END')
    foreach ($n in $services) {
        $stopped = [array]::IndexOf($log, "$n Stopped", $start)
        $running = if ($stopped -ge 0) { [array]::IndexOf($log, "$n Running", $stopped) } else { -1 }
        Assert-True "$n is stopped during deletion and running again before the clean returns" (
            $stopped -gt $start -and $running -gt $stopped -and $running -lt $end) ($log -join ' > ')
    }
    Assert-True 'Sandbox files deleted while services were stopped' ($targets[0].Files -eq 3) "deleted $($targets[0].Files) of 3"
    Assert-True 'Progress ends after "Restarting services"' ($progress.Phase -eq 'Done')
} catch {
    Add-Result 'Service handling' FAIL $_.Exception.Message
} finally {
    foreach ($n in $startedForTest) { Stop-Service $n -Force -ErrorAction SilentlyContinue }
    Remove-TestDirectory $sandbox
}
if ($initial) {
    $changed = @($services | Where-Object { [string](Get-Service $_).Status -ne $initial[$_] })
    Assert-True 'Services are back in their original state' ($changed.Count -eq 0) (($services | ForEach-Object { "$_=$((Get-Service $_).Status)" }) -join ', ')
}

$Results | ConvertTo-Json | Set-Content $ResultFile -Encoding UTF8
