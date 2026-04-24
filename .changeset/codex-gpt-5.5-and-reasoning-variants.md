---
"@in-the-loop-labs/pair-review": patch
---

Add GPT-5.4 and GPT-5.5 high/xhigh reasoning variants to the Codex provider

New Codex model options:
- `gpt-5.4-high` / `gpt-5.4-xhigh` — GPT-5.4 with elevated reasoning effort
- `gpt-5.5-high` / `gpt-5.5-xhigh` — GPT-5.5 with elevated reasoning effort

Each variant passes its base model to `codex exec -m` and configures reasoning
effort via `-c 'model_reasoning_effort="<level>"'`, so a variant ID like
`gpt-5.5-xhigh` is never sent to Codex as a literal model name. Built-in
`cli_model` and `extra_args` are honored by both the main analysis path and
the extraction fallback.

The bare `gpt-5.4` option (unspecified reasoning effort) has been removed
from the picker in favor of these explicit variants. `gpt-5.4` still resolves
as an alias of `gpt-5.4-high`, so previously saved results and councils that
reference it continue to work.
