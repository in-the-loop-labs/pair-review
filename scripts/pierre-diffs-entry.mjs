// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
//
// Browser entry point for @pierre/diffs.
// Re-exports the APIs pair-review needs, attached to window.PierreDiffs by esbuild IIFE.

export {
  // Core components
  FileDiff,
  File,

  // Virtualized multi-file viewer. Not read by production code yet: the vendor
  // contract suite (tests/contract) drives it, and the CodeView migration
  // (plans/codeview-virtualized-diff.md) wires it into the app.
  CodeView,

  // Patch/diff parsing
  parsePatchFiles,
  getSingularPatch,
  parseDiffFromFile,
  hydratePartialDiff,
  trimPatchContext,

  // Highlighter management
  preloadHighlighter,
  getSharedHighlighter,
  disposeHighlighter,
  isHighlighterLoaded,

  // Theme utilities
  registerCustomTheme,
  registerCustomCSSVariableTheme,

  // Line annotation helpers
  getLineAnnotationName,
} from '@pierre/diffs';

export {
  WorkerPoolManager,
} from '@pierre/diffs/worker';
