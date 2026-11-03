#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallationPath, [switch]$ProbeUpstream)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Bridge.Common.psm1') -Force
$InstallationPath = Get-PhysicalFile $InstallationPath
$receipt = Get-Content -LiteralPath $InstallationPath -Raw | ConvertFrom-Json
$hashProblems = @()
foreach ($property in $receipt.RuntimeSha256.PSObject.Properties) {
    $file = Join-Path $receipt.RuntimeRoot $property.Name
    if (-not (Test-Path -LiteralPath $file) -or (Get-BridgeHash $file) -ne $property.Value) { $hashProblems += $property.Name }
}
if ($receipt.PSObject.Properties['SupervisorSha256'] -and
    (Get-BridgeHash $receipt.SupervisorPath) -ne $receipt.SupervisorSha256) { $hashProblems += 'supervisor' }
$entries = @($receipt.Entries | ForEach-Object {
    $actual = Resolve-BridgeShortcut $_.OuterPath
    [pscustomobject]@{Entry=$_.OuterPath;ActiveSnapshot=$actual.Active.Path;
        ExpectedLauncher=($actual.Active.Target -eq $_.LauncherPath);ExpectedArguments=($actual.Active.Arguments -eq '')}
})
$health = $null
try { $health = Get-BridgeHealth $receipt.Port } catch { }
$ready = $null -ne $health -and $health.ready -eq $true -and
    $health.service -eq 'codex-transport-bridge' -and $health.version -eq $receipt.Version -and
    $health.instanceId -eq $receipt.InstanceId
$configState = & $receipt.PythonPath -X utf8 (Join-Path $PSScriptRoot 'config-edit.py') inspect --state $receipt.ConfigTransaction
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the configured base URL.' }
$owned = ($configState | ConvertFrom-Json).ownsSetting
[pscustomobject]@{Status=$receipt.Status;Version=$receipt.Version;Port=$receipt.Port;Ready=$ready;
    RuntimeHashProblems=$hashProblems;ConfigUsesThisBridge=$owned;Shortcuts=$entries;
    BridgePid=$(if($null -ne $health){$health.pid}else{$null});
    ColdRestartVerified=$receipt.ColdRestartVerified;ModelReplyVerified=$receipt.ModelReplyVerified;
    Note='Readiness and configured routing do not prove a loaded chat uses this endpoint. Correlate its connection log and real reply.'} | ConvertTo-Json -Depth 6
if ($hashProblems.Count -gt 0) { throw 'Runtime files differ from the installation receipt.' }
if ($receipt.Status -eq 'enabled' -and (-not $ready -or -not $owned -or @($entries | Where-Object { -not $_.ExpectedLauncher -or -not $_.ExpectedArguments }).Count -gt 0)) {
    throw 'Enabled installation is inconsistent. Inspect the reported boundary before changing anything.'
}
if ($ProbeUpstream) {
    if (-not $ready) { throw 'The expected bridge instance must be ready before a network probe.' }
    & $receipt.NodePath (Join-Path $PSScriptRoot 'probe-upstream.mjs') --installation $InstallationPath
    if ($LASTEXITCODE -ne 0) { throw 'Upstream liveness verification failed; no model request was sent.' }
}
