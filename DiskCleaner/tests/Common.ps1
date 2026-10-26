# Common.ps1 - shared helpers for the DiskCleaner tests. Dot-source it.
#
# Rules every UI test follows so it never touches other apps on the desktop:
#   * Images come from PrintWindow on the Disk Cleaner window only, never from the screen.
#   * Keys are posted to the Disk Cleaner window only, never injected globally.
#   * Before any hover, the window is brought to the front and the point under the cursor is
#     checked; if something else covers it, the step is reported as SKIP instead of guessed.
#   * The mouse position is restored at the end, and GUI processes run with an isolated profile
#     or are killed (not closed), so the user's settings are never written. Suites assert this.

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
# Short base path: the sandbox builds paths longer than 260 characters on purpose.
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) 'DiskCleanerTests'
[void][IO.Directory]::CreateDirectory($TestRoot)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
if (-not ('DiskCleanerTests.Win' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace DiskCleanerTests
{
    public static class Win
    {
        public struct RECT { public int Left, Top, Right, Bottom; }
        public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)]
        struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }

        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
        [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr inst, int id);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

        public static bool IsHandCursor()
        {
            var ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(ci);
            GetCursorInfo(ref ci);
            return ci.hCursor == LoadCursor(IntPtr.Zero, 32649); // IDC_HAND
        }

        public static bool IsWindowAt(IntPtr hwnd, int x, int y)
        {
            var p = new POINT(); p.X = x; p.Y = y;
            return GetAncestor(WindowFromPoint(p), 2) == hwnd; // GA_ROOT
        }

        // Windows refuses SetForegroundWindow from a background process; sharing input state
        // with the foreground thread for a moment is the documented way around it. No input is sent.
        public static void BringToFront(IntPtr hwnd)
        {
            uint me = GetCurrentThreadId();
            uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
            AttachThreadInput(me, fg, true);
            SetForegroundWindow(hwnd);
            BringWindowToTop(hwnd);
            AttachThreadInput(me, fg, false);
            SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0003); // HWND_TOPMOST, keep size and position
        }
    }
}
'@
}

$UIA = [Windows.Automation.AutomationElement]
$TreeScope = [Windows.Automation.TreeScope]
$ControlType = [Windows.Automation.ControlType]

#region Results -----------------------------------------------------------------
$Results = [System.Collections.Generic.List[pscustomobject]]::new()

function Add-Result([string]$Name, [ValidateSet('PASS', 'FAIL', 'SKIP')][string]$Outcome, [string]$Detail = '') {
    $Results.Add([pscustomobject]@{ Test = $Name; Outcome = $Outcome; Detail = $Detail })
    $color = @{ PASS = 'Green'; FAIL = 'Red'; SKIP = 'Yellow' }[$Outcome]
    Write-Host ('  [{0}] {1}  {2}' -f $Outcome, $Name, $Detail) -ForegroundColor $color
}

function Assert-True([string]$Name, [bool]$Condition, [string]$Detail = '') {
    Add-Result $Name $(if ($Condition) { 'PASS' } else { 'FAIL' }) $Detail
}

# Prints the summary and returns the process exit code (1 when anything failed).
function Complete-Test([string]$Suite) {
    $fail = @($Results | Where-Object Outcome -eq 'FAIL').Count
    $skip = @($Results | Where-Object Outcome -eq 'SKIP').Count
    Write-Host ("{0}: {1} passed, {2} failed, {3} skipped" -f $Suite, ($Results.Count - $fail - $skip), $fail, $skip) `
        -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
    [int]($fail -gt 0)
}
#endregion

#region Files -------------------------------------------------------------------
function Remove-TestDirectory([string]$Path) {
    # cmd's rmdir removes junctions without following them and handles long paths.
    if (Test-Path -LiteralPath $Path) { cmd /c "attrib -r `"$Path\*`" /s /d >nul 2>&1 & rmdir /s /q `"$Path`"" }
}

function New-TestFile([string]$Path, [int]$Size, [int]$AgeDays = 0) {
    $long = if ($Path.Length -ge 248) { '\\?\' + $Path } else { $Path }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($long))
    [IO.File]::WriteAllBytes($long, (New-Object byte[] $Size))
    if ($AgeDays) {
        $when = (Get-Date).AddDays(-$AgeDays)
        [IO.File]::SetCreationTime($long, $when); [IO.File]::SetLastWriteTime($long, $when)
    }
}

function Set-DirectoryAge([string]$Path, [int]$AgeDays) {
    $when = (Get-Date).AddDays(-$AgeDays)
    [IO.Directory]::SetCreationTime($Path, $when); [IO.Directory]::SetLastWriteTime($Path, $when)
}

# Original path stored in a Recycle Bin "$I" record (formats 1 and 2), or $null.
function Read-RecycleInfoPath([string]$InfoFile) {
    try {
        $bytes = [IO.File]::ReadAllBytes($InfoFile)
        switch ([BitConverter]::ToInt64($bytes, 0)) {
            2 { return [Text.Encoding]::Unicode.GetString($bytes, 28, ([BitConverter]::ToInt32($bytes, 24) - 1) * 2) }
            1 { return [Text.Encoding]::Unicode.GetString($bytes, 24, 520).TrimEnd([char]0) }
        }
    } catch { }
    $null
}

# Items in the current user's Recycle Bin that came from under $UnderPath.
function Get-RecycledTestItem([string]$UnderPath) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $prefix = $UnderPath.TrimEnd('\') + '\'
    foreach ($drive in [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }) {
        $bin = Join-Path $drive.RootDirectory.FullName ('$Recycle.Bin\' + $sid)
        if (-not [IO.Directory]::Exists($bin)) { continue }
        foreach ($info in [IO.Directory]::GetFiles($bin, '$I*')) {
            $original = Read-RecycleInfoPath $info
            if ($original -and $original.StartsWith($prefix, 'OrdinalIgnoreCase')) {
                [pscustomobject]@{
                    OriginalPath = $original
                    InfoFile     = $info
                    DataPath     = Join-Path $bin ('$R' + [IO.Path]::GetFileName($info).Substring(2))
                }
            }
        }
    }
}

# Removes only the test's own items from the Recycle Bin; everything else in it is left alone.
function Remove-RecycledTestItem([string]$UnderPath) {
    foreach ($item in @(Get-RecycledTestItem $UnderPath)) {
        if (Test-Path -LiteralPath $item.DataPath) { Remove-Item -LiteralPath $item.DataPath -Recurse -Force }
        Remove-Item -LiteralPath $item.InfoFile -Force
    }
}

# Last write time of the user's real settings file ($null when it does not exist).
function Get-RealSettingsStamp {
    $file = Join-Path $env:LOCALAPPDATA 'DiskCleaner\settings.json'
    if (Test-Path $file) { (Get-Item $file).LastWriteTimeUtc } else { $null }
}

# A profile with empty LOCALAPPDATA/APPDATA/TEMP so the GUI cannot see or clean real user data.
function New-IsolatedProfile {
    $root = Join-Path $TestRoot 'profile'
    Remove-TestDirectory $root
    foreach ($d in 'Local\DiskCleaner', 'Roaming', 'Temp') { [void][IO.Directory]::CreateDirectory("$root\$d") }
    @{ LOCALAPPDATA = "$root\Local"; APPDATA = "$root\Roaming"; TEMP = "$root\Temp"; TMP = "$root\Temp" }
}
#endregion

#region GUI ---------------------------------------------------------------------
function Wait-Until([scriptblock]$Probe, [string]$What, [int]$Seconds = 45) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $value = & $Probe
        if ($value) { return $value }
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for $What"
}

# Visible elements only: hidden controls (e.g. the busy panel's Cancel) stay in the UI Automation tree.
function Find-Visible($Root, [string]$Name, $Type) {
    $cond = if ($Type) { [Windows.Automation.PropertyCondition]::new($UIA::ControlTypeProperty, $Type) } else { [Windows.Automation.Condition]::TrueCondition }
    $Root.FindAll($TreeScope::Descendants, $cond) | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -like $Name } | Select-Object -First 1
}

function Invoke-Element($Element) {
    $Element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

# Starts the GUI (optionally with extra environment variables) and waits for the first scan.
# With -Exe it starts DiskCleaner.exe instead of the script.
function Start-Gui([hashtable]$Environment = @{}, [string]$Theme = 'Light', [string]$Exe) {
    $saved = @{}
    foreach ($k in $Environment.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k)
        [Environment]::SetEnvironmentVariable($k, $Environment[$k])
    }
    try {
        $proc = if ($Exe) { Start-Process $Exe -PassThru -ArgumentList "-Theme $Theme" }
                else { Start-Process powershell.exe -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -STA -File `"$ProjectRoot\DiskCleanerGui.ps1`" -Theme $Theme" }
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    $byPid = [Windows.Automation.PropertyCondition]::new($UIA::ProcessIdProperty, $proc.Id)
    $win = Wait-Until { $UIA::RootElement.FindFirst($TreeScope::Children, $byPid) } 'the Disk Cleaner window'
    [void](Wait-Until { Find-Visible $win 'Scan finished*' } 'the first scan')
    [pscustomobject]@{ Process = $proc; Window = $win; Hwnd = [IntPtr]$win.Current.NativeWindowHandle }
}

function Stop-Gui($Gui) {
    if ($Gui -and -not $Gui.Process.HasExited) { $Gui.Process.Kill() } # killed, so no settings are saved
}

function Get-WindowImage($Gui) {
    $r = New-Object DiskCleanerTests.Win+RECT
    [void][DiskCleanerTests.Win]::GetWindowRect($Gui.Hwnd, [ref]$r)
    $bmp = [Drawing.Bitmap]::new($r.Right - $r.Left, $r.Bottom - $r.Top)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [void][DiskCleanerTests.Win]::PrintWindow($Gui.Hwnd, $hdc, 2) # PW_RENDERFULLCONTENT: this window only
    $g.ReleaseHdc($hdc); $g.Dispose()
    @{ Bitmap = $bmp; Left = $r.Left; Top = $r.Top }
}

function Save-WindowImage($Gui, [string]$Path) {
    (Get-WindowImage $Gui).Bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
}

function Get-Crop($Image, [Windows.Rect]$Rect, [int]$Pad = 6) {
    $x = [Math]::Max(0, [int]$Rect.Left - $Image.Left - $Pad)
    $y = [Math]::Max(0, [int]$Rect.Top - $Image.Top - $Pad)
    $w = [Math]::Min([int]$Rect.Width + 2 * $Pad, $Image.Bitmap.Width - $x)
    $h = [Math]::Min([int]$Rect.Height + 2 * $Pad, $Image.Bitmap.Height - $y)
    $Image.Bitmap.Clone([Drawing.Rectangle]::new($x, $y, $w, $h), $Image.Bitmap.PixelFormat)
}

# Number of sampled pixels that differ noticeably between two crops.
function Measure-PixelChange($A, $B) {
    $n = 0
    for ($x = 0; $x -lt [Math]::Min($A.Width, $B.Width); $x += 2) {
        for ($y = 0; $y -lt [Math]::Min($A.Height, $B.Height); $y += 2) {
            $p = $A.GetPixel($x, $y); $q = $B.GetPixel($x, $y)
            if ([Math]::Abs($p.R - $q.R) + [Math]::Abs($p.G - $q.G) + [Math]::Abs($p.B - $q.B) -gt 12) { $n++ }
        }
    }
    $n
}

function Send-WindowKey($Gui, [int]$VirtualKey) {
    [void][DiskCleanerTests.Win]::PostMessage($Gui.Hwnd, 0x0100, [IntPtr]$VirtualKey, [IntPtr]::Zero) # WM_KEYDOWN
    [void][DiskCleanerTests.Win]::PostMessage($Gui.Hwnd, 0x0101, [IntPtr]$VirtualKey, [IntPtr]::Zero) # WM_KEYUP
    Start-Sleep -Milliseconds 400
}

# A native MessageBox (WPF's MessageBox.Show is a real Win32 dialog) is its own top-level window,
# not part of $Gui's WPF tree, so UI Automation sees it as a separate window of the same process.
# BM_CLICK is synchronous, so this does not race the dialog closing.
function Invoke-NativeDialogButton($Gui, [string]$ButtonName, [int]$Seconds = 15) {
    $byPid = [Windows.Automation.PropertyCondition]::new($UIA::ProcessIdProperty, $Gui.Process.Id)
    $button = Wait-Until {
        $UIA::RootElement.FindAll($TreeScope::Children, $byPid) | ForEach-Object {
            $_.FindFirst($TreeScope::Descendants, [Windows.Automation.PropertyCondition]::new($UIA::NameProperty, $ButtonName))
        } | Where-Object { $_ } | Select-Object -First 1
    } "a native dialog button named '$ButtonName'" $Seconds
    [void][DiskCleanerTests.Win]::SendMessage([IntPtr]$button.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) # BM_CLICK
}

function Save-MousePosition {
    $p = New-Object DiskCleanerTests.Win+POINT
    [void][DiskCleanerTests.Win]::GetCursorPos([ref]$p)
    $p
}

function Restore-MousePosition($Point) { [void][DiskCleanerTests.Win]::SetCursorPos($Point.X, $Point.Y) }

function Move-Mouse([double]$X, [double]$Y) {
    [void][DiskCleanerTests.Win]::SetCursorPos([int]$X, [int]$Y)
    Start-Sleep -Milliseconds 60
    [void][DiskCleanerTests.Win]::SetCursorPos([int]$X + 1, [int]$Y) # a second move so WPF notices
    Start-Sleep -Milliseconds 400
}

# Moves the mouse to a point of $Gui's window. Returns $false (and moves nothing) when another
# window covers that point even after bringing ours to the front.
function Move-MouseOnWindow($Gui, [double]$X, [double]$Y) {
    if (-not [DiskCleanerTests.Win]::IsWindowAt($Gui.Hwnd, [int]$X, [int]$Y)) {
        [DiskCleanerTests.Win]::BringToFront($Gui.Hwnd)
        Start-Sleep -Milliseconds 400
        if (-not [DiskCleanerTests.Win]::IsWindowAt($Gui.Hwnd, [int]$X, [int]$Y)) { return $false }
    }
    Move-Mouse $X $Y
    $true
}
#endregion
