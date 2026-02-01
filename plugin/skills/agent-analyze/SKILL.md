---
name: agent-analyze
description: >
  Perform AI-powered code review analysis using pair-review's three-level framework.
  Runs Level 1 (diff isolation), Level 2 (file context), and Level 3 (codebase context)
  as parallel tasks, then orchestrates results into curated suggestions.
  Use when the user says "analyze my changes", "analyze this PR", "run analysis",
  "AI review", or wants automated code review suggestions on local or PR changes.
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

# Agent Analyze Changes

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

## 5. Report

Present the curated suggestions to the user, organized by file. For each suggestion:
- File and line reference
- Type (bug, improvement, security, etc.)
- Title and description
- Suggested fix (if applicable)
- Confidence level
