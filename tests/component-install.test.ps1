#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory,[Parameter(Mandatory)][string]$ProxyUri,[Parameter(Mandatory)][string]$PythonPath)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
if(Test-Path -LiteralPath $WorkDirectory){throw 'Use a fresh external directory.'}
New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
$codex=Join-Path $WorkDirectory 'home'
New-Item -ItemType Directory -Path $codex | Out-Null
$config=Join-Path $codex 'config.toml'
[IO.File]::WriteAllText($config,"model = `"fixture-model`"`n")
$destination=Join-Path $WorkDirectory 'component'
$args=@{ComponentOnly=$true;Destination=$destination;ProxyUri=$ProxyUri;CodexHome=$codex;PythonPath=$PythonPath;HostProcessName=@('lzc-never-running-host')}
& (Join-Path $root 'scripts/Install-Bridge.ps1') @args
$receiptPath=Join-Path $destination 'installation.json'
$receipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if($receipt.Mode -ne 'component' -or @($receipt.Entries).Count -ne 0){throw 'Component mode owns a shortcut.'}
if((Get-ChildItem -LiteralPath $destination -Recurse -Filter '*.lnk').Count -ne 0){throw 'Component installation generated shortcuts.'}
& (Join-Path $root 'scripts/Enable-Bridge.ps1') -InstallationPath $receiptPath
& (Join-Path $root 'scripts/Test-Bridge.ps1') -InstallationPath $receiptPath
& (Join-Path $root 'scripts/Install-Bridge.ps1') @args -Activate
[IO.File]::AppendAllText($config,"model_verbosity = `"low`"`n")
& (Join-Path $root 'scripts/Restore-Bridge.ps1') -InstallationPath $receiptPath -Confirm:$false
$restored=Get-Content -LiteralPath $config -Raw
if($restored -match 'openai_base_url' -or $restored -notmatch 'model_verbosity'){throw 'Restore did not preserve unrelated changes.'}
if((Get-ChildItem -LiteralPath $destination -Recurse -Filter '*.lnk').Count -ne 0){throw 'Activation generated shortcuts.'}
$blocked=$false
try { & (Join-Path $root 'scripts/Install-Bridge.ps1') @args -ShortcutPath 'unused.lnk' } catch { $blocked=$true }
if(-not $blocked){throw 'Mixed shortcut ownership was accepted.'}
Write-Output 'Component prepare/enable/reuse/restore preserved shortcut isolation and concurrent settings.'
