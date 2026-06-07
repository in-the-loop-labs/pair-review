---
"@in-the-loop-labs/pair-review": patch
---

Fix alt-host review submission failing at "Step 2" with HTTP 422 `{ field: "comments[0].commit_id", code: "missing_field" }` when attaching inline comments to a pending review. The host pending-review-comments path now threads the PR head SHA through to each comment as `commit_id`, which GitHub-compatible alt-hosts require (they validate each comment like `pulls.createReviewComment`). The github.com GraphQL path is unchanged — it pins the commit implicitly and ignores the field.

Also make review-submission logging transport-accurate: `createReviewGraphQL` / `createDraftReviewGraphQL` no longer hardcode "GraphQL" in user-facing log and error strings when the review actually ran over the alt-host REST/extension transport; they now label messages "alt-host" or "GraphQL" based on the active binding.
