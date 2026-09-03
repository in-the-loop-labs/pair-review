---
"@in-the-loop-labs/pair-review": patch
---

Fix multi-line comments on the deleted side of a diff, and report honestly when
a failed review write leaves comments on GitHub.

A comment spanning several lines of the OLD side of a diff was submitted with
the side of its END line only. GitHub's review-thread API takes a side per
endpoint and defaults the start of the range to the new file independently of
the end, so a multi-line left-side comment asked for a range that starts on one
side and ends on the other — rejected outright, or anchored against content the
reviewer never pointed at. Both endpoints now carry the same, explicit side.

When submitting a review to GitHub fails, the failure now says what is still on
the pull request, based on what the write actually reported rather than on a
guess:

- A failure that wrote nothing — a bad token, a rate limit, missing permissions
  — keeps its own message and status instead of being reported as a partial
  write. Those are worth retrying once the cause is fixed, and the previous
  behaviour told you not to.
- A review that was created and then failed at the final submit step is now
  deleted, so retrying is clean. Previously it stayed on the pull request as a
  pending review holding every comment, with no warning at all — and a retry
  posted them a second time.
- If that deletion fails, or comments landed on a pending draft you already had,
  the message names the review to look at and says not to resubmit until you
  have.
