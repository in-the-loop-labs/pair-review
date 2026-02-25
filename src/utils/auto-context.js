// SPDX-License-Identifier: GPL-3.0-or-later
const { getDiffFileList } = require('./diff-file-list');
const { ContextFileRepository } = require('../database');
const logger = require('./logger');

const LINE_PADDING = 10;
const FILE_COMMENT_DEFAULT_LINES = 50;
const MAX_RANGE = 500;

/**
 * Ensure a context file entry exists for a comment that targets a file
 * outside the review's diff. If the file IS in the diff, this is a no-op.
 *
 * @param {object} db       - SQLite database handle
 * @param {object} review   - Review row from the database
 * @param {object} opts
 * @param {string} opts.file       - File path the comment targets
 * @param {number|null} opts.line_start - Start line (falsy for file-level comments)
 * @param {number|null} opts.line_end   - End line
 * @returns {Promise<{created: boolean, expanded: boolean, contextFileId?: number}>}
 */
async function ensureContextFileForComment(db, review, { file, line_start, line_end }) {
  try {
    // 1. If the file is already in the diff, nothing to do
    const diffFiles = await getDiffFileList(db, review);
    if (diffFiles.includes(file)) {
      return { created: false, expanded: false };
    }

    // 2. Compute desired range
    let desiredStart, desiredEnd;
    if (line_start) {
      desiredStart = Math.max(1, line_start - LINE_PADDING);
      desiredEnd = (line_end ?? line_start) + LINE_PADDING;
    } else {
      desiredStart = 1;
      desiredEnd = FILE_COMMENT_DEFAULT_LINES;
    }

    // 3. Clamp total range to MAX_RANGE
    if (desiredEnd - desiredStart + 1 > MAX_RANGE) {
      desiredEnd = desiredStart + MAX_RANGE - 1;
    }

    // 4. Look up existing context file entries for this file
    const contextFileRepo = new ContextFileRepository(db);
    const existing = await contextFileRepo.getByReviewIdAndFile(review.id, file);

    if (existing.length > 0) {
      // 5. Check if ANY existing entry already covers the desired range
      const covering = existing.find(e => e.line_start <= desiredStart && e.line_end >= desiredEnd);
      if (covering) {
        return { created: false, expanded: false };
      }

      // 6. Find an entry that overlaps with the desired range
      const overlapping = existing.find(e =>
        e.line_start <= desiredEnd && e.line_end >= desiredStart
      );

      if (overlapping) {
        // 7. Expand to the union of old and desired ranges
        let newStart = Math.min(overlapping.line_start, desiredStart);
        let newEnd = Math.max(overlapping.line_end, desiredEnd);

        if (newEnd - newStart + 1 > MAX_RANGE) {
          newEnd = newStart + MAX_RANGE - 1;
        }

        await contextFileRepo.updateRange(overlapping.id, review.id, newStart, newEnd);
        return { created: false, expanded: true, contextFileId: overlapping.id };
      }

      // No overlapping entry — fall through to create a new one
    }

    // 8. No existing entry — create one
    const inserted = await contextFileRepo.add(
      review.id, file, desiredStart, desiredEnd, 'Auto-added for comment'
    );
    return { created: true, expanded: false, contextFileId: inserted.id };
  } catch (err) {
    logger.warn(`[AutoContext] Failed to ensure context file: ${err.message}`);
    return { created: false, expanded: false };
  }
}

module.exports = { ensureContextFileForComment };
