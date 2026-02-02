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

## Core Principle: Delegate Heavy Lifting

**Implementation and fix work MUST run in Task agents** (subagent_type: "general-purpose").
Analysis runs in the main session (via the `agent-analyze` skill, which works standalone without requiring an MCP server connection — see Step 2).
The main session orchestrates: invoking skills, launching tasks, parsing their JSON results,
running lightweight git commands, evaluating loop conditions, and reporting to the user.

This keeps context lean across iterations.

## Context Management

If the main session's context grows large after several iterations, summarize the iteration history
(see the iteration log maintained in Step 4) into a compact status block, then use `/compact`
to clear context before continuing the loop. The log file header contains the original objective,
all skill arguments, and the current iteration counter — everything needed to resume the loop
after `/compact` without losing state.

## Workflow

```
IMPLEMENT → ANALYZE → EVALUATE ──→ done → REPORT
                ↑                ↓
                └──── FIX ←──── continue
```

Each iteration works toward two goals simultaneously: resolving review findings **and** making further progress on the original objective. The loop converges when the objective is complete and the code is clean.

The user's request text (after any named arguments) is the **objective** — what to build or change.

---

## Step 0: Initialize

Generate a unique log ID using the current epoch seconds (e.g., the output of `date +%s`). The log file for this loop is `.critic-loop-{id}.log` — use this filename consistently for the remainder of the loop.

Initialize the iteration counter to **0** and write the log file header:
```
# Critic Loop Log
- Objective: {the user's objective, verbatim}
- maxIterations: {value}
- tier: {value}
- customInstructions: {value or "none"}
- iteration: 0
```

This header block is the source of truth for the loop's state. It must survive `/compact` and be parseable on resume.

---

## Step 1: Implement

Launch a **Task agent** to implement the objective.

**Task prompt must include:**
- The full objective text from the user's request
- The current working directory and relevant context (branch name, repo structure hints)
- Instructions to work autonomously and make all necessary code changes
- **Do NOT commit changes** — leave them as working tree modifications
- **`git add -N` (intent-to-add) any newly created files** — this makes them visible to `git diff` commands used in analysis
- A request to return a concise summary: files modified, key decisions, any caveats

**Before proceeding**, verify the task succeeded and made changes. If it reports failure or no changes, inform the user and stop.

After the implementation task completes, verify changes exist:
```bash
git status --short
```

All analysis throughout the loop uses `git diff HEAD` to capture the full set of uncommitted working tree changes. Because the implementation and fix tasks `git add -N` any new files they create, untracked files are included in the diff output.

---

## Step 2: Analyze

Invoke the **`agent-analyze` skill** directly from the main session (via the Skill tool) with these arguments:
- `tier`: pass through the `tier` argument from this skill
- `customInstructions`: pass through any `customInstructions` from this skill

The skill handles the entire analysis pipeline internally and returns the curated JSON result.

---

## Step 3: Evaluate

This step runs in the **main session** (it's lightweight — just parsing JSON and deciding).

1. Parse the `suggestions` array, `fileLevelSuggestions` array, and `summary` from the analysis result. Both suggestion arrays must be considered — `suggestions` contains line-level findings while `fileLevelSuggestions` contains file-level findings (architectural concerns, missing tests, organizational issues).
2. Count items from **both** `suggestions` and `fileLevelSuggestions`. No filtering is applied — all suggestion types are potentially valuable:
   - `bug`, `security`, `performance` indicate concrete issues
   - `improvement`, `design`, `suggestion` may provide useful alternative directions
   - `praise`, `code-style` provide reinforcement and are informational
3. Evaluate whether the work is complete. Consider **both** dimensions:
   - **Objective completeness**: Does the summary or do the suggestions indicate missing functionality, incomplete implementation, or TODO stubs? The analysis summary often flags gaps — treat these as reasons to continue.
   - **Code quality**: Are there significant review findings that warrant another iteration? A handful of low-confidence `code-style` suggestions may not warrant one, but multiple `bug` or `security` issues almost certainly do.
   - Use your judgment — the reviewer's notes in the summary also provide signal.
4. Decide:
   - **Objective is complete and no significant issues remain** → Go to **Completion**.
   - **Iteration counter >= maxIterations** → Max reached. Go to **Completion** with remaining issues listed.
   - **Objective is incomplete or significant issues remain** → Proceed to Step 4.

Log each decision:
```
Iteration {N}/{max}: {line-level} suggestions + {file-level} file-level suggestions → {continuing|clean|max reached}
```

---

## Step 4: Fix

Launch a **Task agent** to address the findings and continue working toward the objective.

### Iteration Log

Maintain the log file at `.critic-loop-{id}.log` (the filename generated in Step 0) in the working directory. Before launching the fix task, append the current iteration's findings to this file:
```
## Iteration {N}
- Suggestions: {summary of suggestion types and counts from both arrays}
- File-level suggestions: {summary of file-level suggestion types and counts}
- Key issues: {brief list of the most significant findings}
- Objective status: {complete | incomplete — brief note on what remains}
```

This file persists across iterations and context clears, giving fix tasks visibility into prior attempts.

**Task prompt must include:**
- **The original objective** — so the agent can continue making progress toward it, not just fix review findings
- The `suggestions` array as JSON from the analysis (line-level findings with specific line numbers)
- The `fileLevelSuggestions` array as JSON from the analysis (file-level findings — these won't have specific line numbers, so the agent should locate the relevant code itself)
- The contents of `.critic-loop-{id}.log` (the iteration history) — so the fix agent knows what was already tried and can take a different approach if an issue reappears
- Instructions for each suggestion (from both arrays):
  1. Read the referenced file and lines
  2. Evaluate whether the suggestion is valid or a false positive
  3. If valid, make the code change
  4. If false positive or not worth fixing, skip and note why
- Instructions to continue implementing any incomplete parts of the objective that the analysis identified as missing
- **Do NOT commit changes** — leave them as working tree modifications
- **`git add -N` (intent-to-add) any newly created files** — so they are visible to subsequent analysis diffs
- A request to return a summary: what was fixed, what was skipped (and why), what progress was made on the objective

After the fix task completes:

1. Append the fix task's summary to the log under the same iteration heading:
   ```
   - Fix actions: {what was fixed, what was skipped and why}
   ```
2. Increment the iteration counter in the log file header — update the `- iteration: {N}` line to reflect the new value. This is the durable counter that survives `/compact`.
3. Return to **Step 2**.

---

## Completion

Report the final status to the user:

- **Iterations performed**: How many review-fix cycles ran
- **Outcome**: Whether the objective is complete and the code is clean, or max iterations were reached
- **Changes summary**: What was implemented and what was fixed across all iterations
- **Remaining issues**: If max iterations hit, list any unresolved findings
- **Files modified**: Complete list

Then offer next steps (do not perform them automatically):
- Run tests if applicable
- Use `/local` or `/pr` to open a human review in the pair-review web UI
- Stage or commit the changes when satisfied

Clean up the iteration log only if the outcome is clean:
```bash
rm -f .critic-loop-{id}.log
```

If max iterations were reached with remaining issues, **leave the log in place** and mention its location (`.critic-loop-{id}.log` in the working directory) in the completion report so the user can inspect it.
