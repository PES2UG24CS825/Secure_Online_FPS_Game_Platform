#Requires -RunAsAdministrator

$ruleName = "SecureFPS demo TCP 5000 (Private)"
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($null -eq $rule) {
    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Description "Allow SecureFPS demo HTTP traffic on private networks only." `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort 5000 `
        -Action Allow `
        -Profile Private | Out-Null
} else {
    Set-NetFirewallRule -DisplayName $ruleName -Enabled True -Profile Private -Direction Inbound -Action Allow
}

Write-Host "SecureFPS inbound TCP port 5000 is allowed on the Private profile only."
