<#
.SYNOPSIS
    Builds dist\DiskCleaner.exe: one file with the window and the command-line tool embedded.

.DESCRIPTION
    Uses only what ships with Windows: the .NET Framework C# compiler (csc.exe) and the
    PowerShell 5.1 engine. The app icon is drawn with WPF at build time. Run the window with no arguments, or
    the command-line tool with "DiskCleaner.exe --cli ...".

.PARAMETER Version
    File and product version, e.g. 1.2.0. Defaults to $DiskCleanerVersion in DiskCleaner.Core.ps1.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build\Build-Exe.ps1
#>
param([ValidatePattern('^\d+\.\d+\.\d+(\.\d+)?$')][string]$Version)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, WindowsBase

$root = Split-Path $PSScriptRoot -Parent
if (-not $Version) {
    $m = [regex]::Match([IO.File]::ReadAllText((Join-Path $root 'DiskCleaner.Core.ps1')), "(?m)^\`$DiskCleanerVersion = '([\d.]+)'")
    if (-not $m.Success) { throw '$DiskCleanerVersion not found in DiskCleaner.Core.ps1' }
    $Version = $m.Groups[1].Value
}
$obj = Join-Path $PSScriptRoot 'obj'
$dist = Join-Path $root 'dist'
foreach ($d in $obj, $dist) { [void][IO.Directory]::CreateDirectory($d) }

# Same design as the window icon: accent rounded square with the eraser glyph.
function New-IconPng([int]$Size) {
    $visual = [Windows.Media.DrawingVisual]::new()
    $dc = $visual.RenderOpen()
    $accent = [Windows.Media.SolidColorBrush]::new([Windows.Media.Color]::FromRgb(0x00, 0x5F, 0xB8))
    $dc.DrawRoundedRectangle($accent, $null, [Windows.Rect]::new(0, 0, $Size, $Size), $Size * 0.22, $Size * 0.22)
    $glyph = [Windows.Media.FormattedText]::new([string][char]0xE75C, [Globalization.CultureInfo]::InvariantCulture, 'LeftToRight',
        [Windows.Media.Typeface]::new('Segoe Fluent Icons, Segoe MDL2 Assets'), $Size * 0.56, [Windows.Media.Brushes]::White, 1.0)
    $dc.DrawText($glyph, [Windows.Point]::new(($Size - $glyph.Width) / 2, ($Size - $glyph.Height) / 2))
    $dc.Close()
    $bmp = [Windows.Media.Imaging.RenderTargetBitmap]::new($Size, $Size, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bmp.Render($visual)
    $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp))
    $stream = [IO.MemoryStream]::new()
    $encoder.Save($stream)
    , $stream.ToArray()
}

# .ico with PNG-compressed images (supported since Windows Vista).
function Write-Icon([string]$Path, [int[]]$Sizes) {
    $images = foreach ($s in $Sizes) { , (New-IconPng $s) }
    $ms = [IO.MemoryStream]::new()
    $w = [IO.BinaryWriter]::new($ms)
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$Sizes.Count)
    $offset = 6 + 16 * $Sizes.Count
    for ($i = 0; $i -lt $Sizes.Count; $i++) {
        $dim = [byte]($Sizes[$i] % 256) # 256 is stored as 0
        $w.Write($dim); $w.Write($dim); $w.Write([byte]0); $w.Write([byte]0)
        $w.Write([uint16]1); $w.Write([uint16]32)
        $w.Write([uint32]$images[$i].Length); $w.Write([uint32]$offset)
        $offset += $images[$i].Length
    }
    foreach ($img in $images) { $w.Write($img) }
    $w.Flush()
    [IO.File]::WriteAllBytes($Path, $ms.ToArray())
}

$icon = Join-Path $obj 'app.ico'
Write-Icon $icon 16, 20, 24, 32, 40, 48, 64, 256

$source = Join-Path $obj 'Launcher.cs'
[IO.File]::WriteAllText($source, [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Launcher.cs')).Replace('@VERSION@', $Version))

$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
$exe = Join-Path $dist 'DiskCleaner.exe'
$arguments = @(
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+'
    "/out:$exe"
    "/win32icon:$icon"
    "/win32manifest:$(Join-Path $PSScriptRoot 'app.manifest')"
    "/reference:$([PSObject].Assembly.Location)"
    "/resource:$(Join-Path $root 'DiskCleaner.Core.ps1'),DiskCleaner.Core.ps1"
    "/resource:$(Join-Path $root 'DiskCleanerGui.ps1'),DiskCleanerGui.ps1"
    "/resource:$(Join-Path $root 'DiskCleaner.ps1'),DiskCleaner.ps1"
    $source
)
& $csc @arguments
if ($LASTEXITCODE) { throw "csc.exe failed with exit code $LASTEXITCODE" }

$info = Get-Item $exe
Write-Host ('Built {0} ({1:N0} KB, version {2})' -f $info.FullName, ($info.Length / 1KB), $Version) -ForegroundColor Green
