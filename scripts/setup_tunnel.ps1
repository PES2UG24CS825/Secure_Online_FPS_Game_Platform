<#
.SYNOPSIS
    SecureFPS - Cloudflare Tunnel Setup Utility
    Verifies or downloads cloudflared-windows-amd64.exe into ./tools/
#>

$ErrorActionPreference = "Stop"
$toolsDir = Join-Path $PSScriptRoot "..\tools"
if (-not (Test-Path $toolsDir)) {
    New-Item -ItemType Directory -Path $toolsDir | Out-Null
}

$localCloudflared = Join-Path $toolsDir "cloudflared.exe"
$globalCloudflared = Get-Command "cloudflared" -ErrorAction SilentlyContinue

Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host "  SecureFPS - Cloudflare Tunnel Verification & Setup" -ForegroundColor Cyan
Write-Host "===============================================================" -ForegroundColor Cyan

if ($globalCloudflared) {
    Write-Host "[OK] Global cloudflared found in PATH: $($globalCloudflared.Source)" -ForegroundColor Green
    & cloudflared --version
    exit 0
}

if (Test-Path $localCloudflared) {
    Write-Host "[OK] Local cloudflared found at: $localCloudflared" -ForegroundColor Green
    & $localCloudflared --version
    exit 0
}

Write-Host "[INFO] cloudflared is not installed. Downloading official release..." -ForegroundColor Yellow
$downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

try {
    Write-Host "Downloading from: $downloadUrl" -ForegroundColor Gray
    curl.exe -L -f --output $localCloudflared $downloadUrl
    if (Test-Path $localCloudflared) {
        Write-Host "[SUCCESS] Downloaded cloudflared to: $localCloudflared" -ForegroundColor Green
        & $localCloudflared --version
    } else {
        throw "Download failed or output binary not found."
    }
} catch {
    Write-Host "[ERROR] Could not automatically download cloudflared: $_" -ForegroundColor Red
    Write-Host "Please manually download cloudflared.exe from:" -ForegroundColor Yellow
    Write-Host "  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -ForegroundColor White
    Write-Host "And place it inside: $localCloudflared" -ForegroundColor White
    exit 1
}
