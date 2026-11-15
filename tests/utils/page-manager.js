// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * A page manager for unit tests of the modules that navigate or resolve
 * elements through it (AIPanel, SuggestionNavigator, TourRenderer, ...).
 *
 * It is a PRManager whose methods are the production ones (revealInDiff,
 * setFileCollapsed, isFileCollapsed, findCommentCard, getFileCommentsZone,
 * ...), created without running the constructor, which wires the whole
 * page. A test gives it the state and the collaborators its scenario needs
 * and stubs only what reaches outside the unit (the lazy body render, the
 * line reveal, the file-element lookup). Nothing of PRManager is
 * re-implemented here.
 */

const { PRManager } = require('../../public/js/pr.js');

/**
 * @param {Object} [overrides] - Own properties: state and stubs
 * @returns {PRManager}
 */
function makePageManager(overrides = {}) {
  const manager = Object.create(PRManager.prototype);
  Object.assign(manager, {
    currentPR: { id: 1 },
    pierreBridge: null,
    fileCommentManager: null,
    commentMinimizer: null,
    suggestionManager: null,
    collapsedFiles: new Set(),
    viewedFiles: new Set(),
    changedFilesByPath: new Map(),
    contextFiles: [],
    userComments: [],
    _lazyFileBodies: null,
    _diffEngine: 'filediff',
    findFileElement: () => null,
  });
  // What is collapsed right now, and the virtualized viewer's page state.
  manager._initPaneState();
  Object.assign(manager, overrides);
  // A test names the files of its diff and which of them the reader
  // collapsed; the collapsed state of each is seeded as a render seeds it.
  for (const path of manager.changedFilesByPath?.keys?.() || []) {
    if (!manager._fileCollapsed.has(path)) {
      manager._fileCollapsed.set(path, manager.viewedFiles.has(path) || manager.collapsedFiles.has(path));
    }
  }
  return manager;
}

module.exports = { makePageManager, PRManager };
