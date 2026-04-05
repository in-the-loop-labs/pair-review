---
"@in-the-loop-labs/pair-review": patch
---

Fix Pi 0.65.0 compatibility by switching from stdin to @file syntax for prompt delivery

Pi analysis prompts are now written to a temp file and passed via `@filepath` positional argument instead of piped through stdin. This fixes an issue where stdin piping caused Pi to fall back to plain text output instead of JSONL, breaking streaming progress updates.
