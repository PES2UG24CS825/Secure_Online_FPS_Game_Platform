<#
.SYNOPSIS
    SecureFPS - Graceful Shutdown Utility
    Stops Flask (port 5000), Multiplayer (port 4001), Reverse Proxy (port 8080), and Cloudflare Tunnel.
#>

$ports = @(5000, 4001, 8080)
$services = @("Flask Backend", "Socket.IO Server", "Reverse Proxy")

Write-Host "===============================================================" -ForegroundColor Yellow
Write-Host "  SecureFPS - Stopping All Hosting Services" -ForegroundColor Yellow
Write-Host "===============================================================" -ForegroundColor Yellow

# 1. Stop Cloudflare Tunnel
$cfProcesses = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
if ($cfProcesses) {
    Write-Host "[STOP] Stopping Cloudflare Tunnel process..." -ForegroundColor Yellow
    $cfProcesses | Stop-Process -Force
    Write-Host "[OK] Cloudflare Tunnel stopped." -ForegroundColor Green
} else {
    Write-Host "[INFO] No running cloudflared process found." -ForegroundColor Gray
}

# 2. Stop services listening on ports 5000, 4001, 8080
for ($i = 0; $i -lt $ports.Length; $i++) {
    $port = $ports[$i]
    $service = $services[$i]
    $foundPids = @()

    try {
        $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($connections) {
            $foundPids += ($connections.OwningProcess | Select-Object -Unique)
        }
    } catch {}

    if (-not $foundPids) {
        try {
            $lines = netstat.exe -ano | Select-String ":$port\s+.*LISTENING\s+(\d+)"
            foreach ($line in $lines) {
                if ($line.Matches[0].Groups[1].Value) {
                    $foundPids += [int]$line.Matches[0].Groups[1].Value
                }
            }
            $foundPids = $foundPids | Select-Object -Unique
        } catch {}
    }

    if ($foundPids) {
        foreach ($p in $foundPids) {
            if ($p -gt 0 -and $p -ne $PID) {
                Write-Host "[STOP] Stopping $service (PID: $p on port $port)..." -ForegroundColor Yellow
                Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Host "[OK] $service on port $port stopped." -ForegroundColor Green
    } else {
        Write-Host "[INFO] No active process on port $port ($service)." -ForegroundColor Gray
    }
}

Write-Host "===============================================================" -ForegroundColor Green
Write-Host "  All SecureFPS hosting services have been stopped." -ForegroundColor Green
Write-Host "===============================================================" -ForegroundColor Green
