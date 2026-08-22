---
"@in-the-loop-labs/pair-review": minor
---

Detect PR head drift in local stale check.

A local review whose branch has an associated GitHub PR now also compares your
local `HEAD` against that pull request's head commit on every staleness check,
and reports the pull request's lifecycle. The header gains a badge **group**:
**PR DRIFT** when the two commits differ, plus **MERGED** / **CLOSED** when the
PR is no longer open. Requires a GitHub token that can read the repository.

The badges are independent facts and render together — only **MERGED** and
**CLOSED** are mutually exclusive. A working tree that has moved since the diff
was captured still shows the amber **STALE** badge beside them. That separation
is deliberate: **STALE** is the only one the refresh button can fix, so a
refresh clears it and leaves the other two exactly as they were. PR drift is
never folded into `isStale` for the same reason — re-capturing the working tree
cannot move a commit on GitHub, so doing so would mean a silent re-capture on
every page load, forever, that never clears the condition that triggered it.
Badge tooltips come from the backend's own `reasons[]`, and drift compares
*commits*, not file contents.

Drift also drives a convergence the feature was built for: when the check finds
that the PR has advanced past pair-review's cached copy, the metadata cache is
re-read, so the anchor-trust gate that decides whether GitHub's inline comments
may be trusted to a line self-heals mid-session instead of comparing against a
commit that is no longer the PR head.

PR mode's `check-stale` gains the same `reasons[]` array — additively; every
pre-existing field keeps its name, type and value — and now renders it in its
badge tooltips. A merged pull request whose local copy is also behind shows
**MERGED** and **STALE** together, matching local mode. Refreshing a pull
request also reconciles its lifecycle badge from the freshly fetched state, in
both directions: a PR merged or closed during your session starts showing
**MERGED** / **CLOSED** without a page reload, and one that was reopened stops
showing **CLOSED**.

Drift is reported as a three-valued answer — drifted, not drifted, or not
determined — so a check that could not read one of the two commits (GitHub
unreachable, local `HEAD` unreadable) leaves the badge exactly as a complete
answer left it rather than clearing it.

The GitHub half of the check is bounded at 1200ms and cancelled when that
deadline passes, so a slow or unreachable GitHub can never take the
working-directory answer down with it. Credentials are resolved without ever
shelling out for a `github_token_command` on this path — including after an
authentication failure, which fails open instead of re-running the command. The
post-refresh re-check asks for the PR head only, so it does not walk the working
tree a second time for an answer it does not read.
