---
"@in-the-loop-labs/pair-review": patch
---

Fix `--ai-review` and `--ai-draft` submitting reviews through their own,
drifted copy of the GitHub write.

The headless flow built its own review submission rather than using the one the
web UI uses. Three things were wrong with it, and all three are now fixed by
sharing the single implementation:

- **Alternate hosts rejected the whole submission.** The headless path never
  sent the pull request's head commit, and a GitHub-compatible alternate host
  requires a `commit_id` on every inline review comment — so a headless run
  against such a host failed with a 422 and posted nothing. It now sends the
  head commit, exactly as the web UI does.
- **A suggestion pointing outside the diff was posted anyway.** The line number
  was never checked against the pull request's diff, so an AI suggestion aimed
  at a line GitHub cannot place — expanded context, or a line the pull request
  does not touch — was submitted at a position GitHub will not render. Those
  suggestions are now posted as file-level comments with their line written into
  the text (`(Ref Line 42) 🐛 **Bug**: ...`), the same fallback the web UI has
  always used. This is the one visible change to a successful run: the same
  comments arrive, and the ones GitHub could not have shown inline arrive
  attached to the file instead of vanishing into an unrenderable position.
- **The local record understated what was published.** The review event and the
  submission timestamp were missing from the recorded review, and a submitted
  review was stamped as though it had been created as a draft.

A headless run that fails part way through an existing pending review now says
so, names the draft, and tells the operator to check it before re-running —
re-running would post the comments that did land a second time. Everything else
a headless run prints is unchanged.
