// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * File ordering utilities for consistent file display across components.
 *
 * This module provides functions to sort files to match the file navigator's
 * directory-grouped ordering, ensuring consistency across all panels.
 */

/**
 * Extract the directory path from a file path.
 * @param {string} filePath - Full file path
 * @returns {string} Directory path (or '.' for root-level files)
 */
function getDirectoryPath(filePath) {
  const lastSlashIndex = filePath.lastIndexOf('/');
  return lastSlashIndex === -1 ? '.' : filePath.substring(0, lastSlashIndex);
}

/**
 * Extract the file name from a file path.
 * @param {string} filePath - Full file path
 * @returns {string} File name
 */
function getFileName(filePath) {
  const lastSlashIndex = filePath.lastIndexOf('/');
  return lastSlashIndex === -1 ? filePath : filePath.substring(lastSlashIndex + 1);
}

/**
 * Sort files to match the file navigator's directory-grouped ordering.
 *
 * The file navigator uses groupFilesByDirectory which:
 * 1. Groups files by their directory path
 * 2. Sorts directory keys alphabetically
 * 3. Within each directory group, files are sorted alphabetically by filename
 *
 * To match this behavior, we sort by:
 * 1. Directory path (alphabetically)
 * 2. Then by filename (alphabetically, with numeric sorting for numbered files)
 *
 * @param {Array} files - Array of file objects with a `file` property containing the path
 * @returns {Array} New array sorted to match file navigator order
 */
function sortFilesByPath(files) {
  if (!Array.isArray(files)) return [];

  return [...files].sort((a, b) => {
    const pathA = a.file || '';
    const pathB = b.file || '';

    // First, compare by directory path
    const dirA = getDirectoryPath(pathA);
    const dirB = getDirectoryPath(pathB);
    const dirCompare = dirA.localeCompare(dirB, undefined, { numeric: true });
    if (dirCompare !== 0) return dirCompare;

    // Within same directory, sort by filename (with numeric sorting for files like file2.js, file10.js)
    const nameA = getFileName(pathA);
    const nameB = getFileName(pathB);
    return nameA.localeCompare(nameB, undefined, { numeric: true });
  });
}

/**
 * Create a file order index map for quick lookup.
 * Used by AIPanel to sort items by canonical file order.
 *
 * @param {Array<{file: string}|string>} files - Array of file objects with a `file` property, or plain string paths (already sorted)
 * @returns {Map<string, number>} Map of file path to index
 */
function createFileOrderMap(files) {
  const orderMap = new Map();
  if (!Array.isArray(files)) return orderMap;

  files.forEach((file, index) => {
    const path = file.file || file;
    orderMap.set(path, index);
  });

  return orderMap;
}

// Export to window for use in other modules
window.FileOrderUtils = {
  sortFilesByPath,
  createFileOrderMap
};
