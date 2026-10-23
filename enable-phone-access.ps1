$ErrorActionPreference = 'Stop'
$ruleName = 'Artee Phone Server'

try {
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host 'Artee is already allowed through the Windows Firewall.'
        Start-Sleep -Seconds 2
        exit 0
    }

    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Description 'Allows the Artee phone launcher (Node.js) to serve the drawing app to the phone (USB tether fallback).' `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort 8000-8030 `
        -Profile Any | Out-Null

    Write-Host 'Done. Your phone can now connect to Artee.'
    Start-Sleep -Seconds 2
    exit 0
} catch {
    Write-Host "Could not change the firewall automatically: $($_.Exception.Message)"
    Write-Host 'No problem - when Windows Firewall asks, click "Allow access".'
    Start-Sleep -Seconds 4
    exit 1
}
