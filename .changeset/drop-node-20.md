---
"@in-the-loop-labs/pair-review": major
---

Drop support for Node.js 20 and add Node.js 26. The minimum supported version is now Node.js 22. CI tests against Node 22, 24, and 26, and the project now pins pnpm 11 via the `packageManager` field.

Upgrades `better-sqlite3` from 11.x to 12.x, which ships prebuilt binaries for Node.js 26 (11.x fails to compile against Node 26's V8). The 12.0 major bump only drops EOL Node/Electron build targets — no runtime API changes.
