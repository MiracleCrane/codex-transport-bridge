Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BridgeHash([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PhysicalFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Required file does not exist.' }
    if (-not ('TransportBridgePhysicalPath' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class TransportBridgePhysicalPath {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder text, uint size, uint flags);
    public static string Resolve(string path) {
        using (var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new IOException("Cannot open physical path metadata");
            var value = new StringBuilder(32768);
            uint count = GetFinalPathNameByHandle(handle, value, (uint)value.Capacity, 0);
            if (count == 0 || count >= value.Capacity) throw new IOException("Cannot resolve physical file location");
            string result = value.ToString();
            if (result.StartsWith(@"\\?\UNC\")) return @"\\" + result.Substring(8);
            return result.StartsWith(@"\\?\") ? result.Substring(4) : result;
        }
    }
}


'@
    }
    [TransportBridgePhysicalPath]::Resolve([IO.Path]::GetFullPath($Path))
}

function Assert-BridgeDestination([string]$Destination, [string]$CodexHome, [string[]]$AdditionalExcludedRoot = @()) {
    $logical = [IO.Path]::GetFullPath($Destination)
    $probe = $logical
    $suffix = @()
    while (-not (Test-Path -LiteralPath $probe)) {
        $suffix = @((Split-Path -Leaf $probe)) + $suffix
        $probe = Split-Path -Parent $probe
        if (-not $probe) { throw 'Cannot resolve installation parent.' }
    }
    # Load the physical path helper without putting test files in the target.
    $null = Get-PhysicalFile (Join-Path $PSScriptRoot 'Bridge.Common.psm1')
    $physical = [TransportBridgePhysicalPath]::Resolve($probe)
    foreach ($part in $suffix) { $physical = Join-Path $physical $part }
    $scanRoots = @((Join-Path $HOME '.agents\skills'),(Join-Path $HOME '.claude\skills'),(Join-Path $CodexHome 'skills')) + $AdditionalExcludedRoot
    foreach ($scanRoot in $scanRoots) {
        $aliases = @([IO.Path]::GetFullPath($scanRoot))
        if (Test-Path -LiteralPath $scanRoot) { $aliases += [TransportBridgePhysicalPath]::Resolve($scanRoot) }
        foreach ($alias in $aliases) {
            $candidate = $alias.TrimEnd('\')
            if ($physical -eq $candidate -or $physical.StartsWith($candidate + '\',[StringComparison]::OrdinalIgnoreCase) -or
                $logical -eq $candidate -or $logical.StartsWith($candidate + '\',[StringComparison]::OrdinalIgnoreCase)) {
                throw 'Runtime/config backups must not be placed in a Skill discovery directory.'
            }
        }
    }
    foreach ($syncRoot in @($env:OneDrive,$env:OneDriveConsumer,$env:OneDriveCommercial)) {
        if ($syncRoot) {
            $aliases = @([IO.Path]::GetFullPath($syncRoot))
            if (Test-Path -LiteralPath $syncRoot) { $aliases += [TransportBridgePhysicalPath]::Resolve($syncRoot) }
            foreach ($alias in $aliases) {
                $candidate = $alias.TrimEnd('\')
                if ($physical -eq $candidate -or $physical.StartsWith($candidate + '\',[StringComparison]::OrdinalIgnoreCase) -or
                    $logical -eq $candidate -or $logical.StartsWith($candidate + '\',[StringComparison]::OrdinalIgnoreCase)) {
                    throw 'Runtime/config backups must not be placed in a known synchronized directory.'
                }
            }
        }
    }
    $ancestor = $physical
    while ($ancestor) {
        if (Test-Path -LiteralPath (Join-Path $ancestor '.git')) { throw 'Runtime/config backups must not be placed inside any Git repository.' }
        $parent = Split-Path -Parent $ancestor
        if ($parent -eq $ancestor) { break }
        $ancestor = $parent
    }
    return $physical
}

function Set-BridgeFileIfUnchanged([string]$Target, [string]$Source, [string]$ExpectedHash,
                                  [string]$OuterPath, [string]$OuterHash) {
    $bytes = [IO.File]::ReadAllBytes($Source)
    $outer = $null
    $stream = $null
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        if ($OuterPath -and $OuterPath -ne $Target) {
            $outer = [IO.FileStream]::new($OuterPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            $actualOuter = [Convert]::ToHexString($sha.ComputeHash($outer)).ToLowerInvariant()
            if ($actualOuter -ne $OuterHash) { throw 'Outer wrapper changed before commit; no overwrite.' }
        }
        $stream = [IO.FileStream]::new($Target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
        $old = [IO.MemoryStream]::new()
        try { $stream.CopyTo($old); $oldBytes = $old.ToArray() } finally { $old.Dispose() }
        $actual = [Convert]::ToHexString($sha.ComputeHash($oldBytes)).ToLowerInvariant()
        if ($actual -ne $ExpectedHash) { throw 'Shortcut changed before commit; no overwrite.' }
        try {
            $stream.Position=0; $stream.Write($bytes,0,$bytes.Length); $stream.SetLength($bytes.Length); $stream.Flush($true)
        } catch {
            $stream.Position=0; $stream.Write($oldBytes,0,$oldBytes.Length); $stream.SetLength($oldBytes.Length); $stream.Flush($true)
            throw
        }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $outer) { $outer.Dispose() }
        $sha.Dispose()
    }
}

function Assert-BridgeProxy([string]$ProxyUri) {
    $uri = [uri]$ProxyUri
    if ($uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1','localhost','[::1]','::1') -or
        $uri.Port -lt 1 -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        throw 'Provide the verified local HTTP proxy URI, without credentials or query parameters.'
    }
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.ConnectAsync($uri.DnsSafeHost, $uri.Port)
        if (-not $pending.Wait(3000) -or -not $client.Connected) { throw 'Local proxy is not reachable.' }
    } finally { $client.Dispose() }
}

function Resolve-BridgeExecutable([string]$ExplicitPath, [string]$Name) {
    $path = $ExplicitPath
    if (-not $path) {
        $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) { throw "Missing runtime: $Name. Supply its executable path." }
        $path = $command.Source
    }
    if ($path -match '\\Microsoft\\WindowsApps\\') { throw 'An app-execution alias is not a verified runtime executable.' }
    Get-PhysicalFile $path
}

function Read-BridgeShortcut([string]$Path) {
    $physical = Get-PhysicalFile $Path
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($physical)
    [pscustomobject]@{ Path=$physical; Target=$link.TargetPath; Arguments=$link.Arguments;
        WorkingDirectory=$link.WorkingDirectory; Icon=$link.IconLocation; Description=$link.Description;
        Hotkey=$link.Hotkey; WindowStyle=$link.WindowStyle; Sha256=(Get-BridgeHash $physical) }
}

function Resolve-BridgeShortcut([string]$Path) {
    $outer = Read-BridgeShortcut $Path
    $current = $outer
    $seen = @{}
    for ($depth=0; $depth -lt 8; $depth++) {
        if ($seen.ContainsKey($current.Path)) { throw 'Shortcut wrapper cycle detected.' }
        $seen[$current.Path] = $true
        if ([IO.Path]::GetFileName($current.Target) -ine 'QuotaOrb.Launcher.exe') {
            return [pscustomobject]@{ Outer=$outer; Active=$current }
        }
        if ($current.Arguments -match '^--shortcut\s+"([^"]+)"$') {
            $current = Read-BridgeShortcut $Matches[1]
        } elseif ($current.Arguments -match '^--link\s+"?([a-zA-Z0-9_-]+)"?$') {
            $mapping = Join-Path $env:LOCALAPPDATA ('QuotaOrb\launchers\' + $Matches[1] + '.json')
            $record = Get-Content -LiteralPath $mapping -Raw | ConvertFrom-Json
            $current = Read-BridgeShortcut $record.OriginalShortcut
        } else { throw 'Unrecognized Quota Orb arguments; inspect the active wrapper before installation.' }
    }
    throw 'Shortcut wrapper chain exceeds the supported depth.'
}

function New-BridgeShortcut([string]$Path, [string]$Launcher, $Original) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = $Launcher
    $link.Arguments = ''
    $link.WorkingDirectory = $Original.WorkingDirectory
    $link.IconLocation = $Original.Icon
    $link.Description = $Original.Description
    $link.Hotkey = $Original.Hotkey
    $link.WindowStyle = $Original.WindowStyle
    $link.Save()
}

function Start-BridgeDesktopEntry([string]$Path, [string]$Arguments = '') {
    $desktop = New-Object -ComObject Shell.Application
    $handle = 0
    $view = $desktop.Windows().FindWindowSW(0,0,8,[ref]$handle,1)
    if ($null -eq $view) { throw 'A normal Explorer desktop session is required; no active host was restarted.' }
    $view.Document.Application.ShellExecute($Path,$Arguments,(Split-Path -Parent $Path),'open',0)
}

function Get-BridgeHealth([int]$Port) {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(2)
    try {
        $text = $client.GetStringAsync("http://127.0.0.1:$Port/health").GetAwaiter().GetResult()
        $text | ConvertFrom-Json
    } finally { $client.Dispose() }
}

function Wait-BridgeReady($Receipt) {
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        try {
            $health = Get-BridgeHealth $Receipt.Port
            if ($health.ready -eq $true -and $health.service -eq 'codex-transport-bridge' -and
                $health.version -eq $Receipt.Version -and $health.instanceId -eq $Receipt.InstanceId -and
                $health.managed -eq $true) { return $health }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    throw 'The intended bridge instance did not become ready; keep the existing connection/configuration.'
}

function Invoke-BridgeConfigEdit($Receipt, [string]$Action) {
    & $Receipt.PythonPath -X utf8 (Join-Path $PSScriptRoot 'config-edit.py') $Action --state $Receipt.ConfigTransaction
    if ($LASTEXITCODE -ne 0) { throw "Config transaction $Action failed; inspect its status before retrying." }
}

function Save-BridgeReceipt([string]$Path, $Receipt) {
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary,($Receipt | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary,$Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

Export-ModuleMember -Function *-Bridge*,Get-PhysicalFile
