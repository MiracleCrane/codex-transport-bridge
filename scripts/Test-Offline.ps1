#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorkDirectory,
    [string]$ProxyUri,
    [string]$DependencyDirectory,
    [string]$NodePath
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Bridge.Common.psm1') -Force
$skillRoot = Split-Path -Parent $PSScriptRoot
$WorkDirectory = [IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $WorkDirectory) { throw 'Use a fresh disposable directory for the test fixture.' }
if ($WorkDirectory.StartsWith($skillRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test artifacts must stay outside the Skill repository.' }
$NodePath = Resolve-BridgeExecutable $NodePath 'node.exe'
New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
foreach ($source in @('runtime','tests')) {
    Get-ChildItem -LiteralPath (Join-Path $skillRoot $source) -File | Where-Object { $_.Extension -in @('.mjs','.json') } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $WorkDirectory $_.Name) }
}
if ($DependencyDirectory) {
    $package = Get-Content -LiteralPath (Join-Path $WorkDirectory 'package.json') -Raw | ConvertFrom-Json
    foreach ($property in $package.dependencies.PSObject.Properties) {
        $dependency = Get-Content -LiteralPath (Join-Path $DependencyDirectory ($property.Name + '\package.json')) -Raw | ConvertFrom-Json
        if ($dependency.version -ne $property.Value) { throw 'Reused dependency version differs from the pinned package.' }
    }
    Copy-Item -LiteralPath $DependencyDirectory -Destination (Join-Path $WorkDirectory 'node_modules') -Recurse
} else {
    if (-not $ProxyUri) { throw 'Supply the verified ProxyUri for dependency download, or an explicitly selected matching DependencyDirectory.' }
    Assert-BridgeProxy $ProxyUri
    $npm = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
    & $npm --prefix $WorkDirectory ci --ignore-scripts --no-audit --no-fund --proxy $ProxyUri --https-proxy $ProxyUri
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
$fixtures = Join-Path $WorkDirectory 'fixture-certificate'
New-Item -ItemType Directory -Path $fixtures | Out-Null
$rsa = [Security.Cryptography.RSA]::Create(2048)
try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $rsa,
        [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName('localhost'); $san.AddIpAddress([Net.IPAddress]::Loopback)
    $request.CertificateExtensions.Add($san.Build())
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(2))
    try {
        [IO.File]::WriteAllText((Join-Path $fixtures 'offline-ca.pem'),$certificate.ExportCertificatePem())
        [IO.File]::WriteAllText((Join-Path $fixtures 'offline-key.pem'),$rsa.ExportPkcs8PrivateKeyPem())
    } finally { $certificate.Dispose() }
} finally { $rsa.Dispose() }
$oldCa = $env:NODE_EXTRA_CA_CERTS
$oldFixture = $env:CODEX_TRANSPORT_FIXTURE_DIR
try {
    $env:NODE_EXTRA_CA_CERTS = Join-Path $fixtures 'offline-ca.pem'
    $env:CODEX_TRANSPORT_FIXTURE_DIR = $fixtures
    Push-Location $WorkDirectory
    try { & $NodePath --test (Get-ChildItem -LiteralPath $WorkDirectory -Filter '*.test.mjs' -File | ForEach-Object FullName) }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Offline protocol regression failed.' }
} finally {
    $env:NODE_EXTRA_CA_CERTS = $oldCa
    $env:CODEX_TRANSPORT_FIXTURE_DIR = $oldFixture
}
Write-Output 'Local protocol fixtures passed. No model requests were sent and no system certificate store was modified.'
