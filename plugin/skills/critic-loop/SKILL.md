---
name: critic-loop
description: >
  Implement code, review changes with AI analysis, fix issues, and repeat until clean
  or max iterations reached. Creates a tight implement-review-fix feedback loop.
  Use when the user says "critic loop", "implement and review", "build with review loop",
  or wants iterative development with automated quality checks.
arguments:
  maxIterations:
    description: "Maximum number of review-fix cycles after initial implementation (default: 3)"
    required: false
    default: 3
  tier:
    description: "Analysis tier: fast (Haiku-class), balanced (Sonnet-class, default), or thorough (Opus-class)"
    required: false
    default: balanced
  customInstructions:
    description: "Optional review-specific instructions (e.g., 'focus on security', 'this repo uses X pattern')"
    required: false
---

# Critic Loop

Implement an objective, then iterate with AI-powered code review — addressing both review findings and incomplete work — until the objective is fully realized and the code is clean.

## ZERO PREAMBLE RULE

**Do NOT read source files, grep for patterns, or explore the project structure before starting.**
Go DIRECTLY to the Initialize phase. The Task agents will do their own exploration.

**Your role is orchestrator.** You launch Tasks, read their short return summaries, run lightweight Bash commands (git status, file writes), and make loop decisions. That is ALL. You *should* still read the loop log file and run lightweight git commands as needed for orchestration.

## Architecture: File-Mediated Analysis

All heavy work runs in Task agents. Analysis results are written to a **JSON file on disk** — the main session never sees the full analysis output. This keeps per-iteration context growth to ~300-400 tokens.

```
Main session → Analysis Task → writes .critic-loop/{id}.analysis.json → returns 3-line summary
Main session → reads summary, decides continue/stop
Main session → Fix Task → reads .analysis.json from disk → returns 3-line summary
                                                         → deletes .analysis.json
```

## Workflow

```
IMPLEMENT → ANALYZE → EVALUATE ──→ done → REPORT
                ↑                ↓
                └──── FIX ←──── continue
```

Each iteration works toward two goals simultaneously: resolving review findings **and** making further progress on the original objective. The loop converges when the objective is complete and the code is clean.

The user's request text (after any named arguments) is the **objective** — what to build or change.

### Context Recovery

After `/compact` or session restart, read `{LOG_FILE}` to recover the objective, iteration count, and history. The log header contains everything needed to resume the loop. The SKILL.md instructions will be re-injected automatically since the skill is still active.

If context grows large after many iterations, you may `/compact` between iterations. The log file preserves all state needed to resume.

---

## Phase: Initialize

1. Generate a unique log ID: `date +%s`
2. Get the project root: `git rev-parse --show-toplevel`
3. Create the working directory: `mkdir -p {project_root}/.critic-loop`
4. If `.critic-loop/` is not already in `.gitignore`, add it:
   ```bash
   grep -qxF '.critic-loop/' .gitignore 2>/dev/null || echo '.critic-loop/' >> .gitignore
   ```
5. Store these values for use in subsequent phases:
   - `LOG_FILE` = `{project_root}/.critic-loop/{id}.log`
   - `ANALYSIS_FILE` = `{project_root}/.critic-loop/{id}.analysis.json`
6. Create the log file at `{LOG_FILE}`:

```
# Critic Loop Log
- Objective: {the user's objective, verbatim}
- Project root: {project_root}
- maxIterations: {value}
- tier: {value}
- customInstructions: {value or "none"}
- iteration: 0
```

This header block is the source of truth for the loop's state. It must survive `/compact` and be parseable on resume.

---

## Phase: Implement

Launch a **Task agent** (subagent_type: "general-purpose") to implement the objective.

**Task prompt must include:**
- The full objective text from the user's request
- The current working directory and relevant context (branch name, repo structure hints)
- Instructions to work autonomously and make all necessary code changes
- **Do NOT commit changes** — leave them as working tree modifications
- **`git add -N` (intent-to-add) any newly created files** — this makes them visible to `git diff` commands used in analysis
- A request to return a concise summary (3-5 sentences): files modified, key decisions, any caveats

**Before proceeding**, verify the task succeeded and made changes:
```bash
git status --short
```
If no changes exist, inform the user and stop.

All analysis throughout the loop uses `git diff HEAD` to capture the full set of uncommitted working tree changes. Because the implementation and fix tasks `git add -N` any new files they create, untracked files are included in the diff output.

---

## Phase: Analyze

Launch a **single Task agent** (subagent_type: "general-purpose") that performs the full analysis pipeline and writes results to disk. The main session does NOT see the analysis details.

**Task prompt:**

> You are a code review analysis agent. Your job is to run a three-level code review and write the curated results to a JSON file.
>
> **Output file**: Write the final curated JSON to `{ANALYSIS_FILE}`
>
> **Return to me**: ONLY a brief summary in this exact format:
> ```
> Suggestions: {N} line-level, {M} file-level
> Types: {comma-separated list of types found, e.g. "bug, improvement, praise"}
> Objective status: complete|incomplete|partial — {brief reason}
> Summary: {2 sentences describing the most significant findings}
> ```
> Do NOT return the full JSON. Do NOT return individual suggestions. Just the summary above.
>
> **How to run the analysis:**
>
> 1. Find the analysis tools:
>    - Use Glob to find `**/agent-analyze/scripts/git-diff-lines` — this is the diff annotation script
>    - Use Glob to find `**/agent-analyze/references/` — this directory contains the analysis prompts
>    - Resolve the absolute path to the scripts directory from the Glob result. Use this resolved path in all `PATH=` commands below and include it in each sub-task prompt.
>    - Read these reference files for tier "{tier}":
>      - `references/level1-{tier}.md`
>      - `references/level2-{tier}.md`
>      - `references/level3-{tier}.md`
>      - `references/orchestration-{tier}.md`
>
> 2. Get the annotated diff:
>    - Run `PATH="{scripts-dir}:$PATH" git-diff-lines HEAD` to get the diff with line numbers
>    - Run `git diff --name-only HEAD` to get the list of changed files
>
> 3. Launch Level 1, Level 2, and Level 3 analysis as **parallel Task agents** (subagent_type: "general-purpose"). Each task:
>    - Receives the full prompt text from its reference file as core instructions
>    - Receives the annotated diff output and list of changed files
>    - Must return valid JSON (no markdown wrapping) matching the schema in its prompt
>    - Include the resolved `PATH="{scripts-dir}:$PATH"` command in each sub-task prompt so they can invoke `git-diff-lines` directly
>
> 4. After all levels complete, launch one **orchestration Task agent** that:
>    - Receives the orchestration prompt from the reference file
>    - Receives the JSON output from all three levels
>    - Merges, deduplicates, and curates suggestions
>    - Returns final curated JSON
>
> 5. Write the orchestrated JSON to `{ANALYSIS_FILE}`
>
> 6. Count suggestions and fileLevelSuggestions from the curated result and return ONLY the brief summary format specified above.
>
> {customInstructions if provided: "Additional review instructions: {customInstructions}"}

The Task agent returns ~3 lines. That is all the main session sees.

---

## Phase: Evaluate

This phase runs in the **main session** — it is lightweight.

Parse the summary returned by the Analysis Task. It contains:
- Suggestion counts (line-level and file-level)
- Types of suggestions found
- Objective status (`complete`, `incomplete`, or `partial`) with a brief reason
- A 2-sentence summary of findings

**Decision criteria** (evaluate in this order):

1. **Iteration counter >= maxIterations** → Max reached. Go to **Completion** with note that issues remain.
2. **Objective status is `incomplete` or `partial`** → Continue to the Fix phase regardless of suggestion types.
3. **Suggestions contain `bug`, `security`, `performance`, `improvement`, or `design`** → Continue to the Fix phase.
4. **Only `praise` and/or `code-style` suggestions and objective status is `complete`** → Go to **Completion**.

Append a decision line to the log file:
```
Iteration {N}/{max}: {line-level} line-level + {file-level} file-level suggestions → {continuing|clean|max reached}
```

---

## Phase: Fix

Launch a **Task agent** (subagent_type: "general-purpose") to address findings and continue the objective.

**Before launching**, append the iteration header to the log:
```
## Iteration {N}
- Analysis summary: {the summary from the Analyze phase}
```

**Task prompt:**

> You are a code fix agent. Read the analysis results and fix valid issues while continuing progress on the objective.
>
> **Original objective**: {objective}
>
> **Analysis file**: Read `{ANALYSIS_FILE}` — it contains the full curated analysis JSON with `suggestions` (line-level) and `fileLevelSuggestions` (file-level) arrays.
>
> **Iteration history**: Read `{LOG_FILE}` — it shows what was already tried in previous iterations. Take a different approach if an issue reappears.
>
> **For each suggestion** (from both arrays):
> 1. Read the referenced file and lines
> 2. Evaluate whether the suggestion is valid or a false positive
> 3. If valid, make the code change
> 4. If false positive or not worth fixing, skip and note why
>
> **Also**: Continue implementing any incomplete parts of the objective that the analysis identified as missing.
>
> **Rules**:
> - Do NOT commit changes — leave them as working tree modifications
> - `git add -N` (intent-to-add) any newly created files
> - After finishing, delete `{ANALYSIS_FILE}` — it is no longer needed
>
> **Return to me**: ONLY a brief summary (3-5 sentences): what was fixed, what was skipped (and why), what progress was made on the objective.

After the Fix Task completes:

1. Append the fix summary to the log:
   ```
   - Fix actions: {the summary returned by the fix task}
   ```
2. Increment the iteration counter in the log file header — update the `- iteration: {N}` line to the new value.

---

## MANDATORY: Return to Analyze

**After completing the Fix phase, you MUST go back to the Analyze phase.**

The ONLY ways to exit the loop are:
1. The Evaluate phase decides the work is clean and complete → goes to Completion
2. The Evaluate phase decides maxIterations was reached → goes to Completion

There are NO other valid reasons to stop looping. Do not stop after one fix cycle. Do not stop because "things look good." Only the Evaluate phase's decision logic can end the loop.

**Go to the Analyze phase now.**

---

## Completion

Report the final status to the user:

- **Iterations performed**: How many review-fix cycles ran
- **Outcome**: Whether the objective is complete and the code is clean, or max iterations were reached
- **Changes summary**: What was implemented and what was fixed across all iterations
- **Remaining issues**: If max iterations hit, list the summary from the last analysis
- **Files modified**: Complete list (run `git diff --name-only HEAD`)

Then offer next steps (do not perform them automatically):
- Run tests if applicable
- Use `/local` or `/pr` to open a human review in the pair-review web UI
- Stage or commit the changes when satisfied

Clean up:
```bash
rm -f {ANALYSIS_FILE}
```

If the outcome is clean, also remove the log and the directory (if empty):
```bash
rm -f {LOG_FILE}
rmdir .critic-loop 2>/dev/null
```

If max iterations were reached with remaining issues, **leave the log in place** and mention its location in the completion report so the user can inspect it.
