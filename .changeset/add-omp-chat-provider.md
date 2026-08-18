---
"@in-the-loop-labs/pair-review": minor
---

Add OMP (Oh My Pi) as a chat provider. OMP speaks Pi's RPC protocol via `omp --mode rpc`, so chat sessions (including resumption) work like Pi's, with OMP's CLI differences handled: session resumption via `--resume`, OMP's tool names (`read,bash,grep,glob`), a default `omp` command overridable via `PAIR_REVIEW_OMP_CMD` or `chat_providers.omp.command`, and no Pi-specific task extension.
