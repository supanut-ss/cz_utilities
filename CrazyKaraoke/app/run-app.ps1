$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$keyFile = Join-Path $repositoryRoot "YOUTUBE_API_KEY.txt"
$apiKey = ""

if (Test-Path -LiteralPath $keyFile) {
  $apiKey = (Get-Content -LiteralPath $keyFile -Raw).Trim()
} else {
  $secureKey = Read-Host "Enter the YouTube Data API key" -AsSecureString
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
}

if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw "A YouTube Data API key is required for search."
}

Push-Location $repositoryRoot
try {
  $env:YOUTUBE_API_KEY = $apiKey
  node .\app\server.mjs
} finally {
  Remove-Item Env:YOUTUBE_API_KEY -ErrorAction SilentlyContinue
  Pop-Location
}
