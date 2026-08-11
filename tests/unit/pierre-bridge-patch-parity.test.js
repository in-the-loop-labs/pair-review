// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// Regression coverage for the patch-parity bug behind the CI E2E failures:
// the initial diff item parses the PATCH (with git's context lines), but
// upgradeFileContents re-diffs the full file contents, which can produce
// NARROWER hunks. The upgrade render then silently un-rendered lines that
// annotations were anchored to, leaving them as unslotted (invisible) orphans.
// The bridge must capture the patch-rendered spans as patchParityRanges and
// merge them into every subsequent published metadata — including after
// clearContextRanges, which only clears DYNAMIC expansion ranges.

// Patch-parsed hunks: context included, NEW lines 12-25 rendered.
const PATCH_HUNKS = [{ additionStart: 12, additionCount: 14, deletionStart: 12, deletionCount: 10 }];
// Full-contents re-diff: narrower, lines 17-25 only.
const UPGRADED_HUNKS = [{ additionStart: 17, additionCount: 9, deletionStart: 17, deletionCount: 5 }];

// PierreContext test double: mergeContextRanges tags the metadata with the
// ranges it was merged with so assertions can inspect exactly what got rendered.
const PIERRE_CONTEXT = {
  mergeOverlapping: (ranges) => ranges,
  mergeContextRanges: (base, ranges) => ({ ...base, mergedRanges: ranges }),
  subtractRanges: (existing, toRemove) =>
    existing.filter(r => !toRemove.some(t => t.startLine === r.startLine && t.endLine === r.endLine)),
};

describe('PierreBridge patch parity across content upgrades', () => {
  let env;
  let bridge;
  let codeView;
  let fileState;
  let upgradedMeta;

  beforeEach(() => {
    upgradedMeta = { name: 'a.js', hunks: UPGRADED_HUNKS };
    env = createPierreEnv({
      worker: false,
      context: PIERRE_CONTEXT,
      // The initial diff item's metadata carries the wide PATCH_HUNKS.
      parsePatch: () => ({ name: 'a.js', hunks: PATCH_HUNKS }),
      // upgradeFileContents re-diffs to the narrower UPGRADED_HUNKS.
      parseDiffFromFile: () => upgradedMeta,
    });
    bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -12,10 +12,14 @@\n old\n' },
    ]);
    codeView = env.codeViews[0];
    fileState = bridge.files.get('a.js');
  });

  afterEach(() => {
    env.cleanup();
  });

  function upgrade() {
    return bridge.upgradeFileContents(
      'a.js',
      { name: 'a.js', contents: 'old' },
      { name: 'a.js', contents: 'new' }
    );
  }

  function lastPublished() {
    return codeView.getItem('a.js');
  }

  it('captures the patch-rendered spans as patchParityRanges at upgrade', () => {
    upgrade();
    expect(fileState.patchParityRanges).toEqual([{ startLine: 12, endLine: 25 }]);
    expect(fileState.baseMetadata.hunks).toBe(UPGRADED_HUNKS);
  });

  it('publishes with parity ranges merged so no patch line disappears', () => {
    upgrade();
    expect(lastPublished().fileDiff.mergedRanges).toEqual([{ startLine: 12, endLine: 25 }]);
    // fileState.metadata (the source for the published item) carries the merge.
    expect(fileState.metadata.mergedRanges).toEqual([{ startLine: 12, endLine: 25 }]);
  });

  it('clearContextRanges keeps parity ranges — clears only dynamic ranges', () => {
    upgrade();
    bridge.addContextRanges('a.js', [{ startLine: 40, endLine: 50 }]);
    bridge.clearContextRanges('a.js');
    expect(fileState.contextRanges).toEqual([]);
    expect(lastPublished().fileDiff.mergedRanges).toEqual([{ startLine: 12, endLine: 25 }]);
  });

  it('removeContextRanges falls back to parity-merged render, not raw base', () => {
    upgrade();
    bridge.addContextRanges('a.js', [{ startLine: 40, endLine: 50 }]);
    bridge.removeContextRanges('a.js', [{ startLine: 40, endLine: 50 }]);
    expect(lastPublished().fileDiff.mergedRanges).toEqual([{ startLine: 12, endLine: 25 }]);
  });

  it('renders raw base after clear when there are no parity ranges', () => {
    // Simulate an upgraded file whose patch had no addition-side lines to
    // preserve: baseMetadata present, patchParityRanges empty.
    fileState.baseMetadata = { hunks: UPGRADED_HUNKS };
    fileState.patchParityRanges = null;
    bridge.addContextRanges('a.js', [{ startLine: 40, endLine: 50 }]);
    bridge.clearContextRanges('a.js');
    const published = lastPublished().fileDiff;
    expect(published).toEqual({ hunks: UPGRADED_HUNKS });
    expect(published.mergedRanges).toBeUndefined();
  });

  it('does not recapture parity on subsequent upgrades', () => {
    upgrade();
    const captured = fileState.patchParityRanges;
    // A second upgrade short-circuits (baseMetadata already present) and must
    // never widen parity beyond the original patch.
    upgrade();
    expect(fileState.patchParityRanges).toBe(captured);
  });

  it('skips deletion-only hunks when capturing parity (no NEW-file lines)', () => {
    // Re-seed the diff item so its patch metadata has a deletion-only hunk.
    fileState.metadata = {
      hunks: [
        { additionStart: 5, additionCount: 0, deletionStart: 5, deletionCount: 3 },
        { additionStart: 30, additionCount: 4, deletionStart: 34, deletionCount: 2 },
      ],
    };
    upgrade();
    expect(fileState.patchParityRanges).toEqual([{ startLine: 30, endLine: 33 }]);
  });

  it('is a no-op for a context (non-diff) item', () => {
    bridge.addContextFile('ctx.js', 'contents');
    expect(bridge.upgradeFileContents('context:ctx.js', null, null)).toBe(false);
  });
});
