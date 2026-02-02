---
name: analyze
description: >
  Perform AI-powered code review analysis using pair-review's server-side analysis engine via MCP.
  Requires the pair-review MCP server to be connected. For standalone analysis without MCP,
  use the `code-critic:analyze` skill instead.
  Starts analysis via the pair-review MCP start_analysis tool, polls for completion,
  then fetches and presents the curated suggestions. Results are also visible in the
  pair-review web UI alongside the diff.
  Use when the user says "analyze in the app", "analyze in the UI", "run server analysis",
  "analyze with pair-review", or wants analysis results integrated into the pair-review web UI.
  If the user says something ambiguous like "analyze my changes" or "run analysis" without
  specifying a method, and both the `code-critic:analyze` and `pair-review:analyze` skills are available,
  ask whether they want: (1) agent-based analysis (`code-critic:analyze` — results returned
  directly in the conversation, no server required), or (2) in-app analysis
  (`pair-review:analyze` — results appear in the pair-review web UI, requires MCP connection).
  If only one analysis skill is available, use it directly without asking.
arguments:
  tier:
    description: "Prompt tier: fast (surface/Haiku-class), balanced (standard/Sonnet-class, default), or thorough (deep/Opus-class)"
    required: false
    default: balanced
  skipLevel3:
    description: "Skip Level 3 (codebase context) analysis. Useful for small or isolated changes."
    required: false
    default: false
  customInstructions:
    description: "Optional repo or user-specific review instructions"
    required: false
---

# Analyze Changes (Server-Side via MCP)

Perform a three-level code review analysis using pair-review's built-in analysis engine. Unlike the `code-critic:analyze` skill (which spawns analysis agents directly within the coding agent's context), this skill delegates all analysis work to the pair-review server via MCP tool calls. Use this skill when the pair-review MCP server is connected; use `code-critic:analyze` when it is not.

**Prerequisites**: The pair-review MCP server must be connected with the `start_analysis`, `get_ai_analysis_runs`, and `get_ai_suggestions` tools available.

## 1. Gather context

Determine what is being reviewed:

- **Local changes**: Run `git rev-parse HEAD` to get the HEAD SHA, and use the current working directory as the path.
- **PR changes**: Determine the repository (`owner/repo`) and PR number. If the user provides a PR URL, extract these from it. If available, run `gh pr view --json number,headRepository` or similar.
- If the user specifies a particular scope, use that.

Collect:
- Whether this is local or PR mode
- For local: the absolute path and HEAD SHA
- For PR: the `owner/repo` string and PR number

## 2. Start analysis

Call the `start_analysis` MCP tool with the appropriate parameters:

**For local mode:**
```json
{
  "path": "/absolute/path/to/repo",
  "headSha": "abc123...",
  "tier": "balanced",
  "skipLevel3": false,
  "customInstructions": "optional instructions"
}
```

**For PR mode:**
```json
{
  "repo": "owner/repo",
  "prNumber": 42,
  "tier": "balanced",
  "skipLevel3": false,
  "customInstructions": "optional instructions"
}
```

Pass the `tier`, `skipLevel3`, and `customInstructions` arguments from the skill invocation.

The tool returns immediately with `{ analysisId, runId, reviewId, status: "started" }`.

## 3. Poll for completion

Analysis typically takes 1-5 minutes depending on the size of the changes and the tier.

Poll using `get_ai_analysis_runs` with `limit: 1` and the review coordinates from step 1. Wait approximately 10 seconds between polls.

**For local mode:**
```json
{
  "path": "/absolute/path/to/repo",
  "headSha": "abc123...",
  "limit": 1
}
```

**For PR mode:**
```json
{
  "repo": "owner/repo",
  "prNumber": 42,
  "limit": 1
}
```

Verify that `runs[0].id` matches the `runId` returned from step 2 to ensure you are polling the correct analysis (another tab or user could have triggered a concurrent run).

Check the `status` field in `runs[0]`:
- `"running"`: Analysis is still in progress — keep polling
- `"completed"`: Analysis finished — proceed to fetch results using the same `runId`
- `"failed"`: Analysis failed — report the failure to the user

Keep polling until `status` is `completed` or `failed`. Report progress to the user between polls.

## Error handling

- If `start_analysis` returns an error, report it to the user with the error message. Common causes: the PR has not been loaded in pair-review yet, the worktree is missing, or invalid parameters.
- If polling shows `status: "failed"`, report the failure to the user. The `error` field in the run object contains the failure reason.
- If `get_ai_suggestions` returns an empty list after a completed analysis, this means no issues were found -- report a clean result.

## 4. Fetch results

Once the analysis is complete, call `get_ai_suggestions` to retrieve the curated suggestions.

Pass the `runId` from step 2's `start_analysis` response (same value used for polling):

```json
{
  "runId": "the-runId-from-step-2"
}
```

If `runId` is unavailable, fall back to resolving by review coordinates:

**For local mode:**
```json
{
  "path": "/absolute/path/to/repo",
  "headSha": "abc123..."
}
```

**For PR mode:**
```json
{
  "repo": "owner/repo",
  "prNumber": 42
}
```

This returns the final orchestrated suggestions from the latest analysis run.

## 5. Report

Present the curated suggestions to the user, organized by file. For each suggestion show:
- File and line reference
- Type (bug, improvement, security, performance, praise, etc.)
- Title and description
- Confidence level

Group suggestions by file for easy navigation. Highlight critical issues (bugs, security) prominently.

If no suggestions were found, report that the analysis completed cleanly.
