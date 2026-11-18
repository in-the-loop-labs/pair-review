// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for PRManager.ensureLinesVisible()
 *
 * The method makes line ranges part of what a file shows. It asks the
 * bridge's data whether both ends of a range are shown (never the document:
 * a file far from the viewport has no rows), and reveals a range with a
 * hidden end through the file's context ranges, after the file's contents
 * have been loaded and in new-file line numbers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import the actual PRManager class from production code
const { PRManager } = require('../../public/js/pr.js');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A PRManager with the collaborators ensureLinesVisible() reaches, and a
 * bridge that answers the visibility question from a set of shown lines.
 * @param {Object} [options]
 * @param {string[]} [options.files] - the files the bridge holds
 * @param {Function} [options.visible] - (file, line, side) => boolean
 */
function createTestPRManager({ files = ['a.js'], visible = () => false } = {}) {
  const prManager = Object.create(PRManager.prototype);
  prManager.currentPR = { owner: 'test-owner', repo: 'test-repo', number: 42, id: 1 };
  const order = [];
  prManager.order = order;
  prManager._materializeDeferredDiff = vi.fn(async (file) => { order.push(`materialize:${file}`); return false; });
  prManager._ensurePierreContentUpgrade = vi.fn(async (file) => { order.push(`contents:${file}`); return true; });
  prManager.pierreBridge = {
    files: new Map(files.map((file) => [file, {}])),
    isLineVisible: vi.fn((file, line, side) => visible(file, line, side)),
    convertOldToNew: vi.fn((file, start, end) => ({ startLine: start, endLine: end })),
    addContextRanges: vi.fn((file) => { order.push(`reveal:${file}`); return true; }),
  };
  return prManager;
}

const shown = (...lines) => (file, line) => lines.includes(line);

describe('PRManager.ensureLinesVisible()', () => {
  describe('a range with a hidden end is revealed', () => {
    it.each([
      ['hidden start', shown(50)],
      ['hidden end', shown(10)],
      ['both ends hidden, a middle line shown', shown(30)],
      ['nothing shown', shown()],
    ])('%s: the whole range becomes a context range of the file', async (_name, visible) => {
      const manager = createTestPRManager({ visible });

      await manager.ensureLinesVisible([{ file: 'a.js', line_start: 10, line_end: 50, side: 'right' }]);

      expect(manager.pierreBridge.addContextRanges.mock.calls).toEqual([['a.js', [{ startLine: 10, endLine: 50 }]]]);
      // Both ends were asked, on the side the caller named.
      expect(manager.pierreBridge.isLineVisible.mock.calls).toEqual([['a.js', 10, 'RIGHT'], ['a.js', 50, 'RIGHT']]);
    });

    it('a range whose two ends are shown is left alone, and the file\'s contents are not asked for', async () => {
      const manager = createTestPRManager({ visible: shown(10, 50) });

      await manager.ensureLinesVisible([{ file: 'a.js', line_start: 10, line_end: 50, side: 'left' }]);

      expect(manager.pierreBridge.addContextRanges).not.toHaveBeenCalled();
      expect(manager._ensurePierreContentUpgrade).not.toHaveBeenCalled();
      expect(manager.pierreBridge.isLineVisible.mock.calls).toEqual([['a.js', 10, 'LEFT'], ['a.js', 50, 'LEFT']]);
    });

    it('a held-back diff is shown first, then the contents are loaded, then the range is revealed', async () => {
      const manager = createTestPRManager();

      await manager.ensureLinesVisible([{ file: 'a.js', line_start: 10, line_end: 15 }]);

      expect(manager.order).toEqual(['materialize:a.js', 'contents:a.js', 'reveal:a.js']);
    });
  });

  describe('what is skipped', () => {
    it('is a no-op for an empty list', async () => {
      const manager = createTestPRManager();
      await manager.ensureLinesVisible([]);
      expect(manager._materializeDeferredDiff).not.toHaveBeenCalled();
      expect(manager.pierreBridge.isLineVisible).not.toHaveBeenCalled();
    });

    it('skips items without a file or a start line', async () => {
      const manager = createTestPRManager();
      await manager.ensureLinesVisible([{ file: null, line_start: 10 }, { file: 'a.js', line_start: null }]);
      expect(manager._materializeDeferredDiff).not.toHaveBeenCalled();
      expect(manager.pierreBridge.addContextRanges).not.toHaveBeenCalled();
    });

    it('skips a file the pane does not have, and goes on to the next item', async () => {
      const manager = createTestPRManager({ files: ['b.js'] });

      await manager.ensureLinesVisible([
        { file: 'nonexistent.js', line_start: 10, line_end: 15, side: 'RIGHT' },
        { file: 'b.js', line_start: 20, line_end: 25, side: 'RIGHT' },
      ]);

      expect(manager.pierreBridge.isLineVisible.mock.calls.map((call) => call[0])).toEqual(['b.js', 'b.js']);
      expect(manager.pierreBridge.addContextRanges.mock.calls).toEqual([['b.js', [{ startLine: 20, endLine: 25 }]]]);
    });

    it('does nothing without a bridge', async () => {
      const manager = createTestPRManager();
      manager.pierreBridge = null;
      await expect(manager.ensureLinesVisible([{ file: 'a.js', line_start: 1, line_end: 2 }])).resolves.toBeUndefined();
      expect(manager._ensurePierreContentUpgrade).not.toHaveBeenCalled();
    });
  });

  describe('side and line_end', () => {
    it('defaults the side to RIGHT', async () => {
      const manager = createTestPRManager();
      await manager.ensureLinesVisible([{ file: 'a.js', line_start: 5, line_end: 5 }]);
      expect(manager.pierreBridge.isLineVisible).toHaveBeenCalledWith('a.js', 5, 'RIGHT');
      expect(manager.pierreBridge.convertOldToNew).not.toHaveBeenCalled();
    });

    it('uppercases the side', async () => {
      const manager = createTestPRManager();
      await manager.ensureLinesVisible([{ file: 'a.js', line_start: 5, line_end: 5, side: 'left' }]);
      expect(manager.pierreBridge.isLineVisible).toHaveBeenCalledWith('a.js', 5, 'LEFT');
    });

    it('treats a missing line_end as equal to line_start', async () => {
      const manager = createTestPRManager();
      await manager.ensureLinesVisible([{ file: 'a.js', line_start: 7 }]);
      expect(manager.pierreBridge.isLineVisible.mock.calls).toEqual([['a.js', 7, 'RIGHT'], ['a.js', 7, 'RIGHT']]);
      expect(manager.pierreBridge.addContextRanges.mock.calls).toEqual([['a.js', [{ startLine: 7, endLine: 7 }]]]);
    });

    it('asks about LEFT lines in old-file numbers: a line shown on the left needs nothing', async () => {
      const manager = createTestPRManager({ visible: (file, line, side) => side === 'LEFT' && line === 20 });
      await manager.ensureLinesVisible([{ file: 'a.js', line_start: 20, line_end: 20, side: 'left' }]);
      expect(manager.pierreBridge.addContextRanges).not.toHaveBeenCalled();
    });
  });

  describe('LEFT ranges and padding', () => {
    it('converts LEFT endpoints to new-file numbers before adding context, pads after converting and clamps the start', async () => {
      const manager = createTestPRManager();
      manager.pierreBridge.convertOldToNew.mockReturnValue({ startLine: 2, endLine: 4 });
      await manager.ensureLinesVisible([
        { file: 'a.js', line_start: 10, line_end: 12, side: 'LEFT', contextPadding: 3 },
      ]);
      expect(manager.pierreBridge.isLineVisible.mock.calls).toEqual([
        ['a.js', 10, 'LEFT'], ['a.js', 12, 'LEFT'],
      ]);
      expect(manager.pierreBridge.convertOldToNew.mock.calls).toEqual([['a.js', 10, 12]]);
      expect(manager.pierreBridge.addContextRanges.mock.calls).toEqual([
        ['a.js', [{ startLine: 1, endLine: 7 }]],
      ]);
    });

    it('skips expansion for visible anchors even when padding extends past EOF', async () => {
      const manager = createTestPRManager({ visible: () => true });
      await manager.ensureLinesVisible([
        { file: 'a.js', line_start: 100, line_end: 100, contextPadding: 3 },
      ]);
      expect(manager.pierreBridge.isLineVisible.mock.calls).toEqual([
        ['a.js', 100, 'RIGHT'], ['a.js', 100, 'RIGHT'],
      ]);
      expect(manager.pierreBridge.addContextRanges).not.toHaveBeenCalled();
    });

    it('skips a LEFT range that cannot be mapped to the new file', async () => {
      const manager = createTestPRManager();
      manager.pierreBridge.convertOldToNew.mockReturnValue(null);
      await manager.ensureLinesVisible([
        { file: 'a.js', line_start: 10, line_end: 12, side: 'LEFT', contextPadding: 3 },
      ]);
      expect(manager.pierreBridge.addContextRanges).not.toHaveBeenCalled();
    });
  });

  describe('multiple items', () => {
    it('processes each item independently', async () => {
      const manager = createTestPRManager({
        files: ['a.js', 'b.js', 'c.js'],
        visible: (file) => file === 'a.js',
      });

      await manager.ensureLinesVisible([
        { file: 'a.js', line_start: 10, line_end: 15, side: 'RIGHT' },
        { file: 'b.js', line_start: 20, line_end: 25, side: 'RIGHT' },
        { file: 'c.js', line_start: 30, line_end: 30, side: 'LEFT' },
      ]);

      expect(manager.pierreBridge.addContextRanges.mock.calls).toEqual([
        ['b.js', [{ startLine: 20, endLine: 25 }]],
        ['c.js', [{ startLine: 30, endLine: 30 }]],
      ]);
      expect(manager._ensurePierreContentUpgrade.mock.calls).toEqual([['b.js'], ['c.js']]);
    });

    it('reveals every item when none is shown, in order', async () => {
      const manager = createTestPRManager({ files: ['x.js', 'y.js'] });

      await manager.ensureLinesVisible([
        { file: 'x.js', line_start: 1, line_end: 5, side: 'RIGHT' },
        { file: 'y.js', line_start: 10, line_end: 20, side: 'RIGHT' },
        { file: 'x.js', line_start: 50, line_end: 50, side: 'RIGHT' },
      ]);

      expect(manager.pierreBridge.addContextRanges.mock.calls).toEqual([
        ['x.js', [{ startLine: 1, endLine: 5 }]],
        ['y.js', [{ startLine: 10, endLine: 20 }]],
        ['x.js', [{ startLine: 50, endLine: 50 }]],
      ]);
    });
  });
});
