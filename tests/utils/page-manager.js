// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * A page manager for unit tests of the modules that navigate or resolve
 * elements through it (AIPanel, SuggestionNavigator, TourRenderer, ...).
 *
 * It is a PRManager whose methods are the production ones (revealInDiff,
 * setFileCollapsed, isFileCollapsed, findCommentCard, getFileCommentsZone,
 * ...), created without running the constructor, which wires the whole
 * page. A test gives it the state and the collaborators its scenario needs
 * and stubs only what reaches outside the unit (the bridge, the line
 * reveal, the file-element lookup). Nothing of PRManager is re-implemented
 * here.
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

/**
 * A stand-in for the part of the bridge that revealInDiff asks about cards:
 * which file an annotation is in, its card, whether the viewer draws it,
 * and the wait for it. The cards are the ones a test names by annotation id
 * ('suggestion-<id>', 'comment-<id>', ...), and a card is drawn when it is
 * in the document. It decides nothing of its own: what the real bridge and
 * viewer do is tested in tests/unit/pierre-bridge.test.js and
 * tests/contract/bridge.
 * @param {Object<string, Element>} [cards] - annotation id to card
 * @param {Object} [options]
 * @param {string} [options.file] - the file every card is in (default: the
 *   file the caller asks about)
 * @returns {Object}
 */
function cardBridge(cards = {}, { file = null } = {}) {
  return {
    files: new Map(),
    findAnnotationFile: (annotationId, preferredFile) => (cards[annotationId] ? (file || preferredFile || null) : null),
    getAnnotationElement: (fileName, annotationId) => cards[annotationId] || null,
    isElementDrawn: (element) => !!element?.isConnected,
    scrollToAnnotation: () => true,
    scrollToItem: () => true,
    whenAnnotationRendered: async (fileName, annotationId) => {
      const card = cards[annotationId] || null;
      return card && card.isConnected ? card : null;
    },
    whenElementDrawn: async (element) => !!element?.isConnected,
  };
}

module.exports = { makePageManager, cardBridge, PRManager };
