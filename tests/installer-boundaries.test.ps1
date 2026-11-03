#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $WorkDirectory){throw 'Use a new external test directory.'}
$skillRoot=Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $skillRoot 'scripts\Bridge.Common.psm1') -Force
$null=Assert-BridgeDestination $WorkDirectory (Join-Path $WorkDirectory 'codex-home')
New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
$repo=Join-Path $WorkDirectory 'repository';New-Item -ItemType Directory -Path (Join-Path $repo '.git') -Force | Out-Null
$physical=Join-Path $WorkDirectory 'physical-skills';New-Item -ItemType Directory -Path $physical | Out-Null
$alias=Join-Path $WorkDirectory 'discovery-alias';New-Item -ItemType Junction -Path $alias -Target $physical | Out-Null
foreach($target in @((Join-Path $repo 'generated-runtime'),(Join-Path $physical 'runtime'),(Join-Path $alias 'runtime'))){
    $blocked=$false;try{$null=Assert-BridgeDestination $target (Join-Path $WorkDirectory 'codex-home') @($alias)}catch{$blocked=$true}
    if(-not $blocked){throw 'Repository/discovery destination was accepted.'}
}
$target=Join-Path $WorkDirectory 'active.lnk';$source=Join-Path $WorkDirectory 'prepared.lnk';$outer=Join-Path $WorkDirectory 'outer.lnk'
[IO.File]::WriteAllText($target,'original');[IO.File]::WriteAllText($source,'bridge');[IO.File]::WriteAllText($outer,'wrapper')
$oldHash=Get-BridgeHash $target;$outerHash=Get-BridgeHash $outer
[IO.File]::WriteAllText($target,'concurrent-user-change')
$blocked=$false;try{Set-BridgeFileIfUnchanged $target $source $oldHash $outer $outerHash}catch{$blocked=$true}
if(-not $blocked -or [IO.File]::ReadAllText($target) -ne 'concurrent-user-change'){throw 'Concurrent active entry was overwritten.'}
[IO.File]::WriteAllText($target,'original');[IO.File]::WriteAllText($outer,'new-wrapper')
$blocked=$false;try{Set-BridgeFileIfUnchanged $target $source $oldHash $outer $outerHash}catch{$blocked=$true}
if(-not $blocked -or [IO.File]::ReadAllText($target) -ne 'original'){throw 'Concurrent wrapper change was ignored.'}
[IO.File]::WriteAllText($outer,'wrapper')
$held=[IO.FileStream]::new($target,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{
    $blocked=$false;try{Set-BridgeFileIfUnchanged $target $source $oldHash $outer $outerHash}catch{$blocked=$true}
    if(-not $blocked){throw 'Existing file writer was not respected.'}
}finally{$held.Dispose()}
[pscustomobject]@{DirectoryBoundaries='passed';ConcurrentActiveEntry='preserved';ConcurrentWrapper='preserved';ExistingWriter='respected'}|ConvertTo-Json
