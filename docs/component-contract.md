# Desktop-kit component contract (1.5)

The kit owns its final shortcuts and Codex activation. The bridge owns its runtime, supervisor and one `openai_base_url` transaction. No bridge/orb wrapper chain is created in component mode.

## Prepare and enable

```powershell
./scripts/Install-Bridge.ps1 -ComponentOnly -Destination $destination `
  -ProxyUri $proxyUri -CodexHome $codexHome -NodePath $node -PythonPath $python
./scripts/Enable-Bridge.ps1 -InstallationPath "$destination/installation.json"
```

Prepare copies locked runtime dependencies, compiles a supervisor, and records original configuration without changing it. Component mode rejects `ShortcutPath`. Enable starts the supervisor through the desktop and applies only the owned URL after version/instance readiness passes. It never activates Codex in component mode. These commands never terminate the active host.

## Start and inspect

The receipt contains `Mode=component`, `Version`, `InstanceId`, `BaseUrl`, `Port`, `SupervisorPath`, `SupervisorSha256`, `RuntimeSha256`, `ConfigTransaction`, `PythonPath`, `NodePath`, and an empty `Entries` array. Treat paths as local data, not portable release metadata.

From a normal desktop launcher, invoke `SupervisorPath --guard-only`, without waiting for its process to exit. Poll `http://127.0.0.1:<Port>/health` with system proxy disabled for that loopback request. Require `ready=true`, `service=codex-transport-bridge`, matching `version`, `instanceId` and `managed=true`; an unrelated listener is not readiness. The supervisor is idempotent for its port and keeps ownership of only its own child bridge.

`Test-Bridge.ps1` checks runtime/supervisor hashes, health and configuration ownership. It does not prove a chat uses that endpoint. The supervisor exits cooperatively after the configured host is gone and active requests have drained. The kit must not kill it during active work.

## Restore and upgrade

`Restore-Bridge.ps1 -InstallationPath ... -Confirm:$false` restores the owned URL transaction and marks the receipt restored. It preserves later user changes, does not remove files and does not kill processes. If user changes displaced the owned value, inspect the resulting effective route before starting Codex; a successful no-op restore is not proof that a stale URL disappeared.

Upgrade by restoring the previous owned configuration and preparing a new version/destination with a free port. Keep the old runtime until its active requests finish. For uninstall, restore first and leave unknown files/backups intact. Do not recursively delete an active or unrecognized installation.

The kit consumes a fixed release ZIP and SHA-256, stores its own selected versions, and calls these interfaces. It must not copy or patch bridge source. Breaking receipt or CLI changes require an explicit contract version and a coordinated kit update.
