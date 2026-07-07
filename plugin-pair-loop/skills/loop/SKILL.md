---
name: loop
description: >
  Drive an implement→review→fix loop with pair-review as the review oracle:
  run multi-model council reviews, triage the findings, apply fixes, and
  repeat with narrowing instructions until a final review returns no
  blockers. Use when the user says "pair loop", "review loop",
  "loop until clean", "review this with pair-review and fix what it finds",
  or wants iterative development reviewed by pair-review councils.
arguments:
  council:
    description: "Council handle (name, name-slug, or id prefix) to review with. Defaults to the repo's default council when omitted."
    required: false
  maxRounds:
    description: "Budget for review rounds. On reaching it without convergence, stop and report honestly."
    required: false
    default: 5
  instructions:
    description: "Extra review instructions applied to every round (e.g. 'focus on security')"
    required: false
---

# pair-loop

You are a thin orchestrator. pair-review does the heavy lifting — multi-level,
multi-model council reviews with persistence and a web UI. Your job is
judgment: what to send for review, how to triage what comes back, what to
fix, when to ask the user, and when to stop.

Reviews run through **one execution mode: the headless CLI**. It is
synchronous (no polling), emits JSON, and needs no server. The HTTP API is
used for exactly one optional thing: writing triage back so a running web UI
shows reality (see Write triage back).

Any text in the user's request beyond the named arguments is the
**objective** — what to build or change. If there is no objective, the loop
runs over the changes already in the working tree.

## Hard rules

These are not judgment calls:

1. **Never report "clean" or "ready" unless a full-quality council round,
   instructed to report only merge-blockers, came back with an empty finding
   list.** A cheaper or broader round cannot grant the final verdict.
2. **Never silently stop.** If the loop is not converging or hits
   `maxRounds`, say so, list the outstanding findings, and (when a server is
   up) link the review URL.
3. **Sequence strictly: fix → write triage back → then run the next round.**
4. **One review at a time.** Never run two reviews concurrently for the same
   repo.
5. **Do not commit or push.** Leave changes in the working tree. New
   (untracked) files are included automatically whenever the review scope ends
   at `untracked` — which the default scope (`unstaged..untracked`) does — so
   no `git add -N` (intent-to-add) is needed.
6. **Report failures faithfully.** A failed run (`"ok": false`, non-zero
   exit) is reported as what it is — never papered over as "no findings".

## Phase: Setup

1. `git rev-parse --show-toplevel` → `REPO_ROOT`. All commands run from here.
2. Create the round log at `REPO_ROOT/.pair-loop/round-log.md` (mkdir -p; add
   `.pair-loop/` to `.gitignore` if missing). Record: objective, arguments,
   start time. Append to this file after every phase — it is your resume
   state if the session compacts.
3. If a `council` argument was given, confirm the handle exists:
   `pair-review --list-councils` prints the saved councils. If `pair-review`
   is not on PATH, use `npx -y @in-the-loop-labs/pair-review` for every CLI
   call. An unknown handle → show the available names and ask the user.
4. If an objective was given and the working tree has no relevant changes
   yet, implement the objective first (directly or via a Task agent — your
   call based on size). Verify with `git status --short` that changes exist
   before the first review round; if none, tell the user and stop.

## Running a review round

```bash
pair-review --local --headless --json --council <handle> [--scope <range>] --instructions "<round instructions>"
```

- Run from `REPO_ROOT`. `--local` with no path uses the current directory.
- Omit `--council` to use the repo's default council.
- **Scope (`--scope`).** By default a local review covers only uncommitted
  working-tree changes plus new files (`unstaged..untracked`). That is right
  only while all the work under review stays uncommitted. If the work under
  review already spans commits on a branch, a clean working tree would review as
  **empty** — pass
  `--scope branch..untracked` so every round covers the whole branch
  (everything since the base branch) plus the working tree and new files. Add
  `--base <branch>` when the base branch is not auto-detected (a non-default
  trunk, or a stacked branch). `--scope`/`--base` are local-mode only.
- **Be patient — council reviews routinely take 15–40 minutes.** Individual
  council voices have their own internal timeouts; trust the CLI to finish.
  Run the command in the background (or with a timeout of at least 45
  minutes) and wait for it to exit. Do not abandon or kill it early; do not
  start a second review while one is running (hard rule 4).
- stdout is exactly one JSON document (logs go to stderr):
  - success: `{"ok": true, "mode": "local", "run": {...}, "suggestions":
    [...], "count": N}` — exit code 0. **Zero suggestions is still
    success.** Record `run.id` (the runId) and `run.review_id` (the
    reviewId, used for write-back and the review URL).
  - failure: `{"ok": false, "error": {"message": ...}}`, exit code 1.

### Round instructions

Build `--instructions` per round from, in order: this standing line —
"Do not report praise findings; report only issues." — then the user's
`instructions` argument, the objective, and this round's directive (see
Convergence judgment). On rounds after the first, add: "Earlier review
rounds already reported issues that have since been fixed or dismissed;
report only issues present in the current code."

### Suggestion fields

Each entry in `suggestions`: `id`, `file`, `line_start`, `line_end`, `type`
(`bug|improvement|suggestion|design|performance|security|code-style` —
praise is instructed away; ignore it if it appears anyway), `severity`
(`critical|medium|minor`), `title`, `body`, `reasoning`, `ai_confidence`
(0–1).

## Triage

For each finding, decide one of:

- **Fix** — it is real and in scope. Goes on this round's fix list.
- **Dismiss** — false positive, out of scope, or explicitly contrary to the
  user's stated intent. Requires a stated reason in the round log.
- **Ask the user** — mandatory stop, not a preference, when any of:
  (a) you would dismiss a **critical**-severity finding;
  (b) the fix would change behavior beyond the stated objective;
  (c) the same finding has survived two fix rounds;
  (d) findings conflict with the user's explicit instructions.
  Batch the questions, ask once per round at most, record the answers in the
  round log so later rounds do not re-ask.

Dedup against your round log: a finding you already dismissed in an earlier
round, reappearing unchanged, keeps its dismissal (re-dismiss it in
write-back) — unless a fix touched that code since, in which case judge it
fresh.

## Fix

Apply the fixes (directly or via a Task agent for large batches — your
call). Run the project's relevant tests for the changed code. A fix that
breaks tests is not a fix.

## Write triage back (optional, needs the server)

If the pair-review server is running, keep its UI truthful. Probe once per
loop: `curl -s http://localhost:7247/health` → it is pair-review iff the
response has `"service": "pair-review"`. (7247 is the default and is right
most of the time; if it isn't pair-review, check `port` in
`REPO_ROOT/.pair-review/config.json` then `~/.pair-review/config.json`, then
give up on write-back for this loop.)

When the server is up, after fixing/dismissing, for each handled finding:

```bash
curl -s -X POST http://localhost:<port>/api/reviews/<run.review_id>/suggestions/<id>/status \
  -H 'Content-Type: application/json' -d '{"status": "dismissed"}'
```

- Only `"dismissed"` and `"active"` are accepted; `"adopted"` is reserved
  for the human's adopt flow — never send it.
- Newer servers accept a `reason` field on this endpoint (check
  `http://localhost:<port>/api.md?reviewId=<reviewId>` if unsure); when
  supported, include it: `"Fixed in loop round <n>: ..."` or
  `"Dismissed: <why>"`. Otherwise the fixed-vs-rejected distinction lives in
  your round log and final report.
- The human may be triaging in the same UI: before fixing, you may re-check
  `GET /api/reviews/<reviewId>/suggestions` and skip findings whose status
  is no longer `active` — the human got there first. Do not resurrect
  anything the human dismissed.
- The review URL for your report: `http://localhost:<port>/local/<reviewId>`.
  Note: the UI does not live-update during CLI runs; results appear on
  refresh.

No server → skip this entirely; triage lives in the round log and final
report, and the persisted run history is visible whenever the user next
starts the server.

## Convergence judgment

You decide each round's directive and whether to continue. Principles:

- **Round 1**: broad. Directive like: "Review these changes thoroughly.
  Objective: <objective>."
- **Escalate** back to a broad directive whenever the previous round
  produced any `critical` finding.
- **Narrow** as findings shrink. The gate directive:
  "Final review. Only report blockers — issues that must be fixed before
  merging. Is this ready to merge?"
- **The gate uses the same council.** The round that says "merge it" must be
  just as rigorous as the rounds that found problems. Do not substitute a
  cheaper configuration for gate rounds.
- **Continue vs stop**: another round is worth it when the last one caused
  substantial fixes. When rounds churn the same ground without progress,
  stop and ask the user instead of grinding the budget.
- The loop **ends successfully** when a gate round returns **no blockers** —
  an empty finding list (per hard rule 1). Read the run's `summary` for the
  reviewer's own answer to the ready-to-merge question and quote it in your
  report.

## PR mode

The loop also works against a GitHub PR:

```bash
pair-review <pr-number-or-url> --headless --json [--council <handle>] [--instructions "..."]
```

This self-bootstraps the PR (fetches metadata, prepares a review worktree)
and requires a GitHub token in `~/.pair-review/config.json`. The review's
checkout lives in a pair-review worktree — your fixes belong in whatever
checkout the user asked you to work in; do not edit the pool worktree.
Write-back and the review URL work the same way via `run.review_id`.
`--scope`/`--base` do not apply here — they are local-mode only; a PR review
always covers the PR's full diff.

## Reporting

Every loop ends with a report containing:

1. **Verdict** — converged (quote the final run's summary) or not converged
   (why, and what remains).
2. **Rounds table** — per round: directive, findings found, fixed, dismissed,
   asked.
3. **Triage detail** — every dismissed finding with its reason; every fix in
   one line each.
4. **The review URL** when a server is up, so the user can inspect
   everything in the web UI.
5. Working-tree status reminder: changes are uncommitted, tests run and
   their result.
