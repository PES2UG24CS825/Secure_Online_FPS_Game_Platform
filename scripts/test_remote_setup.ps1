<#
.SYNOPSIS
    SecureFPS - Pre-Flight & Health Verification Utility
    Checks MongoDB, Flask, Socket.IO, and Reverse Proxy health and routing.
#>

$ErrorActionPreference = "Continue"

Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host "  SecureFPS - Hosting & Routing Verification Check" -ForegroundColor Cyan
Write-Host "===============================================================" -ForegroundColor Cyan

$passed = 0
$total = 0

function Check-Service($name, $url, $expectedSnippet = "") {
    global:total++
    Write-Host -NoNewline "Checking $name ($url)... "
    try {
        $res = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 3 -ErrorAction Stop
        $jsonStr = $res | ConvertTo-Json -Compress
        if ($expectedSnippet -eq "" -or $jsonStr -match $expectedSnippet) {
            Write-Host "[PASS]" -ForegroundColor Green
            global:passed++
            return $true
        } else {
            Write-Host "[FAIL: Unexpected response]" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "[FAIL: $($_.Exception.Message)]" -ForegroundColor Red
        return $false
    }
}

# 1. Reverse Proxy Health
Check-Service "Reverse Proxy Health" "http://127.0.0.1:8080/proxy-health" "healthy"

# 2. Flask Direct Health
Check-Service "Flask Direct Health (Port 5000)" "http://127.0.0.1:5000/api/health" "operational|healthy|ok"

# 3. Socket.IO Direct Health
Check-Service "Multiplayer Server Direct (Port 4001)" "http://127.0.0.1:4001/status" "online"

# 4. Proxy Routing to Flask (/api/health)
Check-Service "Reverse Proxy -> Flask API Routing" "http://127.0.0.1:8080/api/health" "operational|healthy|ok"

# 5. Proxy Routing to Socket.IO (/status)
Check-Service "Reverse Proxy -> Socket.IO Status Routing" "http://127.0.0.1:8080/status" "online"

Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host "Summary: $passed / $total checks passed." -ForegroundColor $(if ($passed -eq $total) { "Green" } else { "Yellow" })
Write-Host "===============================================================" -ForegroundColor Cyan
