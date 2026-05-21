---
"@in-the-loop-labs/pair-review": minor
---

Add agentic tour generation. When `tours_enabled=true`, an AI agent explores the worktree (using `git-diff-lines` and read-only shell tools) and produces a short guided walkthrough of the change as a list of file/line-range stops anchored on changed lines. New config keys `tour_provider` and `tour_model` (default to summary settings). `summaries_max_lines_added` (default 3000) gates summary and tour generation on large diffs.
