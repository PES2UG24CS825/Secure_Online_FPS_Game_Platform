<#
.SYNOPSIS
    SecureFPS - Complete Remote Hosting Launcher
    Starts MongoDB verification, Flask (5000), Socket.IO (4001), Reverse Proxy (8080),
    and Cloudflare Tunnel for genuine cross-network internet multiplayer.
#>

$ErrorActionPreference = "Continue"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$logsDir = Join-Path $repoRoot "logs"
$toolsDir = Join-Path $repoRoot "tools"

if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }
if (-not (Test-Path $toolsDir)) { New-Item -ItemType Directory -Path $toolsDir | Out-Null }

Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host "     SECUREFPS - AUTHORITATIVE REMOTE HOST LAUNCHER            " -ForegroundColor Cyan
Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host "Working Directory: $repoRoot" -ForegroundColor Gray

# -----------------------------------------------------------------
# 1. PRE-FLIGHT ENVIRONMENT CHECKS
# -----------------------------------------------------------------
Write-Host "`n[STEP 1/5] Checking Runtimes..." -ForegroundColor Yellow

$nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[ERROR] Node.js is not found in PATH. Install Node.js v18+ from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Node.js: $(& node -v)" -ForegroundColor Green

$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
$pythonExe = "python"
if (Test-Path $venvPython) {
    $pythonExe = $venvPython
    Write-Host "  [OK] Python (virtualenv): $(& $pythonExe --version)" -ForegroundColor Green
} else {
    $pythonCmd = Get-Command "python" -ErrorAction SilentlyContinue
    if (-not $pythonCmd) {
        Write-Host "[ERROR] Python is not found in PATH. Install Python 3.10+ from https://python.org" -ForegroundColor Red
        exit 1
    }
    Write-Host "  [OK] Python: $(& python --version)" -ForegroundColor Green
}

# Check MongoDB
$mongoConn = Test-NetConnection -ComputerName "127.0.0.1" -Port 27017 -WarningAction SilentlyContinue
if (-not $mongoConn.TcpTestSucceeded) {
    Write-Host "  [WARN] MongoDB is not responding on port 27017." -ForegroundColor Yellow
    Write-Host "  Attempting to start MongoDB Windows service..." -ForegroundColor Yellow
    try {
        Start-Service MongoDB -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } catch {}
    $mongoRetry = Test-NetConnection -ComputerName "127.0.0.1" -Port 27017 -WarningAction SilentlyContinue
    if (-not $mongoRetry.TcpTestSucceeded) {
        Write-Host "  [ERROR] MongoDB must be running on localhost:27017." -ForegroundColor Red
        Write-Host "  Please start MongoDB service: net start MongoDB" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  [OK] MongoDB is active on 127.0.0.1:27017." -ForegroundColor Green

# -----------------------------------------------------------------
# 2. CONFIGURE ENVIRONMENT VARIABLES
# -----------------------------------------------------------------
$env:APP_ENV = "development"
$env:SECUREFPS_ENABLE_DEMO = "1"
$env:NUM_PROXIES = "1"
$env:MATCH_SCORE_LIMIT = "10"
$env:FLASK_PORT = "5000"
$env:SOCKET_PORT = "4001"
$env:PROXY_PORT = "8080"
$env:GAME_SERVER_SECRET = "securefps-multiplayer-secret-key-2026"

# -----------------------------------------------------------------
# 3. LAUNCH LOCAL SERVICES (FLASK, MULTIPLAYER, PROXY)
# -----------------------------------------------------------------
Write-Host "`n[STEP 2/5] Starting Backend Services..." -ForegroundColor Yellow

# A. Flask on port 5000
$flaskOut = Join-Path $logsDir "flask.out.log"
$flaskErr = Join-Path $logsDir "flask.err.log"
$flaskRunning = Test-NetConnection -ComputerName "127.0.0.1" -Port 5000 -WarningAction SilentlyContinue
if (-not $flaskRunning.TcpTestSucceeded) {
    Write-Host "  Starting Flask Web Application on port 5000..." -ForegroundColor Gray
    Start-Process -FilePath $pythonExe -ArgumentList "backend/app.py" -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $flaskOut -RedirectStandardError $flaskErr -WindowStyle Hidden
} else {
    Write-Host "  Flask is already running on port 5000." -ForegroundColor Gray
}

# B. Multiplayer Server on port 4001
$mpOut = Join-Path $logsDir "multiplayer.out.log"
$mpErr = Join-Path $logsDir "multiplayer.err.log"
$mpRunning = Test-NetConnection -ComputerName "127.0.0.1" -Port 4001 -WarningAction SilentlyContinue
if (-not $mpRunning.TcpTestSucceeded) {
    Write-Host "  Starting Authoritative Multiplayer Server on port 4001..." -ForegroundColor Gray
    Start-Process -FilePath "node" -ArgumentList "multiplayer-server/server.js" -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $mpOut -RedirectStandardError $mpErr -WindowStyle Hidden
} else {
    Write-Host "  Multiplayer server is already running on port 4001." -ForegroundColor Gray
}

# C. Reverse Proxy on port 8080
$proxyOut = Join-Path $logsDir "proxy.out.log"
$proxyErr = Join-Path $logsDir "proxy.err.log"
$proxyRunning = Test-NetConnection -ComputerName "127.0.0.1" -Port 8080 -WarningAction SilentlyContinue
if (-not $proxyRunning.TcpTestSucceeded) {
    Write-Host "  Starting Reverse Proxy (Unified Port 8080)..." -ForegroundColor Gray
    Start-Process -FilePath "node" -ArgumentList "reverse-proxy/proxy.js" -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $proxyOut -RedirectStandardError $proxyErr -WindowStyle Hidden
} else {
    Write-Host "  Reverse Proxy is already running on port 8080." -ForegroundColor Gray
}

# Wait for proxy ready
Start-Sleep -Seconds 2
$proxyCheck = Test-NetConnection -ComputerName "127.0.0.1" -Port 8080 -WarningAction SilentlyContinue
if ($proxyCheck.TcpTestSucceeded) {
    Write-Host "  [OK] Local Services running: Flask (5000), Socket.IO (4001), Reverse Proxy (8080)" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Reverse proxy did not respond immediately. Check $proxyErr" -ForegroundColor Yellow
}

# -----------------------------------------------------------------
# 4. VERIFY / DOWNLOAD CLOUDFLARE TUNNEL (cloudflared)
# -----------------------------------------------------------------
Write-Host "`n[STEP 3/5] Verifying Cloudflare Tunnel..." -ForegroundColor Yellow

$localCloudflared = Join-Path $toolsDir "cloudflared.exe"
$cfCmd = Get-Command "cloudflared" -ErrorAction SilentlyContinue
$cfExe = $null

if ($cfCmd) {
    $cfExe = $cfCmd.Source
} elseif (Test-Path $localCloudflared) {
    $cfExe = $localCloudflared
} else {
    Write-Host "  Downloading official cloudflared binary to ./tools/..." -ForegroundColor Gray
    $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    try {
        curl.exe -L -f --output $localCloudflared $downloadUrl
        if (Test-Path $localCloudflared) {
            $cfExe = $localCloudflared
        }
    } catch {
        Write-Host "  [ERROR] Failed to download cloudflared: $_" -ForegroundColor Red
    }
}

if (-not $cfExe) {
    Write-Host "  [WARN] cloudflared is not ready. You can test locally via:" -ForegroundColor Yellow
    Write-Host "    http://localhost:8080" -ForegroundColor White
    Write-Host "  To run the tunnel manually, download cloudflared.exe into ./tools/ and run:" -ForegroundColor Yellow
    Write-Host "    .\tools\cloudflared.exe tunnel --url http://localhost:8080" -ForegroundColor White
    exit 0
}

# -----------------------------------------------------------------
# 5. START TUNNEL AND EXTRACT PUBLIC HTTPS URL
# -----------------------------------------------------------------
Write-Host "`n[STEP 4/5] Launching Cloudflare Tunnel (Target: http://localhost:8080)..." -ForegroundColor Yellow

$tunnelOut = Join-Path $logsDir "tunnel.out.log"
$tunnelErr = Join-Path $logsDir "tunnel.err.log"
# Stop previous tunnel instance if running
Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Process -FilePath $cfExe -ArgumentList "tunnel", "--url", "http://localhost:8080" `
    -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelErr -WindowStyle Hidden

Write-Host "  Acquiring public HTTPS URL (waiting up to 10s)..." -ForegroundColor Gray

$publicUrl = $null
for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 500
    foreach ($logFile in @($tunnelErr, $tunnelOut)) {
        if (Test-Path $logFile) {
            $logContent = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
            if ($logContent -match "(https://[a-zA-Z0-9-]+\.trycloudflare\.com)") {
                $publicUrl = $matches[1]
                break
            }
        }
    }
    if ($publicUrl) { break }
}

Write-Host "`n===============================================================" -ForegroundColor Green
if ($publicUrl) {
    Write-Host "  PUBLIC HTTPS MULTIPLAYER URL ACQUIRED:" -ForegroundColor Green
    Write-Host "  $publicUrl" -ForegroundColor Cyan
} else {
    Write-Host "  Tunnel launched in background. Check log for public URL:" -ForegroundColor Yellow
    Write-Host "  Get-Content logs/tunnel.err.log | Select-String 'trycloudflare.com'" -ForegroundColor White
}
Write-Host "===============================================================" -ForegroundColor Green

$displayUrl = if ($publicUrl) { $publicUrl } else { "http://localhost:8080" }
$joinerUrl = if ($publicUrl) { $publicUrl } else { "http://localhost:8080 (or public URL)" }

Write-Host @"

  INSTRUCTIONS FOR HOST (Player 1):
  1. Open the URL in your browser:
     $displayUrl
  2. Log in with your player account.
  3. Go to Game Hub -> CyberStrike 3D -> MULTIPLAYER ARENA.
  4. Click 'CREATE NEW LOBBY'.
  5. Note the 6-character room code (e.g. RJAM5V).

  INSTRUCTIONS FOR JOINER (Player 2 on different network/location):
  1. Open the public HTTPS URL:
     $joinerUrl
  2. Log into their own account (MFA works automatically).
  3. Go to MULTIPLAYER ARENA.
  4. Enter the host's 6-character room code and click 'JOIN'.
  5. Click 'SET READY'.

  MATCH COMMENCEMENT:
  - When both operators are READY, Host clicks 'START MATCH (HOST)'.
  - Server arbitrates 30Hz physics, hit detection, 10 kills limit, and 8:00 timer.
  - To stop all hosting services, run:
    powershell scripts/stop_all.ps1

===============================================================
"@ -ForegroundColor White
