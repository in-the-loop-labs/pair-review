// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * File List Merger - Merges diff files with context files for sidebar display.
 *
 * This module provides the core logic for rebuilding the sidebar file list
 * when context files are added to a review. It merges stored diff files with
 * context files, deduplicates by path, and sorts alphabetically.
 *
 * Used by both PR mode (pr.js) and Local mode (local.js).
 */

/**
 * Merge diff files with context files into a single sorted array.
 *
 * Rules:
 * - Diff files take precedence: context files whose path matches a diff file
 *   are excluded (the diff version is kept).
 * - Context files are deduplicated by path, keeping the first occurrence.
 * - The result is sorted alphabetically by file path.
 *
 * @param {Array<{file: string}>} diffFiles - Files from the PR diff
 * @param {Array<{file: string, id: number, label: string, line_start: number, line_end: number}>} contextFiles - Additional context files
 * @returns {Array<{file: string}>} Merged and sorted file list
 */
function mergeFileListWithContext(diffFiles, contextFiles) {
  const merged = [...(diffFiles || [])];

  // Build set of diff file paths so context files don't duplicate them
  const diffPaths = new Set((diffFiles || []).map(f => f.file));

  // Deduplicate context files by path and skip any that overlap with diff files
  const seenContextPaths = new Set();
  for (const cf of (contextFiles || [])) {
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

  // Sort by file path (context files interleave naturally)
  merged.sort((a, b) => a.file.localeCompare(b.file));

  return merged;
}

// Export for browser usage (attach to window)
if (typeof window !== 'undefined') {
  window.FileListMerger = {
    mergeFileListWithContext
  };
}

// Export for Node.js/test usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeFileListWithContext
  };
}
