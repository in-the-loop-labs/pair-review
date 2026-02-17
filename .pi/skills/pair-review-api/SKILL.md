# Pair-Review API Skill

You have **read-only access to the filesystem**. To modify the review (create comments, adopt suggestions, trigger analysis), you MUST use the pair-review API via `curl`.

The pair-review server base URL is provided in your system prompt context (e.g., `http://localhost:<PORT>`). All endpoints accept and return JSON.

---

## User Comments

### Create a line-level comment

**PR mode:**
```bash
curl -s -X POST http://localhost:PORT/api/user-comment \
  -H 'Content-Type: application/json' \
  -d '{
    "review_id": REVIEW_ID,
    "file": "src/example.js",
    "line_start": 42,
    "line_end": 42,
    "side": "right",
    "body": "This variable should be renamed for clarity.",
    "type": "suggestion",
    "title": "Rename variable"
  }'
```

**Local mode:**
```bash
curl -s -X POST http://localhost:PORT/api/local/REVIEW_ID/user-comments \
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

**Response:** `{ "success": true, "commentId": 123, "message": "Comment saved successfully" }`

Required fields: `file`, `line_start`, `body` (and `review_id` in PR mode).
Optional fields: `line_end`, `side` ("left" or "right"), `diff_position`, `commit_sha`, `parent_id`, `type`, `title`.

### Create a file-level comment

**PR mode:**
```bash
curl -s -X POST http://localhost:PORT/api/file-comment \
  -H 'Content-Type: application/json' \
  -d '{
    "review_id": REVIEW_ID,
    "file": "src/example.js",
    "body": "This file needs better error handling throughout.",
    "type": "suggestion",
    "title": "Error handling"
  }'
```

**Local mode:**
```bash
curl -s -X POST http://localhost:PORT/api/local/REVIEW_ID/file-comment \
  -H 'Content-Type: application/json' \
  -d '{
    "file": "src/example.js",
    "body": "This file needs better error handling throughout.",
    "type": "suggestion",
    "title": "Error handling"
  }'
```

**Response:** `{ "success": true, "commentId": 124, "message": "File-level comment saved successfully" }`

Required fields: `file`, `body` (and `review_id` in PR mode).
Optional fields: `type`, `title`, `parent_id`, `commit_sha`.

### Update a user comment (line-level or file-level)

**Line-level comment:**
```bash
curl -s -X PUT http://localhost:PORT/api/user-comment/COMMENT_ID \
  -H 'Content-Type: application/json' \
  -d '{ "body": "Updated comment text." }'
```

**Local mode alternate (line-level):**
```bash
curl -s -X PUT http://localhost:PORT/api/local/REVIEW_ID/user-comments/COMMENT_ID \
  -H 'Content-Type: application/json' \
  -d '{ "body": "Updated comment text." }'
```

**File-level comment (local mode):**
```bash
curl -s -X PUT http://localhost:PORT/api/local/REVIEW_ID/file-comment/COMMENT_ID \
  -H 'Content-Type: application/json' \
  -d '{ "body": "Updated file-level comment text." }'
```

### Delete a user comment (line-level or file-level)

**Line-level comment:**
```bash
curl -s -X DELETE http://localhost:PORT/api/user-comment/COMMENT_ID
```

**Local mode alternate (line-level):**
```bash
curl -s -X DELETE http://localhost:PORT/api/local/REVIEW_ID/user-comments/COMMENT_ID
```

**File-level comment (local mode):**
```bash
curl -s -X DELETE http://localhost:PORT/api/local/REVIEW_ID/file-comment/COMMENT_ID
```

**Response:** `{ "success": true, "message": "Comment deleted successfully", "dismissedSuggestionId": null }`

### Get user comments

**PR mode:**
```bash
curl -s http://localhost:PORT/api/pr/OWNER/REPO/PR_NUMBER/user-comments
```

**Local mode:**
```bash
curl -s http://localhost:PORT/api/local/REVIEW_ID/user-comments
```

**Response:** `{ "success": true, "comments": [...] }`

---

## AI Suggestions

### Get AI suggestions

**PR mode:**
```bash
curl -s 'http://localhost:PORT/api/pr/OWNER/REPO/PR_NUMBER/ai-suggestions'
```

**Local mode:**
```bash
curl -s 'http://localhost:PORT/api/local/REVIEW_ID/suggestions'
```

Optional query params: `levels` (comma-separated: "final", "1", "2", "3"; default: "final"), `runId` (specific analysis run).

**Response:** `{ "suggestions": [{ "id": 1, "file": "...", "line_start": 10, "type": "bug", "title": "...", "body": "...", "status": "active", ... }] }`

### Adopt an AI suggestion (with edits)

```bash
curl -s -X POST http://localhost:PORT/api/ai-suggestion/SUGGESTION_ID/edit \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "adopt_edited",
    "editedText": "The edited comment body to adopt as a user comment."
  }'
```

**Response:** `{ "success": true, "userCommentId": 125, "message": "Suggestion edited and adopted as user comment" }`

### Update AI suggestion status

**PR mode:**
```bash
curl -s -X POST http://localhost:PORT/api/ai-suggestion/SUGGESTION_ID/status \
  -H 'Content-Type: application/json' \
  -d '{ "status": "adopted" }'
```

**Local mode:**
```bash
curl -s -X POST http://localhost:PORT/api/local/REVIEW_ID/ai-suggestion/SUGGESTION_ID/status \
  -H 'Content-Type: application/json' \
  -d '{ "status": "adopted" }'
```

Valid statuses: `"adopted"`, `"dismissed"`, `"active"` (restore).

---

## Analysis

### Trigger AI analysis

**PR mode:**
```bash
curl -s -X POST http://localhost:PORT/api/analyze/OWNER/REPO/PR_NUMBER \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "claude",
    "model": "claude-sonnet-4-5-20250929",
    "tier": "balanced",
    "customInstructions": "Focus on security issues."
  }'
```

**Local mode:**
```bash
curl -s -X POST http://localhost:PORT/api/local/REVIEW_ID/analyze \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "claude",
    "tier": "balanced"
  }'
```

**Response:** `{ "analysisId": "uuid", "runId": "uuid", "status": "started", "message": "AI analysis started in background" }`

Optional body fields: `provider`, `model`, `tier` ("fast", "balanced", "thorough"), `customInstructions`, `skipLevel3` (boolean), `enabledLevels` (object like `{"1": true, "2": true, "3": false}`).

### Check analysis status

```bash
curl -s http://localhost:PORT/api/analyze/status/ANALYSIS_ID
```

**Response:** `{ "id": "...", "status": "running"|"completed"|"failed"|"cancelled", "levels": {...}, "progress": "...", ... }`

### Cancel analysis

```bash
curl -s -X POST http://localhost:PORT/api/analyze/cancel/ANALYSIS_ID
```

### Check if suggestions exist

**PR mode:**
```bash
curl -s http://localhost:PORT/api/pr/OWNER/REPO/PR_NUMBER/has-ai-suggestions
```

**Local mode:**
```bash
curl -s http://localhost:PORT/api/local/REVIEW_ID/has-ai-suggestions
```

**Response:** `{ "hasSuggestions": true, "analysisHasRun": true, "summary": "...", "stats": { "issues": 2, "suggestions": 3, "praise": 1 } }`

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

## Notes

- Replace `PORT`, `REVIEW_ID`, `OWNER`, `REPO`, `PR_NUMBER`, `COMMENT_ID`, `SUGGESTION_ID`, and `ANALYSIS_ID` with actual values from the review context.
- All POST/PUT/DELETE endpoints return `{ "success": true, ... }` on success.
- Error responses have the shape `{ "error": "description" }` with appropriate HTTP status codes.
- The review ID and review type (local vs PR) are provided in your system prompt context.
