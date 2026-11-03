# Maintenance boundaries

This repository is the only source of the bridge runtime, configuration transaction, standalone installer and headless supervisor. Keep runtime and installer changes versioned together. Never edit installed copies as the long-term fix.

`codex-desktop-kit` owns the combined installer, proxy launcher, component version manifest and final kit shortcuts. `quota-orb` owns the GUI, quota reads and its lifecycle. Component-only installation must never create, modify or remove shortcuts. Before changing a cross-project contract, coordinate its consumer and document the version boundary in `docs/component-contract.md`.

Preserve concurrent configuration changes, official TLS/auth semantics, bounded cancellation and close draining. Do not infer model failure from text silence. Keep receipts, credentials, process logs and local paths outside this repository. Do not kill the active Agent host to validate a restart.

For changes run relevant protocol fixtures, Python configuration-transaction tests and Windows installer/component fixtures. Store generated certificates, binaries and receipts in an external temporary directory. Record live restart/model acceptance separately from automated tests. Never introduce real model calls into CI.

README and linked docs are the canonical product instructions; SKILL.md is a short Agent entrypoint. Personal Skills should reference a matching release's docs, not copy scripts or the full manual. Publish reviewed source and checksum assets from a fixed tag; kit updates its own component pin only after integration validation.
