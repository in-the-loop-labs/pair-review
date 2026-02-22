// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';

describe('rebuildFileListWithContext', () => {
  /**
   * Create a lightweight PRManager-like object with diffFiles, contextFiles,
   * a mocked updateFileList, and the rebuildFileListWithContext method bound
   * so we can test it in isolation.
   */
  function createManager(diffFiles, contextFiles) {
    const manager = {
      diffFiles,
      contextFiles,
      updateFileList: vi.fn(),
      rebuildFileListWithContext: null,
    };
    // Inline copy of the method from PRManager (public/js/pr.js ~line 4168)
    manager.rebuildFileListWithContext = function () {
      const merged = [...(this.diffFiles || [])];
      const diffPaths = new Set((this.diffFiles || []).map(f => f.file));
      const seenContextPaths = new Set();
      for (const cf of this.contextFiles || []) {
        if (diffPaths.has(cf.file) || seenContextPaths.has(cf.file)) continue;
        seenContextPaths.add(cf.file);
        merged.push({
          file: cf.file,
          contextFile: true,
          contextId: cf.id,
          label: cf.label,
          lineStart: cf.line_start,
          lineEnd: cf.line_end,
        });
      }
      merged.sort((a, b) => a.file.localeCompare(b.file));
      this.updateFileList(merged);
    };
    return manager;
  }

  // ── 1. Basic merge ──────────────────────────────────────────────────

  it('should merge diff files and context files in sorted path order', () => {
    const diff = [
      { file: 'src/app.js' },
      { file: 'src/utils.js' },
    ];
    const context = [
      { file: 'src/config.js', id: 1, label: 'Config', line_start: 1, line_end: 50 },
      { file: 'tests/app.test.js', id: 2, label: 'Tests', line_start: 10, line_end: 30 },
    ];

    const mgr = createManager(diff, context);
    mgr.rebuildFileListWithContext();

    expect(mgr.updateFileList).toHaveBeenCalledTimes(1);
    const merged = mgr.updateFileList.mock.calls[0][0];

    expect(merged.map(f => f.file)).toEqual([
      'src/app.js',
      'src/config.js',
      'src/utils.js',
      'tests/app.test.js',
    ]);

    // Verify the context entries carry the expected metadata
    const configEntry = merged.find(f => f.file === 'src/config.js');
    expect(configEntry).toEqual({
      file: 'src/config.js',
      contextFile: true,
      contextId: 1,
      label: 'Config',
      lineStart: 1,
      lineEnd: 50,
    });
  });

  // ── 2. Duplicate context file paths ─────────────────────────────────

  it('should deduplicate context files by path, keeping first occurrence', () => {
    const diff = [{ file: 'src/app.js' }];
    const context = [
      { file: 'src/helper.js', id: 10, label: 'First', line_start: 1, line_end: 20 },
      { file: 'src/helper.js', id: 20, label: 'Second', line_start: 50, line_end: 80 },
      { file: 'src/helper.js', id: 30, label: 'Third', line_start: 100, line_end: 120 },
    ];

    const mgr = createManager(diff, context);
    mgr.rebuildFileListWithContext();

    const merged = mgr.updateFileList.mock.calls[0][0];
    const helperEntries = merged.filter(f => f.file === 'src/helper.js');

    expect(helperEntries).toHaveLength(1);
    expect(helperEntries[0].contextId).toBe(10);
    expect(helperEntries[0].label).toBe('First');
  });

  // ── 3. Diff-takes-precedence ────────────────────────────────────────

  it('should exclude context files whose path matches a diff file', () => {
    const diff = [
      { file: 'src/app.js' },
      { file: 'src/utils.js' },
    ];
    const context = [
      { file: 'src/app.js', id: 1, label: 'Overlap', line_start: 1, line_end: 50 },
      { file: 'src/new.js', id: 2, label: 'New', line_start: 10, line_end: 30 },
    ];

    const mgr = createManager(diff, context);
    mgr.rebuildFileListWithContext();

    const merged = mgr.updateFileList.mock.calls[0][0];

    // src/app.js should appear once (from diff), not from context
    const appEntries = merged.filter(f => f.file === 'src/app.js');
    expect(appEntries).toHaveLength(1);
    expect(appEntries[0]).not.toHaveProperty('contextFile');

    // The non-overlapping context file should be present
    expect(merged.map(f => f.file)).toContain('src/new.js');
  });

  // ── 4. Empty inputs ────────────────────────────────────────────────

  describe('empty inputs', () => {
    it('should handle undefined diffFiles and contextFiles', () => {
      const mgr = createManager(undefined, undefined);
      mgr.rebuildFileListWithContext();

      const merged = mgr.updateFileList.mock.calls[0][0];
      expect(merged).toEqual([]);
    });

    it('should handle null diffFiles and contextFiles', () => {
      const mgr = createManager(null, null);
      mgr.rebuildFileListWithContext();

      const merged = mgr.updateFileList.mock.calls[0][0];
      expect(merged).toEqual([]);
    });

    it('should handle empty arrays for both', () => {
      const mgr = createManager([], []);
      mgr.rebuildFileListWithContext();

      const merged = mgr.updateFileList.mock.calls[0][0];
      expect(merged).toEqual([]);
    });

    it('should handle empty diffFiles with populated contextFiles', () => {
      const context = [
        { file: 'src/standalone.js', id: 5, label: 'Alone', line_start: 1, line_end: 100 },
      ];
      const mgr = createManager([], context);
      mgr.rebuildFileListWithContext();

      const merged = mgr.updateFileList.mock.calls[0][0];
      expect(merged).toHaveLength(1);
      expect(merged[0]).toEqual({
        file: 'src/standalone.js',
        contextFile: true,
        contextId: 5,
        label: 'Alone',
        lineStart: 1,
        lineEnd: 100,
      });
    });

    it('should handle populated diffFiles with empty contextFiles', () => {
      const diff = [{ file: 'src/app.js' }];
      const mgr = createManager(diff, []);
      mgr.rebuildFileListWithContext();

      const merged = mgr.updateFileList.mock.calls[0][0];
      expect(merged).toHaveLength(1);
      expect(merged[0]).toEqual({ file: 'src/app.js' });
    });
  });

  // ── 5. No context files — output matches diff files sorted ──────────

  it('should return only diff files sorted when no context files exist', () => {
    const diff = [
      { file: 'src/z.js' },
      { file: 'src/a.js' },
      { file: 'lib/utils.js' },
    ];

    const mgr = createManager(diff, []);
    mgr.rebuildFileListWithContext();

    const merged = mgr.updateFileList.mock.calls[0][0];
    expect(merged.map(f => f.file)).toEqual([
      'lib/utils.js',
      'src/a.js',
      'src/z.js',
    ]);
  });

  it('should sort diff files even when contextFiles is undefined', () => {
    const diff = [
      { file: 'b.js' },
      { file: 'a.js' },
    ];

    const mgr = createManager(diff, undefined);
    mgr.rebuildFileListWithContext();

    const merged = mgr.updateFileList.mock.calls[0][0];
    expect(merged.map(f => f.file)).toEqual(['a.js', 'b.js']);
  });

  // ── Additional edge cases ───────────────────────────────────────────

  it('should call updateFileList exactly once', () => {
    const mgr = createManager(
      [{ file: 'src/app.js' }],
      [{ file: 'src/other.js', id: 1, label: 'Other', line_start: 1, line_end: 10 }],
    );
    mgr.rebuildFileListWithContext();

    expect(mgr.updateFileList).toHaveBeenCalledTimes(1);
  });

  it('should preserve extra properties on diff file objects', () => {
    const diff = [
      { file: 'src/app.js', additions: 10, deletions: 5, extra: 'data' },
    ];

    const mgr = createManager(diff, []);
    mgr.rebuildFileListWithContext();

    const merged = mgr.updateFileList.mock.calls[0][0];
    expect(merged[0]).toEqual({
      file: 'src/app.js',
      additions: 10,
      deletions: 5,
      extra: 'data',
    });
  });
});
