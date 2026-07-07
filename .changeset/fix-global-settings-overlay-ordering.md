---
"@in-the-loop-labs/pair-review": patch
---

Fix in-app global settings (from the `/settings` page) not taking effect after a restart, despite their "restart required" badge.

The DB-backed settings overlay was folded into config too late at every entry point, so startup consumers had already latched the pre-overlay file values. Overriding `yolo`, `dev_mode`, or `debug_stream` via `/settings` had no effect even after restarting (`applyConfigOverrides` had already snapshotted `config.yolo`, `warnIfDevModeWithoutDbName` and the static-file cache closure had already read `dev_mode`, and the logger stream-debug flag was already set). The overlay now runs immediately after database initialization and before those consumers in both the web server (`src/server.js`) and the CLI (`src/main.js`).

The stdio MCP server (`src/mcp-stdio.js`) never applied the overlay at all, so `start_analysis` over stdio ignored `/settings` `default_provider`/`default_model` overrides. It now folds the overlay into the config it hands to the MCP tools.
