// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

/**
 * Unit tests for HunkParser - Hunk header parsing and gap context expansion
 * Focuses on static properties and pure logic functions
 * DOM-creating functions are tested via E2E tests
 */

// Import the actual HunkParser module from production code
const { HunkParser } = require('../../public/js/modules/hunk-parser.js');
const { parseUnifiedDiffPatches } = require('../../src/utils/diff-file-list.js');
const {
  LOOKALIKE_DIFF, LOOKALIKE_STATS, EXHAUSTED_HUNK_PATCH, EXHAUSTED_HUNK_STATS,
  CR_CONTEXT_DIFF, CR_CONTEXT_STATS
} = require('../utils/diff-stat-fixtures.js');

describe('HunkParser', () => {

  describe('countPatchStats', () => {
    // Per-file patches, as Local mode's loadLocalDiff hands them over.
    const patches = parseUnifiedDiffPatches(LOOKALIKE_DIFF);

    it('counts a removed `-- comment` (`--- x`) and an added `++ x` (`+++ x`) line', () => {
      expect(HunkParser.countPatchStats(patches.get('q.sql'))).toEqual(LOOKALIKE_STATS['q.sql']);
    });

    it('leaves real headers, `\\ No newline` markers and binary sections uncounted', () => {
      expect(HunkParser.countPatchStats(patches.get('a.js'))).toEqual(LOOKALIKE_STATS['a.js']);
      expect(HunkParser.countPatchStats(patches.get('img.bin'))).toEqual(LOOKALIKE_STATS['img.bin']);
    });

    it('stops counting once a hunk has delivered its declared lines', () => {
      expect(HunkParser.countPatchStats(EXHAUSTED_HUNK_PATCH)).toEqual(EXHAUSTED_HUNK_STATS);
    });

    it('counts a hunk whose `@@` context contains a carriage return', () => {
      const patch = parseUnifiedDiffPatches(CR_CONTEXT_DIFF).get('f.js');
      expect(HunkParser.countPatchStats(patch)).toEqual(CR_CONTEXT_STATS['f.js']);
    });

    it('returns zeros for an empty or missing patch', () => {
      expect(HunkParser.countPatchStats('')).toEqual({ additions: 0, deletions: 0 });
      expect(HunkParser.countPatchStats(undefined)).toEqual({ additions: 0, deletions: 0 });
    });
  });
});
