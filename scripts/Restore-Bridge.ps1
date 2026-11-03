#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param([Parameter(Mandatory)][string]$InstallationPath)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Bridge.Common.psm1') -Force
$InstallationPath = Get-PhysicalFile $InstallationPath
$receipt = Get-Content -LiteralPath $InstallationPath -Raw | ConvertFrom-Json
if ($receipt.Status -eq 'restored') { Write-Output 'Already restored.'; return }
if ($receipt.Status -notin @('prepared','enabled')) { throw 'Unknown installation state; inspect before restoring.' }
foreach ($entry in $receipt.Entries) {
    if ((Get-BridgeHash $entry.ActivePath) -notin @($entry.InstalledSha256,$entry.BeforeSha256) -or
        (Get-BridgeHash $entry.BackupPath) -ne $entry.BeforeSha256) {
        throw 'Shortcut or original backup changed; inspect it before restoring.'
    }
    if ($entry.OuterPath -ne $entry.ActivePath -and (Get-BridgeHash $entry.OuterPath) -ne $entry.OuterSha256) {
        throw 'Outer wrapper changed; inspect before restoring.'
    }
}
if (-not $PSCmdlet.ShouldProcess($receipt.Destination, 'Restore only this bridge base URL and selected shortcut snapshots')) { return }
Invoke-BridgeConfigEdit $receipt 'restore'
foreach ($entry in $receipt.Entries) {
    if ((Get-BridgeHash $entry.ActivePath) -eq $entry.InstalledSha256) {
        Set-BridgeFileIfUnchanged $entry.ActivePath $entry.BackupPath $entry.InstalledSha256 $entry.OuterPath $entry.OuterSha256
    }
}
$receipt.Status = 'restored'
Save-BridgeReceipt $InstallationPath $receipt
Write-Output 'Owned config/shortcut changes restored; later user config changes preserved. No process was terminated or program files deleted. Existing loaded sessions may retain their route until a normal restart.'
