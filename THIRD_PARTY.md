# Third-party software

Runtime dependencies are pinned in `runtime/package-lock.json` and installed with `npm ci --ignore-scripts`. `ws`, `https-proxy-agent` and their transitive dependencies retain their own license files in the installed packages. The source release does not bundle `node_modules`.

Node.js, Python, PowerShell, .NET Framework and Codex are separate prerequisites. No official Codex binaries, account data or application assets are redistributed here.
