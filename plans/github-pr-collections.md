# GitHub PR Collections on Index Page

## Overview
Add two new tabs to the index page: "Review Requests" and "My PRs", fetching data from the GitHub API.

## Design Decision: Option A — Flat Tabs
Four tabs with a subtle divider before the Local tab:
```
[Pull Requests] [Review Requests] [My PRs]  |  [Local Reviews]
```

## Backend

### New route file: `src/routes/github-collections.js`

Two endpoint pairs per collection:

- **`GET /api/github/review-requests`** — Returns cached data (or empty if never fetched)
- **`POST /api/github/review-requests/refresh`** — Hits GitHub Search API, updates cache, returns fresh data
- **`GET /api/github/my-prs`** — Returns cached data (or empty if never fetched)
- **`POST /api/github/my-prs/refresh`** — Hits GitHub Search API, updates cache, returns fresh data

### GitHub API queries
- Review Requests: `GET /search/issues?q=is:pr+is:open+review-requested:{username}`
- My PRs: `GET /search/issues?q=is:pr+is:open+author:{username}`

Both require knowing the authenticated user's login — use `octokit.rest.users.getAuthenticated()`.

### New method on GitHubClient: `searchPullRequests(query)`
Returns array of `{ owner, repo, number, title, author, updated_at, html_url }`.

### DB Cache: `github_pr_cache` table (migration v26)

| Column | Type |
|--------|------|
| id | INTEGER PK |
| owner | TEXT NOT NULL |
| repo | TEXT NOT NULL |
| number | INTEGER NOT NULL |
| title | TEXT |
| author | TEXT |
| updated_at | TEXT |
| html_url | TEXT |
| collection | TEXT NOT NULL (review-requests / my-prs) |
| fetched_at | DATETIME DEFAULT CURRENT_TIMESTAMP |

Unique index on `(collection, owner, repo, number)`.

Cache strategy:
- GET returns from cache (could be empty)
- POST refresh: delete old rows for that collection, insert fresh results
- Frontend: on first tab visit, GET. If empty, auto-trigger refresh.

## Frontend

### HTML (`public/index.html`)
- Add two new tab buttons with data-tab attributes
- Add a `.tab-divider` span before Local Reviews
- Add two new `.tab-pane` divs with:
  - A `.tab-pane-header` containing a refresh button
  - A container div for the table/empty state

### CSS
- `.tab-divider` — thin vertical line separator
- `.btn-refresh` — icon button with spin animation while loading
- Reuse existing table styles

### JS (`public/js/index.js`)
- New pagination state objects for each collection
- `loadReviewRequests()` / `loadMyPrs()` — fetch from cache endpoint
- `refreshReviewRequests()` / `refreshMyPrs()` — POST to refresh endpoint, then reload
- Auto-refresh on first visit if cache is empty
- Lazy-load on tab activation (same pattern as local reviews)
- Tab persistence in localStorage

### Empty states
1. No GitHub token: "Configure a GitHub token to see review requests."
2. Loading/refreshing: spinner
3. Zero results: "No PRs awaiting your review." / "You have no open pull requests."

## Cross-tab behavior
Clicking a PR from new tabs goes through existing worktree creation flow (same as pasting a URL in the Pull Requests tab). After that, the PR appears in Pull Requests naturally.

## Deferred
- Badge counts on tabs
- Graphite stack grouping in "My PRs"
- Background auto-refresh
- Mobile responsive layout
