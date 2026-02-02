---
name: analyze
description: >
  Perform AI-powered code review analysis by spawning parallel Task agents directly within
  the coding agent's context. Does not require the pair-review MCP server — works standalone.
  Runs Level 1 (diff isolation), Level 2 (file context), and Level 3 (codebase context)
  as parallel tasks, then orchestrates results into curated suggestions.
  Results are returned directly in the conversation and also pushed to the pair-review web UI (if running).
  Use when the user says "analyze", "analyze my changes", "run analysis", "analyze using tasks",
  "analyze directly", "analyze here", or wants code review analysis of their changes.
  This is the default analysis skill. If the user says something ambiguous like
  "analyze my changes" or "run analysis", use this skill unless they specifically ask for
  in-app analysis. For in-app analysis (results in the pair-review web UI), use the
  `analyze-in-app` skill instead (requires MCP connection).
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
    description: "Optional repo or user-specific review instructions (e.g., 'focus on security' or 'this repo uses X pattern')"
    required: false
---

# Analyze Changes

Perform a three-level code review analysis and return curated suggestions.

## Tools

This skill includes a `scripts/git-diff-lines` script that annotates `git diff` output with explicit OLD and NEW line numbers. Each subagent should invoke it by name (`git-diff-lines`) — the orchestrating agent must ensure the script's directory is on `PATH` (e.g., via `PATH="<skill-dir>/scripts:$PATH"`).

## 1. Gather context

Determine what's being reviewed:

- **Local changes**: `git diff --name-only HEAD` for changed files.
- **PR changes**: Determine the merge base (`git merge-base main HEAD`), then diff against it. Get PR title and description if available.
- If the user specifies a different diff range, use that.

Collect:
- The list of changed files
- PR metadata (title, description, author) if applicable
- Whether this is local or PR mode
- Any custom review instructions the user provided

## 2. Get analysis prompts

Obtain the prompt instructions for each analysis level. Use the `tier` argument (default: `balanced`).

**If `get_analysis_prompt` is in your available tools** (i.e., the pair-review MCP server is connected):
- Call `get_analysis_prompt` for each level you will run: `level1`, `level2`, and (unless `skipLevel3` is true) `level3`
- Call `get_analysis_prompt` with `promptType: "orchestration"` for the orchestration step
- Pass the user's `tier` argument to each call
- Pass any custom review instructions (from the `customInstructions` argument, or gathered from user context in Step 1) as the `customInstructions` parameter — this injects them into the rendered prompt
- These return the full prompt text to use as Task agent instructions

**Otherwise** (standalone mode — no MCP connection):
- Read the static reference files from this skill's `references/` directory:
  - `references/level1-{tier}.md`
  - `references/level2-{tier}.md`
  - `references/level3-{tier}.md` (unless `skipLevel3`)
  - `references/orchestration-{tier}.md`

## 3. Run analysis levels in parallel

Launch **two or three Task agents simultaneously** (subagent_type: "general-purpose"), depending on `skipLevel3`. Each task must:
1. Use the prompt obtained in Step 2 as its core instructions
2. Use the `git-diff-lines` script to get the annotated diff
3. Analyze the changes per its framework
4. Return valid JSON (no markdown wrapping) with the schema defined in the prompt

Pass each task the following context in its prompt:
- The analysis prompt from Step 2
- Review type (local or PR)
- The list of changed files
- PR title and description (if PR mode)
- Instructions to invoke `git-diff-lines` (ensure the script's directory is on `PATH`)

**Level 1** — Analyze changes in isolation (diff only)
**Level 2** — Analyze changes in file context (full files)
**Level 3** — Analyze changes in codebase context (architecture, dependencies) — **skip if `skipLevel3` is true**

## 4. Orchestrate results

Launch one more Task agent (subagent_type: "general-purpose") that:
1. Uses the orchestration prompt from Step 2 as its core instructions
2. Receives the JSON output from all completed levels (pass empty `[]` for Level 3 if skipped)
3. Merges, deduplicates, and curates suggestions
4. Returns final curated JSON

## 5. Push results to server

Push the orchestrated JSON to the pair-review web UI so suggestions appear inline. This step does **not** require MCP — it uses a direct HTTP POST with a fallback to `http://localhost:7247` when the MCP `get_server_info` tool is unavailable.

1. **Determine server URL**:
   - If the `get_server_info` MCP tool is available, call it and use the `url` field
   - Otherwise, try reading the port from config: `cat ~/.pair-review/config.json 2>/dev/null | jq -r '.port // empty'`
   - If neither works, default to `http://localhost:7247`

2. **Build the POST body** from the orchestrated output:
   - For local mode: set `path` (absolute working directory from `pwd`) and `headSha` (from `git rev-parse HEAD`)
   - For PR mode: set `repo` (`owner/repo`) and `prNumber`
   - Include `provider`, `model`, `summary`, `suggestions`, and `fileLevelSuggestions` from the orchestrated JSON

3. **POST via `curl`** to `${SERVER_URL}/api/analysis-results`:
   ```
   curl -s --connect-timeout 3 --max-time 10 \
     -X POST "${SERVER_URL}/api/analysis-results" \
     -H "Content-Type: application/json" \
     -d @- <<'PAYLOAD'
   { ... }
   PAYLOAD
   ```

   A successful import returns HTTP 201 with `{ runId, reviewId, totalSuggestions, status: "completed" }`.

4. **Graceful degradation**: If the request fails (server not running, timeout, etc.), log a short warning and continue to the Report step. The push is best-effort.

5. Note in the report whether results were successfully pushed to the pair-review UI.

## 6. Report

Present the curated suggestions to the user, organized by file. For each suggestion:
- File and line reference
- Type (bug, improvement, security, etc.)
- Title and description
- Suggested fix (if applicable)
- Confidence level
