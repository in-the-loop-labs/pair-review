// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * HunkParser - Parsing of unified diff patches into hunks.
 * Used for hunk-summary anchors (PRManager), the diff position of a comment
 * line (CommentManager) and per-file line stats (LocalManager). The diff
 * itself is drawn by the viewer (PierreBridge), which parses on its own.
 */

class HunkParser {
  /**
   * Parse a unified diff patch string into structured blocks (hunks).
   * Each block contains the hunk header info and its content lines.
   * Strips trailing empty-string artifacts from split('\n') on newline-terminated input,
   * which would otherwise be misclassified as context lines and corrupt coordinate calculations.
   * @param {string} patch - Unified diff patch string (may include diff --git headers)
   * @returns {Array<{header: string, oldStart: number, newStart: number, lines: string[]}>}
   */
  static parseDiffIntoBlocks(patch) {
    const lines = patch.split('\n');
    const blocks = [];
    let currentBlock = null;

    lines.forEach(line => {
      if (line.startsWith('@@')) {
        if (currentBlock) {
          HunkParser._stripTrailingEmpty(currentBlock);
          blocks.push(currentBlock);
        }
        currentBlock = null;

        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          currentBlock = {
            header: line,
            oldStart: parseInt(match[1]),
            newStart: parseInt(match[2]),
            lines: []
          };
        }
      } else if (currentBlock) {
        currentBlock.lines.push(line);
      }
    });

    if (currentBlock) {
      HunkParser._stripTrailingEmpty(currentBlock);
      blocks.push(currentBlock);
    }

    return blocks;
  }

  /**
   * Count added and deleted lines in a per-file patch.
   *
   * Counts only lines inside a hunk (a block from parseDiffIntoBlocks, within
   * the line counts its `@@` header declares), so a prefix never decides
   * header-vs-content: inside a hunk a deleted `-- x` line is `--- x` and an
   * added `++ x` line is `+++ x`, and both count. Mirrors the server's
   * `countPatchStats` (src/utils/diff-file-list.js); both suites share
   * tests/utils/diff-stat-fixtures.js.
   * @param {string} patch - Per-file patch text
   * @returns {{additions: number, deletions: number}}
   */
  static countPatchStats(patch) {
    let additions = 0;
    let deletions = 0;
    for (const block of HunkParser.parseDiffIntoBlocks(patch || '')) {
      const counts = block.header.match(/@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/) || [];
      let oldRemaining = counts[1] === undefined ? 1 : parseInt(counts[1], 10);
      let newRemaining = counts[2] === undefined ? 1 : parseInt(counts[2], 10);
      for (const line of block.lines) {
        if (line.startsWith('+') && newRemaining > 0) {
          additions++;
          newRemaining--;
        } else if (line.startsWith('-') && oldRemaining > 0) {
          deletions++;
          oldRemaining--;
        } else if (line.startsWith(' ')) {
          oldRemaining--;
          newRemaining--;
        }
      }
    }
    return { additions, deletions };
  }

  /**
   * Remove trailing empty string artifact from a block's lines array.
   * split('\n') on newline-terminated input produces a trailing '' that has no
   * diff prefix (+/-/space) and would be misclassified as a context line.
   * @param {Object} block - Block with lines array to clean up
   */
  static _stripTrailingEmpty(block) {
    if (block.lines.length > 0 && block.lines[block.lines.length - 1] === '') {
      block.lines.pop();
    }
  }
}

// Make HunkParser available globally in browser
if (typeof window !== 'undefined') {
  window.HunkParser = HunkParser;
}

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HunkParser };
}
