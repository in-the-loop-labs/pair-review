// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { mergeFileListWithContext } from '../../public/js/modules/file-list-merger.js';

describe('mergeFileListWithContext', () => {
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

    const merged = mergeFileListWithContext(diff, context);

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

    const merged = mergeFileListWithContext(diff, context);
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

    const merged = mergeFileListWithContext(diff, context);

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
      const merged = mergeFileListWithContext(undefined, undefined);
      expect(merged).toEqual([]);
    });

    it('should handle null diffFiles and contextFiles', () => {
      const merged = mergeFileListWithContext(null, null);
      expect(merged).toEqual([]);
    });

    it('should handle empty arrays for both', () => {
      const merged = mergeFileListWithContext([], []);
      expect(merged).toEqual([]);
    });

    it('should handle empty diffFiles with populated contextFiles', () => {
      const context = [
        { file: 'src/standalone.js', id: 5, label: 'Alone', line_start: 1, line_end: 100 },
      ];
      const merged = mergeFileListWithContext([], context);

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
      const merged = mergeFileListWithContext(diff, []);

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

    const merged = mergeFileListWithContext(diff, []);

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

    const merged = mergeFileListWithContext(diff, undefined);

    expect(merged.map(f => f.file)).toEqual(['a.js', 'b.js']);
  });

  // ── Additional edge cases ───────────────────────────────────────────

  it('should preserve extra properties on diff file objects', () => {
    const diff = [
      { file: 'src/app.js', additions: 10, deletions: 5, extra: 'data' },
    ];

    const merged = mergeFileListWithContext(diff, []);

    expect(merged[0]).toEqual({
      file: 'src/app.js',
      additions: 10,
      deletions: 5,
      extra: 'data',
    });
  });
});
