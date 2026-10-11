// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Diff annotation utility for adding explicit line numbers to unified diffs
 * Provides two-column format showing both OLD (base) and NEW (head) line numbers
 */
const { parseDiffGitPaths, decodeDiffLinePath } = require('./git-paths');

const logger = require('./logger');

/**
 * Parse a hunk header to extract line number information
 * Format: @@ -oldStart,oldCount +newStart,newCount @@ [function context]
 * @param {string} header - Hunk header line
 * @returns {Object|null} { oldStart, oldCount, newStart, newCount, context } or null if invalid
 */
function parseHunkHeader(header) {
  // Match: @@ -oldStart,oldCount +newStart,newCount @@ optional context
  // Count can be omitted, defaulting to 1. The `s` (dotAll) flag lets the
  // trailing context span a carriage return: git trims trailing whitespace
  // from the function-context line but keeps a lone `\r` inside it, and
  // without dotAll `.` stops at that `\r`, `$` cannot match, and the whole
  // header is rejected, so its hunk body goes uncounted.
  const match = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/s);

  if (!match) {
    return null;
  }

  const context = match[5].trim();
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    context: context || null  // null for no context, not empty string
  };
}

/**
 * Format a line number or placeholder for display
 * @param {number|null} num - Line number or null for placeholder
 * @param {number} width - Minimum width for padding
 * @returns {string} Formatted number or '--' placeholder
 */
function formatLineNum(num, width = 4) {
  if (num === null) {
    return '--'.padStart(width);
  }
  return String(num).padStart(width);
}

/**
 * Get the line type marker for display
 * @param {string} line - Diff line
 * @returns {string} '[+]', '[-]', or '   ' (3 spaces for context)
 */
function getLineMarker(line) {
  if (line.startsWith('+')) {
    return '[+]';
  }
  if (line.startsWith('-')) {
    return '[-]';
  }
  return '   ';
}

/**
 * Extract the content from a diff line (removing the leading +/- or space)
 * @param {string} line - Diff line
 * @returns {string} Line content without diff marker
 */
function getLineContent(line) {
  // Handle the "No newline at end of file" marker
  if (line.startsWith('\\ No newline')) {
    return line;
  }
  // Remove the leading +, -, or space
  return line.substring(1);
}

/**
 * Parse file header lines to extract old and new file paths
 *
 * CALLER CONTRACT: only call this on lines that are OUTSIDE a hunk body. It
 * returns `true` for anything merely starting with `---`, `+++`, `index ` or
 * `diff --git`, and those prefixes are ordinary CONTENT inside a hunk (a
 * deleted `-- x` is emitted as `--- x`, an added `++ x` as `+++ x`). Both
 * loops in this file enforce that with an `!inHunk` guard.
 *
 * @param {string} line - A diff line that might be a file header
 * @param {Object} currentFile - Current file info to update
 * @returns {boolean} Whether this was a file header line
 */
function parseFileHeader(line, currentFile) {
  // Handle diff --git header
  if (line.startsWith('diff --git')) {
    const paths = parseDiffGitPaths(line);
    if (paths) {
      currentFile.oldPath = paths.oldPath;
      currentFile.newPath = paths.newPath;
    }
    return true;
  }

  // Handle --- header
  if (line.startsWith('---')) {
    const match = line.match(/^---\s+(.+)$/);
    const oldPath = match ? decodeDiffLinePath(match[1], 'a/') : null;
    if (oldPath !== null) {
      currentFile.oldPath = oldPath;
    }
    return true;
  }

  // Handle +++ header
  if (line.startsWith('+++')) {
    const match = line.match(/^\+\+\+\s+(.+)$/);
    const newPath = match ? decodeDiffLinePath(match[1], 'b/') : null;
    if (newPath !== null) {
      currentFile.newPath = newPath;
    }
    return true;
  }

  // Handle index line
  if (line.startsWith('index ')) {
    return true;
  }

  // Handle mode change lines
  if (line.startsWith('old mode') || line.startsWith('new mode')) {
    return true;
  }

  // Handle new file mode
  if (line.startsWith('new file mode')) {
    currentFile.isNew = true;
    return true;
  }

  // Handle deleted file mode
  if (line.startsWith('deleted file mode')) {
    currentFile.isDeleted = true;
    return true;
  }

  // Handle similarity index (renames)
  if (line.startsWith('similarity index')) {
    return true;
  }

  // Handle rename from/to
  if (line.startsWith('rename from')) {
    const match = line.match(/^rename from (.+)$/);
    if (match) {
      currentFile.renamedFrom = decodeDiffLinePath(match[1]);
    }
    return true;
  }

  if (line.startsWith('rename to')) {
    const match = line.match(/^rename to (.+)$/);
    if (match) {
      currentFile.renamedTo = decodeDiffLinePath(match[1]);
    }
    return true;
  }

  // Handle copy from/to
  if (line.startsWith('copy from') || line.startsWith('copy to')) {
    return true;
  }

  // Handle binary file notice
  if (line.startsWith('Binary files') || line.match(/^GIT binary patch/)) {
    currentFile.isBinary = true;
    return true;
  }

  return false;
}

/**
 * Calculate the maximum line number width needed for a hunk
 * @param {Object} hunkInfo - Parsed hunk header info
 * @returns {number} Width needed for line numbers
 */
function calculateLineNumWidth(hunkInfo) {
  const maxOld = hunkInfo.oldStart + hunkInfo.oldCount;
  const maxNew = hunkInfo.newStart + hunkInfo.newCount;
  const maxNum = Math.max(maxOld, maxNew);
  return Math.max(4, String(maxNum).length);
}

/**
 * Annotate a unified diff with explicit line numbers
 * @param {string} rawDiff - Raw unified diff output from git diff
 * @returns {string} Annotated diff with OLD|NEW columns
 */
function annotateDiff(rawDiff) {
  if (!rawDiff || rawDiff.trim() === '') {
    return '';
  }

  const lines = rawDiff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const output = [];

  let currentFile = {};
  let oldLineNum = 0;
  let newLineNum = 0;
  let inHunk = false;
  let lineNumWidth = 4;
  let fileStarted = false;
  let fileHeaderOutput = false;

  let isFirstFile = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for new file header
    if (line.startsWith('diff --git')) {
      // Add blank line before new file (except for the first file)
      if (!isFirstFile && output.length > 0) {
        output.push('');
      }
      isFirstFile = false;
      currentFile = {};
      inHunk = false;
      fileStarted = true;
      fileHeaderOutput = false;
      parseFileHeader(line, currentFile);
      continue;
    }

    // Parse file header lines. Guarded on `!inHunk`: inside a hunk body these
    // prefixes are content, and letting `parseFileHeader` claim them both
    // corrupts the file path (an added `++ x` line arrives as `+++ x`) and
    // skips the counter-advancing branches below, shifting every later anchor
    // in the file. `git diff` opens every file with `diff --git`, which resets
    // `inHunk` above before that file's real headers arrive.
    if (!inHunk && parseFileHeader(line, currentFile)) {
      // Check if we just detected a binary file that needs output
      if (currentFile.isBinary && fileStarted && !fileHeaderOutput) {
        let filePath = currentFile.newPath || currentFile.oldPath || 'unknown';
        // Handle renames for binary files
        if (currentFile.renamedFrom && currentFile.renamedTo) {
          output.push(`=== ${currentFile.renamedFrom} -> ${currentFile.renamedTo} ===`);
        } else {
          output.push(`=== ${filePath} ===`);
        }
        output.push('Binary file (not annotated)');
        fileStarted = false;
        fileHeaderOutput = true;
      }
      continue;
    }

    // Check for hunk header
    const hunkInfo = parseHunkHeader(line);
    if (hunkInfo) {
      // Output file separator if this is the first hunk of a file
      if (fileStarted && !fileHeaderOutput) {
        let filePath = currentFile.newPath || currentFile.oldPath || 'unknown';

        // Handle renames
        if (currentFile.renamedFrom && currentFile.renamedTo) {
          output.push(`=== ${currentFile.renamedFrom} -> ${currentFile.renamedTo} ===`);
        } else {
          output.push(`=== ${filePath} ===`);
        }

        // Check for binary
        if (currentFile.isBinary) {
          output.push('Binary file (not annotated)');
          fileStarted = false;
          fileHeaderOutput = true;
          continue;
        }

        // Output column header
        output.push(' OLD | NEW |');
        fileHeaderOutput = true;
      }

      // Output original hunk header to preserve chunk boundaries
      // Pass through the original git hunk header format unchanged
      output.push(line);

      oldLineNum = hunkInfo.oldStart;
      newLineNum = hunkInfo.newStart;
      lineNumWidth = calculateLineNumWidth(hunkInfo);
      inHunk = true;
      continue;
    }

    // Handle binary file indication (for diffs without hunk headers)
    if (line.startsWith('Binary files') || line.match(/^GIT binary patch/)) {
      currentFile.isBinary = true;
      if (fileStarted && !fileHeaderOutput) {
        let filePath = currentFile.newPath || currentFile.oldPath || 'unknown';
        // Handle renames for binary files
        if (currentFile.renamedFrom && currentFile.renamedTo) {
          output.push(`=== ${currentFile.renamedFrom} -> ${currentFile.renamedTo} ===`);
        } else {
          output.push(`=== ${filePath} ===`);
        }
        output.push('Binary file (not annotated)');
        fileStarted = false;
        fileHeaderOutput = true;
        inHunk = false;
      }
      continue;
    }

    // Skip if not in a hunk
    if (!inHunk) {
      continue;
    }

    // Handle "No newline at end of file" marker
    if (line.startsWith('\\ No newline')) {
      output.push(`${formatLineNum(null, lineNumWidth)} | ${formatLineNum(null, lineNumWidth)} |     ${line}`);
      continue;
    }

    // Process diff content lines
    if (line.startsWith('+')) {
      // Addition: only new line number
      const marker = getLineMarker(line);
      const content = getLineContent(line);
      output.push(`${formatLineNum(null, lineNumWidth)} | ${formatLineNum(newLineNum, lineNumWidth)} | ${marker} ${content}`);
      newLineNum++;
    } else if (line.startsWith('-')) {
      // Deletion: only old line number
      const marker = getLineMarker(line);
      const content = getLineContent(line);
      output.push(`${formatLineNum(oldLineNum, lineNumWidth)} | ${formatLineNum(null, lineNumWidth)} | ${marker} ${content}`);
      oldLineNum++;
    } else if (line.startsWith(' ') || line === '') {
      // Context line: both line numbers
      // Note: The `line === ''` check handles edge cases in malformed diffs or
      // diffs where a blank line in the original file appears without a leading space
      const marker = getLineMarker(line);
      const content = line === '' ? '' : getLineContent(line);
      output.push(`${formatLineNum(oldLineNum, lineNumWidth)} | ${formatLineNum(newLineNum, lineNumWidth)} | ${marker} ${content}`);
      oldLineNum++;
      newLineNum++;
    }
  }

  return output.join('\n');
}

/**
 * Parse annotated diff back into structured format
 * Useful for testing or further processing
 * @param {string} annotatedDiff - Annotated diff output
 * @returns {Array} Array of file objects with lines
 */
function parseAnnotatedDiff(annotatedDiff) {
  const files = [];
  let currentFile = null;

  const lines = annotatedDiff.split('\n');

  for (const line of lines) {
    // Check for file separator
    const fileMatch = line.match(/^=== (.+) ===$/);
    if (fileMatch) {
      currentFile = {
        path: fileMatch[1],
        lines: []
      };
      files.push(currentFile);
      continue;
    }

    // Skip header line
    if (line.trim() === 'OLD | NEW |') {
      continue;
    }

    // Skip binary notice
    if (line === 'Binary file (not annotated)') {
      if (currentFile) {
        currentFile.isBinary = true;
      }
      continue;
    }

    // Parse hunk header (original git format: @@ -old,count +new,count @@ context)
    const hunkInfo = parseHunkHeader(line);
    if (hunkInfo && currentFile) {
      currentFile.lines.push({
        type: 'hunk',
        oldStart: hunkInfo.oldStart,
        oldCount: hunkInfo.oldCount,
        newStart: hunkInfo.newStart,
        newCount: hunkInfo.newCount,
        context: hunkInfo.context  // already null when no context (normalized in parseHunkHeader)
      });
      continue;
    }

    // Parse content line
    if (currentFile) {
      const contentMatch = line.match(/^\s*(\d+|--)\s*\|\s*(\d+|--)\s*\|\s*(\[\+\]|\[-\]|   )\s?(.*)$/);
      if (contentMatch) {
        const oldNum = contentMatch[1] === '--' ? null : parseInt(contentMatch[1], 10);
        const newNum = contentMatch[2] === '--' ? null : parseInt(contentMatch[2], 10);
        const marker = contentMatch[3].trim();
        const content = contentMatch[4];

        currentFile.lines.push({
          oldLineNum: oldNum,
          newLineNum: newNum,
          type: marker === '[+]' ? 'add' : marker === '[-]' ? 'delete' : 'context',
          content
        });
      }
    }
  }

  return files;
}

/**
 * Build a lookup of which file+side+line combinations appear in diff hunks.
 * Used to determine whether a comment targets a line GitHub can render inline
 * (inside a hunk) vs. one that must be submitted as file-level.
 *
 * File headers are only headers OUTSIDE a hunk body. `parseFileHeader`
 * returns `true` for anything starting with `---`, `+++`, `index ` or
 * `diff --git`, and inside a hunk those are content: a deleted `-- x` line is
 * emitted as `--- x`, an added `++ x` as `+++ x`, and an unindented `++i;` as
 * `+++i;`. Letting the header parser claim them overwrote the section's path
 * with a fragment of source code AND skipped the counter-advancing branch,
 * shifting every later RIGHT anchor in the file by one. The `!inHunk` guard is
 * what makes those lines fall through to the ordinary `+`/`-` accounting where
 * they belong.
 *
 * Each line also records the hunk it belongs to, so a caller can tell
 * whether two lines share a hunk: GitHub only accepts a multi-line comment
 * whose two ends are in the same hunk.
 *
 * @param {string} rawDiff - Raw unified diff from git
 * @returns {{
 *   isLineInDiff: (file: string, line: number, side?: string) => boolean,
 *   hunkOf: (file: string, line: number, side?: string) => number|null
 * }} `hunkOf` returns an index that is unique per hunk across the whole
 *   diff, or null for a line outside every hunk.
 */
function buildDiffLineSet(rawDiff) {
  if (!rawDiff || rawDiff.trim() === '') {
    return { isLineInDiff: () => false, hunkOf: () => null };
  }

  // `${file}:${side}:${line}` -> index of the hunk that contains the line
  const entries = new Map();
  let hunkIndex = -1;
  const diffLines = rawDiff.split('\n');
  // Trim trailing empty element produced by split('\n') on newline-terminated input.
  // Without this, the empty string matches the context-line branch and adds phantom
  // entries for lines beyond the actual hunk boundary.
  if (diffLines[diffLines.length - 1] === '') diffLines.pop();
  let currentFile = {};
  let oldLineNum = 0;
  let newLineNum = 0;
  let inHunk = false;

  for (const line of diffLines) {
    if (line.startsWith('diff --git')) {
      currentFile = {};
      inHunk = false;
      parseFileHeader(line, currentFile);
      continue;
    }

    // Header lines are headers only outside a hunk body — see the docblock.
    // Inside one they fall through to the +/- accounting below.
    if (!inHunk && parseFileHeader(line, currentFile)) {
      continue;
    }

    const hunkInfo = parseHunkHeader(line);
    if (hunkInfo) {
      oldLineNum = hunkInfo.oldStart;
      newLineNum = hunkInfo.newStart;
      inHunk = true;
      hunkIndex++;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('\\ No newline')) continue;

    const filePath = currentFile.newPath || currentFile.oldPath;
    if (!filePath) continue;

    if (line.startsWith('+')) {
      entries.set(`${filePath}:RIGHT:${newLineNum}`, hunkIndex);
      newLineNum++;
    } else if (line.startsWith('-')) {
      entries.set(`${filePath}:LEFT:${oldLineNum}`, hunkIndex);
      oldLineNum++;
    } else if (line.startsWith(' ') || line === '') {
      entries.set(`${filePath}:LEFT:${oldLineNum}`, hunkIndex);
      entries.set(`${filePath}:RIGHT:${newLineNum}`, hunkIndex);
      oldLineNum++;
      newLineNum++;
    }
  }

  return {
    isLineInDiff(file, lineNum, side = 'RIGHT') {
      return entries.has(`${file}:${side}:${lineNum}`);
    },
    hunkOf(file, lineNum, side = 'RIGHT') {
      const hunk = entries.get(`${file}:${side}:${lineNum}`);
      return hunk === undefined ? null : hunk;
    }
  };
}

/**
 * Map stored comment rows to the GitHub review comments that a review
 * submission sends. The one mapping for both submit paths: the web submit
 * route (src/routes/pr.js) and headless --ai-draft / --ai-review
 * (src/main.js). Both GitHub transports (GraphQL and the host REST
 * extension) accept the result.
 *
 * - `is_file_level = 1` rows become file-level comments.
 * - A range written backwards (`line_end < line_start`) is the same span,
 *   so its ends are put in ascending order first.
 * - A range becomes a multi-line comment (`start_line`, `start_side`, `line`)
 *   only when both ends are inside the diff, on the comment side, in the
 *   SAME hunk. GitHub rejects a range that crosses hunks, and one rejected
 *   comment discards the whole pending review.
 * - Otherwise, a single line or a range whose `line_start` is inside a hunk
 *   becomes a single-line comment on `line_start` (the line the finding is
 *   anchored on).
 * - Anything else (e.g. expanded context) cannot be inline, so it becomes a
 *   file-level comment whose body starts with `(Ref Line N)` or
 *   `(Ref Lines N-M)`.
 *
 * @param {Array<Object>|null} rows - Comment rows: file, line_start,
 *   line_end, side, body, is_file_level
 * @param {string} diffContent - Raw unified diff used for the hunk check
 * @param {Object} [options]
 * @param {(row: Object) => string} [options.formatBody] - Comment text for a
 *   row, before any line reference prefix. Defaults to `row.body`.
 * @returns {Array<{path: string, body: string, isFileLevel: boolean,
 *   line?: number, side?: string, start_line?: number, start_side?: string}>}
 */
function buildReviewComments(rows, diffContent, { formatBody = row => row.body } = {}) {
  const diffLineSet = buildDiffLineSet(diffContent);

  return (rows || []).map(comment => {
    const side = comment.side || 'RIGHT';
    const body = formatBody(comment);

    // Explicit file-level comment: about the whole file, not tied to lines
    if (comment.is_file_level === 1) {
      logger.debug(`Formatting file-level comment: ${comment.file}`);
      return {
        path: comment.file,
        body,
        isFileLevel: true
      };
    }

    // A backwards range is the same span; order it so start < end.
    const isRange = comment.line_start != null && Boolean(comment.line_end) && comment.line_end !== comment.line_start;
    const rangeStart = isRange ? Math.min(comment.line_start, comment.line_end) : comment.line_start;
    const rangeEnd = isRange ? Math.max(comment.line_start, comment.line_end) : comment.line_start;

    // Check whether the target lines actually appear in a diff hunk rather
    // than relying on diff_position, which may be absent (e.g. comments
    // created by the chat agent or headless AI findings).
    if (isRange) {
      const startHunk = diffLineSet.hunkOf(comment.file, rangeStart, side);
      const endHunk = diffLineSet.hunkOf(comment.file, rangeEnd, side);
      if (startHunk !== null && startHunk === endHunk) {
        logger.debug(`Formatting range comment: ${comment.file}:${rangeStart}-${rangeEnd} side=${side}`);
        return {
          path: comment.file,
          line: rangeEnd,
          body,
          side,
          isFileLevel: false,
          start_line: rangeStart,
          start_side: side
        };
      }
    }

    // A single line, or a range GitHub cannot render as one thread: anchor
    // on line_start when it is inside a hunk.
    if (diffLineSet.isLineInDiff(comment.file, comment.line_start, side)) {
      if (isRange) {
        logger.debug(`Range ${comment.file}:${rangeStart}-${rangeEnd} side=${side} does not fit one hunk; anchoring on line ${comment.line_start}`);
      } else {
        logger.debug(`Formatting line comment: ${comment.file}:${comment.line_start} side=${side}`);
      }
      return {
        path: comment.file,
        line: comment.line_start,
        body,
        side,
        isFileLevel: false
      };
    }

    const lineRef = isRange
      ? `(Ref Lines ${rangeStart}-${rangeEnd})`
      : `(Ref Line ${comment.line_start})`;
    logger.debug(`Formatting file-level comment (expanded context): ${comment.file} ${lineRef}`);
    return {
      path: comment.file,
      body: `${lineRef} ${body}`,
      isFileLevel: true
    };
  });
}

module.exports = {
  annotateDiff,
  parseAnnotatedDiff,
  parseHunkHeader,
  formatLineNum,
  getLineMarker,
  getLineContent,
  buildDiffLineSet,
  buildReviewComments
};
