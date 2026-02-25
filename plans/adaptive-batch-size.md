# Adaptive Batch Size for GitHub Review Submission

## Context

Submitting a review with just 16 comments failed due to GitHub GraphQL complexity/cost limits at the current default batch size of 25. The user had to manually split into batches of 8. We need to:
1. Lower the default batch size from 25 to 10
2. Detect complexity/cost errors from GitHub's GraphQL API
3. Automatically halve the batch size and retry when these errors occur

## Key Files

- `src/github/client.js` — `addCommentsInBatches` method (line 359), exports
- `tests/unit/github-client.test.js` — existing batch tests (line 608+)

## Implementation

### 1. Add `isComplexityError` helper (module-level function in `client.js`)

Detects GitHub GraphQL complexity/cost errors by checking `error.message` and `error.errors[].message` against patterns:
- `/complexity/i`, `/MAX_NODE_LIMIT/`, `/cost/i`, `/too large/i`, `/query size exceeds/i`

Export it from `module.exports` for testability.

### 2. Change default batch size from 25 to 10

Update the parameter default and the accompanying comment.

### 3. Restructure `addCommentsInBatches` to use a `remaining` queue

Replace the pre-computed `batches` array with a `remaining` comments queue and a mutable `currentBatchSize`. Each iteration slices `remaining.slice(0, currentBatchSize)`.

**On complexity error:**
- Halve `currentBatchSize` (floor to `MIN_BATCH_SIZE = 1`)
- If size actually decreased: log a warning, `continue` outer loop (re-attempt same comments with smaller batch)
- If already at minimum: fall through to existing retry-once logic → permanent failure if retry fails

**On non-complexity error:** existing behavior unchanged (retry once, then abort).

**On success:** advance `remaining` past the processed batch.

Log messages adjust since total batch count is no longer known upfront (e.g., `"batch 2 (3 of 8 remaining)"`).

### 4. Tests

**`isComplexityError` unit tests:**
- True for "complexity", "MAX_NODE_LIMIT", "cost", "too large" in message
- True for pattern match in `error.errors[]` array
- False for unrelated errors

**Adaptive batch size tests:**
- Halves batch size on complexity error, retries with smaller batches, all succeed
- Reduced size persists for remaining batches
- Can halve multiple times (4 → 2 → 1)
- Complexity error at min batch size (1) treated as permanent failure
- Non-complexity errors do NOT trigger halving

## Verification

1. `npm test -- tests/unit/github-client.test.js` — all existing + new tests pass
2. Existing call sites (`createReviewGraphQL`, `createDraftReviewGraphQL`) need no changes — they use the default parameter
