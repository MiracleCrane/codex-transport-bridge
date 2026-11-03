---
name: codex-transport-bridge
description: Install, inspect, upgrade and restore the Windows Codex transport bridge. Use for this project's local model-stream bridge, not generic VPN setup or every slow model response.
---

# Codex transport bridge

Use the installed release's [installation guide](references/installation.md) and [component contract](docs/component-contract.md). Read [troubleshooting](references/troubleshooting.md) only for a matching symptom.

Discover this machine's actual proxy URI, Codex home, runtimes and installation receipt. Standalone mode preserves a selected existing shortcut; desktop-kit mode uses `-ComponentOnly` and leaves all shortcut ownership to the kit. Do not nest another bridge around an existing bridge.

Preserve official upstream authentication, TLS verification, local/intranet bypasses and the user's system-proxy/TUN mode. Never print credentials or terminate the active Codex host. Configuration restoration must use the installation transaction and preserve concurrent user changes.

Health, offline fixtures and a successful WebSocket handshake establish different layers. Verify the real chat route and a model/tool exchange after a normal restart; do not call fixture results live acceptance. Normal reasoning may continue while matching transport Pongs arrive.

This repository owns runtime, installer, tests and generic documentation. The desktop kit owns combined installation and its final shortcut; Quota Orb owns its own GUI. Do not copy these implementations into personal Skills or the kit. Follow [AGENTS.md](AGENTS.md) for maintenance boundaries.
