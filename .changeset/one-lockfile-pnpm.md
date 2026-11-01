---
"@in-the-loop-labs/pair-review": patch
---

Make `pnpm-lock.yaml` the only lock file. The generated npm `package-lock.json` (and `scripts/generate-package-lock.sh`) is gone: packagers should build from `pnpm-lock.yaml`, which is what CI tests. Also bump `@pierre/diffs` to `^1.6.2` (with `@pierre/theming` 1.0.2), so the tested diff renderer matches what users install.
