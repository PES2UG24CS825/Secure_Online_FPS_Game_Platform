<#
.SYNOPSIS
    Starts SecureFPS on loopback. Use -PublicTunnel to start a production HTTPS tunnel.
#>
param(
    [switch]$PublicTunnel,
    [ValidateRange(1024, 65535)][int]$FlaskPort = 5000,
    [ValidateRange(1024, 65535)][int]$SocketPort = 4001
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logsDir = Join-Path $repoRoot 'logs'
$statePath = Join-Path $logsDir 'host-processes.json'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

if (Test-Path -LiteralPath $statePath) {
    throw 'A launcher state file already exists. Run scripts/stop_all.ps1 first.'
}

$pythonExe = Join-Path $repoRoot '.venv\Scripts\python.exe'
if (Test-Path -LiteralPath $pythonExe) {
    # Windows venv executables launch a second Python process. Use the base
    # interpreter with the environment's packages so the recorded PID owns Flask.
    $pythonInfo = & $pythonExe -c "import json, sys, sysconfig; print(json.dumps([sys._base_executable, sysconfig.get_path('purelib')]))" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $pythonInfo) { throw 'Could not resolve the Python virtual environment.' }
    $pythonExe = $pythonInfo[0]
    $pythonPackages = $pythonInfo[1]
} else {
    $pythonExe = (Get-Command python -CommandType Application).Source
}
$nodeExe = (Get-Command node -CommandType Application).Source
$cloudflared = $null
if ($PublicTunnel) {
    $command = Get-Command cloudflared -CommandType Application -ErrorAction SilentlyContinue
    $cloudflared = if ($command) { $command.Source } else { Join-Path $repoRoot 'tools\cloudflared.exe' }
    if (-not (Test-Path -LiteralPath $cloudflared)) {
        throw 'Cloudflared is missing. Run scripts/setup_tunnel.ps1 first.'
    }
}

if ($FlaskPort -eq $SocketPort -or 8080 -in @($FlaskPort, $SocketPort)) { throw 'Each service requires a distinct port.' }
foreach ($port in @($FlaskPort, $SocketPort, 8080)) {
    $connection = [Net.Sockets.TcpClient]::new()
    try {
        $connection.Connect('127.0.0.1', $port)
        throw "Required port $port is already serving connections."
    } catch [Net.Sockets.SocketException] {
        if ($_.Exception.SocketErrorCode -ne [Net.Sockets.SocketError]::ConnectionRefused) { throw }
    } finally {
        $connection.Dispose()
    }
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    try {
        $probe.Server.ExclusiveAddressUse = $true
        $probe.Start()
    } catch {
        throw "Required port $port is unavailable. Free it before launching SecureFPS."
    } finally {
        $probe.Stop()
    }
}

$settings = @{
    APP_ENV = $(if ($PublicTunnel) { 'production' } else { 'development' })
    FLASK_ENV = $(if ($PublicTunnel) { 'production' } else { 'development' })
    NODE_ENV = $(if ($PublicTunnel) { 'production' } else { 'development' })
    SECUREFPS_LOCAL_DEV = '0'
    SECUREFPS_ENABLE_DEMO = '0'
    FLASK_DEBUG = '0'
    ALLOW_ANONYMOUS = 'false'
    NUM_PROXIES = '1'
    FLASK_HOST = '127.0.0.1'
    FLASK_PORT = [string]$FlaskPort
    HOST = '127.0.0.1'
    PORT = [string]$SocketPort
    SOCKET_HOST = '127.0.0.1'
    SOCKET_PORT = [string]$SocketPort
    PROXY_HOST = '127.0.0.1'
    PROXY_PORT = '8080'
    TRUST_CLOUDFLARE_TUNNEL = $(if ($PublicTunnel) { '1' } else { '0' })
    FLASK_INTERNAL_URL = "http://127.0.0.1:$FlaskPort"
    GAME_SERVER_URL = "http://127.0.0.1:$SocketPort"
}
if ($pythonPackages) {
    $settings.PYTHONPATH = (@($pythonPackages, $env:PYTHONPATH) | Where-Object { $_ }) -join [IO.Path]::PathSeparator
}
$previous = @{}
$processes = @()
$records = @()

function Start-SecureFPSProcess($name, $executable, $arguments) {
    Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $repoRoot `
        -RedirectStandardOutput (Join-Path $logsDir "$name.out.log") `
        -RedirectStandardError (Join-Path $logsDir "$name.err.log") -WindowStyle Hidden -PassThru
}

function Save-ProcessState {
    ConvertTo-Json -InputObject $records | Set-Content -LiteralPath $statePath -Encoding UTF8
}

try {
    foreach ($key in $settings.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
    }
    foreach ($service in @(
        @{ Name = 'flask'; Executable = $pythonExe; Arguments = 'backend/app.py' }
        @{ Name = 'multiplayer'; Executable = $nodeExe; Arguments = 'multiplayer-server/server.js' }
        @{ Name = 'proxy'; Executable = $nodeExe; Arguments = 'reverse-proxy/proxy.js' }
    )) {
        $process = Start-SecureFPSProcess $service.Name $service.Executable $service.Arguments
        $processes += $process
        $records += @{ Name = $service.Name; Id = $process.Id; Started = $process.StartTime.ToUniversalTime().Ticks.ToString() }
        Save-ProcessState
    }

    $check = Join-Path $PSScriptRoot 'test_remote_setup.ps1'
    $ready = $false
    foreach ($attempt in 1..12) {
        if (@($processes | Where-Object HasExited).Count) {
            throw "A SecureFPS service exited during startup. Inspect $logsDir."
        }
        $ready = & $check -Quiet -FlaskPort $FlaskPort -SocketPort $SocketPort
        if ($ready) { break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        & $check -AsResult -FlaskPort $FlaskPort -SocketPort $SocketPort | Out-Null
        throw "Required health checks failed. Inspect $logsDir."
    }

    if (-not $PublicTunnel) {
        Write-Host 'SecureFPS is ready at http://127.0.0.1:8080'
        return
    }

    $tunnel = Start-SecureFPSProcess 'tunnel' $cloudflared @('tunnel', '--url', 'http://127.0.0.1:8080')
    $processes += $tunnel
    $records += @{ Name = 'tunnel'; Id = $tunnel.Id; Started = $tunnel.StartTime.ToUniversalTime().Ticks.ToString() }
    Save-ProcessState

    foreach ($attempt in 1..24) {
        if ($tunnel.HasExited) { break }
        $logs = Get-Content -LiteralPath (Join-Path $logsDir 'tunnel.err.log') -Raw -ErrorAction SilentlyContinue
        if ($logs -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
            $publicUrl = $Matches[0]
            if (& $check -Quiet -PublicUrl $publicUrl) {
                Write-Host "SecureFPS is ready at $publicUrl"
                return
            }
        }
        Start-Sleep -Seconds 1
    }
    throw "The public tunnel failed its health checks. Inspect $logsDir."
} catch {
    & (Join-Path $PSScriptRoot 'stop_all.ps1')
    throw
} finally {
    foreach ($key in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
    }
}
