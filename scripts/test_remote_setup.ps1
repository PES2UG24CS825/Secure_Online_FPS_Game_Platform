<# .SYNOPSIS
Checks Flask, MongoDB, Socket.IO, and reverse proxy routing.
#>
param(
    [switch]$Quiet, [switch]$AsResult, [string]$PublicUrl,
    [ValidateRange(1024, 65535)][int]$FlaskPort = 5000,
    [ValidateRange(1024, 65535)][int]$SocketPort = 4001
)

function Test-ServiceHealth($name, $url, $expectedStatus, [switch]$Database) {
    $healthy = $false
    try {
        $response = Invoke-RestMethod -Uri $url -TimeoutSec 4 -ErrorAction Stop
        $healthy = $response.status -eq $expectedStatus -and (-not $Database -or $response.database -eq 'connected')
    } catch {
        if (-not $Quiet) { Write-Host "$name check failed ($($_.Exception.Message))." }
    }
    if (-not $Quiet) {
        $message = if ($healthy) { 'passed' } else { 'failed' }
        Write-Host "$name $message."
    }
    return $healthy
}

function Test-GameWebSocket($url) {
    $client = [Net.WebSockets.ClientWebSocket]::new()
    $timeout = [Threading.CancellationTokenSource]::new(4000)
    $healthy = $false
    try {
        $uri = [uri]($url + '/socket.io/?EIO=4&transport=websocket')
        $client.ConnectAsync($uri, $timeout.Token).GetAwaiter().GetResult() | Out-Null
        $packet = [byte[]]::new(4096)
        $received = $client.ReceiveAsync([ArraySegment[byte]]::new($packet), $timeout.Token).GetAwaiter().GetResult()
        $healthy = $received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Text -and
            [Text.Encoding]::UTF8.GetString($packet, 0, $received.Count).StartsWith('0{')
    } catch {
        if (-not $Quiet) { Write-Host "Game WebSocket check failed ($($_.Exception.Message))." }
    } finally {
        $client.Dispose()
        $timeout.Dispose()
    }
    if (-not $Quiet) { Write-Host $(if ($healthy) { 'Game WebSocket passed.' } else { 'Game WebSocket failed.' }) }
    return $healthy
}

$checks = if ($PublicUrl) {
    @(
        (Test-ServiceHealth 'Public Flask and MongoDB' "$PublicUrl/api/health" 'ok' -Database)
        (Test-ServiceHealth 'Public multiplayer' "$PublicUrl/status" 'online')
        (Test-GameWebSocket ($PublicUrl -replace '^https:', 'wss:'))
    )
} else {
    @(
        (Test-ServiceHealth 'Reverse proxy' 'http://127.0.0.1:8080/proxy-health' 'healthy')
        (Test-ServiceHealth 'Flask and MongoDB' "http://127.0.0.1:$FlaskPort/api/health" 'ok' -Database)
        (Test-ServiceHealth 'Multiplayer' "http://127.0.0.1:$SocketPort/status" 'online')
        (Test-ServiceHealth 'Proxied Flask and MongoDB' 'http://127.0.0.1:8080/api/health' 'ok' -Database)
        (Test-ServiceHealth 'Proxied multiplayer' 'http://127.0.0.1:8080/status' 'online')
        (Test-GameWebSocket 'ws://127.0.0.1:8080')
    )
}
$passed = @($checks | Where-Object { $_ }).Count
if (-not $Quiet) { Write-Host "$passed of $($checks.Count) health checks passed." }
if ($Quiet -or $AsResult) { return ($passed -eq $checks.Count) }
if ($passed -ne $checks.Count) { exit 1 }
