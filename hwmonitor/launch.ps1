# Starts the HW Monitor server (optionally elevated) and opens the dashboard window.
# The window is opened from this non-elevated process so the browser never runs as admin.
param([switch]$Admin, [int]$Port = 5757)

$url = "http://localhost:$Port"
$server = Join-Path $PSScriptRoot 'server.js'
$pawnIoService = 'HKLM:\SYSTEM\CurrentControlSet\Services\PawnIO'

if (-not (Test-Path $pawnIoService)) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        try {
            Start-Process -FilePath $winget.Source `
                -ArgumentList 'install --id namazso.PawnIO --exact --accept-source-agreements --accept-package-agreements --silent' `
                -WindowStyle Hidden -ErrorAction Stop | Out-Null
        } catch { }
    }
}

function Test-Server {
    try { Invoke-WebRequest "$url/icon.svg" -UseBasicParsing -TimeoutSec 1 | Out-Null; $true } catch { $false }
}

if (-not (Test-Server)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show('Node.js is required: https://nodejs.org', 'HW Monitor') | Out-Null
        exit 1
    }
    # Pass the port as an argument: elevated processes do not inherit this environment
    $nodeArgs = @("`"$server`"", '--app', "--port=$Port")
    if ($Admin) {
        # Elevated processes start in System32; server.js resolves its files from __dirname
        try { Start-Process $node -ArgumentList $nodeArgs -Verb RunAs -WindowStyle Hidden -ErrorAction Stop }
        catch { exit 1 } # UAC prompt was declined
    } else {
        Start-Process $node -ArgumentList $nodeArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    }
    for ($i = 0; $i -lt 40 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 250 }
}

try { Start-Process msedge -ArgumentList "--app=$url", '--start-maximized' -ErrorAction Stop }
catch { Start-Process $url -WindowStyle Maximized }
