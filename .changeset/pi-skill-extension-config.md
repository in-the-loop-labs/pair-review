---
"@in-the-loop-labs/pair-review": patch
---

Add `load_skills` and `app_extensions` config fields for Pi providers (analysis and chat). When `load_skills` is false, adds `--no-skills` to suppress Pi's skill auto-discovery. When `app_extensions` is false, omits pair-review's task extension (`-e` flag). Replaces the need to manually configure `extra_args: ["--no-skills"]`.
