# Agent-Orchestrated Review Loop: pair-review as the Review Oracle

## Vision

The companion plan (`plans/agent-fix-loop.md`) puts pair-review in charge:
the human clicks, pair-review dispatches an agent, verifies, resolves. This
plan inverts control. The **coding agent orchestrates its own
implement→review→fix loop**, and pair-review is the review oracle inside it —
supplying what a solo agent cannot: structured multi-level analysis,
**multi-model councils**, persistence, and a live web UI where the human
watches and steers.

The loop, as run by the agent (Claude Code or any agent that can run curl or
a shell command):

1. Agent implements changes.
2. Agent runs a **council review** via the synchronous headless CLI —
   `pair-review --local --headless --json --council <name>` — one execution
   mode, no server required, findings persisted either way.
3. Agent **triages** each finding: fix it, dismiss it with a recorded reason,
   or — when its confidence criteria say so — stop and ask the user.
4. Agent applies fixes and — when the pair-review server is running —
   **writes its triage back over HTTP** (so the UI shows reality, not stale
   findings). This is the API's only role in the loop.
5. Agent decides the next round dynamically: scope, instructions, and whether
   to continue at all (see Convergence judgment). Later rounds typically
   narrow — e.g. `customInstructions: "Final review. Only blockers. Is this
   ready to merge?"` — but **gate rounds use the same council by default**.
   The gate is the step that says "merge it"; it must be just as good as the
   review that found the problems.
6. Loop ends when a full-quality round comes back with no blockers, or the
   agent judges it is not converging and reports that honestly, with a link
   to the review UI.

**The shared blackboard is the payoff.** Because every run and every triage
decision persists, the human can open the web UI at any moment during the
loop, watch findings appear, and steer: dismissing a suggestion in the UI
removes it from the agent's next fetch (default filters already exclude
dismissed); the agent's dismissals-with-reasons are auditable in the same UI.
Human and agent operate the same state through the same API.

## Verified inventory (2026-07-04): almost everything exists

- **Headless councils via CLI**: `pair-review --local --headless --json
  --council <handle>` (`src/main.js:203,222,224`); `--instructions` is carried
  into council runs (`src/main.js:180-182`). Synchronous: blocks until done,
  emits the completed run as JSON, exits. Persists to the same database.
  Caveat: WebSocket events come from the server process, so a browser open
  mid-loop sees CLI-run results on refresh, not live.
- **Councils via HTTP, both modes**: `POST /api/local/:reviewId/analyses/council`
  (`src/routes/local.js:2358`) and the PR-mode twin accept `councilId` or
  inline `councilConfig`, `customInstructions`, `configType`,
  `excludePrevious` (`local.js:2361`). The plain `/analyses` endpoint also
  dispatches the repo's `default_council_id` via the same shared
  `launchCouncilAnalysis` path (`local.js:1224-1240`) — council dispatch is
  not duplicated.
- **Self-onboarding docs**: `GET /api.md?reviewId=N` (`src/routes/chat.js:696`)
  renders the full API reference with the real port and review id baked in
  (`src/chat/api-reference.js`). An agent bootstraps from one URL.
- **Full write surface over HTTP** (documented in api.md): list suggestions,
  update suggestion status (with the guard that `adopted` must go through
  `POST /suggestions/:id/adopt` or `/edit`), create/update/delete/restore
  comments, trigger/cancel/poll analyses, list runs, context files.
- **Polling + push**: `GET /api/analyses/:id/status` for simple polling;
  WebSocket for the UI. `excludePrevious: {github, feedback}` for cross-run
  dedup.
- **Prior art, not a foundation**: `plugin-code-critic/skills/loop/SKILL.md`
  was an existing implement→review→fix loop skill (removed once `pair-loop`
  shipped — two skills named `loop` with near-identical descriptions would
  have degraded skill routing) — and it went unused, which
  says something. It is a heavyweight orchestration program (file-mediated
  Task pipelines, log-file resume protocol) because it predates a usable
  server surface: with no oracle to call, the skill had to *be* the oracle.
  This plan **starts over** with a fresh, thin skill. The old skill is
  reference material for pitfalls (context growth, resume), nothing more.

## Gap analysis

The remaining work is one new skill and one small server ticket:

| # | Work | Size |
|---|------|------|
| 1 | New loop skill: thin protocol over HTTP/CLI, triage discipline, dynamic convergence judgment | skill authoring, no server code |
| 2 | Dismissal reasons: status changes carry a persisted, rendered "why" | small migration + endpoint param + UI |

---

## Design

### 1. The new skill (working name: `pair-loop`)

A fresh skill, written thin. The server (or CLI) does the heavy lifting; the
skill is protocol and judgment guidance, not an orchestration program.

**One execution mode: the headless CLI — MCP-independent by design.**
Reviews always run via `pair-review --local --headless --json --council
<handle> --instructions "..."`. Synchronous (no trigger/poll machinery in
the skill at all), JSON out (`run.review_id` and suggestion `id`s included,
which is everything write-back needs), persists to the shared database, and
identical with or without a server running.

The HTTP API has exactly one optional role: **triage write-back.** Probe
`GET http://localhost:7247/health` (default port first — right most of the
time; config files only as fallback); if a server answers, dismiss handled
findings via `POST /api/reviews/{reviewId}/suggestions/{id}/status` so the
web UI reflects the loop's decisions, and include the review URL in the
report. No server → triage lives in the round log and final report.

MCP is never required.

**Council selection.** A `council` argument wins; otherwise the repo's
`default_council_id` (the plain `/analyses` endpoint dispatches it
automatically; the CLI takes `--council`). **Gate rounds default to the same
council** — a cheaper gate config is available as an explicit option, never
the default.

**Triage discipline.** For each finding: fix, dismiss-with-reason (written
back via `POST .../suggestions/{id}/status`), or ask the user. Ask-the-user
is criteria, not vibes — mandatory stops when: (a) a critical/blocker finding
would be dismissed, (b) a fix would change behavior outside the stated
objective, (c) the same finding has survived two fix rounds, or (d) findings
conflict with explicit user instructions. Everything else proceeds
autonomously. Sequencing rule: **fix → write triage back → then trigger the
next round**, so `excludePrevious` dedup operates on current state.

**Convergence judgment — dynamic, not a state machine.** The driving agent
decides each round's scope, instructions, and whether to continue. The skill
supplies principles and hard rules, not stages:

- Principles (agent's call): escalate to broad scope when the previous round
  found anything critical; narrow the instructions as findings shrink
  ("Final review. Only blockers. Is this ready to merge?"); prefer another
  round when fixes were substantial, prefer stopping to ask when rounds churn
  the same ground.
- Hard rules (not the agent's call): never report "clean" unless a
  full-quality council round with blockers-only-or-stricter instructions
  came back with no blockers; never silently stop — if the loop is not
  converging, say so, with the outstanding findings and the review URL;
  respect a user-set iteration budget if one was given.

**Reading the verdict.** No structured verdict field. The round's question is
asked explicitly via `customInstructions`, and the answer appears where
review answers always appear: the run summary and the (empty or non-empty)
blocker-severity finding list. The agent reads the summary. No prompt or
schema changes for this.

### 2. Dismissal reasons (server)

- Migration: `comments.status_reason TEXT NULL` (additive column, no CHECK
  rebuild).
- `POST /api/reviews/:reviewId/suggestions/:id/status` accepts optional
  `reason` (length-capped); stored on the transition, cleared on restore
  (mirroring how restore clears `adopted_as_id`, `database.js:3519-3527`).
- Comment DELETE (user-comment dismiss) gains the same optional reason.
- UI: dismissed items in the AI panel's dismissed section show the reason;
  agent-written reasons are the human's audit trail.
- Document in `src/chat/api-reference.js` (api.md is handwritten — an
  undocumented param does not exist as far as agents are concerned).

## Considered and cut

Recorded so they are not re-proposed without new evidence:

- **Run chaining (`responds_to_run_id`).** The loop is serial: chronology is
  the chain, and the skill receives `runId` from every trigger call, so it
  already knows which run is which. A persistent link is only needed if runs
  ever branch (parallel configs over the same round), which is hypothetical.
  No speculative migration; revisit only when branching is real.
- **Structured gate verdict (`gateMode`, `merge_verdict`).** An explicit
  question in `customInstructions` produces a clear answer in the run
  summary, and the calling agent reads the summary. Disturbing three
  instruction paths and adding a schema column to restate what the summary
  already says is not worth the squeeze.
- **Building on the existing loop skill.** Unused in practice; its weight is
  a consequence of predating the server surface. Start over.

---

## Phasing

**Phase 1 — the skill, no server changes.** Transport selection, api.md
bootstrap, council rounds via HTTP and CLI, triage discipline (interim:
dismissal reasons appended to the suggestion body text), convergence
judgment. **Fully shippable against the current server.** Exercise it on real
work in this repo before touching the server.

**Phase 2 — dismissal reasons** (migration, endpoints, UI, api.md docs);
skill switches from body-text reasons to the `reason` param. Unit +
integration tests for BOTH modes; update `tests/e2e/global-setup.js` and
`tests/integration/routes.test.js` schemas.

**Phase 3 — docs + changeset.** README section ("Using pair-review inside an
agent loop"), changeset (`minor` — covers the reason param and UI rendering).

---

## Hazards

- **api.md is the contract.** `src/chat/api-reference.js` is handwritten.
  The `reason` param must be documented there in the same PR, or agents
  cannot discover it. Conversely, the skill must tolerate older servers
  (feature-detect via 400s or absent api.md sections) — skills and servers
  version independently.
- **Suggestion status endpoint is multi-caller.** The web UI (dismiss
  buttons, bulk actions) and now the agent both hit
  `POST /suggestions/:id/status`. The `adopted`-requires-adopt-endpoint guard
  must be preserved; `reason` must be optional so existing UI callers don't
  break; restore must clear `status_reason`. Grep all callers of
  `updateSuggestionStatus` before changing it and list them in the
  implementation PR.
- **Agent-initiated changes must broadcast.** If the status endpoint only
  fires WebSocket events on UI-path mutations, the human's browser won't
  reflect agent triage live — which breaks the blackboard. Verify first; if
  broadcasting is missing on the API path, that is the first bug to fix.
- **Concurrent triage races.** Human (UI) and agent (HTTP) can act on the
  same suggestion in the same second. Last-write-wins on a single row is
  acceptable, but handlers must not read-modify-write across requests.
- **Cross-round dedup is instruction-based.** The CLI has no
  exclude-previous flag, so round N+1 relies on round instructions ("earlier
  rounds' issues have been fixed or dismissed; report only issues in the
  current code") plus the skill's own round-log dedup. The fix → write-back →
  next-round sequencing still matters: persisted dismissals are visible to
  the server-side consolidation and to the human. If instruction-based dedup
  proves leaky in practice, adding an exclude-previous CLI flag is the
  ticket.
- **One review at a time.** Two concurrent headless runs against the same
  review would interleave runs and confuse triage; the skill forbids it
  (hard rule). A human-triggered server analysis running concurrently with a
  CLI run is possible and harmless at the DB level, but the skill should not
  assume the latest run is its own — it keys off the `run.id` from its own
  invocation.
- **CLI-mode liveness gap.** CLI rounds don't emit WS events; a human
  watching the browser during a CLI-mode loop sees updates on refresh only.
  The skill's final report should include the review URL either way; do not
  promise live updates in CLI mode.
- **CLI/server database concurrency.** CLI mode writing the database while a
  server holds it open is the same SQLite-concurrency surface the app already
  manages, but the loop makes it routine rather than occasional. Verify
  headless writes behave under an open server (WAL/busy-timeout) before
  documenting CLI mode as supported alongside a running server.
- **`parent_run_id` stays what it is.** It means council-voice hierarchy
  (`src/routes/mcp.js:307` filters on it). If run-linking ever returns (see
  Considered and cut), it gets a new column — never this one.

## Non-goals

- pair-review does not orchestrate, schedule, or supervise the loop — the
  agent does. (That inversion is `plans/agent-fix-loop.md`.)
- No MCP involvement anywhere in the loop; no MCP feature-parity work.
- No edit permissions, worktree snapshots, or interdiff machinery — the agent
  edits its own working tree under its own session permissions.
- No auto-commit/auto-push by the skill; working-tree changes only.
- No changes to analysis prompts, run schema, or verdict formats.

## Relationship to `plans/agent-fix-loop.md`

Complementary, with one shared piece: dismissal reasons (ticket 2) are the
same audit trail the fix loop's bounce-back wants. Ship this plan first — it
is a skill plus one small ticket against the current server, it exercises the
triage write-back surface with real traffic, and what it teaches about triage
quality directly de-risks the fix loop's heavier machinery.

## Status

- **Phase 1: implemented** as a new plugin `plugin-pair-loop/` with skill
  `/pair-loop:loop` (decision: packaged as a plugin from the start, so it can
  be tested on real examples beyond this repo — resolves former open
  question 1). Wired into `.claude-plugin/marketplace.json`,
  `package.json` `files`, `scripts/sync-plugin-versions.js`, and the README
  plugins section; changeset added. Endpoint contracts in the skill verified
  against a live server (health, local/start idempotency, councils list,
  api.md, review-level analysis status, suggestions).
- **Restructured to CLI-first (2026-07-05 review feedback):** the CLI is the
  single execution mode for reviews (synchronous, no trigger/poll/bootstrap
  machinery in the skill); HTTP is used only for optional triage write-back
  (probe default port 7247 first). Also from that review: reviews are
  instructed not to report praise; gate success is "no blockers" (an empty
  finding list from a blockers-only round), not a severity check; CLI waits
  must allow 30+ minutes (council voices have internal timeouts).
- Interim triage write-back: fixed/rejected findings are dismissed via the
  status endpoint; the fixed-vs-rejected distinction and reasons live in the
  loop's round log until Phase 2 lands the `reason` param (the skill already
  feature-detects it via api.md).

## Open questions

1. Is Phase 1's interim (reasons only in the round log/report) acceptable
   until Phase 2, or should Phase 2 land immediately after first real-world
   use? (Current answer: acceptable; revisit after dogfooding.)
