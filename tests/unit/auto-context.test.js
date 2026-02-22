// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for ensureContextFileForComment() in src/utils/auto-context.js
 *
 * Tests the logic that ensures a context file entry exists when a comment
 * targets a file outside the review's diff. Covers: diff membership checks,
 * line padding, file-level comments, existing range coverage/expansion,
 * MAX_RANGE clamping, boundary clamping, and error handling.
 *
 * Because auto-context.js is a CJS module that uses require() for its
 * dependencies, we pre-populate the Node module cache with mock modules
 * before loading auto-context. This gives us full control over its deps.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

// --- Resolve absolute paths for dependencies ---
const srcDir = path.resolve(__dirname, '../../src');
const autoContextPath = path.join(srcDir, 'utils/auto-context.js');
const databasePath = path.join(srcDir, 'database.js');
const loggerPath = path.join(srcDir, 'utils/logger.js');
const diffFileListPath = path.join(srcDir, 'utils/diff-file-list.js');

// --- Create mock functions ---
const mockGetDiffFileList = vi.fn();
const mockAdd = vi.fn();
const mockGetByReviewIdAndFile = vi.fn();
const mockUpdateRange = vi.fn();
const mockWarn = vi.fn();

// Track ContextFileRepository constructor calls
let constructorCalls = 0;
function resetConstructorCalls() { constructorCalls = 0; }

// A real constructor function that `new` can invoke without warnings
function FakeContextFileRepository() {
  constructorCalls++;
  this.getByReviewIdAndFile = mockGetByReviewIdAndFile;
  this.add = mockAdd;
  this.updateRange = mockUpdateRange;
}

// --- Clear any cached versions and inject mocks ---
function clearAndInjectMocks() {
  delete require.cache[autoContextPath];
  delete require.cache[databasePath];
  delete require.cache[loggerPath];
  delete require.cache[diffFileListPath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { ContextFileRepository: FakeContextFileRepository }
  };

  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { warn: mockWarn }
  };

  require.cache[diffFileListPath] = {
    id: diffFileListPath,
    filename: diffFileListPath,
    loaded: true,
    exports: { getDiffFileList: mockGetDiffFileList }
  };
}

// Inject mocks and load the module under test
clearAndInjectMocks();
const { ensureContextFileForComment } = require(autoContextPath);

describe('ensureContextFileForComment', () => {
  let db;
  let review;

  beforeEach(() => {
    vi.clearAllMocks();
    resetConstructorCalls();

    db = {};
    review = { id: 42 };

    // Default mock behaviors
    mockGetByReviewIdAndFile.mockResolvedValue([]);
    mockAdd.mockResolvedValue({ id: 100 });
    mockUpdateRange.mockResolvedValue(true);
  });

  it('should return no-op when the file is already in the diff', async () => {
    mockGetDiffFileList.mockResolvedValue(['src/app.js', 'src/utils.js']);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/app.js',
      line_start: 10,
      line_end: 20
    });

    expect(result).toEqual({ created: false, expanded: false });
    expect(constructorCalls).toBe(0);
  });

  it('should create a context file with padded range for a line comment on a non-diff file', async () => {
    mockGetDiffFileList.mockResolvedValue(['src/other.js']);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/target.js',
      line_start: 50,
      line_end: 55
    });

    expect(result).toEqual({ created: true, expanded: false, contextFileId: 100 });
    expect(mockAdd).toHaveBeenCalledWith(
      42, 'src/target.js', 40, 65, 'Auto-added for comment'
    );
  });

  it('should create a context file with range [1, 50] for a file-level comment', async () => {
    mockGetDiffFileList.mockResolvedValue([]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/config.js',
      line_start: null,
      line_end: null
    });

    expect(result).toEqual({ created: true, expanded: false, contextFileId: 100 });
    expect(mockAdd).toHaveBeenCalledWith(
      42, 'src/config.js', 1, 50, 'Auto-added for comment'
    );
  });

  it('should return no-op when existing context file already covers the desired range', async () => {
    mockGetDiffFileList.mockResolvedValue([]);
    mockGetByReviewIdAndFile.mockResolvedValue([
      { id: 77, line_start: 30, line_end: 80 }
    ]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/covered.js',
      line_start: 50,
      line_end: 55
    });

    // Desired range is [40, 65], existing [30, 80] covers it
    expect(result).toEqual({ created: false, expanded: false });
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockUpdateRange).not.toHaveBeenCalled();
  });

  it('should expand range when existing context file does not cover the desired range', async () => {
    mockGetDiffFileList.mockResolvedValue([]);
    mockGetByReviewIdAndFile.mockResolvedValue([
      { id: 77, line_start: 50, line_end: 60 }
    ]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/partial.js',
      line_start: 50,
      line_end: 55
    });

    // Desired range: [40, 65]. Existing: [50, 60].
    // Union: [min(50,40), max(60,65)] = [40, 65]
    expect(result).toEqual({ created: false, expanded: true, contextFileId: 77 });
    expect(mockUpdateRange).toHaveBeenCalledWith(77, 40, 65);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('should clamp range to MAX_RANGE (500) when computed range is too large', async () => {
    mockGetDiffFileList.mockResolvedValue([]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/huge.js',
      line_start: 1000,
      line_end: 1600
    });

    // Desired: [990, 1610] — range of 621 lines, exceeds 500
    // Clamped: [990, 990 + 499] = [990, 1489]
    expect(result).toEqual({ created: true, expanded: false, contextFileId: 100 });
    expect(mockAdd).toHaveBeenCalledWith(
      42, 'src/huge.js', 990, 1489, 'Auto-added for comment'
    );
  });

  it('should clamp start to 1 when line_start is near the beginning of the file', async () => {
    mockGetDiffFileList.mockResolvedValue([]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/top.js',
      line_start: 3,
      line_end: 5
    });

    // Desired: [max(1, 3-10), 5+10] = [1, 15]
    expect(result).toEqual({ created: true, expanded: false, contextFileId: 100 });
    expect(mockAdd).toHaveBeenCalledWith(
      42, 'src/top.js', 1, 15, 'Auto-added for comment'
    );
  });

  it('should log a warning and return no-op when getDiffFileList throws', async () => {
    mockGetDiffFileList.mockRejectedValue(new Error('git exploded'));

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/broken.js',
      line_start: 10,
      line_end: 20
    });

    expect(result).toEqual({ created: false, expanded: false });
    expect(mockWarn).toHaveBeenCalledWith(
      '[AutoContext] Failed to ensure context file: git exploded'
    );
    expect(constructorCalls).toBe(0);
  });

  it('should handle undefined line_start as a file-level comment', async () => {
    mockGetDiffFileList.mockResolvedValue([]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/nolines.js',
      line_start: undefined,
      line_end: undefined
    });

    expect(result).toEqual({ created: true, expanded: false, contextFileId: 100 });
    expect(mockAdd).toHaveBeenCalledWith(
      42, 'src/nolines.js', 1, 50, 'Auto-added for comment'
    );
  });

  it('should recognise coverage by a non-first entry when multiple entries exist', async () => {
    mockGetDiffFileList.mockResolvedValue([]);
    mockGetByReviewIdAndFile.mockResolvedValue([
      { id: 10, line_start: 1, line_end: 50 },
      { id: 11, line_start: 90, line_end: 150 }
    ]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/multi.js',
      line_start: 120,
      line_end: 120
    });

    // Desired range: [110, 130]. Entry [90, 150] covers it entirely.
    expect(result).toEqual({ created: false, expanded: false });
    expect(mockUpdateRange).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('should expand the overlapping entry when multiple entries exist and none fully covers the range', async () => {
    mockGetDiffFileList.mockResolvedValue([]);
    mockGetByReviewIdAndFile.mockResolvedValue([
      { id: 10, line_start: 1, line_end: 50 },
      { id: 11, line_start: 90, line_end: 120 }
    ]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/multi-expand.js',
      line_start: 115,
      line_end: 125
    });

    // Desired range: [105, 135]. Entry [90, 120] overlaps, so expand it.
    // Union: [min(90,105), max(120,135)] = [90, 135]
    expect(result).toEqual({ created: false, expanded: true, contextFileId: 11 });
    expect(mockUpdateRange).toHaveBeenCalledWith(11, 90, 135);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('should create a new entry when existing entry does not overlap desired range', async () => {
    mockGetDiffFileList.mockResolvedValue([]);
    mockGetByReviewIdAndFile.mockResolvedValue([
      { id: 88, line_start: 1, line_end: 100 }
    ]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/wide.js',
      line_start: 600,
      line_end: 610
    });

    // Desired: [590, 620]. Existing: [1, 100]. No overlap.
    // Instead of expanding [1,100] to a clamped [1,500] that misses 590-620,
    // create a new entry with the desired range.
    expect(result).toEqual({ created: true, expanded: false, contextFileId: 100 });
    expect(mockAdd).toHaveBeenCalledWith(
      42, 'src/wide.js', 590, 620, 'Auto-added for comment'
    );
    expect(mockUpdateRange).not.toHaveBeenCalled();
  });

  it('should clamp expanded union range to MAX_RANGE for overlapping entries', async () => {
    mockGetDiffFileList.mockResolvedValue([]);
    mockGetByReviewIdAndFile.mockResolvedValue([
      { id: 88, line_start: 1, line_end: 400 }
    ]);

    const result = await ensureContextFileForComment(db, review, {
      file: 'src/overlap-clamp.js',
      line_start: 390,
      line_end: 500
    });

    // Desired: [380, 510]. Existing: [1, 400]. They overlap (380 <= 400).
    // Union: [min(1,380), max(400,510)] = [1, 510] => 510 lines, exceeds 500
    // Clamped: [1, 1+499] = [1, 500]
    expect(result).toEqual({ created: false, expanded: true, contextFileId: 88 });
    expect(mockUpdateRange).toHaveBeenCalledWith(88, 1, 500);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});
