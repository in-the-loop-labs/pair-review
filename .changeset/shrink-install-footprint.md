---
"@in-the-loop-labs/pair-review": patch
---

fix: shrink install footprint and fix postinstall script for consumers

- Stop emitting a sourcemap for the bundled `@pierre/diffs` output. The
  sourcemap is only useful for debugging minified pierre internals, which
  end users never do. Cuts unpacked package size by ~13MB (49%).
- Switch the bundle-build lifecycle hook from `postinstall` to `prepare`.
  `postinstall` ran on end-user installs and tried to invoke `esbuild`,
  which is a devDep and is not present when the package is installed as
  a dependency. `prepare` runs for developers on `pnpm install` in the
  repo and before `npm publish`, but does not run for consumers.
