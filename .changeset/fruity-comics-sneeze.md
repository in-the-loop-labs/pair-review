---
"@in-the-loop-labs/pair-review": patch
---

Prevent direct status transition to "adopted" and add atomic /adopt endpoint

- Reject "adopted" in POST /suggestions/:id/status with 400 pointing to proper endpoints
- Add POST /suggestions/:id/adopt for atomic adopt-as-is (creates linked user comment + sets status in one request)
- Wrap /adopt and /edit DB operations in transactions for true atomicity
- Migrate frontend adoption paths to use /adopt endpoint instead of two-request dance
- Harmonize CATEGORY_EMOJI_MAP across all four locations to match AI prompt schema
- Update pair-review-api skill documentation
