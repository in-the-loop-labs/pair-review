---
name: analyze
description: >
  Perform AI-powered code review analysis using pair-review's three-level framework.
  Runs Level 1 (diff isolation), Level 2 (file context), and Level 3 (codebase context)
  as parallel tasks, then orchestrates results into curated suggestions.
  Use when the user says "analyze my changes", "analyze this PR", "run analysis",
  "AI review", or wants automated code review suggestions on local or PR changes.
---

# Analyze Changes

Perform a three-level code review analysis and return curated suggestions.

## Tools

This skill includes a `scripts/git-diff-lines` script that annotates `git diff` output with explicit OLD and NEW line numbers. Pass the absolute path to this script to each subagent so they can execute it.

## 1. Gather context

Determine what's being reviewed:

- **Local changes**: `git diff --name-only HEAD` for changed files.
- **PR changes**: Determine the merge base (`git merge-base main HEAD`), then diff against it. Get PR title and description if available.
- If the user specifies a different diff range, use that.

Collect:
- The list of changed files
- PR metadata (title, description, author) if applicable
- Whether this is local or PR mode

## 2. Run three analysis levels in parallel

Launch **three Task agents simultaneously** (subagent_type: "general-purpose"). Each task must:
1. Read its reference file from this skill's `references/` directory
2. Use the `git-diff-lines` script to get the annotated diff
3. Analyze the changes per its framework
4. Return valid JSON (no markdown wrapping) with the schema defined in the reference file

Pass each task the following context in its prompt:
- Review type (local or PR)
- The list of changed files
- PR title and description (if PR mode)
- The absolute path to its reference file
- The absolute path to the `scripts/git-diff-lines` script

**Level 1** — `references/level1.md`: Analyze changes in isolation (diff only)
**Level 2** — `references/level2.md`: Analyze changes in file context (full files)
**Level 3** — `references/level3.md`: Analyze changes in codebase context (architecture, dependencies)

## 3. Orchestrate results

Launch one more Task agent (subagent_type: "general-purpose") that:
1. Reads `references/orchestration.md`
2. Receives the JSON output from all three levels
3. Merges, deduplicates, and curates suggestions
4. Returns final curated JSON

## 4. Report

Present the curated suggestions to the user, organized by file. For each suggestion:
- File and line reference
- Type (bug, improvement, security, etc.)
- Title and description
- Suggested fix (if applicable)
- Confidence level
