---
"@in-the-loop-labs/pair-review": minor
---

Sync GitHub pending drafts into local reviews.

A local review whose branch has an associated GitHub PR now pulls in the draft
("pending") review you started in the GitHub UI. The toolbar shows a **Draft on
GitHub** indicator with the draft's comment count, linking to the draft itself,
and a circular-arrow button re-asks GitHub for when you started or added to the
draft after opening pair-review. The sync runs once automatically on page load —
the local review's page-load request itself never waits on GitHub, so the client
asks for it separately — and again on demand from the button. Requires a GitHub
token that can read the repository.

The manual sync also re-reads the pull request's inline comments, because the
two answers belong to the same click: a draft submitted on GitHub since you
loaded the page stops being pending and its comments become ordinary review
comments at the same moment.

Only the draft's existence, comment count and link are pulled in — its
individual comments stay on GitHub until you submit it, at which point the
ordinary review-comment sync picks them up.

The reconciliation itself moved into a shared provider that PR mode's existing
draft endpoints now call, so both modes give byte-identical answers about a
draft and cannot drift apart. A GitHub failure is still logged and answered
with the local record unchanged rather than a failed request — draft state is
supplementary and must not take down the page that asked for it — but the
response now says which happened, so an unreachable GitHub no longer clears a
live draft indicator or reports "no draft review on GitHub". A database
failure, by contrast, is no longer disguised as a GitHub outage.

Two long-standing reconciliation bugs are fixed in the process, in both modes:
a review whose state could not be looked up (a rate limit, a brief outage) is
left at its last known state instead of being durably recorded as dismissed,
and drafts submitted or discarded on GitHub with no replacement are now
resolved instead of lingering as live drafts forever. Concurrent syncs — two
tabs, a reload landing on a click — can no longer leave two rows for one draft:
the database enforces one mirror row per review (migration 57, which collapses
any existing duplicates).

That "left at its last known state" guarantee now reaches all the way down:
the GitHub lookup itself reports a missing review only when GitHub actually
says so, and raises everything else — a rate limit, a 5xx, a dropped
connection, or a review it has no way to look up on an alternate host — rather
than reporting it as "this review is gone". Previously it answered the same way
for all of them, so a network blip could still record a review you had
submitted as dismissed. A draft GitHub reports without a numeric id is stored
as genuinely absent instead of the text "null", which two unrelated reviews
used to share as an identity, and a review that survived earlier versions as
two half-identified rows is merged back into one instead of failing the sync
with a constraint error.

The local endpoint refuses before reaching the network in the cases where an
answer would be wrong rather than merely absent: no associated pull request, no
credential for that repository, and — for a repository configured on both
github.com and an alternate host whose PR host cannot be resolved — a dual-host
refusal, since asking the wrong host about "my pending review on PR #N" answers
about a different pull request that merely shares a number. A host already
recorded for that PR settles the question, so a dual-host repository that has
been opened in PR mode syncs normally; when it genuinely cannot be settled the
button is not offered at all rather than failing on every click.

For a repository configured on both github.com and an alternate host, the
**Draft on GitHub** controls are now offered on the basis of the credential the
request will actually use, resolved against the host that pull request is
recorded on. A global github.com token no longer advertises a button whose
every click fails against a tokenless alternate host, and an alternate-host
repository token no longer hides a feature that works. If that recorded host no
longer matches your configuration — a renamed `api_host`, a deleted `repos`
entry — pair-review says so instead of quietly asking github.com about a pull
request it has already established lives elsewhere.

The draft link is now resolved the same way in both modes and in the review
modal — through the repository's configured URL template, which is what makes
it host-correct on an alternate host, with the reported URL as the fallback.
Local sessions resolve their header links against the associated pull request
(rather than just the checkout's repository) so that template has a pull
request to name.
