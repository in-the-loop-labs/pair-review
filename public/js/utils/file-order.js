// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * File ordering utilities for consistent file display across components.
 *
 * This module provides functions to build the file navigator's directory tree
 * and to sort files in the same order, ensuring consistency across all panels.
 */

/**
 * Compare two file paths in file-navigator tree order.
 *
 * Paths are compared directory segment by directory segment. Within any
 * directory, its own files come before its subdirectories; siblings are
 * sorted alphabetically (numeric-aware, so file2 < file10).
 *
 * @param {string} pathA
 * @param {string} pathB
 * @returns {number} Negative, zero or positive, like Array#sort comparators
 */
function compareFilePaths(pathA, pathB) {
  const dirsA = pathA.split('/');
  const dirsB = pathB.split('/');
  const nameA = dirsA.pop();
  const nameB = dirsB.pop();

  const shared = Math.min(dirsA.length, dirsB.length);
  for (let i = 0; i < shared; i++) {
    const cmp = dirsA[i].localeCompare(dirsB[i], undefined, { numeric: true });
    if (cmp !== 0) return cmp;
  }

  // One directory contains the other: the file directly in the shallower
  // directory comes first (files before subdirectories).
  if (dirsA.length !== dirsB.length) return dirsA.length - dirsB.length;

  return nameA.localeCompare(nameB, undefined, { numeric: true });
}

/**
 * Sort files to match the file navigator's tree ordering.
 *
 * The file navigator renders a nested directory tree (see buildDirectoryTree)
 * in which each directory lists its files first, then its subdirectories,
 * each alphabetically. Sorting with the same rules keeps every panel in the
 * same order as the navigator.
 *
 * @param {Array} files - Array of file objects with a `file` property containing the path
 * @returns {Array} New array sorted to match file navigator order
 */
function sortFilesByPath(files) {
  if (!Array.isArray(files)) return [];

  return [...files].sort((a, b) => compareFilePaths(a.file || '', b.file || ''));
}

/**
 * Build a nested directory tree for the file navigator, collapsing
 * single-child directory chains into one node (like GitHub's sidebar).
 *
 * For `root/foo/bar/xyz/example.rb`, `root/foo/bar/index.md` and
 * `root/foo/README.md` this produces:
 *
 *   root/foo
 *     README.md
 *     bar
 *       index.md
 *       xyz
 *         example.rb
 *
 * A directory is merged into its parent when the parent has no files of its
 * own and exactly one subdirectory. Root-level files stay on the root node.
 *
 * @param {Array<T>} items - Items to place in the tree
 * @param {function(T): string} [getPath] - Returns an item's path (defaults to `item.file`)
 * @returns {{name: string, path: string, files: Array<T>, dirs: Array}} Root node;
 *   `name` is the label to display (may contain slashes after collapsing),
 *   `path` is the full directory path ('' for the root). Files and dirs are sorted.
 * @template T
 */
function buildDirectoryTree(items, getPath = item => item.file) {
  const makeNode = (name, path) => ({ name, path, files: [], dirs: [], _children: new Map() });
  const root = makeNode('', '');

  (Array.isArray(items) ? items : []).forEach(item => {
    const segments = (getPath(item) || '').split('/');
    segments.pop();
    let node = root;
    segments.forEach(segment => {
      if (!node._children.has(segment)) {
        const childPath = node.path ? `${node.path}/${segment}` : segment;
        node._children.set(segment, makeNode(segment, childPath));
      }
      node = node._children.get(segment);
    });
    node.files.push(item);
  });

  const fileName = item => (getPath(item) || '').split('/').pop();
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

  const finalize = (node, isRoot) => {
    let current = node;
    // Collapse chains of directories that only contain one subdirectory
    while (!isRoot && current.files.length === 0 && current._children.size === 1) {
      const [only] = current._children.values();
      only.name = `${current.name}/${only.name}`;
      current = only;
    }
    // Sort before collapsing: each child's name is still a single path segment
    // here, matching how compareFilePaths orders directories. Sorting collapsed
    // labels like "foo/bar" would put "foo-x" first, since '-' sorts before '/'.
    // Collapsing never reorders siblings: a collapsed node keeps its first segment.
    current.dirs = [...current._children.values()]
      .sort((a, b) => byName(a.name, b.name))
      .map(child => finalize(child, false));
    current.files.sort((a, b) => byName(fileName(a), fileName(b)));
    delete current._children;
    return current;
  };

  return finalize(root, true);
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
  compareFilePaths,
  sortFilesByPath,
  buildDirectoryTree,
  createFileOrderMap
};
