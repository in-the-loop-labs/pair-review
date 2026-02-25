---
"@in-the-loop-labs/pair-review": patch
---

Use `process.execPath` instead of `'node'` when spawning the child process, fixing native module ABI mismatch errors when installed via Nix or other package managers that bundle a specific Node.js version
