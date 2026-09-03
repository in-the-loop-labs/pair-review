---
"@in-the-loop-labs/pair-review": minor
---

Submit local reviews to GitHub when the branch has an associated pull request.

A local review whose branch has an associated GitHub PR can now be submitted as
a real review — Approve, Request Changes, Comment, or Save as Draft — from the
same toolbar button, review modal and preview modal that PR mode has always
used. The controls appear only for a session that can actually submit: an
associated pull request, a credential that works for that repository, and a
settled host. They retract again if the association is lost mid-session (a
force-push to unrelated history), rather than leaving a button that would post
to a pull request the session is no longer tied to.

The review is refused, before anything is written, when submitting it would
attach comments to the wrong commit or to a pull request that can no longer take
them:

- **Your working tree has moved since the diff you commented on was captured,
  or that comparison cannot be made at all.** A commit made after commenting can
  put local `HEAD` back in step with the pull request while every stored line
  anchor still describes the older snapshot, so the head check below cannot
  catch it. A session that captured no diff, one from before diff digests
  existed, and a working tree that cannot be read right now are refused on the
  same terms — an unverified anchor is not a verified one. Refresh the diff and
  check where your comments landed, then submit again; refreshing captures a
  fresh snapshot and keeps your comments. This one refuses rather than degrades:
  a line number written into the comment text is only worth having while it
  describes the diff you were looking at.
- **Your local `HEAD` is not the pull request's head commit.** Every inline
  comment is a file-and-line pair resolved against the PR's head, so submitting
  from a different commit posts them against lines that have moved, with nothing
  to tell the reader. Push or pull so the two match, then submit again — there
  is no force override.
- **The pull request is closed or merged, and you are not commenting.** GitHub
  takes comment reviews and inline review comments on a settled pull request,
  so a closed or merged PR still accepts Comment; only Approve, Request Changes
  and Save as Draft are refused. The review modal disables those three up front
  rather than letting you write a review it will not accept, and if the pull
  request settles while the modal is open it updates in place so you can send
  the same comments as a Comment review.
- **GitHub could not be read at all.** Unlike the PR pill, the staleness badge
  and the draft indicator — all of which degrade quietly when GitHub is
  unreachable — this check fails closed. Not knowing whether the pull request
  moved is not permission to write to it. An authentication, permission,
  not-found or rate-limit failure is reported as itself; only a genuinely
  unknown state falls back to this.

A comment on a file the pull request does not touch at all — easy to end up
with in local mode, since a local review can cover files you have not committed
— is reported by name before anything is sent. GitHub will not accept a comment on a path
outside the pull request's diff, inline or file-level, so the submission would
have failed anyway; it now fails with a message that says which files, and
without a half-created review to clean up.

Comments in files with uncommitted local edits are submitted as file-level
comments with their line number written into the text, rather than as inline
comments. Local mode renders the working tree, so an uncommitted edit above a
comment shifts the line it describes while the shifted number still lands
inside the diff — the comment would be rendered by GitHub against the wrong
line, silently. An unrelated dirty file is the normal state of a local review
and is no reason to refuse the whole submission, so those comments degrade
instead. The same fallback covers a pull request whose base commit is not
fetched into your checkout.

A comment on the deleted side of the diff degrades the same way, always. The
base a comment was written against is not recorded anywhere, so agreement with
the pull request's base cannot be proven after the fact — and the two part
company routinely: a stacked pull request, one whose base was changed on GitHub,
a base branch selected in the UI, a base that moved after the comment was
written. A shifted left-side line number will not be caught by checking it
against the diff, since every deleted and unchanged line is a valid left-side
position, so it is written into the comment text instead of guessed at.

For a repository configured on both github.com and an alternate host, the
submit controls follow the credential the request will actually use, resolved
against the host that pull request is recorded on — the same rule the draft sync
and the comment sync already follow. A pull request whose host cannot be settled
is refused rather than guessed at: submitting a review to a same-numbered pull
request on the wrong host is not something a later fix can take back.

Note that this is the first local-mode PR feature that writes. Everything else
the association unlocks — the PR pill, inline PR comments, the badges, the draft
indicator — works with a token that can only read the repository; submitting
needs one that can create and submit pull request reviews (`repo` for a classic
token, **Pull requests: Read and write** for a fine-grained one).

If GitHub accepts some of the comments and then fails, the failure says so and
names the review holding them rather than reporting a clean error. Resubmitting
would post the accepted comments a second time, so the message sends you to
GitHub to see what landed first.

The write itself moved into a shared provider that local mode, PR mode and the
headless `--ai-review` / `--ai-draft` flow all now call, so a review submitted
from a local session, from a PR session, or from CI is the same operation —
including how comments are shaped, how an existing GitHub draft is reused rather
than duplicated, and how the result is recorded. Sharing it changes PR mode in
three ways:

- **The review modal greys out Approve, Request Changes and Save as Draft on a
  merged or closed pull request in PR mode too**, leaving Comment, with the
  reason on each disabled option. The policy is GitHub's, not local mode's —
  approving a merged pull request fails on GitHub whoever asks — so a shared
  modal that enforces it in both modes is the right shape rather than a local
  rule leaking outward. GitHub remains the authority: the modal reads the
  lifecycle the page already holds, and a stale copy just means the submission
  is refused by GitHub exactly as it was before. PR mode's submit route is
  otherwise untouched and still performs no lifecycle check of its own.
- **A failed write is now classified by what it left on the pull request.** A
  failure that wrote nothing keeps the message and status it always had; one
  that left comments behind — on a pending draft that was yours, or on a review
  we created and could not delete — is reported as a conflict that names the
  review to look at, because retrying it would post the landed comments a second
  time. A review created by this submission that then fails at the final submit
  step is deleted, so that retry is clean.
- **Finalising a pending draft now marks its earlier drafted comments submitted
  locally.** This is a correctness fix in both modes, not a new behaviour: a
  `Save as Draft` pass marks that review's comments `draft` and does not resend
  them when you later finalise, but GitHub submits the whole pending review,
  drafted comments included. Those rows read `draft` forever while GitHub showed
  them published, and every count derived from them disagreed with the host.
