---
"@in-the-loop-labs/pair-review": patch
---

Fix headless PR analysis silently skipping every consolidation stage.

On the headless PR paths — `--headless`, `--ai-draft`, and `--ai-review` — the analyzer was handed the raw stored `pr_data` blob as its PR metadata instead of the normalized `pr_metadata` row the web routes pass. In that blob `repository` is an object (`{ full_name, clone_url, … }`) rather than the `"owner/repo"` string, so `buildDedupContext` threw `TypeError: prMetadata.repository?.split is not a function`. Because every consolidation and orchestration stage builds its dedup context first, that single throw was swallowed by the store-everything fallback: the run still reported `status: completed` / `ok: true`, but the final suggestion set became the unmerged union of all three analysis levels — and, for a council, of every voice. A 3-voice council on a ~30-file PR returned 45 suggestions (13 + 13 + 19) with the same issue repeated in up to seven wordings. Every headless PR analysis reaching consolidation had been affected since the exclude-previous-findings feature introduced `buildDedupContext`, including the reviews posted by `--ai-draft`/`--ai-review` workflows.

Both headless call sites now read PR metadata through `PRMetadataRepository.getByPR`, the same accessor the web routes use, so the analyzer receives one shape from every entry point. Two lower-severity defects on the same path are fixed as a consequence: prompts had been rendering `**Repository:** [object Object]`, omitting the `**PR #:**` line (the number lives under `number` in the blob), and dropping the PR description entirely (it lives under `body`).

As defense in depth, the analyzer's metadata readers now accept either shape rather than assuming the normalized one, so a future caller passing the raw blob degrades nothing.

Headless output also surfaces the outcome. `--headless --json` gains a top-level `consolidation` field — `"success"`, `"failed"`, `"skipped"` (nothing to merge: a council that resolved to a single voice or level, which is healthy), or `null` — and the human-readable output prints a warning when consolidation failed. Previously the only evidence was a stderr line and `level_outcomes` on the run row, leaving a machine consumer unable to tell a consolidated review from a duplicate-laden concatenation. Only `"failed"` indicates degraded output, so branch on that value rather than on `!= "success"`.
