---
"@in-the-loop-labs/pair-review": patch
---

Antigravity: replace the retired Gemini 3.5 Flash models with Gemini 3.8 Flash (Low/High) in the fast tier. The old `gemini-3.5-flash-low`, `gemini-3.5-flash`, and `gemini-3.5-flash-high` ids are kept as aliases that resolve to the matching 3.8 Flash effort level, so saved councils and configs keep working instead of falling through to agy's default model. Gemini 3.8 Flash (High) moves to the thorough tier and becomes the provider's default model — it is now the strongest Gemini that agy exposes (DeepSWE v1.1 73.7, Terminal-Bench 2.1 89.4, on par with GPT-6 Astra and Muse 1.3), so "Flash" describes latency rather than capability. Gemini 3.1 Pro (Low/High) is demoted to the previous-generation Pro line: it keeps its balanced/thorough tiers but is no longer the default. Gemini 3.8 Flash (Low) stays the sole fast-tier model and the JSON-extraction fallback.
