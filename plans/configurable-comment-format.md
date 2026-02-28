# Plan: Configurable Comment Format for Adopted Suggestions

## Context

When users adopt AI suggestions, pair-review formats them as `🐛 **Bug**: description text\n\n**Suggestion:** remediation` before submitting to GitHub. This format is hardcoded with no user customization. Two problems:

1. The `description` and `suggestion` fields from AI output are concatenated into a single `body` column at storage time, destroying the structure needed for flexible formatting.
2. The adoption prefix (`{emoji} **{Category}**: ...`) is hardcoded in three parallel `formatAdoptedComment` implementations.

This plan splits the fields apart in the DB, then builds configurable formatting on top.

## Part 1: Split `suggestion_text` out of `body`

### DB Migration (version 25)

Add `suggestion_text TEXT` column to the `comments` table. No backfill — legacy rows have `suggestion_text = NULL`.

**File:** `src/database.js`
- Bump `CURRENT_SCHEMA_VERSION` to 25
- Add migration 25: `ALTER TABLE comments ADD COLUMN suggestion_text TEXT`
- Update `SCHEMA_SQL.comments` to include `suggestion_text TEXT` column

### Stop concatenating at storage time

Two code paths currently concatenate `description + **Suggestion:** + suggestion`:

**`src/ai/analyzer.js:3508-3509`:**
```javascript
// Before:
const body = suggestion.description +
  (suggestion.suggestion ? '\n\n**Suggestion:** ' + suggestion.suggestion : '');

// After:
const body = suggestion.description;
const suggestionText = suggestion.suggestion || null;
```
Update the INSERT to store `suggestionText` in the new `suggestion_text` column.

**`src/database.js:2196-2197`** (in `saveSuggestions` or similar):
Same change — stop concatenating, store `suggestion.suggestion` in `suggestion_text`.

### Legacy data handling

When reading a comment where `suggestion_text IS NULL` and `body` contains `\n\n**Suggestion:** `, split on that marker. This logic lives in the shared formatter (Part 2) so it's centralized. No migration backfill needed.

### Update test schemas

Per CLAUDE.md testing practices, update schemas in:
- `tests/e2e/global-setup.js`
- `tests/integration/routes.test.js`

## Part 2: Configurable format via shared formatter

### Config shape

Add `comment_format` to `~/.pair-review/config.json`. Accepts a preset name (string) or custom template (object):

```jsonc
// Preset:
"comment_format": "default"

// Custom:
"comment_format": {
  "template": "{emoji} **{category}**: {description}\n\n**Suggestion:** {suggestion}",
  "showEmoji": true,
  "emojiOverrides": { "bug": "🔴" }
}
```

**Presets:**
| Name | Template | Result |
|------|----------|--------|
| `default` | `{emoji} **{category}**: {description}\n\n**Suggestion:** {suggestion}` | `🐛 **Bug**: desc\n\n**Suggestion:** fix` (current behavior) |
| `minimal` | `[{category}] {description}\n\n{suggestion}` | `[Bug] desc\n\nfix` |
| `plain` | `{description}\n\n{suggestion}` | `desc\n\nfix` |
| `emoji-only` | `{emoji} {description}\n\n{suggestion}` | `🐛 desc\n\nfix` |

Template placeholders: `{emoji}`, `{category}`, `{title}`, `{description}`, `{suggestion}`. The `{suggestion}` block (including surrounding text) is omitted if the suggestion has no `suggestion_text`. `{title}` is already stored as a separate DB column — no migration needed for it.

### Create shared formatter module

**`src/utils/comment-formatter.js`** (backend, CommonJS):
- `resolveFormat(config)` — resolve preset string or object into a template config
- `formatAdoptedComment({ title, description, suggestionText, category }, formatConfig, getEmojiFn)` — assemble the final text from structured fields
- Legacy handling: if called with a flat `body` string (no separate `suggestionText`), attempt to split on `\n\n**Suggestion:** `
- Depends on `src/utils/category-emoji.js` for emoji lookup

**`public/js/utils/comment-formatter.js`** (frontend, IIFE → `window.CommentFormatter`):
- Browser-compatible version of the same logic
- Uses `window.CategoryEmoji.getEmoji` for emoji lookup

### Consolidate three `formatAdoptedComment` implementations

Replace the duplicated functions in:
- `src/routes/reviews.js:33-44` → import from `src/utils/comment-formatter.js`
- `public/js/modules/suggestion-manager.js:168-179` → delegate to `window.CommentFormatter`
- `public/js/modules/file-comment-manager.js:79-90` → delegate to `window.CommentFormatter`

### Update adoption flow

**Backend (`src/routes/reviews.js` adopt endpoint, ~line 695):**
Currently receives `suggestion.body` (concatenated). After Part 1, the suggestion row will have separate `body` (description) and `suggestion_text` fields. Pass both to the formatter along with `req.app.get('config')`.

### Config plumbing

**`src/config.js`:** Add `comment_format: "default"` to `DEFAULT_CONFIG`

**`src/routes/config.js`:**
- `GET /api/config`: include `comment_format`
- `PATCH /api/config`: validate `comment_format` (known preset string, or object with `{description}` in template)

**Frontend (`public/js/pr.js`):** Store `comment_format` from `/api/config` response, make available to suggestion managers.

**HTML files:** Add `<script src="/js/utils/comment-formatter.js">` to `public/pr.html` and `public/local.html`.

## Key files

| File | Action | What changes |
|------|--------|-------------|
| `src/database.js` | Modify | Migration 25, schema, stop concatenating in saveSuggestions |
| `src/ai/analyzer.js` | Modify | Stop concatenating description+suggestion |
| `src/utils/comment-formatter.js` | Create | Shared formatter with presets + templates |
| `public/js/utils/comment-formatter.js` | Create | Frontend IIFE version |
| `src/config.js` | Modify | Add `comment_format` default |
| `src/routes/config.js` | Modify | Expose in GET/PATCH |
| `src/routes/reviews.js` | Modify | Use shared formatter, pass structured fields |
| `public/js/modules/suggestion-manager.js` | Modify | Delegate to shared formatter |
| `public/js/modules/file-comment-manager.js` | Modify | Delegate to shared formatter |
| `public/js/pr.js` | Modify | Store format config from API |
| `public/pr.html` | Modify | Add script tag |
| `public/local.html` | Modify | Add script tag |
| `tests/unit/comment-formatter.test.js` | Create | Unit tests for formatter |
| `tests/integration/routes.test.js` | Modify | Config API + schema update |
| `tests/e2e/global-setup.js` | Modify | Schema update |

## Verification

1. `npm test` — all existing + new unit tests pass
2. `npm run test:e2e` — adopt suggestion in both PR and Local mode
3. Manual: run analysis, adopt suggestion, verify default format matches current behavior
4. Manual: set `"comment_format": "minimal"` in config, adopt → verify `[Bug] desc` format
5. Legacy test: adopt a suggestion from a pre-migration analysis (no `suggestion_text`), verify it falls back correctly by splitting on `**Suggestion:**`

## Changeset

Minor version bump — new feature, backwards-compatible (default preset produces identical output to today).
