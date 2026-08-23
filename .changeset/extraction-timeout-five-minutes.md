---
"@in-the-loop-labs/pair-review": patch
---

Harden thorough-tier reviews against narration-prefixed output, and raise the LLM JSON-extraction fallback timeout from 60 seconds to 5 minutes. Every thorough template (Levels 1-3, orchestration, consolidation) now closes with a reply-shape guard — the reply is the JSON object alone, its first character `{` — since agentic models can narrate their process ahead of the JSON and break extraction. The guard deliberately does not quote an example of the forbidden preamble: an earlier version did, and eval showed the model emitting the quoted sentence near-verbatim. The extraction timeout raise keeps large (100KB+) analyses recoverable instead of discarding them mid-extraction; the Antigravity extraction budget (`--print-timeout`) moves in step so agy still self-terminates just before the outer cap, and the Antigravity analysis directive now defers access rules to the task instructions instead of hardcoding its own.
