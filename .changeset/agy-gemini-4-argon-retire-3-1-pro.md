---
"@in-the-loop-labs/pair-review": patch
---

Update the Antigravity (`agy`) provider's built-in models to match agy 1.3.5: add Gemini 4 Argon (thorough tier; Google AI Ultra and eligible Gemini Enterprise plans only) and Gemini 3.8 Flash (Medium) as the balanced tier, and remove the retired Gemini 3.1 Pro (High/Low) models, which agy no longer offers. Gemini 3.8 Flash (High) remains the default.

Switching providers in the analysis dialog or repository settings now keeps the new provider's default model when it is in the same tier as the previous selection, instead of taking that tier's first model, which could be one your plan cannot run.

Cursor's default model is now Composer 1.5 (previously Claude 4.6 Sonnet (Thinking)).
