#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $WorkDirectory){throw 'Use a fresh external directory.'}
New-Item -ItemType Directory -Path $WorkDirectory|Out-Null
$root=Split-Path -Parent $PSScriptRoot
$code=Get-Content -LiteralPath (Join-Path $root 'assets/ConnectedLauncher.cs.template') -Raw
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
try{$listener.Start();$port=$listener.LocalEndpoint.Port}finally{$listener.Stop()}
$replacements=@{'@@RUNTIME_ROOT@@'=$WorkDirectory;'@@NODE_PATH@@'=(Join-Path $WorkDirectory 'missing-node.exe');'@@ORIGINAL_SHORTCUT@@'='';'@@PORT@@'=[string]$port;'@@VERSION@@'='fixture';'@@PROXY_URI@@'='http://127.0.0.1:1';'@@INSTANCE_ID@@'=[guid]::NewGuid().ToString();'@@HOST_PROCESS_NAMES@@'='"lzc-never-running-host"'}
foreach($key in $replacements.Keys){$code=$code.Replace($key,$replacements[$key])}
$source=Join-Path $WorkDirectory 'Fixture.cs';$exe=Join-Path $WorkDirectory 'lzc-supervisor-fixture.exe'
[IO.File]::WriteAllText($source,$code,[Text.UTF8Encoding]::new($false))
& (Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe') /nologo /target:winexe /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll "/out:$exe" $source
if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed.'}
$process=Start-Process -FilePath $exe -ArgumentList '--guard-only' -WindowStyle Hidden -PassThru
if(-not $process.WaitForExit(15000)){Stop-Process -Id $process.Id;throw 'Missing runtime left a persistent supervisor.'}
if($process.ExitCode -ne 2){throw 'Startup failure did not return the expected status.'}
Write-Output 'Component supervisor exits on bounded startup failure; no model request was sent.'
