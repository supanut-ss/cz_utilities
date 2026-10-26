#Requires -Version 5.1
<#
.SYNOPSIS
    Fast, safe junk-file cleaner for Windows 10/11 (command line).

.DESCRIPTION
    Finds junk in well-known locations (temp folders, browser/app caches, crash
    dumps, Windows Update downloads, ...) and reports how much space can be
    reclaimed. Nothing is deleted unless -Execute is given.
    For a window with checkboxes, run DiskCleanerGui.ps1 (or DiskCleanerGui.cmd).

    Performance: the directory walk and the deletes run in a compiled C# engine
    (DiskCleaner.Core.ps1) with a shared work-stealing queue, so every thread
    stays busy even when one folder holds most of the files. Files are deleted
    while walking, so memory stays flat no matter how many files there are.

    Safety:
      * Dry run by default; -Execute asks for confirmation unless -Force.
      * Never follows or deletes reparse points (junctions, symlinks).
      * Only deletes files whose creation AND last-write time are older than
        -MinAgeDays; files in use are skipped.
      * Target root folders are kept; only their contents are removed.
      * Admin-only locations are skipped when the shell is not elevated.
      * Never touches %windir%\Installer, WinSxS files, or personal folders.

.PARAMETER Execute
    Delete the junk. Without it the script only scans and reports.

.PARAMETER Force
    Skip the confirmation prompt and the separate scan pass (single pass).

.PARAMETER AiApps
    Also clean caches and old logs of AI apps (Claude, ChatGPT/Codex, Cursor, Copilot, ...)
    and other Electron/WebView apps. Close those apps first. AI models are never deleted;
    their size is reported under "Manual options".

.PARAMETER DevCaches
    Also clean developer package caches (npm, Yarn, pip, NuGet, Gradle, Go, Cargo).

.PARAMETER Deep
    Also empty the Recycle Bin, run DISM component store cleanup, and remove Windows upgrade
    leftovers and Windows.old (admin). Upgrade leftovers and Windows.old are removed through
    Windows' own Disk Cleanup, and skipped while an update is waiting for a restart.
    After Windows.old is removed you can no longer go back to the previous Windows version.

.PARAMETER MinAgeDays
    Only delete files not created or modified for this many days. Default 1.

.PARAMETER Only
    Restrict the run to these category names (see the report for names).

.PARAMETER ExtraPath
    Extra folders or drives to search for temp and junk files (category "Custom"): files in
    Temp-like folders, *.tmp, crash dumps, thumbnail/shader caches, abandoned partial
    downloads, ... Ordinary files are never touched. Junk is moved to the Recycle Bin, so it
    can be restored; files the Recycle Bin cannot take (too large, path too long, drive
    without a Recycle Bin) are left in place. A whole non-system drive is allowed (e.g.
    -ExtraPath D:\). Write the trailing backslash, or a bare "D:" may resolve to a different
    folder (Windows treats it as that drive's last working directory, not its root).

.PARAMETER PermanentDelete
    Delete -ExtraPath files permanently instead of moving them to the Recycle Bin.

.PARAMETER Threads
    Degree of parallelism. Use 1-2 on spinning hard disks.

.PARAMETER LogPath
    Append a transcript of the run to this file.

.EXAMPLE
    .\DiskCleaner.ps1
    Scan only and show how much space each category would free.

.EXAMPLE
    .\DiskCleaner.ps1 -Execute
    Clean the default categories after a confirmation prompt.

.EXAMPLE
    .\DiskCleaner.ps1 -AiApps
    Show how much the AI and other desktop apps' caches would free.

.EXAMPLE
    .\DiskCleaner.ps1 -Execute -Force -DevCaches -Deep -LogPath .\clean.log
    Clean everything in one pass without prompting (run as Administrator).

.EXAMPLE
    .\DiskCleaner.ps1 -Only Custom -ExtraPath D:\
    Show temp and junk files anywhere on the D: drive.

.EXAMPLE
    .\DiskCleaner.ps1 -Only Custom -ExtraPath $HOME\Downloads -MinAgeDays 30
    Show temp and junk files in Downloads that are older than 30 days.
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$Force,
    [switch]$AiApps,
    [switch]$DevCaches,
    [switch]$Deep,
    [ValidateRange(0, 3650)]
    [int]$MinAgeDays = 1,
    [string[]]$Only,
    [string[]]$ExtraPath,
    [switch]$PermanentDelete,
    [ValidateRange(1, 64)]
    [int]$Threads = [Math]::Min([Environment]::ProcessorCount, 8),
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'
# DiskCleaner.exe --cli runs this script from memory and passes the core as text ($DiskCleanerCoreText).
if ($DiskCleanerCoreText) { . ([scriptblock]::Create($DiskCleanerCoreText)) }
else { . (Join-Path $PSScriptRoot 'DiskCleaner.Core.ps1') }

# "powershell -File" passes "-Only a,b" as one string; accept both forms.
if ($Only) { $Only = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

function Show-Report([object[]]$Rows, [string]$SizeLabel) {
    $Rows | Sort-Object Bytes -Descending | Format-Table -AutoSize Category, Group,
        @{ n = 'Files'; e = { '{0:N0}' -f $_.Files }; a = 'Right' },
        @{ n = $SizeLabel; e = { Format-Size $_.Bytes }; a = 'Right' },
        @{ n = 'Skipped'; e = { '{0:N0}' -f $_.Skipped }; a = 'Right' },
        Status | Out-Host
}

function Show-Hints {
    $hints = @(Get-SpaceHint)
    if ($hints) {
        Write-Host "`nManual options (not run by this script):" -ForegroundColor Yellow
        foreach ($h in $hints) { Write-Host "  - $h" }
    }
}

$isAdmin = Test-IsAdmin
$cutoff = [DateTime]::UtcNow.AddDays(-$MinAgeDays)
if ($LogPath) { Start-Transcript -Path $LogPath -Append | Out-Null }

try {
    $Categories = @(Get-CleanerCategory)
    if ($ExtraPath) {
        $resolved = @(foreach ($p in $ExtraPath) {
            $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p)
            if (Test-CustomRoot $full) { $full } else { Write-Warning "Refusing protected path: $full" }
        })
        if ($resolved) { $Categories += New-Category Custom Custom $resolved 'Folders from -ExtraPath' -Recycle (-not $PermanentDelete) }
    }

    if ($Only) {
        $unknown = @($Only | Where-Object { $_ -notin $Categories.Name })
        if ($unknown) { Write-Warning "Unknown category: $($unknown -join ', ')" }
    }
    $selected = @($Categories | Where-Object {
        if ($_.Group -eq 'Custom') { return $true }
        if ($Only) { return $_.Name -in $Only }
        $_.Group -eq 'Core' -or ($_.Group -eq 'AI' -and $AiApps) -or ($_.Group -eq 'Dev' -and $DevCaches) -or ($_.Group -eq 'Deep' -and $Deep)
    })

    $targets = New-TargetList -Categories $selected -IsAdmin $isAdmin -CutoffUtc $cutoff
    $needAdmin = @($selected | Where-Object { $_.Status -eq 'needs admin' })
    $ready = @($selected | Where-Object { -not $_.Skip })
    $cmdCats = @($ready | Where-Object { $_.CleanCmd })
    # File targets of every command-based category (also skipped ones) are only measured, never deleted.
    $cmdNames = @($selected | Where-Object { $_.CleanCmd } | ForEach-Object { $_.Name })
    $fileTargets = [DiskCleaner.Target[]]@($targets | Where-Object { $_.Category -notin $cmdNames })
    $sw = [Diagnostics.Stopwatch]::StartNew()

    # Scan pass (skipped with -Execute -Force: the delete pass reports what it freed).
    if (-not ($Execute -and $Force)) {
        Wait-Engine ([DiskCleaner.Engine]::Start($targets.ToArray(), $Threads, $false)) 'Scanning'
        $rows = @(Get-Report $selected $targets)
        Write-Host ("`nScanned in {0:N1}s | threads: {1} | admin: {2} | files older than {3} day(s)" -f
            $sw.Elapsed.TotalSeconds, $Threads, $isAdmin, $MinAgeDays)
        Show-Report $rows 'Size'
        $total = [long](($rows | Measure-Object -Property Bytes -Sum).Sum)
        Write-Host "Reclaimable: $(Format-Size $total)" -ForegroundColor Green
        if ($needAdmin) { Write-Host "Run as Administrator to include: $($needAdmin.Name -join ', ')" -ForegroundColor Yellow }

        if (-not $Execute) {
            Show-Hints
            Write-Host "`nDry run only - nothing was deleted. Re-run with -Execute to clean." -ForegroundColor Cyan
            return
        }
        if ($total -le 0 -and -not $cmdCats) { Write-Host 'Nothing to clean.'; return }
        $question = if ($ready | Where-Object Recycle) {
            "Clean about $(Format-Size $total)? Custom folders go to the Recycle Bin; everything else is deleted permanently."
        } else { "Permanently delete about $(Format-Size $total)?" }
        # "No" is the default: pressing Enter alone, or closed input, must never delete anything.
        $choices = [System.Management.Automation.Host.ChoiceDescription[]]@('&Yes', '&No')
        if ($Host.UI.PromptForChoice('DiskCleaner', $question, $choices, 1) -ne 0) { return }
    }

    $freeBefore = Get-FreeBytes
    $sw.Restart()
    $cmdStatus = Invoke-Clean -Targets $fileTargets -Categories $ready -Threads $Threads
    foreach ($c in $cmdCats) { $c.Status = $cmdStatus[$c.Name] }

    $gained = [Math]::Max([long]0, (Get-FreeBytes) - $freeBefore) # other apps keep writing meanwhile
    $done = @(Get-Report $selected $fileTargets)
    Write-Host ("`nCleaned in {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    Show-Report $done 'Cleaned'
    Write-Host "Free space gained (all fixed drives): $(Format-Size $gained)" -ForegroundColor Green
    $recycled = [long](($done | Where-Object Recycle | Measure-Object -Property Bytes -Sum).Sum)
    if ($recycled) {
        Write-Host "Moved to the Recycle Bin: $(Format-Size $recycled) - restore from there if needed; empty it to free the space." -ForegroundColor Cyan
    }
    if ($needAdmin) { Write-Host "Run as Administrator to include: $($needAdmin.Name -join ', ')" -ForegroundColor Yellow }
    Show-Hints
} finally {
    if ($LogPath) { Stop-Transcript | Out-Null }
}
