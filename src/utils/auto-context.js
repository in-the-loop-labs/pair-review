// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { getDiffFileList } = require('./diff-file-list');
const { createChangedFilePredicate } = require('./changed-file-membership');
const { ContextFileRepository, queryOne } = require('../database');
const { broadcastReviewEvent } = require('../events/review-events');
const logger = require('./logger');

const LINE_PADDING = 10;
const FILE_COMMENT_DEFAULT_LINES = 50;
const MAX_RANGE = 500;
const SUGGESTION_CONTEXT_LABEL = 'Auto-added for suggestion';

/**
 * Ensure a context file entry exists for feedback that targets a file
 * outside the review's diff. If the file IS in the diff, this is a no-op.
 *
 * @param {object} db       - SQLite database handle
 * @param {object} review   - Review row from the database
 * @param {object} opts
 * @param {string} opts.file       - File path the feedback targets
 * @param {number|null} opts.line_start - Start line (falsy for file-level feedback)
 * @param {number|null} opts.line_end   - End line
 * @param {string} [opts.label]    - Label for a newly created entry
 * @param {Array<string>} [opts.diffFiles] - The review's diff files, when already known
 * @param {boolean} [opts.onePerFile=false] - Create an entry only when the file
 *   has none yet; never expand or add to existing entries. Suggestions use
 *   this: the browser reveals any further finding inside the one panel.
 * @returns {Promise<{created: boolean, expanded: boolean, contextFileId?: number}>}
 */
async function ensureContextFile(db, review, {
  file, line_start, line_end, label = 'Auto-added for comment', diffFiles: knownDiffFiles, onePerFile = false
}) {
  try {
    // 1. If the file is already in the diff, nothing to do
    const diffFiles = knownDiffFiles ?? await getDiffFileList(db, review);
    if (createChangedFilePredicate(diffFiles)(file)) {
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

    const contextFileRepo = new ContextFileRepository(db);

    if (onePerFile) {
      // Atomic: two analyses finishing together still create one entry.
      const inserted = await contextFileRepo.addIfFileMissing(review.id, file, desiredStart, desiredEnd, label);
      return inserted
        ? { created: true, expanded: false, contextFileId: inserted.id }
        : { created: false, expanded: false };
    }

    // 4. Look up existing context file entries for this file
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
      review.id, file, desiredStart, desiredEnd, label
    );
    return { created: true, expanded: false, contextFileId: inserted.id };
  } catch (err) {
    logger.warn(`[AutoContext] Failed to ensure context file: ${err.message}`);
    return { created: false, expanded: false };
  }
}

/**
 * Ensure a context file entry exists for a comment outside the diff.
 * @see ensureContextFile
 */
function ensureContextFileForComment(db, review, { file, line_start, line_end }) {
  return ensureContextFile(db, review, { file, line_start, line_end });
}

/**
 * Pick the finding each unchanged file's panel is centered on: the earliest
 * line-level finding, or a file-level one when the file has no line findings.
 * @param {Array<Object>} suggestions
 * @returns {Map<string, Object>} file -> finding
 */
function firstFindingPerFile(suggestions) {
  const first = new Map();
  for (const suggestion of suggestions) {
    const current = first.get(suggestion.file);
    const line = suggestion.line_start ?? null;
    if (!current) {
      first.set(suggestion.file, suggestion);
    } else if (line != null && (current.line_start == null || line < current.line_start)) {
      first.set(suggestion.file, suggestion);
    }
  }
  return first;
}

/**
 * Create one context-file panel per unchanged file that a set of displayed
 * findings targets, centered on the first finding in that file.
 *
 * A file that already has any context entry is left alone: later findings
 * are revealed inside the existing panel by the browser, never by adding
 * more context files. Dismissed findings never create a panel.
 *
 * @param {object} db - SQLite database handle
 * @param {number} reviewId - Review ID
 * @param {Array<Object>} suggestions - Findings with file / line_start / line_end / status
 * @param {object} [options]
 * @param {Array<object|string>} [options.diffFiles] - The review's changed files
 *   (looked up when omitted). With an empty list membership is unknown and
 *   nothing is created.
 * @param {string} [options.sourceClientId] - Browser tab that triggered this
 * @returns {Promise<number>} Number of context files created
 */
async function seedContextFilesForSuggestions(db, reviewId, suggestions, { diffFiles, sourceClientId } = {}) {
  try {
    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
    if (!review) return 0;
    const files = diffFiles ?? await getDiffFileList(db, review);
    const isChanged = createChangedFilePredicate(files);
    if (!isChanged.hasChangedFiles) return 0;

    const offDiff = (suggestions || []).filter(s =>
      s?.file && s.status !== 'dismissed' && !isChanged(s.file)
    );
    let created = 0;
    for (const [file, finding] of firstFindingPerFile(offDiff)) {
      const result = await ensureContextFile(db, review, {
        file,
        line_start: finding.line_start ?? null,
        line_end: finding.line_end ?? null,
        label: SUGGESTION_CONTEXT_LABEL,
        diffFiles: files,
        onePerFile: true
      });
      if (result.created) created++;
    }

    if (created > 0) {
      logger.info(`[AutoContext] Added ${created} context file(s) for findings in unchanged files`);
      broadcastReviewEvent(reviewId, { type: 'review:context_files_changed' }, { sourceClientId });
    }
    return created;
  } catch (err) {
    logger.warn(`[AutoContext] Failed to add context files for findings: ${err.message}`);
    return 0;
  }
}

module.exports = {
  ensureContextFile,
  ensureContextFileForComment,
  seedContextFilesForSuggestions,
  SUGGESTION_CONTEXT_LABEL
};
