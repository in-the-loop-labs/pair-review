// SPDX-License-Identifier: GPL-3.0-or-later
//
// Browser entry point for @pierre/diffs.
// Re-exports the APIs pair-review needs, attached to window.PierreDiffs by esbuild IIFE.

export {
  // Core components
  FileDiff,
  File,

  // Patch/diff parsing
  parsePatchFiles,
  getSingularPatch,
  parseDiffFromFile,
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
