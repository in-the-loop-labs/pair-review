---
"@in-the-loop-labs/pair-review": patch
---

Make the Pi/OMP JSON-extraction fallback match the analysis run's configuration: `load_skills: false` now also passes `--no-skills` to the extraction command (previously the fallback silently re-enabled skill auto-discovery), and extraction env vars are resolved for the extraction model instead of reusing the analysis model's cached env.
