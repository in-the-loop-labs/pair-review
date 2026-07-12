---
"@in-the-loop-labs/pair-review": patch
---

Refresh UI styling to remove generic "AI-generated" visual tells while keeping the amber AI identity as flat color. The Analyze button is now text-only, gradient button/badge/card fills are flattened to solid colors, colored glow box-shadows and pulse-glow animations are removed (focus rings kept), `transition: all` is replaced with explicit properties, a `prefers-reduced-motion` guard is added, and the DM Sans / JetBrains Mono Google Fonts are dropped in favor of the system font stack. The sparkles icon remains the mark for AI suggestions (light-bulb already denotes the improvement category), minus its glow and float animations.
