# Pair-Review API Skill

You have **read-only access to the filesystem**. To modify the review (create comments, adopt suggestions, trigger analysis) or interact with the pair-review app, you MUST use the pair-review API via `curl`.

The pair-review server base URL (including port) is provided **per-turn** in the message context (e.g., `[Server port: 7247] The pair-review API is at http://localhost:7247`). The port may change between server restarts, so always use the port from the most recent message context. All endpoints accept and return JSON.

## Comments

All comment operations use a single set of unified endpoints.

### List all comments

```bash
curl -s http://localhost:PORT/api/reviews/REVIEW_ID/comments
```

Optional query param: `includeDismissed=true` to include soft-deleted (inactive) comments.

**Response:** `{ "success": true, "comments": [...] }`

### Create a comment

A single endpoint handles both line-level and file-level comments. If `line_start` is present, it creates a line-level comment; if omitted, it creates a file-level comment.

**Line-level comment:**
```bash
curl -s -X POST http://localhost:PORT/api/reviews/REVIEW_ID/comments \
  -H 'Content-Type: application/json' \
  -d '{
    "file": "src/example.js",
    "line_start": 42,
    "line_end": 42,
    "side": "right",
    "body": "This variable should be renamed for clarity.",
    "type": "suggestion",
    "title": "Rename variable"
  }'
```

**File-level comment (omit `line_start`):**
```bash
curl -s -X POST http://localhost:PORT/api/reviews/REVIEW_ID/comments \
  -H 'Content-Type: application/json' \
  -d '{
    "file": "src/example.js",
    "body": "This file needs better error handling throughout.",
    "type": "suggestion",
    "title": "Error handling"
  }'
```

**Response:** `{ "success": true, "commentId": 123, "message": "Comment saved successfully" }`

Required fields: `file`, `body`.
Optional fields: `line_start`, `line_end`, `side` ("left" or "right"), `diff_position`, `commit_sha`, `parent_id`, `type`, `title`.

### Get a single comment

```bash
curl -s http://localhost:PORT/api/reviews/REVIEW_ID/comments/COMMENT_ID
```

### Update a comment

```bash
curl -s -X PUT http://localhost:PORT/api/reviews/REVIEW_ID/comments/COMMENT_ID \
  -H 'Content-Type: application/json' \
  -d '{ "body": "Updated comment text." }'
```

**Response:** `{ "success": true, "message": "Comment updated successfully" }`

### Delete a comment

> **Terminology note:** The UI refers to this operation as "dismiss." When a user asks to "dismiss a comment," use this DELETE endpoint.

Soft-deletes the comment. If the comment was adopted from an AI suggestion, the parent suggestion is automatically transitioned to "dismissed" status.

```bash
curl -s -X DELETE http://localhost:PORT/api/reviews/REVIEW_ID/comments/COMMENT_ID
```

**Response:** `{ "success": true, "message": "Comment deleted successfully", "dismissedSuggestionId": null }`

### Restore a deleted comment

```bash
curl -s -X PUT http://localhost:PORT/api/reviews/REVIEW_ID/comments/COMMENT_ID/restore
```

**Response:** `{ "success": true, "message": "Comment restored successfully", "comment": {...} }`

### Bulk delete all comments

Deletes all user comments for a review. Also dismisses any parent AI suggestions.

```bash
curl -s -X DELETE http://localhost:PORT/api/reviews/REVIEW_ID/comments
```

**Response:** `{ "success": true, "deletedCount": 5, "dismissedSuggestionIds": [...], "message": "Deleted 5 user comments" }`

---

## Suggestions

All suggestion operations use unified endpoints. These work identically for both PR and local reviews.

### List AI suggestions

```bash
curl -s 'http://localhost:PORT/api/reviews/REVIEW_ID/suggestions'
```

Optional query params:
- `levels` — comma-separated list of levels: `"final"`, `"1"`, `"2"`, `"3"`. Default: `"final"` (orchestrated suggestions only).
- `runId` — specific analysis run UUID. Default: latest run.

**Response:** `{ "suggestions": [{ "id": 1, "file": "...", "line_start": 10, "type": "bug", "title": "...", "body": "...", "status": "active", ... }] }`

### Check if suggestions exist

```bash
curl -s 'http://localhost:PORT/api/reviews/REVIEW_ID/suggestions/check'
```

Optional query param: `runId` (specific analysis run UUID).

**Response:** `{ "hasSuggestions": true, "analysisHasRun": true, "summary": "...", "stats": { "issues": 2, "suggestions": 3, "praise": 1 } }`

### Update AI suggestion status

```bash
curl -s -X POST http://localhost:PORT/api/reviews/REVIEW_ID/suggestions/SUGGESTION_ID/status \
  -H 'Content-Type: application/json' \
  -d '{ "status": "adopted" }'
```

Valid statuses: `"adopted"`, `"dismissed"`, `"active"` (restore).

**Response:** `{ "success": true, "status": "adopted" }`

### Adopt an AI suggestion with edits

Edits the suggestion text and adopts it as a new user comment.

```bash
curl -s -X POST http://localhost:PORT/api/reviews/REVIEW_ID/suggestions/SUGGESTION_ID/edit \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "adopt_edited",
    "editedText": "The edited comment body to adopt as a user comment."
  }'
```

**Response:** `{ "success": true, "userCommentId": 125, "message": "Suggestion edited and adopted as user comment" }`

---

## Analysis Launch

Analysis launch endpoints are **mode-specific** because starting an analysis requires mode-specific context (worktree paths for PRs, local directory paths for local reviews). Once launched, all subsequent analysis management uses the shared endpoints below.

### Trigger AI analysis (PR mode)

```bash
curl -s -X POST http://localhost:PORT/api/pr/OWNER/REPO/PR_NUMBER/analyses \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "claude",
    "model": "claude-sonnet-4-5-20250929",
    "tier": "balanced",
    "customInstructions": "Focus on security issues."
  }'
```

### Trigger AI analysis (local mode)

```bash
curl -s -X POST http://localhost:PORT/api/local/REVIEW_ID/analyses \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "claude",
    "tier": "balanced",
    "customInstructions": "Focus on security issues."
  }'
```

**Response (both modes):** `{ "analysisId": "uuid", "runId": "uuid", "status": "started", "message": "AI analysis started in background" }`

Optional body fields: `provider`, `model`, `tier` ("fast", "balanced", "thorough"), `customInstructions`, `skipLevel3` (boolean), `enabledLevels` (object like `{"1": true, "2": true, "3": false}`).

### Trigger council analysis (PR mode)

```bash
curl -s -X POST http://localhost:PORT/api/pr/OWNER/REPO/PR_NUMBER/analyses/council \
  -H 'Content-Type: application/json' \
  -d '{
    "councilId": "COUNCIL_UUID",
    "customInstructions": "Focus on security."
  }'
```

### Trigger council analysis (local mode)

```bash
curl -s -X POST http://localhost:PORT/api/local/REVIEW_ID/analyses/council \
  -H 'Content-Type: application/json' \
  -d '{
    "councilId": "COUNCIL_UUID",
    "customInstructions": "Focus on security."
  }'
```

**Response (both modes):** `{ "analysisId": "uuid", "runId": "uuid", "status": "started", "message": "Council analysis started in background", "isCouncil": true }`

Required: either `councilId` (UUID of a saved council config) or `councilConfig` (inline config object).
Optional: `customInstructions`, `configType` ("advanced" or "council").

---

## Analysis Status (Review-Level)

Check whether an analysis is currently running for a review. This is a unified endpoint that works for both PR and local reviews.

```bash
curl -s http://localhost:PORT/api/reviews/REVIEW_ID/analyses/status
```

**Response (running):** `{ "running": true, "analysisId": "uuid", "status": {...} }`
**Response (idle):** `{ "running": false, "analysisId": null, "status": null }`

---

## Analysis Management

These shared endpoints operate on analysis UUIDs (returned when you launch an analysis). They work for both PR and local reviews.

### Get analysis status by ID

```bash
curl -s http://localhost:PORT/api/analyses/ANALYSIS_ID/status
```

**Response:** `{ "id": "...", "status": "running"|"completed"|"failed"|"cancelled", "levels": {...}, "progress": "...", ... }`

### Cancel an analysis

```bash
curl -s -X POST http://localhost:PORT/api/analyses/ANALYSIS_ID/cancel
```

**Response:** `{ "success": true, "message": "Analysis cancelled", "processesKilled": 2, "status": "cancelled" }`

### SSE progress stream

Connect to receive real-time progress events for a running analysis:

```bash
curl -s -N http://localhost:PORT/api/analyses/ANALYSIS_ID/progress
```

This is a Server-Sent Events (SSE) stream. Events are JSON objects with `type`, `status`, `levels`, `progress`, etc.

### List analysis runs for a review

```bash
curl -s 'http://localhost:PORT/api/analyses/runs?reviewId=REVIEW_ID'
```

**Response:** `{ "runs": [{ "id": "uuid", "review_id": 1, "provider": "claude", "status": "completed", ... }] }`

### Get latest analysis run for a review

```bash
curl -s 'http://localhost:PORT/api/analyses/runs/latest?reviewId=REVIEW_ID'
```

**Response:** `{ "run": { "id": "uuid", "review_id": 1, "provider": "claude", "status": "completed", ... } }`

### Get a specific analysis run by ID

```bash
curl -s http://localhost:PORT/api/analyses/runs/RUN_ID
```

**Response:** `{ "run": { "id": "uuid", ... } }`

### Import external analysis results

Submit analysis results produced outside pair-review (e.g., by a coding agent):

```bash
curl -s -X POST http://localhost:PORT/api/analyses/results \
  -H 'Content-Type: application/json' \
  -d '{
    "path": "/absolute/path/to/repo",
    "headSha": "abc123",
    "provider": "claude",
    "summary": "Analysis summary text",
    "suggestions": [
      {
        "file": "src/example.js",
        "line_start": 10,
        "line_end": 15,
        "type": "bug",
        "title": "Potential null reference",
        "description": "This could throw if input is null."
      }
    ],
    "fileLevelSuggestions": []
  }'
```

Required: either `path` + `headSha` (local mode) or `repo` + `prNumber` (PR mode).
Each suggestion requires: `file`, `type`, `title`, `description`.

**Response (HTTP 201):** `{ "runId": "uuid", "reviewId": 1, "totalSuggestions": 5, "status": "completed" }`

---

## Comment Types

The `type` field on comments and suggestions can be one of:
- `"bug"` - Bug or defect
- `"suggestion"` - General suggestion
- `"improvement"` - Code improvement
- `"security"` - Security concern
- `"performance"` - Performance issue
- `"design"` - Design/architecture concern
- `"praise"` - Positive feedback
- `"style"` or `"code-style"` - Style/formatting
- `"nitpick"` - Minor nitpick
- `"question"` - Question for the author

---

## Context Files

Add non-diff files to the review's diff panel for reference during discussion. Each context file shows a specific line range from a file that isn't part of the PR/local changes.

### Add a context file

```bash
curl -s -X POST http://localhost:PORT/api/reviews/REVIEW_ID/context-files \
  -H 'Content-Type: application/json' \
  -d '{
    "file": "src/utils/helpers.js",
    "line_start": 42,
    "line_end": 78,
    "label": "Helper function used by the changed code"
  }'
```

**Response (HTTP 201):** `{ "success": true, "contextFile": { "id": 1, "review_id": 1, "file": "...", "line_start": 42, "line_end": 78, "label": "..." } }`

Required fields: `file` (must be a relative path without `..` segments), `line_start`, `line_end`.
Optional fields: `label`.

### List context files

```bash
curl -s http://localhost:PORT/api/reviews/REVIEW_ID/context-files
```

**Response:** `{ "success": true, "contextFiles": [...] }`

### Remove a context file

```bash
curl -s -X DELETE http://localhost:PORT/api/reviews/REVIEW_ID/context-files/CONTEXT_FILE_ID
```

**Response:** `{ "success": true, "message": "Context file removed" }`

### Remove all context files

```bash
curl -s -X DELETE http://localhost:PORT/api/reviews/REVIEW_ID/context-files
```

**Response:** `{ "success": true, "deletedCount": 3, "message": "Removed 3 context files" }`

### Guidelines

- Use judiciously -- only add files that are directly relevant to the discussion.
- Keep ranges focused on specific functions/blocks (max 500 lines).
- Use the `label` field to explain why the file is relevant.
- Context files appear in the diff panel below the actual changes.
- Reference context files in chat using backtick notation: `` `src/utils/helpers.js:42-78` ``.

---

## Diff Hunk Expansion

Expand collapsed diff gaps to reveal hidden lines. Useful when you need to show the user lines that are inside a collapsed hunk. This is a transient UI command — expansions are not persisted.

### Expand a hunk

```bash
curl -X POST http://localhost:PORT/api/reviews/REVIEW_ID/expand-hunk \
  -H "Content-Type: application/json" \
  -d '{
    "file": "src/app.js",
    "line_start": 10,
    "line_end": 20,
    "side": "right"
  }'
```

**Required fields:**
- `file` (string): Path of the changed file in the diff
- `line_start` (integer): First line to reveal (≥ 1)
- `line_end` (integer): Last line to reveal (≥ `line_start`)

**Optional fields:**
- `side` (string): `"left"` or `"right"` (default: `"right"`)

**Response:** `{ "success": true }`

---

## Notes

- Replace `PORT`, `REVIEW_ID`, `OWNER`, `REPO`, `PR_NUMBER`, `COMMENT_ID`, `SUGGESTION_ID`, `ANALYSIS_ID`, `RUN_ID`, and `CONTEXT_FILE_ID` with actual values from the review context.
- `REVIEW_ID` is the integer review ID from the `reviews` table. It is the same for both PR and local reviews and is provided in your system prompt context.
- `ANALYSIS_ID` and `RUN_ID` are UUIDs returned when an analysis is launched.
- All POST/PUT/DELETE endpoints return `{ "success": true, ... }` on success.
- Error responses have the shape `{ "error": "description" }` with appropriate HTTP status codes.
