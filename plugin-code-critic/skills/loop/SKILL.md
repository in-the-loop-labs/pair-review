---
name: loop
description: >
  Implement code, review changes with AI analysis, fix issues, and repeat until clean
  or max iterations reached. Creates a tight implement-review-fix feedback loop.
  Use when the user says "critic loop", "code review loop", "implement and review", "build with review loop",
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
  skipLevel3:
    description: "Skip Level 3 (codebase context) analysis. Set 'true' to skip, 'false' to force, or 'auto' to let the analysis agent decide based on change scope (default: auto)."
    required: false
    default: auto
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

All heavy work runs in Task agents. Analysis results are written to a **directory on disk** — the main session never sees the full analysis output. This keeps per-iteration context growth to ~300-400 tokens.

```
.critic-loop/{id}/
├── loop.log                # High-level orchestration log
├── analysis.1.json         # Iteration 1 analysis (kept for history)
├── analysis.2.json         # Iteration 2 analysis
├── implementation.0.md     # What initial Implement task built
├── implementation.1.md     # What Fix iteration 1 addressed
└── implementation.2.md     # What Fix iteration 2 addressed
```

```
Main session → Implement Task → writes implementation.0.md → returns summary
Main session → Analysis Task → writes analysis.{N}.json → returns summary
Main session → reads summary, decides continue/stop
Main session → Fix Task → reads analysis.{N}.json → writes implementation.{N}.md → returns summary
```

**History is preserved.** Analysis and implementation files are kept for debugging and so subsequent iterations can avoid re-suggesting already-addressed issues.

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
3. Create the loop directory: `mkdir -p {project_root}/.critic-loop/{id}`
4. If `.critic-loop/` is not already in `.gitignore`, add it:
   ```bash
   grep -qxF '.critic-loop/' .gitignore 2>/dev/null || echo '.critic-loop/' >> .gitignore
   ```
5. Store these values for use in subsequent phases:
   - `LOOP_DIR` = `{project_root}/.critic-loop/{id}`
   - `LOG_FILE` = `{LOOP_DIR}/loop.log`
   - Analysis files are dynamic: `{LOOP_DIR}/analysis.{iteration}.json` (iteration starts at 1)
   - Implementation files are dynamic: `{LOOP_DIR}/implementation.{iteration}.md` (iteration 0 = initial implementation)
6. Create the log file at `{LOG_FILE}`:

```
# Critic Loop Log
- Objective: {the user's objective, verbatim}
- Project root: {project_root}
- Loop directory: {LOOP_DIR}
- maxIterations: {value}
- tier: {value}
- skipLevel3: {value}
- customInstructions: {value or "none"}
- iteration: 0  # completed fix cycles (implementation.0.md is the initial build)
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
- Write a summary file at `{LOOP_DIR}/implementation.0.md` with this structure:
  ```markdown
  # Initial Implementation

  ## What was built
  - {bullet points of what was created/modified}

  ## Key decisions
  - {any notable choices made}

  ## Caveats
  - {any incomplete items or known limitations}
  ```
- Return a concise summary (3-5 sentences) to the main session: files modified, key decisions, any caveats

**Before proceeding**, verify the task succeeded and made changes:
```bash
git status --short
```
If no changes exist, inform the user and stop.

All analysis throughout the loop uses `git diff HEAD` to capture the full set of uncommitted working tree changes. Because the implementation and fix tasks `git add -N` any new files they create, untracked files are included in the diff output.

---

## Phase: Analyze

Launch a **single Task agent** (subagent_type: "general-purpose") that performs the full analysis pipeline and writes results to disk. The main session does NOT see the analysis details.

**Determine the analysis file path:** `{LOOP_DIR}/analysis.{iteration}.json` where iteration is 1 for the first analysis, 2 after the first fix, etc. (The iteration counter in the log file shows how many fix cycles have completed; add 1 for the current analysis.)

**Build aggregate custom instructions** to pass to the analysis task. These give the analysis agent context about the loop:

```markdown
## Loop Context

**Objective:** {the user's objective verbatim from the log file}

**Iteration:** {current iteration} of {maxIterations}

{User's customInstructions if provided, otherwise omit this section}

## History Reference
Previous iteration files are available at:
- `{LOOP_DIR}/analysis.*.json` — Prior analysis results (1 through current-1)
- `{LOOP_DIR}/implementation.*.md` — What was implemented/fixed (0 = initial, 1+ = fixes)

If you see a suggestion that was already made and addressed in a previous iteration,
do NOT re-suggest it unless the fix introduced a new problem.

## Merge Readiness Assessment
In addition to objective status, assess whether these changes are ready to merge:
- `ready` = Objective complete, no blocking issues. Minor polish suggestions may exist but would not block a code review approval.
- `needs-fixes` = Issues that should be addressed before merging (bugs, security, incomplete features).
- `blocked` = Major issues that would definitely block merging (critical bugs, security vulnerabilities, broken functionality).
```

**Task prompt:**

> You are a code review analysis agent. Your job is to run a three-level code review and write the curated results to a JSON file.
>
> **Output file**: Write the final curated JSON to `{LOOP_DIR}/analysis.{iteration}.json`
>
> **Return to me**: ONLY a brief summary in this exact format:
> ```
> Suggestions: {N} line-level, {M} file-level
> Types: {comma-separated list of types found, e.g. "bug, improvement, praise"}
> Level 3: {ran|skipped} — {reason if auto}
> Objective status: complete|incomplete|partial — {brief reason}
> Merge readiness: ready|needs-fixes|blocked — {brief reason}
> Summary: {2 sentences describing the most significant findings}
> ```
> Do NOT return the full JSON. Do NOT return individual suggestions. Just the summary above.
>
> **How to run the analysis:**
>
> 1. Find the analysis tools:
>    - Use Glob to find `**/analyze/scripts/git-diff-lines` — this is the diff annotation script
>    - Use Glob to find `**/analyze/references/` — this directory contains the analysis prompts
>    - Resolve the absolute path to the scripts directory from the Glob result. Use this resolved path in all `PATH=` commands below and include it in each sub-task prompt.
>    - Read the reference files for tier "{tier}" (read Level 3 only if it will be needed based on `skipLevel3` setting):
>      - `references/level1-{tier}.md`
>      - `references/level2-{tier}.md`
>      - `references/level3-{tier}.md` (skip if `skipLevel3` is `true`; read if `false` or `auto` since the agent may need it)
>      - `references/orchestration-{tier}.md`
>
> 2. Get the annotated diff:
>    - Run `PATH="{scripts-dir}:$PATH" git-diff-lines HEAD` to get the diff with line numbers
>    - Run `git diff --name-only HEAD` to get the list of changed files
>
> 3. Determine which analysis levels to run:
>    - **Level 1 and Level 2**: Always run these.
>    - **Level 3 (codebase context)**: Depends on the `skipLevel3` setting:
>      - If `skipLevel3` is `true`: **Skip Level 3** — do not launch a Level 3 task.
>      - If `skipLevel3` is `false`: **Run Level 3** — always launch a Level 3 task.
>      - If `skipLevel3` is `auto`: Assess the diff to decide. Run Level 3 if ANY of these apply: changes affect shared utilities/APIs/types/interfaces, entire modules are added or deleted, changes are cross-cutting (e.g., renaming a widely-used function). Skip Level 3 if changes are small and localized (CSS/copy/config/test-only, no cross-cutting concerns). When in doubt, run Level 3.
>
>    Launch the analysis levels you determined above as **parallel Task agents** (subagent_type: "general-purpose"). Each task:
>    - Receives the full prompt text from its reference file as core instructions
>    - Receives the annotated diff output and list of changed files
>    - Must return valid JSON (no markdown wrapping) matching the schema in its prompt
>    - Include the resolved `PATH="{scripts-dir}:$PATH"` command in each sub-task prompt so they can invoke `git-diff-lines` directly
>
> 4. After all levels complete, launch one **orchestration Task agent** that:
>    - Receives the orchestration prompt from the reference file
>    - Receives the JSON output from all completed levels (pass empty `[]` for Level 3 if it was skipped)
>    - Merges, deduplicates, and curates suggestions
>    - Returns final curated JSON
>
> 5. Write the orchestrated JSON to the output file path specified above.
>
> 6. Count suggestions and fileLevelSuggestions from the curated result and return ONLY the brief summary format specified above.
>
> **Aggregate custom instructions:**
> {the aggregate custom instructions block built above}

The Task agent returns ~5 lines. That is all the main session sees. **Do NOT delete analysis files** — they are kept for history.

---

## Phase: Evaluate

This phase runs in the **main session** — it is lightweight.

Parse the summary returned by the Analysis Task. It contains:
- Suggestion counts (line-level and file-level)
- Types of suggestions found
- Level 3 status (ran or skipped, with reason if auto-decided)
- Objective status (`complete`, `incomplete`, or `partial`) with a brief reason
- Merge readiness (`ready`, `needs-fixes`, or `blocked`) with a brief reason
- A 2-sentence summary of findings

**Decision criteria** (evaluate in this order):

1. **Iteration counter >= maxIterations** → Max reached. Go to **Completion** with note that issues remain.
2. **Merge readiness is `ready`** → SUCCESS. Go to **Completion**. The objective is complete and the code is clean enough to merge. Minor polish suggestions may exist but they don't block approval.
3. **Objective status is `incomplete` or `partial`** → Continue to the Fix phase.
4. **Merge readiness is `blocked`** → Continue to the Fix phase. Critical issues must be addressed.
5. **Merge readiness is `needs-fixes` AND suggestions contain actionable types** (`bug`, `security`, `performance`, `improvement`, or `design`) → Continue to the Fix phase.
6. **No actionable suggestions remaining** (only `praise` and/or `code-style`) → Go to **Completion** (clean).

The key difference from simpler logic: a `ready` merge status stops the loop even if there are minor improvement suggestions. This prevents chasing perfection to max iterations when the code is already good enough.

Append a decision line to the log file:
```
Iteration {N}/{max}: {line-level} line-level + {file-level} file-level suggestions, merge={merge_readiness} → {continuing|clean|ready|max reached}
```

---

## Phase: Fix

Launch a **Task agent** (subagent_type: "general-purpose") to address findings and continue the objective.

**Determine the current fix iteration**: Read the `- iteration: {N}` line from the log file. Set `CURRENT = N + 1` (the fix iteration number, since N represents completed cycles). Use `CURRENT` for all file paths in this phase.

**Before launching**, append the iteration header to the log:
```
## Iteration {CURRENT}
- Analysis summary: {the summary from the Analyze phase}
```

**Task prompt:**

> You are a code fix agent. Read the analysis results and fix valid issues while continuing progress on the objective.
>
> **Original objective**: {objective}
>
> **Analysis file**: Read `{LOOP_DIR}/analysis.{CURRENT}.json` — it contains the full curated analysis JSON with `suggestions` (line-level) and `fileLevelSuggestions` (file-level) arrays.
>
> **Iteration history**: Read `{LOG_FILE}` and the implementation files in `{LOOP_DIR}/implementation.*.md` — these show what was already tried in previous iterations. Take a different approach if an issue reappears.
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
> - Write a summary file at `{LOOP_DIR}/implementation.{CURRENT}.md` with this structure:
>   ```markdown
>   # Iteration {CURRENT} Response
>
>   ## Suggestions addressed
>   - {suggestion type}: {file:line} — {what was fixed}
>
>   ## Suggestions skipped
>   - {suggestion type}: {file:line} — {reason: false positive / not worth fixing / style preference}
>
>   ## Objective progress
>   - {any additional work done toward the objective}
>   ```
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
- **Outcome**: Whether the objective is complete and the code is clean/ready, or max iterations were reached
- **Changes summary**: What was implemented and what was fixed across all iterations
- **Remaining issues**: If max iterations hit, list the summary from the last analysis
- **Files modified**: Complete list (run `git diff --name-only HEAD`)

Then offer next steps (do not perform them automatically):
- Run tests if applicable
- Use `pair-review:local` or `pair-review:pr` to open a human review in the pair-review web UI (requires the pair-review plugin)
- Stage or commit the changes when satisfied

**Clean up based on outcome:**

If the outcome is clean (merge readiness was `ready` or no actionable suggestions remained):
```bash
# Remove the entire loop directory
rm -rf {LOOP_DIR}
# Remove parent .critic-loop directory if empty
rmdir .critic-loop 2>/dev/null
```

If max iterations were reached with remaining issues, **leave the loop directory intact** and mention its location in the completion report so the user can inspect the history:
- `{LOOP_DIR}/loop.log` — orchestration log with all iteration summaries
- `{LOOP_DIR}/analysis.*.json` — analysis results from each iteration
- `{LOOP_DIR}/implementation.*.md` — what was implemented/fixed in each iteration
