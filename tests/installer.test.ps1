#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory,[Parameter(Mandatory)][string]$ProxyUri,[Parameter(Mandatory)][string]$PythonPath,[string]$NodePath)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $WorkDirectory){throw 'Use a new external test directory.'}
$skillRoot=Split-Path -Parent $PSScriptRoot
$scripts=Join-Path $skillRoot 'scripts'
Import-Module (Join-Path $scripts 'Bridge.Common.psm1') -Force
$null=Assert-BridgeDestination $WorkDirectory (Join-Path $WorkDirectory 'codex-home')
New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$hostSource=Join-Path $WorkDirectory 'Host.cs'
[IO.File]::WriteAllText($hostSource,@'
using System; using System.IO; using System.Threading;
class Program { [STAThread] static void Main() { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"host-started.txt"),DateTimeOffset.Now.ToString("o")); Thread.Sleep(8000); } }
'@)
$hostExe=Join-Path $WorkDirectory 'lzc-bridge-host-fixture.exe'
& $compiler /nologo /target:winexe "/out:$hostExe" $hostSource
if($LASTEXITCODE -ne 0){throw 'Fixture host compilation failed.'}
$wrapperSource=Join-Path $WorkDirectory 'Wrapper.cs'
[IO.File]::WriteAllText($wrapperSource,@'
using System; using System.Diagnostics;
class Program { [STAThread] static void Main(string[] args) { if(args.Length==2 && args[0]=="--shortcut") Process.Start(new ProcessStartInfo(args[1]) { UseShellExecute=true }); } }
'@)
$wrapper=Join-Path $WorkDirectory 'QuotaOrb.Launcher.exe'
& $compiler /nologo /target:winexe "/out:$wrapper" $wrapperSource
if($LASTEXITCODE -ne 0){throw 'Fixture wrapper compilation failed.'}
$links=Join-Path $WorkDirectory 'linked-shortcuts';$backupLinks=Join-Path $WorkDirectory 'shortcut-backups'
New-Item -ItemType Directory -Path $links,$backupLinks | Out-Null
$shell=New-Object -ComObject WScript.Shell
$active=Join-Path $links 'original.lnk';$link=$shell.CreateShortcut($active);$link.TargetPath=$hostExe;$link.WorkingDirectory=$WorkDirectory;$link.Save()
$oldBackup=Join-Path $backupLinks 'original.lnk';Copy-Item -LiteralPath $active -Destination $oldBackup
$outer=Join-Path $WorkDirectory '入口.lnk';$link=$shell.CreateShortcut($outer);$link.TargetPath=$wrapper;$link.Arguments='--shortcut "'+$active+'"';$link.Save()
$outerHash=Get-BridgeHash $outer;$activeHash=Get-BridgeHash $active;$backupHash=Get-BridgeHash $oldBackup
$codexHome=Join-Path $WorkDirectory 'codex-home';New-Item -ItemType Directory -Path $codexHome | Out-Null
$config=Join-Path $codexHome 'config.toml';[IO.File]::WriteAllText($config,"model = `"fixture-model`"`n")
$destination=Join-Path $WorkDirectory 'installed runtime'
$installArgs=@{Destination=$destination;ProxyUri=$ProxyUri;ShortcutPath=@($outer);CodexHome=$codexHome;PythonPath=$PythonPath;HostProcessName=@('lzc-bridge-host-fixture')}
if($NodePath){$installArgs.NodePath=$NodePath}
& (Join-Path $scripts 'Install-Bridge.ps1') @installArgs
$receiptPath=Join-Path $destination 'installation.json'
if((Get-BridgeHash $outer) -ne $outerHash -or (Get-BridgeHash $active) -ne $activeHash){throw 'Prepare modified an entry.'}
[IO.File]::AppendAllText($config,"model_reasoning_effort = `"high`"`n")
$concurrentConfig=Get-BridgeHash $config
$blocked=$false
try { & (Join-Path $scripts 'Enable-Bridge.ps1') -InstallationPath $receiptPath } catch { $blocked=$true }
if(-not $blocked -or (Get-BridgeHash $config) -ne $concurrentConfig -or (Get-BridgeHash $active) -ne $activeHash){throw 'Concurrent config edit was not preserved with shortcut rollback.'}
& (Join-Path $scripts 'Restore-Bridge.ps1') -InstallationPath $receiptPath -Confirm:$false
& (Join-Path $scripts 'Install-Bridge.ps1') @installArgs -Activate
& (Join-Path $scripts 'Test-Bridge.ps1') -InstallationPath $receiptPath
$receipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if((Get-BridgeHash $outer) -ne $outerHash -or (Get-BridgeHash $oldBackup) -ne $backupHash){throw 'Wrapper or inactive backup was changed.'}
if((Read-BridgeShortcut $active).Target -ne $receipt.Entries[0].LauncherPath){throw 'Actual active snapshot was not installed.'}
$enabledConfig=Get-BridgeHash $config;$enabledLink=Get-BridgeHash $active
& (Join-Path $scripts 'Enable-Bridge.ps1') -InstallationPath $receiptPath
if((Get-BridgeHash $config) -ne $enabledConfig -or (Get-BridgeHash $active) -ne $enabledLink){throw 'Repeated activation changed owned files.'}
[IO.File]::AppendAllText($config,"model_verbosity = `"low`"`n")
& (Join-Path $scripts 'Restore-Bridge.ps1') -InstallationPath $receiptPath -WhatIf
if((Get-BridgeHash $active) -ne $enabledLink){throw 'WhatIf modified a shortcut.'}
& (Join-Path $scripts 'Restore-Bridge.ps1') -InstallationPath $receiptPath -Confirm:$false
if((Get-BridgeHash $active) -ne $activeHash -or (Get-BridgeHash $outer) -ne $outerHash -or (Get-BridgeHash $oldBackup) -ne $backupHash){throw 'Shortcut restoration did not preserve originals.'}
$text=Get-Content -LiteralPath $config -Raw
if($text -match '(?m)^openai_base_url\s*=' -or $text -notmatch 'model_verbosity = "low"' -or $text -notmatch 'model_reasoning_effort = "high"'){throw 'Restore lost unrelated config or retained the bridge URL.'}
$deadline=[DateTime]::UtcNow.AddSeconds(25)
do {
    $ready=$false;try{$ready=(Get-BridgeHealth $receipt.Port).ready}catch{}
    if(-not $ready){break};Start-Sleep -Milliseconds 500
} while([DateTime]::UtcNow -lt $deadline)
if($ready){throw 'Fixture supervisor did not exit after its host ended.'}
if(-not(Test-Path -LiteralPath (Join-Path $WorkDirectory 'host-started.txt'))){throw 'Original fixture entry was not activated.'}
[pscustomobject]@{InstallerFixture='passed';ActiveSnapshotVerified=$true;InactiveBackupPreserved=$true;ConcurrentConfigPreserved=$true;RepeatedEnableStable=$true;RestorePreservesOtherSettings=$true;OwnedBridgeExited=$true;ModelRequestsSent=0} | ConvertTo-Json
