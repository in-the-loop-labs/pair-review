// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Diff annotation utility for adding explicit line numbers to unified diffs
 * Provides two-column format showing both OLD (base) and NEW (head) line numbers
 */

const { parseDiffGitPaths, parseDiffSidePath, unquoteGitPath } = require('./diff-paths');

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
 * Paths come from `src/utils/diff-paths.js` so that this parser and
 * `parseUnifiedDiffPatches` in `src/utils/diff-file-list.js` agree byte for
 * byte — see that module's header for why a one-byte disagreement rejects a
 * whole review submission.
 *
 * `diff --git` wins over `---`/`+++`: it names BOTH sides in one place, so a
 * secondary header can only ever confirm it. The secondary headers still fill
 * in when there is no `diff --git` at all (bare `diff -u` output, patch
 * fragments), which is the only case they are the sole source of truth.
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
      currentFile.pathsFromDiffGit = true;
    }
    return true;
  }

  // Handle --- header
  if (line.startsWith('---')) {
    if (!currentFile.pathsFromDiffGit) {
      const oldPath = parseDiffSidePath(line, 'a');
      if (oldPath) currentFile.oldPath = oldPath;
    }
    return true;
  }

  // Handle +++ header
  if (line.startsWith('+++')) {
    if (!currentFile.pathsFromDiffGit) {
      const newPath = parseDiffSidePath(line, 'b');
      if (newPath) currentFile.newPath = newPath;
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

  // Handle rename from/to. These names obey the same C-quoting rules as the
  // header line, so they go through the same decoder — `annotateDiff` prints
  // them verbatim in its `=== old -> new ===` banner.
  if (line.startsWith('rename from')) {
    const match = line.match(/^rename from (.+)$/);
    if (match) {
      currentFile.renamedFrom = unquoteGitPath(match[1]);
    }
    return true;
  }

  if (line.startsWith('rename to')) {
    const match = line.match(/^rename to (.+)$/);
    if (match) {
      currentFile.renamedTo = unquoteGitPath(match[1]);
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
 * Detect the start of a file section in a diff that carries NO `diff --git`
 * line — bare `diff -u` output, a concatenation of patch fragments.
 *
 * Such a diff separates files with nothing but the `---` / `+++` / `@@` triple,
 * which can arrive while the previous file's hunk is still open. That is the
 * one case where a header legitimately appears mid-hunk, so it is the one case
 * the `!inHunk` guard in both loops must not swallow.
 *
 * All THREE lines are required. The `---` / `+++` pair alone is forgeable from
 * hunk content: a deleted `-- x` renders as `--- x` and an added `++ y` as
 * `+++ y`, and those can sit next to each other. A bare
 * `@@ -n,n +n,n @@` at column 0 cannot be forged — every hunk body line carries
 * its own `+`, `-` or space marker, so content can never reach column 0 as
 * `@@`. (A deleted header line `--- a/x` renders as `---- a/x`, four dashes,
 * which already fails the `--- ` + whitespace test.)
 *
 * Callers must additionally refuse to apply this MID-hunk until the current
 * hunk's declared line counts are exhausted. With `--unified=0` a hunk can end
 * on a deleted line followed by an added line followed immediately by the next
 * `@@`, which is the one shape that satisfies all three tests above from pure
 * content. An unexhausted hunk proves the `---` is content.
 *
 * @param {string[]} lines - All diff lines
 * @param {number} i - Index of the candidate `---` line
 * @returns {boolean} Whether a new file section starts at `i`
 */
function isBareFileSectionStart(lines, i) {
  return /^---\s/.test(lines[i] || '')
    && /^\+\+\+\s/.test(lines[i + 1] || '')
    && parseHunkHeader(lines[i + 2] || '') !== null;
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
  // Set by every construct that opens a file section. Lets the bare-diff
  // detection below fire for the FIRST file of a `diff --git`-less diff
  // without re-firing on the `---`/`+++` pair that follows a real
  // `diff --git` header (which has already opened the section).
  let sectionStarted = false;
  // How many lines the open hunk still owes on each side. Only consulted to
  // prove a mid-hunk `---` is CONTENT, never to end a hunk — a diff whose
  // counts disagree with its body must still annotate every line it carries.
  let oldRemaining = 0;
  let newRemaining = 0;

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
      sectionStarted = true;
      fileStarted = true;
      fileHeaderOutput = false;
      parseFileHeader(line, currentFile);
      continue;
    }

    // A bare unified diff has no `diff --git`; its files are separated by the
    // `---`/`+++`/`@@` triple alone, which can land mid-hunk — but only once
    // the open hunk has delivered every line it declared.
    const hunkExhausted = oldRemaining <= 0 && newRemaining <= 0;
    if ((!sectionStarted || (inHunk && hunkExhausted)) && isBareFileSectionStart(lines, i)) {
      if (!isFirstFile && output.length > 0) {
        output.push('');
      }
      isFirstFile = false;
      currentFile = {};
      inHunk = false;
      sectionStarted = true;
      fileStarted = true;
      fileHeaderOutput = false;
      // Falls through to the header parsing below, which now runs with
      // inHunk === false and reads this `---` line as the header it is.
    }

    // Parse file header lines. Guarded on `!inHunk`: inside a hunk body these
    // prefixes are content, and letting `parseFileHeader` claim them both
    // corrupts the file path (an added `++ x` line arrives as `+++ x`) and
    // skips the counter-advancing branches below, shifting every later anchor
    // in the file.
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
      oldRemaining = hunkInfo.oldCount;
      newRemaining = hunkInfo.newCount;
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
      newRemaining--;
    } else if (line.startsWith('-')) {
      // Deletion: only old line number
      const marker = getLineMarker(line);
      const content = getLineContent(line);
      output.push(`${formatLineNum(oldLineNum, lineNumWidth)} | ${formatLineNum(null, lineNumWidth)} | ${marker} ${content}`);
      oldLineNum++;
      oldRemaining--;
    } else if (line.startsWith(' ') || line === '') {
      // Context line: both line numbers
      // Note: The `line === ''` check handles edge cases in malformed diffs or
      // diffs where a blank line in the original file appears without a leading space
      const marker = getLineMarker(line);
      const content = line === '' ? '' : getLineContent(line);
      output.push(`${formatLineNum(oldLineNum, lineNumWidth)} | ${formatLineNum(newLineNum, lineNumWidth)} | ${marker} ${content}`);
      oldLineNum++;
      newLineNum++;
      oldRemaining--;
      newRemaining--;
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
 * `hasFile` answers the coarser question its callers also need: does the diff
 * touch this path AT ALL. A file-level comment on a path outside the diff is
 * not a degraded anchor, it is a comment GitHub will refuse — see
 * `filesNotInDiff` in src/providers/review-submit.js. Both answers are `false`
 * for an empty diff, which callers must read as "unknown", not "no".
 *
 * The two answers are deliberately populated from DIFFERENT places. A file
 * header can close with no hunk body whatsoever — a 100%-similarity rename, a
 * `Binary files ... differ` entry, a mode-only change, an empty new file — and
 * every one of those IS a path the diff touches, so `hasFile` is keyed off the
 * header while `isLineInDiff` stays keyed off hunk bodies. Reading the path
 * out of the hunk loop instead would make `hasFile` an alias for "has at least
 * one hunk line", and local mode's `refuseCommentsOutsideDiff` would then
 * reject the WHOLE submission — including its unrelated valid comments — over
 * a file-level comment on a renamed file that is plainly in the pull request.
 * Rename detection is on (`GIT_DIFF_FLAGS` carries no `--no-renames`), so the
 * hunkless-rename shape is routine, not exotic.
 *
 * Two rules keep the answers honest, and both exist because breaking them
 * produced a wrong answer that looked plausible:
 *
 * 1. File headers are only headers OUTSIDE a hunk body. `parseFileHeader`
 *    returns `true` for anything starting with `---`, `+++`, `index ` or
 *    `diff --git`, and inside a hunk those are content: a deleted `-- x` line
 *    is emitted as `--- x`, an added `++ x` as `+++ x`, and an unindented
 *    `++i;` as `+++i;`. Letting the header parser claim them overwrote the
 *    section's path with a fragment of source code (so `hasFile` said "no" to
 *    a file that changed and "yes" to a path that never existed) AND skipped
 *    the counter-advancing branch, shifting every later RIGHT anchor in the
 *    file by one. The `!inHunk` guard is what makes those lines fall through
 *    to the ordinary `+`/`-` accounting where they belong.
 *
 * 2. Paths are decoded through `src/utils/diff-paths.js`, never taken raw off
 *    the header line. Git writes `--- a/my file.txt\t` for a name with a
 *    space and `"a/caf\303\251.txt"` for a name with non-ASCII bytes; a raw
 *    read keeps the TAB or the quotes, `hasFile` then disagrees with the
 *    UI's parser, and local mode's `refuseCommentsOutsideDiff` rejects the
 *    ENTIRE review over a file the user is looking at.
 *
 * @param {string} rawDiff - Raw unified diff from git
 * @returns {{ isLineInDiff: (file: string, line: number, side?: string) => boolean,
 *   hasFile: (file: string) => boolean }}
 */
function buildDiffLineSet(rawDiff) {
  if (!rawDiff || rawDiff.trim() === '') {
    return { isLineInDiff: () => false, hasFile: () => false };
  }

  const entries = new Set();
  const files = new Set();
  const diffLines = rawDiff.split('\n');
  // Trim trailing empty element produced by split('\n') on newline-terminated input.
  // Without this, the empty string matches the context-line branch and adds phantom
  // entries for lines beyond the actual hunk boundary.
  if (diffLines[diffLines.length - 1] === '') diffLines.pop();
  let currentFile = {};
  let oldLineNum = 0;
  let newLineNum = 0;
  let inHunk = false;

  // Record the path of the section that is ENDING. Called at each section
  // boundary rather than per header line so the `---`/`+++` refinements have
  // already landed on `currentFile`, and rebuilt from the same
  // `newPath || oldPath` expression the hunk loop uses so a rename, a deletion
  // and a plain edit all register the one path comments are anchored to.
  // Idempotent: `files` is a Set, and the final section is closed once after
  // the loop because no `diff --git` follows it.
  const closeSection = () => {
    const closingPath = currentFile.newPath || currentFile.oldPath;
    if (closingPath) files.add(closingPath);
  };

  // See `isBareFileSectionStart`: tracks whether a file section is already open
  // so the bare-diff detection cannot re-fire on a real header's `---` line.
  let sectionStarted = false;
  // Lines the open hunk still owes on each side. Only consulted to prove a
  // mid-hunk `---` is CONTENT — never to end a hunk, because a diff whose
  // declared counts disagree with its body must still register every line.
  let oldRemaining = 0;
  let newRemaining = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];

    if (line.startsWith('diff --git')) {
      closeSection();
      currentFile = {};
      inHunk = false;
      sectionStarted = true;
      parseFileHeader(line, currentFile);
      continue;
    }

    // A bare unified diff (no `diff --git`) separates files with the
    // `---`/`+++`/`@@` triple alone, which can arrive while the previous
    // file's hunk is still open. This is the ONLY legitimate mid-hunk header,
    // and only once that hunk has delivered every line it declared.
    const hunkExhausted = oldRemaining <= 0 && newRemaining <= 0;
    if ((!sectionStarted || (inHunk && hunkExhausted)) && isBareFileSectionStart(diffLines, i)) {
      closeSection();
      currentFile = {};
      inHunk = false;
      sectionStarted = true;
      // Falls through: with inHunk cleared, the guard below now reads this
      // `---` line as the file header it is.
    }

    // Header lines are headers only outside a hunk body — see rule (1) in the
    // docblock. Inside one they fall through to the +/- accounting below.
    if (!inHunk && parseFileHeader(line, currentFile)) {
      continue;
    }

    const hunkInfo = parseHunkHeader(line);
    if (hunkInfo) {
      oldLineNum = hunkInfo.oldStart;
      newLineNum = hunkInfo.newStart;
      oldRemaining = hunkInfo.oldCount;
      newRemaining = hunkInfo.newCount;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('\\ No newline')) continue;

    // A pathless section still has to CONSUME its body: the counters and line
    // numbers advance either way, only the lookup entries are withheld. One
    // dispatch on the line marker, so the two cannot drift apart.
    const filePath = currentFile.newPath || currentFile.oldPath;

    if (line.startsWith('+')) {
      if (filePath) entries.add(`${filePath}:RIGHT:${newLineNum}`);
      newLineNum++;
      newRemaining--;
    } else if (line.startsWith('-')) {
      if (filePath) entries.add(`${filePath}:LEFT:${oldLineNum}`);
      oldLineNum++;
      oldRemaining--;
    } else if (line.startsWith(' ') || line === '') {
      if (filePath) {
        entries.add(`${filePath}:LEFT:${oldLineNum}`);
        entries.add(`${filePath}:RIGHT:${newLineNum}`);
      }
      oldLineNum++;
      newLineNum++;
      oldRemaining--;
      newRemaining--;
    }
  }

  // The last section has no `diff --git` after it to close it.
  closeSection();

  return {
    isLineInDiff(file, lineNum, side = 'RIGHT') {
      return entries.has(`${file}:${side}:${lineNum}`);
    },
    hasFile(file) {
      return files.has(file);
    }
  };
}

module.exports = {
  annotateDiff,
  parseAnnotatedDiff,
  parseHunkHeader,
  formatLineNum,
  getLineMarker,
  getLineContent,
  buildDiffLineSet
};
