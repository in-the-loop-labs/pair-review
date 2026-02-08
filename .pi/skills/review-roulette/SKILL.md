<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
---
name: review-roulette
description: Dispatch a review task to 3 randomly-selected reasoning models in parallel for diverse perspectives, then merge all suggestions into a single result.
---

# Review Roulette

When this skill is active, your ONLY job is orchestration — you do NOT perform
any review analysis yourself. You randomly select 3 reasoning models, dispatch
the review to all of them in parallel, and merge the results.

## Step 1: Discover Available Reasoning Models

Run `${PI_CMD:-pi} --list-models` via bash to get the current list of models with
valid API keys. **Eligible models** are those that show `thinking: yes` in the
output — these are the reasoning-capable / premium models.

Example reasoning models you might see (provider/model format):

- `anthropic/claude-opus-4-6`
- `anthropic/claude-sonnet-4-5` (with thinking)
- `openai/o3-pro`
- `openai/o3`
- `openai/o4-mini`
- `openai/gpt-5-pro`
- `openai/gpt-5.2-pro`
- `google/gemini-2.5-pro` (with thinking)
- `google/gemini-2.5-flash` (with thinking)
- `google/gemini-3-pro-preview`
- `xai/grok-4`

The exact list depends on which API keys are configured. Always check — do not
assume models are available.

## Step 2: Randomly Select 3 Models

From the eligible reasoning models, pick **exactly 3** at random.

**CRITICAL — true randomness and diversity:**

- Do NOT always pick the same 3 models. The entire point of review roulette is
  variety of perspectives across runs.
- **Prefer different providers** when possible. If you have reasoning models from
  Anthropic, OpenAI, Google, and xAI, pick from 3 different providers. Only
  double up on a provider if fewer than 3 providers have eligible models.
- Shuffle or randomize your selection each time. Do not default to alphabetical
  order or any fixed preference.

## Step 3: Dispatch the Review in Parallel

Use the `task` tool with the `tasks` array to dispatch all 3 reviews
simultaneously. Each task object must include:

1. **`model`**: The selected model in `provider/model` format.
2. **`task`**: The **FULL original review prompt/instructions**. Each subtask
   starts fresh with NO conversation history and NO context from the parent.
   You must forward EVERYTHING you were asked to do — the complete prompt, all
   instructions, the diff, file contents, any constraints or formatting
   requirements, the expected JSON output schema, etc. Do not summarize or
   abbreviate. Pass it all through verbatim.

Example structure:

```json
{
  "tasks": [
    {
      "task": "<the ENTIRE original review prompt and instructions>",
      "model": "anthropic/claude-opus-4-6"
    },
    {
      "task": "<the ENTIRE original review prompt and instructions>",
      "model": "openai/o3"
    },
    {
      "task": "<the ENTIRE original review prompt and instructions>",
      "model": "google/gemini-2.5-pro"
    }
  ]
}
```

## Step 4: Merge Results

Each subtask will return a review result containing a `summary` string and a
`suggestions` array (the standard review JSON format).

Collect the results from all 3 subtask responses and merge them:

- **Suggestions**: Concatenate all `suggestions` arrays into a single array.
- **Summary**: Concatenate all summaries with model attribution. Format the
  merged summary as:

  ```
  <provider/model1>:
  <summary1>

  <provider/model2>:
  <summary2>

  <provider/model3>:
  <summary3>
  ```

  This attributed format also serves as a record of which models were used in
  the review.

Return the merged result as the final JSON response.

**Do NOT:**

- Deduplicate suggestions — let the consumer decide what overlaps
- Synthesize, summarize, or editorialize on the combined results
- Perform any review analysis yourself

**Do:**

- Concatenate all suggestion arrays: `[...model1, ...model2, ...model3]`
- Concatenate all summaries with `provider/model:` attribution as shown above
- Return the merged result as the final JSON response in the same schema the
  subtasks used

## Summary

```
You (parent)                    Subtask 1 (model A)
    │                               │
    ├── pick 3 random models        ├── receive full prompt
    ├── forward full prompt ──────► ├── perform review
    │                               └── return suggestions JSON
    │
    ├── forward full prompt ──────► Subtask 2 (model B) ──► suggestions JSON
    │
    ├── forward full prompt ──────► Subtask 3 (model C) ──► suggestions JSON
    │
    └── merge all summaries (with model attribution) + suggestions[] ──► final JSON response
```

The parent does zero analysis. It is purely a dispatcher and merger.
Each model's summary is attributed so the final output records which models contributed.
