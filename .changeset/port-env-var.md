---
"@in-the-loop-labs/pair-review": minor
---

Support `PORT` env var to override the configured port

Setting `PORT` in the environment now overrides `config.port` from every config layer (managed, global, project, local). Invalid values (non-numeric or outside 1024–65535) fail fast with a clear error.

This makes pair-review compatible with launchers that dynamically assign a port — notably Claude Code's Preview feature, whose `"autoPort": true` in `.claude/launch.json` picks a free port and injects it via `PORT`.

Also migrated `console.error`/`console.log` calls in `src/config.js` to the project's `logger`, matching the existing logging convention.
