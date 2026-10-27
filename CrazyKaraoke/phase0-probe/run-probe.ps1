$ErrorActionPreference = "Stop"
$secureKey = Read-Host "YouTube Data API key (input is hidden)" -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
    $env:YOUTUBE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    $env:PHASE0_PORT = "4173"
    node (Join-Path $PSScriptRoot "server.mjs")
}
finally {
    $env:YOUTUBE_API_KEY = $null
    $env:PHASE0_PORT = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
}
