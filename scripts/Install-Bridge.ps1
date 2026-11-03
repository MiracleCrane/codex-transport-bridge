#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$ProxyUri,
    [string[]]$ShortcutPath = @(),
    [switch]$ComponentOnly,
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }),
    [ValidateRange(0,65535)][int]$Port = 0,
    [string]$NodePath,
    [string]$PythonPath,
    [ValidatePattern('^[A-Za-z0-9_.-]{1,80}$')][string[]]$HostProcessName = @('ChatGPT','codex'),
    [switch]$Activate
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This installer targets Windows Codex Desktop.' }
if ($ComponentOnly -and $ShortcutPath.Count -gt 0) { throw 'ComponentOnly does not own shortcuts; omit ShortcutPath.' }
if (-not $ComponentOnly -and $ShortcutPath.Count -eq 0) { throw 'Select an existing ShortcutPath, or use ComponentOnly for a managed component.' }
$mode = if ($ComponentOnly) { 'component' } else { 'standalone' }
Import-Module (Join-Path $PSScriptRoot 'Bridge.Common.psm1') -Force
$skillRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $skillRoot 'runtime\package.json') -Raw | ConvertFrom-Json
$Destination = [IO.Path]::GetFullPath($Destination)
$CodexHome = [IO.Path]::GetFullPath($CodexHome)
$Destination = Assert-BridgeDestination $Destination $CodexHome
if ($Destination.StartsWith($skillRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $Destination -eq $skillRoot -or $Destination -eq [IO.Path]::GetPathRoot($Destination)) {
    throw 'Choose a dedicated runtime directory outside the Skill/repository and filesystem root.'
}
$receiptPath = Join-Path $Destination 'installation.json'
if (Test-Path -LiteralPath $receiptPath) {
    $existing = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $existingMode = if ($existing.PSObject.Properties['Mode']) { $existing.Mode } else { 'standalone' }
    if ($existing.Status -in @('prepared','enabled') -and $existing.Version -eq $package.version -and
        $existingMode -eq $mode -and
        $existing.ProxyUri -eq $ProxyUri -and $existing.CodexHome -eq $CodexHome -and
        ($Port -eq 0 -or $existing.Port -eq $Port)) {
        $requested = @($ShortcutPath | ForEach-Object { Get-PhysicalFile $_ } | Sort-Object)
        $saved = @($existing.Entries | ForEach-Object OuterPath | Sort-Object)
        if (($requested -join "`n") -ne ($saved -join "`n")) { throw 'Existing installation uses different shortcuts.' }
        Write-Output "Reusing existing installation: $receiptPath"
        if ($Activate) { & (Join-Path $PSScriptRoot 'Enable-Bridge.ps1') -InstallationPath $receiptPath }
        return
    }
    if ($existing.Status -ne 'restored') {
        throw 'Existing installation differs. Inspect it and use Restore-Bridge before an authorized upgrade.'
    }
}
Assert-BridgeProxy $ProxyUri
$NodePath = Resolve-BridgeExecutable $NodePath 'node.exe'
$PythonPath = Resolve-BridgeExecutable $PythonPath 'python.exe'
$nodeVersion = & $NodePath --version
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion -replace '^v(\d+).*','$1') -lt 22) { throw 'Node.js 22 or newer is required.' }
& $PythonPath -I -c 'import sys,tomllib; sys.exit(0 if sys.version_info >= (3,11) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 or newer with tomllib is required.' }
$npm = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) { throw 'npm.cmd was not found beside Node.js.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is unavailable.' }
$chains = @($ShortcutPath | ForEach-Object { Resolve-BridgeShortcut $_ })
if (@($chains.Active.Path | Sort-Object -Unique).Count -ne $chains.Count) { throw 'Selected shortcuts share an active snapshot; select it only once.' }
foreach ($chain in $chains) {
    if ([IO.Path]::GetFileName($chain.Active.Target) -match '^Codex-Connected') {
        throw 'An older/manual bridge is already wrapped here. Restore its original entry before migration; do not stack bridges.'
    }
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $listener.Start(); $Port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
$instanceId = [guid]::NewGuid().ToString()
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$transaction = Join-Path $Destination ('transactions\' + $instanceId)
New-Item -ItemType Directory -Path $transaction -Force | Out-Null
if (Test-Path -LiteralPath $receiptPath) { Copy-Item -LiteralPath $receiptPath -Destination (Join-Path $transaction 'previous-installation.json') }
$runtime = Join-Path $Destination ('releases\' + $package.version)
$runtimeFiles = @(Get-ChildItem -LiteralPath (Join-Path $skillRoot 'runtime') -File)
if (Test-Path -LiteralPath $runtime) {
    foreach ($file in $runtimeFiles) {
        $installed = Join-Path $runtime $file.Name
        if (-not (Test-Path -LiteralPath $installed) -or (Get-BridgeHash $installed) -ne (Get-BridgeHash $file.FullName)) {
            throw 'Same-version runtime files differ. Preserve them and use a new destination or version.'
        }
    }
} else {
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    foreach ($file in $runtimeFiles) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $runtime $file.Name) }
}
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'node_modules\ws\package.json'))) {
    & $npm --prefix $runtime ci --ignore-scripts --no-audit --no-fund --proxy $ProxyUri --https-proxy $ProxyUri
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency installation failed; configuration and shortcuts remain unchanged.' }
}
$runtime = Split-Path -Parent (Get-PhysicalFile (Join-Path $runtime 'package.json'))
$configTransaction = Join-Path $transaction 'config-transaction.json'
$baseUrl = "http://127.0.0.1:$Port/backend-api/codex"
& $PythonPath -X utf8 (Join-Path $PSScriptRoot 'config-edit.py') prepare --state $configTransaction --config (Join-Path $CodexHome 'config.toml') --url $baseUrl
if ($LASTEXITCODE -ne 0) { throw 'Config preparation failed; no user config was changed.' }
$template = Get-Content -LiteralPath (Join-Path $skillRoot 'assets\ConnectedLauncher.cs.template') -Raw
$entries = @()
$supervisor = $null
for ($i=0; $i -lt [Math]::Max(1,$chains.Count); $i++) {
    $original = ''
    if (-not $ComponentOnly) {
        $chain = $chains[$i]
        $original = Join-Path $transaction ("original-$i.lnk")
        Copy-Item -LiteralPath $chain.Active.Path -Destination $original
        $original = Get-PhysicalFile $original
    }
    $source = Join-Path $transaction ("ConnectedLauncher-$i.cs")
    $launcher = Join-Path $transaction ("Codex-Connected-$i.exe")
    $replacements = @{
        '@@RUNTIME_ROOT@@'=$runtime; '@@NODE_PATH@@'=$NodePath; '@@ORIGINAL_SHORTCUT@@'=$original;
        '@@PORT@@'=[string]$Port; '@@VERSION@@'=$package.version; '@@PROXY_URI@@'=$ProxyUri; '@@INSTANCE_ID@@'=$instanceId
    }
    $code = $template
    foreach ($key in $replacements.Keys) { $code = $code.Replace($key, $replacements[$key].Replace('"','""')) }
    $hostNames = ($HostProcessName | ForEach-Object { '"' + ($_ -replace '\.exe$','') + '"' }) -join ', '
    $code = $code.Replace('@@HOST_PROCESS_NAMES@@', $hostNames)
    if ($code -match '@@[A-Z_]+@@') { throw 'Unresolved launcher template parameter.' }
    [IO.File]::WriteAllText($source, $code, [Text.UTF8Encoding]::new($false))
    & $compiler /nologo /target:winexe /optimize+ /codepage:65001 /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll "/out:$launcher" $source
    if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed; no user entry was changed.' }
    $launcher = Get-PhysicalFile $launcher
    if ($i -eq 0) { $supervisor = $launcher }
    if ($ComponentOnly) { continue }
    $stagedLink = Join-Path $transaction ("installed-$i.lnk")
    New-BridgeShortcut $stagedLink $launcher $chain.Active
    $entries += [pscustomobject]@{
        OuterPath=$chain.Outer.Path; OuterSha256=$chain.Outer.Sha256; ActivePath=$chain.Active.Path;
        BeforeSha256=$chain.Active.Sha256; BackupPath=$original; LauncherPath=$launcher;
        StagedPath=(Get-PhysicalFile $stagedLink); InstalledSha256=(Get-BridgeHash $stagedLink)
    }
}
$hashes = @{}
foreach ($file in $runtimeFiles) { $hashes[$file.Name] = Get-BridgeHash (Join-Path $runtime $file.Name) }
$receipt = [pscustomobject]@{
    FormatVersion=1; Status='prepared'; Mode=$mode; Version=$package.version; InstanceId=$instanceId;
    PreparedAt=[DateTimeOffset]::Now.ToString('o'); Destination=$Destination; RuntimeRoot=$runtime;
    ProxyUri=$ProxyUri; Port=$Port; BaseUrl=$baseUrl; CodexHome=$CodexHome;
    NodePath=$NodePath; PythonPath=$PythonPath; ConfigTransaction=(Get-PhysicalFile $configTransaction);
    Entries=$entries; SupervisorPath=$supervisor; SupervisorSha256=(Get-BridgeHash $supervisor);
    RuntimeSha256=$hashes; ColdRestartVerified=$false; ModelReplyVerified=$false;
    LauncherLog=(Join-Path $runtime ("launcher-$instanceId.log")); EventLog=(Join-Path $runtime ("transport-events-$instanceId.jsonl"))
}
Save-BridgeReceipt $receiptPath $receipt
Write-Output "Prepared bridge $($package.version): $receiptPath"
if ($Activate) { & (Join-Path $PSScriptRoot 'Enable-Bridge.ps1') -InstallationPath $receiptPath }
else { Write-Output 'Config and shortcuts are unchanged. Run Enable-Bridge.ps1 with this receipt when activation is authorized.' }
