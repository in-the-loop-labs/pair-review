---
name: review-requests
description: >
  Open outstanding GitHub review requests in pair-review for AI-powered code review.
  Finds open PRs where my review is pending from the past week and starts pair-review
  analysis for each. Use when the user says "review requests", "review my PRs",
  "check review requests", "open review requests", "pair-review my requests",
  or wants to batch-review their outstanding GitHub review requests.
---

# Review Requests

Batch-open outstanding GitHub review requests in pair-review with AI analysis.

## Workflow

### Phase 1: Discover pair-review server

Call `mcp__pair-review__get_server_info` to get the pair-review web UI URL. If the server
is not running, inform the user and stop.

### Phase 2: Find pending review requests

Use `user-review-requested:@me` (not `review-requested`) to find only PRs where the user
was *directly* requested as a reviewer, excluding team-based review requests. The `gh search prs`
CLI does not support this qualifier, so use the search API directly:

```bash
SINCE=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d)
gh api "search/issues?q=is:pr+is:open+user-review-requested:@me+updated:>=${SINCE}&per_page=30" \
  --jq '.items[] | {number, title, html_url, repo: (.repository_url | split("/")[-2:] | join("/"))}'
```

Each result provides `number`, `title`, `html_url`, and `repo` (as `owner/repo`).

### Phase 3: Open each PR in pair-review with auto-analysis

For each PR found, open it in the browser with the `?analyze=true` query parameter, which
automatically starts AI analysis when the page loads:

```
open "{server_url}/pr/{owner}/{repo}/{number}?analyze=true"
```

where `{owner}/{repo}` comes from the `repo` field split on `/`.

No MCP calls per PR are needed — the `?analyze=true` parameter handles triggering analysis.

### Phase 4: Report

Summarize what was done:
- How many PRs were found with pending review
- List each PR opened in pair-review with title and URL
- If no pending review requests exist, say so
