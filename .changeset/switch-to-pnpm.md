---
"@in-the-loop-labs/pair-review": patch
---

Switch dev tooling from npm to pnpm. Internal-only change: the published package and `npx pair-review` usage are unaffected. Contributors should install pnpm and use `pnpm install` / `pnpm test` / `pnpm run dev` going forward.
