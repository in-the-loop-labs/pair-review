// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
//
// Browser entry point for @pierre/diffs.
// Re-exports the APIs pair-review needs, attached to window.PierreDiffs by esbuild IIFE.
//
// Keep this list to what a consumer actually reads off window.PierreDiffs — the
// per-file FileDiff/File components died with the CodeView migration, and the
// highlighter/theme/annotation-name helpers were never read from the bridge
// (CodeView owns highlighting and takes the theme via its options).

export {
  // Core component — one virtualized view owns the whole diff list
  CodeView,

  // Patch/diff parsing
  parsePatchFiles,
  getSingularPatch,
  parseDiffFromFile,
} from '@pierre/diffs';

export {
  WorkerPoolManager,
} from '@pierre/diffs/worker';
