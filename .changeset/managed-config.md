---
"@in-the-loop-labs/pair-review": patch
---

Add managed config layer (`config.managed.json`) for corporate/packaged environments

Ships an empty `config.managed.json` with the package. When the package is repackaged for corporate environments (e.g., Nix store), this file can be overwritten with company-wide defaults. The config chain is now: defaults -> managed -> global -> global.local -> project -> project.local.
