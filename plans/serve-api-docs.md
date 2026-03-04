# Plan: Serve API docs from the server (`GET /api.md`)

## Context

The chat agent currently learns the pair-review API by reading `.pi/skills/pair-review-api/SKILL.md` from disk. This wastes a tool call, uses placeholder values (`PORT`, `REVIEW_ID`) the agent must mentally substitute, and decouples docs from the server code. The fix: serve the API reference from the running server itself with real values baked in, and inject a compact cheat-sheet into the initial context so most sessions never need to fetch the full docs at all.

## Changes

### 1. New: `src/chat/api-reference.js`

Two exports:

- **`renderApiDocs({ port, reviewId })`** — Returns the full API reference markdown (extracted from SKILL.md lines 12-440) with `{{PORT}}` and `{{REVIEW_ID}}` substituted. Behavioral preamble and placeholder notes stripped.

- **`buildApiCheatSheet({ port, reviewId })`** — Returns a ~1.5KB compact cheat-sheet with endpoint signatures + key params, real values baked in, and a pointer to `curl http://localhost:<port>/api.md?reviewId=<id>` for the full reference.

### 2. New route: `GET /api.md` in `src/routes/chat.js`

- **Requires** `?reviewId=N` query param (returns 400 without it)
- The server can have multiple active reviews; `reviewId` is not server-global
- Calls `renderApiDocs({ port: req.socket.localPort, reviewId })`
- Returns `Content-Type: text/markdown` with all values baked in

### 3. Modify: `src/chat/prompt-builder.js`

- Remove `skillPath` parameter from `buildChatPrompt()` signature and JSDoc
- Replace the "API capability" section (lines 56-63) with a new "API Access" section containing:
  - Behavioral instructions from SKILL.md ("read-only filesystem access", "use curl", "all endpoints accept/return JSON")
  - Note that the compact API reference + server URL are in the initial context
  - The "don't mention you're reading docs" instruction stays

### 4. Modify: `src/routes/chat.js`

- **Remove** `pairReviewSkillPath` constant (line 22)
- **Remove** `skillPath: pairReviewSkillPath` from all three `buildChatPrompt()` calls (lines 248, 375, 499)
- **Inject cheat-sheet** into initial context alongside the port (around line 296): call `buildApiCheatSheet({ port, reviewId: review.id })` and prepend to `initialContextWithPort`
- **Remove** SKILL.md Read tool-badge suppression (lines 142-149) — no longer needed
- **Widen regex** in `buildPairReviewApiRe`: change `/api/` to `/api` so it also matches `/api.md` fetches. All pair-review API paths start with `/api`, so no false positives.

### 5. Modify: `src/chat/session-manager.js`

- Remove `pairReviewSkillPath` import (line 19)
- Remove `skills: [pairReviewSkillPath]` from PiBridge constructor (line 547) — the cheat-sheet is now in the initial context, not a skill file

### 6. Delete: `.pi/skills/pair-review-api/SKILL.md`

No other consumers reference this file. The content lives in `api-reference.js` now.

### 7. Tests

**New: `tests/unit/chat/api-reference.test.js`**
- `renderApiDocs` substitutes all `{{PORT}}` and `{{REVIEW_ID}}` placeholders
- `renderApiDocs` with `reviewId=null` throws or returns error (required param)
- `buildApiCheatSheet` output is under 2KB
- `buildApiCheatSheet` output contains all major endpoint categories
- `buildApiCheatSheet` output uses real port/reviewId values (no `{{...}}` placeholders)

**Update: `tests/unit/chat/prompt-builder.test.js`**
- Line 188-194: Change "should include API capability section" to check for "API Access" and "read-only" instead of "pair-review-api skill"

**Update: `tests/integration/chat-routes.test.js`**
- Add tests for `GET /api.md?reviewId=N` (success) and `GET /api.md` without reviewId (400)
- Update regex tests (line 913): `curl http://localhost:7247/api.md` should now match
- Remove or update any assertions about SKILL.md read suppression

## Verification

1. `npm test` — all unit and integration tests pass
2. `npm run test:e2e` — E2E tests pass (chat sessions still work with cheat-sheet in context)
3. Manual: `curl http://localhost:7247/api.md?reviewId=1` returns rendered markdown; `curl http://localhost:7247/api.md` returns 400
4. Manual: start a chat session and verify the agent can use the API without reading SKILL.md
