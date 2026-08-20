---
"@in-the-loop-labs/pair-review": minor
---

Show existing PR review comments inline in local reviews.

A local review whose branch has an associated GitHub PR now displays that PR's
inline review comments in the diff, read-only, alongside AI suggestions and your
own drafts — the same **External** segment, refresh button, and chat-about
affordances that PR mode already had. Requires a GitHub token that can read the
repository, and the `external_comments` config toggle.

Anchor trust is enforced: GitHub's line numbers are resolved against a specific
commit, so they are only used verbatim when the code on screen is that commit —
checked at the session level (local `HEAD` vs the PR's head), per comment
(against the commit each comment was actually written against), and, for
comments on removed lines, against the diff's base as well, since those line
numbers come from the PR's base commit rather than its head. On drift, a thread
renders in the file's comment zone with a note explaining why, rather than
anchoring confidently to a line that has since moved. The "chat about this"
buttons honour the same check, so the AI is never handed a line number the card
itself has disowned. Pull or push so the two commits agree, then refresh, and
the comments snap back to their exact lines.

A thread on a file your current scope doesn't render is no longer a dead end:
clicking it in the **External** segment pulls that file in as a context file so
the comment can anchor where it belongs.

Also in this release:

- Local reviews with uncommitted changes — the common case — now pick up their
  associated PR without a manual page reload.
- Repositories configured for both github.com and a self-hosted host resolve the
  correct host from the local checkout's git remote, instead of guessing
  github.com and risking showing an unrelated PR's comments. Detecting a PR and
  reading it now always resolve the host the same way, so a PR can never be
  found on one host and read from the other.
- A repository-scoped token (`repos["owner/repo"].token`) now counts for local
  reviews that have not yet detected their PR, so alt-host users are no longer
  stuck without the feature.
- Switching the base branch on a stacked local review no longer drops your draft
  comments and AI suggestions from the diff.
- Refreshing a local review across a new commit no longer clears which files you
  had marked as viewed.

Internally, `routes/external-comments.js` now resolves a review's comment target
through a single `resolveCommentTarget` predicate (replacing `isPRMode`), so the
sync and fetch endpoints cannot disagree about which PR a review's comments
belong to. Pure PR mode behaviour is unchanged.
