#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallationPath)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Bridge.Common.psm1') -Force
$InstallationPath = Get-PhysicalFile $InstallationPath
$receipt = Get-Content -LiteralPath $InstallationPath -Raw | ConvertFrom-Json
$component = $receipt.PSObject.Properties['Mode'] -and $receipt.Mode -eq 'component'
$supervisor = if ($receipt.PSObject.Properties['SupervisorPath']) { $receipt.SupervisorPath } else { $receipt.Entries[0].LauncherPath }
if ($receipt.PSObject.Properties['SupervisorSha256'] -and (Get-BridgeHash $supervisor) -ne $receipt.SupervisorSha256) {
    throw 'Supervisor binary differs from the installation receipt.'
}
if ($receipt.Status -notin @('prepared','enabled')) { throw 'Installation is not prepared for activation.' }
Assert-BridgeProxy $receipt.ProxyUri
foreach ($entry in $receipt.Entries) {
    $expected = if ($receipt.Status -eq 'enabled') { $entry.InstalledSha256 } else { $entry.BeforeSha256 }
    if ((Get-BridgeHash $entry.ActivePath) -ne $expected) { throw 'Active shortcut changed; do not overwrite concurrent edits.' }
    if ($entry.OuterPath -ne $entry.ActivePath -and (Get-BridgeHash $entry.OuterPath) -ne $entry.OuterSha256) {
        throw 'Outer shortcut wrapper changed; re-resolve it before activation.'
    }
    if ((Get-BridgeHash $entry.StagedPath) -ne $entry.InstalledSha256) { throw 'Prepared shortcut hash mismatch.' }
}
foreach ($property in $receipt.RuntimeSha256.PSObject.Properties) {
    if ((Get-BridgeHash (Join-Path $receipt.RuntimeRoot $property.Name)) -ne $property.Value) { throw 'Runtime source hash mismatch.' }
}
if ($receipt.Status -eq 'enabled') {
    $configState = & $receipt.PythonPath -X utf8 (Join-Path $PSScriptRoot 'config-edit.py') inspect --state $receipt.ConfigTransaction
    if ($LASTEXITCODE -ne 0 -or -not ($configState | ConvertFrom-Json).ownsSetting) {
        throw 'Previously enabled config changed; no automatic overwrite or rollback.'
    }
    if ($component) { Start-BridgeDesktopEntry $supervisor '--guard-only' }
    else { Start-BridgeDesktopEntry $receipt.Entries[0].OuterPath }
    $health = Wait-BridgeReady $receipt
    [pscustomobject]@{Status='already_enabled';Version=$receipt.Version;Port=$receipt.Port;BridgePid=$health.pid} | ConvertTo-Json
    return
}
# A normal desktop dispatcher avoids inheriting the active Agent executor's job.
Start-BridgeDesktopEntry $supervisor '--guard-only'
$health = Wait-BridgeReady $receipt
$changed = @()
$configAttempted = $false
try {
    if ($receipt.Status -eq 'prepared') {
        foreach ($entry in $receipt.Entries) {
            Set-BridgeFileIfUnchanged $entry.ActivePath $entry.StagedPath $entry.BeforeSha256 $entry.OuterPath $entry.OuterSha256
            $changed += $entry
            $actual = Resolve-BridgeShortcut $entry.OuterPath
            if ($actual.Active.Target -ne $entry.LauncherPath -or $actual.Active.Arguments -ne '' -or
                (Get-BridgeHash $entry.ActivePath) -ne $entry.InstalledSha256) { throw 'Actual shortcut chain verification failed.' }
        }
    }
    # Verify the real outer entry, not just a manually started listener.
    if (-not $component) { Start-BridgeDesktopEntry $receipt.Entries[0].OuterPath }
    $health = Wait-BridgeReady $receipt
    $configAttempted = $true
    Invoke-BridgeConfigEdit $receipt 'apply'
    $receipt.Status = 'enabled'
    $receipt | Add-Member -NotePropertyName EnabledAt -NotePropertyValue ([DateTimeOffset]::Now.ToString('o')) -Force
    Save-BridgeReceipt $InstallationPath $receipt
} catch {
    $canRestoreLinks = $true
    if ($configAttempted) {
        & $receipt.PythonPath -X utf8 (Join-Path $PSScriptRoot 'config-edit.py') restore --state $receipt.ConfigTransaction
        $canRestoreLinks = $LASTEXITCODE -eq 0
    }
    if ($canRestoreLinks) {
        foreach ($entry in $changed) {
            if ((Get-BridgeHash $entry.ActivePath) -eq $entry.InstalledSha256) {
                Set-BridgeFileIfUnchanged $entry.ActivePath $entry.BackupPath $entry.InstalledSha256 $entry.OuterPath $entry.OuterSha256
            }
        }
    }
    throw
}
[pscustomobject]@{Version=$receipt.Version;Port=$receipt.Port;BridgePid=$health.pid;
    Status='enabled';ColdRestartVerified=$false;ModelReplyVerified=$false;
    NextStep='Finish current work, fully exit Codex, and reopen the selected original shortcut. Verify a real reply afterward.'} | ConvertTo-Json
