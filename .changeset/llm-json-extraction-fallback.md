---
"@in-the-loop-labs/pair-review": patch
---

Added LLM-based JSON extraction fallback for all AI providers. When regex-based JSON extraction fails to parse AI responses, providers now attempt to use a fast-tier LLM to extract the JSON content, improving reliability of AI analysis across all providers.
