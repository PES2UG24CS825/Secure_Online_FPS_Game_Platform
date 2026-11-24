<# .SYNOPSIS
Stops only processes recorded by the SecureFPS launcher.
#>
$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot '..\logs\host-processes.json'
if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Host 'No SecureFPS launcher processes are registered.'
    return
}

$records = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
foreach ($record in $records) {
    $process = Get-Process -Id $record.Id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.Started) {
        Stop-Process -InputObject $process -Force
        Write-Host "Stopped $($record.Name) (PID $($record.Id))."
    }
}
Remove-Item -LiteralPath $statePath
