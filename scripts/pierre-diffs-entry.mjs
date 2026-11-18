// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
//
// Browser entry point for @pierre/diffs.
// Re-exports the APIs pair-review needs, attached to window.PierreDiffs by esbuild IIFE.
// The list is pinned by tests/unit/pierre-diffs-entry-exports.test.js: every
// name here is read by production code, and nothing else is exported. (What
// only the vendor contract suite needs is built into a bundle of its own by
// that suite's setup: tests/contract/harness/vendor-extras.js.)

export {
  // The virtualized multi-file viewer that draws the diff pane
  // (public/js/modules/pierre-bridge.js).
  CodeView,

  // Patch/diff parsing: a changed file's patch, and the diff of two contents
  // (a file's full contents once loaded; a context file's base).
  parsePatchFiles,
  parseDiffFromFile,

  // The class of the viewer's diff items. The bridge corrects which rows of
  // a very long item it draws (PierreBridge.coverPaneWithRowWindow).
  VirtualizedFileDiff,
} from '@pierre/diffs';

export {
  // The highlight worker pool.
  WorkerPoolManager,
} from '@pierre/diffs/worker';
