# Test-Engine.ps1 - deletion rules of the engine, through the CLI and the GUI's background path.
# Works only inside a sandbox under %TEMP%\DiskCleanerTests; no real files are touched.
param([string]$Exe) # -Exe: also test the command line embedded in DiskCleaner.exe
. (Join-Path $PSScriptRoot 'Common.ps1')

# Sandboxes are folders named Temp: a user-added folder is searched for junk only, and a root that is itself a junk folder is all junk.
$base = Join-Path $TestRoot 'sandbox\Temp'
$outside = Join-Path $TestRoot 'outside'
$long = "$base\" + (('x' * 50 + '\') * 6) + 'old-long-path.txt'
$recycle = Join-Path $TestRoot 'recycle-sandbox\Temp'
$recycleLong = "$recycle\" + (('y' * 50 + '\') * 6) + 'old-long-path.txt'

function New-Sandbox {
    Remove-TestDirectory (Split-Path $base)
    Remove-TestDirectory $outside
    New-TestFile "$base\old.txt" 1000 10
    New-TestFile "$base\new.txt" 1000
    New-TestFile "$base\sub\old.bin" 1048576 10
    New-TestFile "$base\sub\deep\old.bin" 2000 10
    New-TestFile "$base\mixed\new.txt" 10
    New-TestFile "$base\readonly.txt" 500 10
    Set-ItemProperty "$base\readonly.txt" IsReadOnly $true
    New-TestFile "$base\locked.txt" 700 10
    New-TestFile "$outside\keep.txt" 300 10
    New-TestFile $long 400 10
    cmd /c mklink /J "$base\link-outside" "$outside" | Out-Null
    [void][IO.Directory]::CreateDirectory("$base\empty-old")
    [void][IO.Directory]::CreateDirectory("$base\empty-new")
    foreach ($d in @("$base\empty-old", "$base\sub\deep", "$base\sub", "$base\mixed") +
                   @([IO.Directory]::EnumerateDirectories('\\?\' + $base, 'xxxx*', 'AllDirectories'))) { Set-DirectoryAge $d 10 }
}

function Test-Sandbox([string]$Via) {
    Assert-True "$Via keeps the target folder"            (Test-Path $base)
    Assert-True "$Via deletes old files"                  (-not (Test-Path "$base\old.txt"))
    Assert-True "$Via keeps new files"                    (Test-Path "$base\new.txt")
    Assert-True "$Via deletes read-only old files"        (-not (Test-Path "$base\readonly.txt"))
    Assert-True "$Via skips files in use"                 (Test-Path "$base\locked.txt")
    Assert-True "$Via removes emptied old folders"        (-not (Test-Path "$base\sub"))
    Assert-True "$Via keeps folders with new files"       (Test-Path "$base\mixed\new.txt")
    Assert-True "$Via removes old empty folders"          (-not (Test-Path "$base\empty-old"))
    Assert-True "$Via keeps new empty folders"            (Test-Path "$base\empty-new")
    Assert-True "$Via handles paths over 260 characters"  (-not [IO.File]::Exists('\\?\' + $long))
    Assert-True "$Via keeps junctions"                    (Test-Path "$base\link-outside")
    Assert-True "$Via never follows junctions"            (Test-Path "$outside\keep.txt")
}

Write-Host 'Engine tests' -ForegroundColor Cyan
$cli = Join-Path $ProjectRoot 'DiskCleaner.ps1'
try {
    # Dry run must not delete anything.
    New-Sandbox
    $dry = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli -Only Custom -ExtraPath $base 2>&1 | Out-String
    Assert-True 'CLI dry run reports the 6 old files' ($dry -match 'Custom\s+Custom\s+6\s') ($dry -split "`n" | Select-String 'Custom\s+Custom' | Select-Object -First 1)
    Assert-True 'CLI dry run deletes nothing' ((Test-Path "$base\old.txt") -and [IO.File]::Exists('\\?\' + $long))

    # "-Only a,b" through "powershell -File" arrives as one string.
    $multi = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli -Only 'Custom,npm' -ExtraPath $base 2>&1 | Out-String
    Assert-True 'CLI accepts -Only a,b via -File' ($multi -notmatch 'Unknown category')

    # CLI execute with permanent deletion, with one file held open.
    $lock = [IO.File]::Open("$base\locked.txt", 'Open', 'Read', 'None')
    try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli -Only Custom -ExtraPath $base -Execute -Force -PermanentDelete *> $null }
    finally { $lock.Dispose() }
    Test-Sandbox 'CLI'
    Assert-True 'CLI -PermanentDelete puts nothing in the Recycle Bin' (@(Get-RecycledTestItem $base).Count -eq 0)

    # Background runspace path used by the GUI.
    New-Sandbox
    . (Join-Path $ProjectRoot 'DiskCleaner.Core.ps1')
    $cat = New-Category sandbox Custom @($base) $base
    $targets = New-TargetList -Categories @($cat) -IsAdmin $false -CutoffUtc ([DateTime]::UtcNow.AddDays(-1))
    $lock = [IO.File]::Open("$base\locked.txt", 'Open', 'Read', 'None')
    try {
        $bg = Start-BackgroundClean -Targets $targets.ToArray() -Categories @($cat) -Threads 4
        while (-not $bg.Handle.IsCompleted) { Start-Sleep -Milliseconds 50 }
        [void]$bg.PS.EndInvoke($bg.Handle)
        Assert-True 'Background clean reports 5 deleted, 1 in use' ($targets[0].Files -eq 5 -and $targets[0].Skipped -eq 1) "deleted=$($targets[0].Files) skipped=$($targets[0].Skipped)"
    } finally { $lock.Dispose() }
    Test-Sandbox 'Background'

    # Recycle Bin mode (default for -ExtraPath): restorable, and what the bin cannot take stays put.
    Remove-TestDirectory $recycle
    New-TestFile "$recycle\old.txt" 1000 10
    New-TestFile "$recycle\new.txt" 1000
    New-TestFile "$recycle\readonly.txt" 500 10
    Set-ItemProperty "$recycle\readonly.txt" IsReadOnly $true
    New-TestFile "$recycle\locked.txt" 700 10
    New-TestFile $recycleLong 400 10
    $lock = [IO.File]::Open("$recycle\locked.txt", 'Open', 'Read', 'None')
    try { $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli -Only Custom -ExtraPath $recycle -Execute -Force 2>&1 | Out-String }
    finally { $lock.Dispose() }
    $inBin = @(Get-RecycledTestItem $recycle | ForEach-Object { [IO.Path]::GetFileName($_.OriginalPath) } | Sort-Object)
    Assert-True 'Recycle: old files go to the Recycle Bin'      (($inBin -join ',') -eq 'old.txt,readonly.txt') ($inBin -join ', ')
    Assert-True 'Recycle: old files are gone from the folder'   (-not (Test-Path "$recycle\old.txt") -and -not (Test-Path "$recycle\readonly.txt"))
    Assert-True 'Recycle: new files stay'                       (Test-Path "$recycle\new.txt")
    Assert-True 'Recycle: files in use stay'                    (Test-Path "$recycle\locked.txt")
    Assert-True 'Recycle: paths too long for the bin stay'      ([IO.File]::Exists('\\?\' + $recycleLong))
    Assert-True 'Recycle: CLI reports what went to the bin'     ($out -match 'Moved to the Recycle Bin')

    # Files larger than the bin accepts are kept, never deleted for good.
    Remove-RecycledTestItem $recycle
    New-TestFile "$recycle\small.bin" 1000 10
    New-TestFile "$recycle\large.bin" (2MB) 10
    $cat = New-Category recycle Custom @($recycle) $recycle -Recycle $true
    $targets = New-TargetList -Categories @($cat) -IsAdmin $false -CutoffUtc ([DateTime]::UtcNow.AddDays(-1))
    Assert-True 'Recycle: bin size limit is read for a local drive' ($targets[0].RecycleMaxBytes -gt 0) (Format-Size $targets[0].RecycleMaxBytes)
    $targets[0].RecycleMaxBytes = 1MB
    $bg = Start-BackgroundClean -Targets $targets.ToArray() -Categories @($cat) -Threads 2
    while (-not $bg.Handle.IsCompleted) { Start-Sleep -Milliseconds 50 }
    [void]$bg.PS.EndInvoke($bg.Handle)
    Assert-True 'Recycle: files over the bin limit stay'       ((Test-Path "$recycle\large.bin") -and -not (Test-Path "$recycle\small.bin"))
    Assert-True 'Recycle: kept files are counted'              ($targets[0].NotRecycled -ge 2) "not recycled=$($targets[0].NotRecycled)"
    Assert-True 'Recycle: no usable bin on a network path'     ((Get-RecycleBinLimit '\\localhost\c$\Windows') -eq 0)

    # Emptying the Recycle Bin runs before files are moved into it; other commands run after.
    New-TestFile "$recycle\probe.txt" 100 10
    $before = Join-Path $TestRoot 'run-first.txt'; $after = Join-Path $TestRoot 'run-after.txt'
    $first = New-Category RunFirst Deep @() 'probe' -RunFirst $true -CleanCmd ([scriptblock]::Create("Set-Content -LiteralPath '$before' -Value (Test-Path -LiteralPath '$recycle\probe.txt')"))
    $last = New-Category RunAfter Deep @() 'probe' -CleanCmd ([scriptblock]::Create("Set-Content -LiteralPath '$after' -Value (Test-Path -LiteralPath '$recycle\probe.txt')"))
    $files = New-Category files Custom @($recycle) $recycle
    $targets = New-TargetList -Categories @($files) -IsAdmin $false -CutoffUtc ([DateTime]::UtcNow.AddDays(-1))
    [void](Invoke-Clean -Targets $targets.ToArray() -Categories @($first, $files, $last) -Threads 2 *>&1)
    Assert-True 'RunFirst command runs before files are cleaned' ((Get-Content $before) -eq 'True')
    Assert-True 'Other commands run after files are cleaned'     ((Get-Content $after) -eq 'False')

    # The command line embedded in DiskCleaner.exe (--cli), through redirected output.
    if ($Exe) {
        function Invoke-ExeCli([string]$Arguments, [string]$Stdin) {
            $out = Join-Path $TestRoot 'exe-out.txt'; $err = Join-Path $TestRoot 'exe-err.txt'
            $params = @{ FilePath = $Exe; ArgumentList = $Arguments; Wait = $true; PassThru = $true; NoNewWindow = $true
                         RedirectStandardOutput = $out; RedirectStandardError = $err }
            if ($null -ne $Stdin) { $in = Join-Path $TestRoot 'exe-in.txt'; Set-Content $in $Stdin; $params.RedirectStandardInput = $in }
            $p = Start-Process @params
            [pscustomobject]@{ Code = $p.ExitCode; Out = (Get-Content $out -Raw); Err = (Get-Content $err -Raw) }
        }
        $q = "`"$base`""

        $help = Invoke-ExeCli '--help'
        Assert-True 'Exe: --help prints usage and exits 0' ($help.Code -eq 0 -and $help.Out -match '--cli \[options\]')

        New-Sandbox
        $dry = Invoke-ExeCli "--cli -Only Custom -ExtraPath $q"
        Assert-True 'Exe CLI: dry run reports the 6 old files' ($dry.Code -eq 0 -and $dry.Out -match 'Custom\s+Custom\s+6\s') ($dry.Out -split "`n" | Select-String 'Custom\s+Custom' | Select-Object -First 1)
        Assert-True 'Exe CLI: dry run deletes nothing' ((Test-Path "$base\old.txt") -and [IO.File]::Exists('\\?\' + $long))
        Assert-True 'Exe CLI: output has no mangled lines' ($dry.Out -match 'Dry run only')

        $multi = Invoke-ExeCli "--cli -Only Custom,npm -ExtraPath $q"
        Assert-True 'Exe CLI: -Only a,b is accepted' ($multi.Out -notmatch 'Unknown category' -and $multi.Code -eq 0)

        $no = Invoke-ExeCli "--cli -Only Custom -ExtraPath $q -Execute -PermanentDelete" 'n'
        Assert-True 'Exe CLI: answering n at the prompt deletes nothing' ((Test-Path "$base\old.txt") -and $no.Out -match 'Permanently delete|Clean about')
        $eof = Invoke-ExeCli "--cli -Only Custom -ExtraPath $q -Execute -PermanentDelete" ''
        Assert-True 'Exe CLI: empty input counts as No' (Test-Path "$base\old.txt")

        $lock = [IO.File]::Open("$base\locked.txt", 'Open', 'Read', 'None')
        try { $yes = Invoke-ExeCli "--cli -Only Custom -ExtraPath $q -Execute -PermanentDelete" 'y' } finally { $lock.Dispose() }
        Test-Sandbox 'Exe CLI'
        Assert-True 'Exe CLI: exit code 0 after cleaning' ($yes.Code -eq 0) "exit $($yes.Code)"

        # Recycle Bin is the default for -ExtraPath, with a transcript written by -LogPath.
        Remove-RecycledTestItem $recycle # items left by the tests above
        Remove-TestDirectory $recycle
        New-TestFile "$recycle\old.txt" 1000 10
        New-TestFile "$recycle\new.txt" 1000
        $logFile = Join-Path $TestRoot 'exe-transcript.log'; Remove-Item $logFile -ErrorAction SilentlyContinue
        $rec = Invoke-ExeCli "--cli -Only Custom -ExtraPath `"$recycle`" -Execute -Force -LogPath `"$logFile`""
        $inBin = @(Get-RecycledTestItem $recycle | ForEach-Object { [IO.Path]::GetFileName($_.OriginalPath) })
        Assert-True 'Exe CLI: -ExtraPath goes to the Recycle Bin by default' (($inBin -join ',') -eq 'old.txt' -and (Test-Path "$recycle\new.txt")) ($inBin -join ', ')
        Assert-True 'Exe CLI: reports the Recycle Bin move' ($rec.Out -match 'Moved to the Recycle Bin')
        Assert-True 'Exe CLI: -LogPath writes a transcript' ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 0))

        $bad = Invoke-ExeCli '--cli -MinAgeDays abc'
        Assert-True 'Exe CLI: a bad value gives exit code 1 and a message' ($bad.Code -eq 1 -and $bad.Err -match 'MinAgeDays')
    }

    # Whole-drive scanning ("Add drive" in the GUI, or -ExtraPath D:\ on the CLI). A bare drive
    # letter ("D:") is drive-relative in Windows - it resolves to that drive's *last working
    # directory*, not its root - so every function that turns a category root into a real path
    # must treat "D:" like "D:\" regardless of what a leftover "cd D:\Somewhere" left behind.
    $otherDrive = [IO.DriveInfo]::GetDrives() |
        Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady -and $_.Name.TrimEnd('\') -ne $env:SystemDrive.TrimEnd('\') } |
        Select-Object -First 1
    if (-not $otherDrive) {
        Add-Result 'Whole-drive scan' SKIP 'no non-system fixed drive on this machine'
    } else {
        $driveRoot = $otherDrive.Name.TrimEnd('\') # e.g. "D:"
        $trap = "$driveRoot\DiskCleanerTests-cwd-trap"
        $marker = "$driveRoot\DiskCleanerTests-root-probe-$(Get-Random).tmp"
        $savedCwd = [Environment]::CurrentDirectory
        try {
            [void][IO.Directory]::CreateDirectory($trap)
            New-TestFile $marker 10 10
            [Environment]::CurrentDirectory = $trap # simulate a leftover "cd D:\Somewhere" from the launching shell

            # A dry-run, non-recursive scan of the bare root, filtered to just this marker: if "D:"
            # resolved to anywhere but the true root, this specific file would never be seen.
            $probe = [DiskCleaner.Target]::new()
            $probe.Category = 'probe'; $probe.Root = $driveRoot; $probe.Recurse = $false
            $probe.Filter = [IO.Path]::GetFileName($marker)
            $probe.CutoffUtc = [DateTime]::UtcNow.AddDays(-1)
            [DiskCleaner.Engine]::Start(@($probe), 2, $false).Wait()
            Assert-True 'Whole-drive: a bare drive letter resolves to the true root, not a leftover CWD' `
                ($probe.Files -eq 1 -and $probe.Bytes -eq 10) "found=$($probe.Files) bytes=$($probe.Bytes)"
            Assert-True 'Whole-drive: Test-SafeRoot treats "D:" the same as "D:\" under the CWD trap' `
                ((Test-SafeRoot $driveRoot) -eq (Test-SafeRoot "$driveRoot\"))
            Assert-True 'Whole-drive: Get-RecycleBinLimit treats "D:" the same as "D:\" under the CWD trap' `
                ((Get-RecycleBinLimit $driveRoot) -eq (Get-RecycleBinLimit "$driveRoot\"))
        } finally {
            [Environment]::CurrentDirectory = $savedCwd
            Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
            Remove-TestDirectory $trap
        }

        # $RECYCLE.BIN and System Volume Information sit at every drive's root; a whole-drive sweep
        # must never recurse into them, whatever root reached them.
        $driveSandbox = Join-Path $TestRoot 'drive-sandbox'
        Remove-TestDirectory $driveSandbox
        New-TestFile "$driveSandbox\old.tmp" 1000 10
        New-TestFile "$driveSandbox\`$RECYCLE.BIN\S-1-5-21-0\old.dat" 1000 10
        New-TestFile "$driveSandbox\System Volume Information\old.dat" 1000 10
        $cat = New-Category drivesandbox Custom @($driveSandbox) $driveSandbox
        $targets = New-TargetList -Categories @($cat) -IsAdmin $false -CutoffUtc ([DateTime]::UtcNow.AddDays(-1))
        [DiskCleaner.Engine]::Start($targets.ToArray(), 2, $false).Wait()
        Assert-True 'Reserved folders: only the real old file is counted' ($targets[0].Files -eq 1) "found=$($targets[0].Files)"
        Assert-True 'Reserved folders: $RECYCLE.BIN is never entered' (Test-Path "$driveSandbox\`$RECYCLE.BIN\S-1-5-21-0\old.dat")
        Assert-True 'Reserved folders: System Volume Information is never entered' (Test-Path "$driveSandbox\System Volume Information\old.dat")
        Remove-TestDirectory $driveSandbox

        # A drive root always becomes a junk-only target; an ordinary folder does not.
        $driveCat = New-Category whole Custom @("$driveRoot\") 'whole drive'
        $folderCat = New-Category folder Core @($env:TEMP) 'built-in style category'
        $rootTargets = New-TargetList -Categories @($driveCat, $folderCat) -IsAdmin $false -CutoffUtc ([DateTime]::UtcNow.AddDays(-1))
        Assert-True 'Junk-only: a drive root is searched for junk only' (($rootTargets | Where-Object Category -eq 'whole').JunkOnly)
        Assert-True 'Junk-only: a built-in category is not (everything in its folders is junk)' (-not ($rootTargets | Where-Object Category -eq 'folder').JunkOnly)
    }

    # Junk-only mode (used for whole drives): only junk names or files inside junk folders go.
    $junk = Join-Path $TestRoot 'junk-sandbox'
    Remove-TestDirectory $junk
    $kept = 'report.docx', 'photos\2019\img.jpg', 'Templates\letter.dotx', 'game\save.dat', 'notes.log', 'new.tmp'
    $taken = 'a.tmp', 'b.TEMP', 'app.dmp', 'Thumbs.db', '~$report.docx', '._img.jpg', 'video.mp4.crdownload',
             'Temp\x.dat', 'Temp\sub\y.dat', 'game\tmp\z.bin', 'FOUND.000\FILE0000.CHK', 'proj\__pycache__\m.pyc', 'gpu\GPUCache\data_0'
    foreach ($p in $kept + $taken) { New-TestFile "$junk\$p" 100 $(if ($p -eq 'new.tmp') { 0 } else { 10 }) }
    [void][IO.Directory]::CreateDirectory("$junk\empty-old")
    foreach ($d in 'Temp\sub', 'photos\2019', 'photos', 'Templates', 'empty-old') { Set-DirectoryAge "$junk\$d" 10 }
    $jt = [DiskCleaner.Target]::new()
    $jt.Category = 'junk'; $jt.Root = $junk; $jt.JunkOnly = $true
    $jt.CutoffUtc = [DateTime]::UtcNow.AddDays(-1)
    [DiskCleaner.Engine]::Start(@($jt), 2, $false).Wait()
    Assert-True 'Junk-only: scan counts exactly the junk files' ($jt.Files -eq $taken.Count) "found=$($jt.Files), expected $($taken.Count)"
    [DiskCleaner.Engine]::Start(@($jt), 2, $true).Wait()
    $left = @($kept | Where-Object { -not (Test-Path "$junk\$_") })
    Assert-True 'Junk-only: ordinary files (documents, photos, saves, logs, templates) stay' ($left.Count -eq 0) "missing: $($left -join ', ')"
    $still = @($taken | Where-Object { Test-Path "$junk\$_" })
    Assert-True 'Junk-only: every junk file is deleted' ($still.Count -eq 0) "left: $($still -join ', ')"
    # Any folder added as Custom is junk-only (ordinary name -> junk files only; Temp-named root -> everything).
    $ordinary = New-Category ordinary Custom @($junk) 'ordinary custom folder'
    $viaList = New-TargetList -Categories @($ordinary) -IsAdmin $false -CutoffUtc ([DateTime]::UtcNow.AddDays(-1))
    Assert-True 'Junk-only: a custom folder added by the user is junk-only too' ($viaList[0].JunkOnly)
    Assert-True 'Junk-only: emptied folders inside a junk folder are removed' (-not (Test-Path "$junk\Temp\sub"))
    Assert-True 'Junk-only: the junk folder itself and ordinary empty folders stay' ((Test-Path "$junk\Temp") -and (Test-Path "$junk\empty-old"))
    Remove-TestDirectory $junk

    # Protection rules for user-chosen folders.
    Assert-True 'Refuses a folder inside Windows'   (-not (Test-CustomRoot "$env:windir\Temp"))
    Assert-True 'Refuses the profile root'          (-not (Test-CustomRoot $env:USERPROFILE))
    Assert-True 'Allows a normal folder (Downloads)' (Test-CustomRoot "$env:USERPROFILE\Downloads")
    Assert-True 'Refuses the system drive root'      (-not (Test-CustomRoot "$env:SystemDrive\"))
    if ($otherDrive) {
        Assert-True 'Allows a non-system drive root' (Test-CustomRoot "$driveRoot\")
    }
} catch {
    Add-Result 'Engine suite' FAIL $_.Exception.Message
} finally {
    if (Test-Path "$base\link-outside") { cmd /c rmdir "$base\link-outside" }
    Remove-TestDirectory (Split-Path $base)
    Remove-TestDirectory $outside
    Remove-RecycledTestItem $base
    Remove-RecycledTestItem $recycle
    Remove-TestDirectory (Split-Path $recycle)
    Remove-TestDirectory (Join-Path $TestRoot 'drive-sandbox')
    Remove-TestDirectory (Join-Path $TestRoot 'junk-sandbox')
    Remove-Item (Join-Path $TestRoot 'run-*.txt'), (Join-Path $TestRoot 'exe-*') -ErrorAction SilentlyContinue
}
exit (Complete-Test 'Engine')
