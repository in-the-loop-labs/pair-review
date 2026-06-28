---
"@in-the-loop-labs/pair-review": minor
---

Make `--headless --json` an agent-friendly contract. stderr is now quiet by default in this mode (only warnings and errors, not progress narration) since coding agents capture stderr into their context — add `--debug`/`-d` to restore verbose logging. Failures now emit a structured `{ "ok": false, "error": { "message": … } }` envelope on stdout (with a non-zero exit) instead of leaving stdout empty, and the success document gains an `ok: true` field, so a consumer parses one stream and branches on `ok`.
