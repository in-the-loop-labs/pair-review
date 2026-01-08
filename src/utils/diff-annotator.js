/**
 * Diff annotation utility for adding explicit line numbers to unified diffs
 * Provides two-column format showing both OLD (base) and NEW (head) line numbers
 */

/**
 * Parse a hunk header to extract line number information
 * Format: @@ -oldStart,oldCount +newStart,newCount @@ [function context]
 * @param {string} header - Hunk header line
 * @returns {Object|null} { oldStart, oldCount, newStart, newCount, context } or null if invalid
 */
function parseHunkHeader(header) {
  // Match: @@ -oldStart,oldCount +newStart,newCount @@ optional context
  // Count can be omitted, defaulting to 1
  const match = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);

  if (!match) {
    return null;
  }

  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    context: match[5].trim()
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
 * @param {string} line - A diff line that might be a file header
 * @param {Object} currentFile - Current file info to update
 * @returns {boolean} Whether this was a file header line
 */
function parseFileHeader(line, currentFile) {
  // Handle diff --git header
  if (line.startsWith('diff --git')) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (match) {
      currentFile.oldPath = match[1];
      currentFile.newPath = match[2];
    }
    return true;
  }

  // Handle --- header
  if (line.startsWith('---')) {
    const match = line.match(/^---\s+(?:a\/)?(.+)$/);
    if (match && match[1] !== '/dev/null') {
      currentFile.oldPath = match[1];
    }
    return true;
  }

  // Handle +++ header
  if (line.startsWith('+++')) {
    const match = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (match && match[1] !== '/dev/null') {
      currentFile.newPath = match[1];
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
      currentFile.renamedFrom = match[1];
    }
    return true;
  }

  if (line.startsWith('rename to')) {
    const match = line.match(/^rename to (.+)$/);
    if (match) {
      currentFile.renamedTo = match[1];
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
  const output = [];

  let currentFile = {};
  let oldLineNum = 0;
  let newLineNum = 0;
  let inHunk = false;
  let lineNumWidth = 4;
  let fileStarted = false;
  let fileHeaderOutput = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for new file header
    if (line.startsWith('diff --git')) {
      currentFile = {};
      inHunk = false;
      fileStarted = true;
      fileHeaderOutput = false;
      parseFileHeader(line, currentFile);
      continue;
    }

    // Parse file header lines
    if (parseFileHeader(line, currentFile)) {
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

      // Output hunk header marker to preserve chunk boundaries
      // Format: @@ OLD:start NEW:start @@ [function context]
      // This gives context without the full git syntax, and indicates discontinuity
      let hunkHeaderLine = `@@ OLD:${hunkInfo.oldStart} NEW:${hunkInfo.newStart} @@`;
      if (hunkInfo.context) {
        hunkHeaderLine += ` ${hunkInfo.context}`;
      }
      output.push(hunkHeaderLine);

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

    // Parse hunk header (chunk boundary marker)
    const hunkMatch = line.match(/^@@ OLD:(\d+) NEW:(\d+) @@(.*)$/);
    if (hunkMatch && currentFile) {
      currentFile.lines.push({
        type: 'hunk',
        oldStart: parseInt(hunkMatch[1], 10),
        newStart: parseInt(hunkMatch[2], 10),
        context: hunkMatch[3].trim() || null
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

module.exports = {
  annotateDiff,
  parseAnnotatedDiff,
  parseHunkHeader,
  formatLineNum,
  getLineMarker,
  getLineContent
};
