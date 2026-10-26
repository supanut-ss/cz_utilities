# Test-Gui.ps1 - drives the real window: hover/pressed states, keyboard, and the clean flow.
# The window runs with an isolated profile (empty AppData/Temp) and only a sandbox folder selected.
# The mouse moves while it runs; avoid clicking other windows (covered steps are reported as SKIP).
param([string]$Theme = 'Light', [string]$Exe) # -Exe: test DiskCleaner.exe instead of the script
. (Join-Path $PSScriptRoot 'Common.ps1')

$sandbox = Join-Path $TestRoot 'gui-sandbox\Temp' # a Temp folder: everything in it is junk
$sheetPath = Join-Path $TestRoot "gui-states-$Theme.png"
$gui = $null
$mouse = Save-MousePosition
$settingsStamp = Get-RealSettingsStamp
$rows = [System.Collections.Generic.List[object]]::new()

function Test-Hover([string]$Label, $Element, [double]$OffsetX = 0.5, [int]$MinChange = 15, [switch]$Press) {
    if (-not $Element) { Add-Result "Hover: $Label" FAIL 'element not found'; return }
    $rect = $Element.Current.BoundingRectangle
    $x = $rect.Left + $rect.Width * $OffsetX
    $y = $rect.Top + $rect.Height / 2
    if (-not (Move-MouseOnWindow $gui $script:Park.X $script:Park.Y)) { Add-Result "Hover: $Label" SKIP 'window covered'; return }
    $before = Get-Crop (Get-WindowImage $gui) $rect
    if (-not (Move-MouseOnWindow $gui $x $y)) { Add-Result "Hover: $Label" SKIP 'window covered'; return }
    $hand = [DiskCleanerTests.Win]::IsHandCursor()
    $after = Get-Crop (Get-WindowImage $gui) $rect
    $change = Measure-PixelChange $before $after
    Assert-True "Hover: $Label" ($change -ge $MinChange -and $hand) "changed px=$change, hand cursor=$hand"
    $images = @($before, $after)
    if ($Press) {
        [DiskCleanerTests.Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 300 # left down
        $pressed = Get-Crop (Get-WindowImage $gui) $rect
        [DiskCleanerTests.Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 300 # left up
        $change = Measure-PixelChange $after $pressed
        Assert-True "Pressed: $Label" ($change -ge $MinChange) "changed px=$change"
        $images += $pressed
    }
    $rows.Add(@{ Label = $Label; Images = $images })
}

function Save-StateSheet([string]$Path) {
    $cellW = ($rows | ForEach-Object { $_.Images } | Measure-Object -Property Width -Maximum).Maximum
    $height = ($rows | ForEach-Object { ($_.Images | Measure-Object -Property Height -Maximum).Maximum + 12 } | Measure-Object -Sum).Sum + 30
    $sheet = [Drawing.Bitmap]::new(190 + 3 * ($cellW + 12), [int]$height)
    $g = [Drawing.Graphics]::FromImage($sheet)
    $g.Clear([Drawing.Color]::White)
    $font = [Drawing.Font]::new('Segoe UI', 9)
    foreach ($i in 0..2) { $g.DrawString(@('normal', 'hover', 'pressed / focus')[$i], $font, [Drawing.Brushes]::Gray, 190 + $i * ($cellW + 12), 6) }
    $y = 26
    foreach ($row in $rows) {
        $g.DrawString($row.Label, $font, [Drawing.Brushes]::Black, 6, $y + 4)
        $x = 190
        foreach ($img in $row.Images) { $g.DrawImage($img, $x, $y); $x += $cellW + 12 }
        $y += ($row.Images | Measure-Object -Property Height -Maximum).Maximum + 12
    }
    $g.Dispose()
    $sheet.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
}

Write-Host "GUI tests ($Theme$(if ($Exe) { ', exe' }))" -ForegroundColor Cyan
$lock = $null
try {
    # Isolated profile with one custom folder selected.
    $envVars = New-IsolatedProfile
    Remove-TestDirectory $sandbox
    foreach ($f in 'a.bin', 'b.bin', 'sub\c.bin', 'locked.bin') { New-TestFile "$sandbox\$f" 524288 10 }
    Set-DirectoryAge "$sandbox\sub" 10
    New-TestFile "$sandbox\fresh.bin" 100
    @{ Selected = @('Temp'); MinAgeDays = 1; DiskType = 'SSD'; CustomFolders = @($sandbox) } |
        ConvertTo-Json | Set-Content "$($envVars.LOCALAPPDATA)\DiskCleaner\settings.json" -Encoding UTF8

    $gui = Start-Gui $envVars $Theme $Exe
    $win = $gui.Window
    [DiskCleanerTests.Win]::BringToFront($gui.Hwnd)
    Start-Sleep -Milliseconds 400
    $title = (Find-Visible $win 'Disk Cleaner' $ControlType::Text).Current.BoundingRectangle
    $script:Park = @{ X = $title.Left + 20; Y = $title.Top + $title.Height / 2 }
    [void](Move-MouseOnWindow $gui $script:Park.X $script:Park.Y) # warm-up so WPF tracks the mouse

    # The busy panel and the dialog both show "Cancel"; screen readers must be able to tell them apart.
    $cancelButtons = @($win.FindAll($TreeScope::Descendants, [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new($UIA::NameProperty, 'Cancel'),
        [Windows.Automation.PropertyCondition]::new($UIA::ControlTypeProperty, $ControlType::Button))))
    # Hidden controls may or may not still be in the tree, so only duplicates matter.
    Assert-True 'No two buttons share the name Cancel' ($cancelButtons.Count -le 1) "found $($cancelButtons.Count)"

    # Custom folders go to the Recycle Bin by default; the option switches the chip and the dialog.
    $option = Find-Visible $win 'Move files from custom folders to the Recycle Bin' $ControlType::CheckBox
    $toggle = $option.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    Assert-True 'Recycle Bin option is on by default' ($toggle.Current.ToggleState -eq 'On')
    Assert-True 'Custom row shows "To Recycle Bin"' ([bool](Find-Visible $win 'To Recycle Bin*'))
    $toggle.Toggle(); Start-Sleep -Milliseconds 300
    Assert-True 'Turning the option off removes the chip' (-not (Find-Visible $win 'To Recycle Bin*'))
    Invoke-Element (Find-Visible $win 'Clean selected' $ControlType::Button)
    $permanent = Wait-Until { Find-Visible $win 'Delete *' $ControlType::Button } 'the confirmation dialog'
    Assert-True 'With the option off the dialog asks to delete permanently' ([bool]$permanent) $permanent.Current.Name
    Send-WindowKey $gui 0x1B
    $toggle.Toggle(); Start-Sleep -Milliseconds 300
    Assert-True 'Turning the option on restores the chip' ([bool](Find-Visible $win 'To Recycle Bin*'))

    # Hover states (hand cursor + visible change)
    Test-Hover 'Clean selected (accent)' (Find-Visible $win 'Clean selected' $ControlType::Button)
    Test-Hover 'Recommended (link)' (Find-Visible $win 'Recommended' $ControlType::Button)
    Test-Hover 'Category row' (Find-Visible $win 'UserTemp' $ControlType::Text)
    Test-Hover 'Group checkbox' (Find-Visible $win 'Select all in Recommended' $ControlType::CheckBox) -MinChange 5
    Test-Hover 'Open folder (icon)' (Find-Visible $win 'Open folder of UserTemp' $ControlType::Button)
    Test-Hover 'Drive type segment' (Find-Visible $win 'Drive type hard disk' $ControlType::RadioButton)
    $slider = Find-Visible $win 'Only delete files older than*' $ControlType::Slider
    $sw = $slider.Current.BoundingRectangle.Width
    Test-Hover 'Slider thumb' $slider ((10.0 + ($sw - 20) / 30) / $sw) -MinChange 5

    # Confirmation dialog: safe default, hover, Esc
    Invoke-Element (Find-Visible $win 'Clean selected' $ControlType::Button)
    $move = Wait-Until { Find-Visible $win 'Move *' $ControlType::Button } 'the confirmation dialog'
    Start-Sleep -Milliseconds 400
    Assert-True 'Dialog opens with focus on Cancel' ($UIA::FocusedElement.Current.Name -eq 'Cancel')
    Assert-True 'Dialog title says Recycle Bin' ([bool](Find-Visible $win 'Move * to the Recycle Bin?'))
    Test-Hover 'Dialog Move (accent)' $move
    Test-Hover 'Dialog Cancel' (Find-Visible $win 'Cancel' $ControlType::Button)
    Send-WindowKey $gui 0x1B # Esc
    Assert-True 'Esc closes the dialog' (-not (Find-Visible $win 'Move *' $ControlType::Button))

    # Keyboard focus ring
    Send-WindowKey $gui 0x09 # Tab
    $focused = $UIA::FocusedElement
    Assert-True 'Tab moves focus to a control' ($focused.Current.ProcessId -eq $gui.Process.Id -and $focused.Current.IsKeyboardFocusable) $focused.Current.Name
    $fr = $focused.Current.BoundingRectangle
    $rows.Add(@{ Label = "Focus ring ($($focused.Current.Name))"; Images = @(Get-Crop (Get-WindowImage $gui) $fr 10) })

    # Clean flow through the dialog, with one file held open
    $lock = [IO.File]::Open("$sandbox\locked.bin", 'Open', 'Read', 'None')
    Invoke-Element (Find-Visible $win 'Clean selected' $ControlType::Button)
    Invoke-Element (Wait-Until { Find-Visible $win 'Move *' $ControlType::Button } 'the confirmation dialog')
    $status = Wait-Until { Find-Visible $win 'Cleaned in*' } 'the clean to finish'
    $lock.Dispose(); $lock = $null
    $left = @(Get-ChildItem $sandbox -Recurse -File | ForEach-Object Name | Sort-Object)
    Assert-True 'Clean deletes old files, keeps new and in-use ones' (($left -join ',') -eq 'fresh.bin,locked.bin') ($left -join ', ')
    Assert-True 'Clean removes the emptied old folder' (-not (Test-Path "$sandbox\sub"))
    $inBin = @(Get-RecycledTestItem $sandbox | ForEach-Object { [IO.Path]::GetFileName($_.OriginalPath) } | Sort-Object)
    Assert-True 'Cleaned files are in the Recycle Bin' (($inBin -join ',') -eq 'a.bin,b.bin,c.bin') ($inBin -join ', ')
    $banner = Find-Visible $win 'Done.*'
    Assert-True 'Result banner mentions the Recycle Bin' ($banner.Current.Name -like '*Moved*to the Recycle Bin*') $banner.Current.Name
    Assert-True 'Result banner never shows a negative size' ($banner.Current.Name -notmatch 'Freed -') $status.Current.Name
    Assert-True 'Row shows a "Moved ... to Recycle Bin" chip' ([bool](Find-Visible $win 'Moved * to Recycle Bin*'))
    Save-WindowImage $gui (Join-Path $TestRoot "gui-after-clean-$Theme.png")

    # Pressed state last: releasing the button starts a rescan.
    Test-Hover 'Rescan (secondary)' (Find-Visible $win 'Rescan' $ControlType::Button) -Press
    Save-StateSheet $sheetPath
    Write-Host "  images: $sheetPath"
} catch {
    Add-Result 'GUI suite' FAIL $_.Exception.Message
} finally {
    if ($lock) { $lock.Dispose() }
    Stop-Gui $gui
    Restore-MousePosition $mouse
    Remove-RecycledTestItem $sandbox
    Remove-TestDirectory $sandbox
    Remove-TestDirectory (Join-Path $TestRoot 'profile')
}

# "Add drive" shortcut on the drive-usage cards. Uses a subst'd drive letter mapped to a tiny test
# folder, so the window's real whole-drive scan is instant and never touches an actual drive's
# contents; DriveInfo reports a subst'd drive as Fixed/Ready, same as any other local drive.
$driveLetter = $null
$driveGui = $null
try {
    $driveFolder = Join-Path $TestRoot 'drive-button-sim'
    Remove-TestDirectory $driveFolder
    New-TestFile "$driveFolder\old.txt" 1000 10          # ordinary file: must be ignored
    New-TestFile "$driveFolder\stuff\old.tmp" 1000 10    # junk: the only file the drive row may count
    New-TestFile "$driveFolder\new.txt" 1000

    $used = [IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name[0] }
    $driveLetter = 90..65 | ForEach-Object { [char]$_ } | Where-Object { $_ -notin $used } | Select-Object -First 1
    if (-not $driveLetter) {
        Add-Result 'Add drive button' SKIP 'no free drive letter to simulate one'
    } else {
        subst "${driveLetter}:" $driveFolder
        Start-Sleep -Milliseconds 300
        try {
            $driveGui = Start-Gui (New-IsolatedProfile) $Theme $Exe
            $dwin = $driveGui.Window
            [DiskCleanerTests.Win]::BringToFront($driveGui.Hwnd)
            Start-Sleep -Milliseconds 300

            $sysRoot = $env:SystemDrive.TrimEnd('\')
            Assert-True 'No "Add drive" shortcut on the system drive' (-not (Find-Visible $dwin "Add drive $sysRoot*" $ControlType::Button))

            $addButton = Find-Visible $dwin "Add drive ${driveLetter}:*" $ControlType::Button
            Assert-True 'Simulated drive shows an "Add drive" shortcut' ([bool]$addButton)
            if ($addButton) {
                Invoke-Element $addButton
                Invoke-NativeDialogButton $driveGui 'No'
                Start-Sleep -Milliseconds 300
                Assert-True 'Declining the warning adds nothing' (-not (Find-Visible $dwin "${driveLetter}:\ (whole drive)*"))
                Assert-True '"Add drive" shortcut is still there after declining' ([bool](Find-Visible $dwin "Add drive ${driveLetter}:*" $ControlType::Button))

                Invoke-Element (Find-Visible $dwin "Add drive ${driveLetter}:*" $ControlType::Button)
                Invoke-NativeDialogButton $driveGui 'Yes'
                $driveRow = Wait-Until { Find-Visible $dwin "${driveLetter}:\ (whole drive)*" } 'the whole-drive row'
                Assert-True 'Accepting adds a row named after the drive' ([bool]$driveRow) $driveRow.Current.Name
                Assert-True '"Add drive" shortcut disappears once added' (-not (Find-Visible $dwin "Add drive ${driveLetter}:*" $ControlType::Button))
                Assert-True 'New drive folder defaults to the Recycle Bin' ([bool](Find-Visible $dwin 'To Recycle Bin*'))
                [void](Wait-Until { Find-Visible $dwin 'Scan finished*' } 'the rescan after adding the drive' 30)
                Assert-True 'Whole-drive row counts only the junk file, not the ordinary old one' ([bool](Find-Visible $dwin '1 file' $ControlType::Text))

                $removeButton = Find-Visible $dwin "Remove ${driveLetter}:\ (whole drive) from list" $ControlType::Button
                Assert-True 'Row has a Remove button' ([bool]$removeButton)
                if ($removeButton) {
                    Invoke-Element $removeButton
                    Start-Sleep -Milliseconds 300
                    Assert-True 'Removing the row brings the "Add drive" shortcut back' ([bool](Find-Visible $dwin "Add drive ${driveLetter}:*" $ControlType::Button))
                }
            }
        } finally {
            Stop-Gui $driveGui
        }
    }
} catch {
    Add-Result 'Add drive button' FAIL $_.Exception.Message
} finally {
    if ($driveLetter) { cmd /c "subst ${driveLetter}: /d" 2>$null }
    Remove-TestDirectory (Join-Path $TestRoot 'drive-button-sim')
    Remove-TestDirectory (Join-Path $TestRoot 'profile')
}

Assert-True "User's real settings were not touched" ((Get-RealSettingsStamp) -eq $settingsStamp)
exit (Complete-Test "GUI ($Theme)")
