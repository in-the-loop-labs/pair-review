// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Regression tests for issue #540: Context entry controls must collapse
 * independently from a same-file diff entry.
 *
 * A path can be a context file of the review and a changed file of the
 * diff (an LLM chat brings in a section of a file that a later commit
 * changes). The pane then shows the changed file only ("the diff wins",
 * pane-entries.test.js), but the collapse and viewed state stored for the
 * context entry must never be read or written as the changed file's, and
 * vice versa: context state lives under context-scoped keys.
 *
 * Shared by PR mode and Local mode: Local mode reuses PRManager's toggle*
 * methods and only patches viewed-state persistence, so these tests cover
 * both modes. The context file's header and its controls are in
 * context-file-header.test.js.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');
const { PRManager } = require('../../public/js/pr.js');

// jsdom exposes CSS.escape via window; make sure the global exists for code
// that references bare `CSS`.
if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
  globalThis.CSS = window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS
    : { escape: (s) => String(s).replace(/[^a-zA-Z0-9_\-]/g, (c) => `\\${c}`) };
}

const FILE = 'src/app.js';

function buildWrapper(file, { context = false } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = context ? 'd2h-file-wrapper context-file' : 'd2h-file-wrapper';
  wrapper.dataset.fileName = file;

  const header = document.createElement('div');
  header.className = context ? 'd2h-file-header context-file-header' : 'd2h-file-header';

  const chevron = document.createElement('button');
  chevron.className = 'file-collapse-toggle';
  chevron.title = 'Collapse file';
  header.appendChild(chevron);
  wrapper.appendChild(header);

  // Production wrappers nest a comments zone that ALSO carries
  // data-file-name (FileCommentManager.createFileCommentsZone) — file
  // lookups must never resolve to it.
  const commentsZone = document.createElement('div');
  commentsZone.className = 'file-comments-zone';
  commentsZone.dataset.fileName = file;
  wrapper.appendChild(commentsZone);

  const body = document.createElement('div');
  body.className = 'd2h-file-body';
  wrapper.appendChild(body);

  return wrapper;
}

function createManager() {
  const manager = Object.create(PRManager.prototype);
  manager.collapsedFiles = new Set();
  manager.viewedFiles = new Set();
  manager.saveViewedState = vi.fn();
  manager.contextFiles = [];
  manager.findFileElement = (file) => DiffRenderer.findFileElement(file);
  manager.pierreBridge = null;
  manager._initPaneState();
  return manager;
}

describe('context entry collapse independence (#540)', () => {
  let manager, diffWrapper, contextWrapper;

  beforeEach(() => {
    document.body.innerHTML = '<div id="diff-container"></div>';
    window.DiffRenderer = DiffRenderer;
    window.HeaderAnchor = HeaderAnchor;

    manager = createManager();
    diffWrapper = buildWrapper(FILE);
    contextWrapper = buildWrapper(FILE, { context: true });
    // Both entries as their renders leave them: expanded, each under its
    // own state key.
    manager.changedFilesByPath = new Map([[FILE, { file: FILE }]]);
    manager._fileCollapsed.set(FILE, false);
    manager._fileCollapsed.set(`context:${FILE}`, false);
    const container = document.getElementById('diff-container');
    container.appendChild(diffWrapper);
    container.appendChild(contextWrapper);
  });

  describe('DiffRenderer.findFileElement', () => {
    beforeEach(() => {
      // Put the context wrapper FIRST in document order. A naive first-match
      // lookup would return it, so these assertions exercise the preference
      // logic itself rather than passing by DOM position.
      document.getElementById('diff-container').insertBefore(contextWrapper, diffWrapper);
    });

    it('prefers the diff wrapper when a context entry precedes it in the DOM', () => {
      expect(DiffRenderer.findFileElement(FILE)).toBe(diffWrapper);
    });

    it('still resolves the context wrapper when the file has no diff entry', () => {
      diffWrapper.remove();
      expect(DiffRenderer.findFileElement(FILE)).toBe(contextWrapper);
    });

    it('never resolves to a nested comments zone that carries data-file-name', () => {
      diffWrapper.remove();
      const result = DiffRenderer.findFileElement(FILE);
      expect(result).toBe(contextWrapper);
      expect(result.classList.contains('file-comments-zone')).toBe(false);
    });

    it('prefers the diff wrapper in the partial-match fallback too', () => {
      // Force the fallback path: query by a suffix of the stored path, with
      // the context wrapper still first in document order.
      expect(DiffRenderer.findFileElement('app.js')).toBe(diffWrapper);
    });
  });

  describe('a context file\'s state is kept under its own key', () => {
    const CONTEXT = 'lib/context.js';

    /** A pane with the changed file FILE and the context file CONTEXT, as a render leaves it. */
    function pane() {
      const bridge = { files: new Map([[FILE, { kind: 'diff' }], [CONTEXT, { kind: 'context' }]]), setCollapsed: vi.fn() };
      manager.pierreBridge = bridge;
      manager.contextFiles = [{ id: 1, file: CONTEXT, line_start: 1, line_end: 10 }];
      manager._contextItemIds.add(CONTEXT);
      manager._fileCollapsed.set(`context:${CONTEXT}`, false);
      manager.updateFileItemViewedState = vi.fn();
      return bridge;
    }

    it('toggleContextFileCollapse collapses and expands the context file under the context key, and needs no element', () => {
      const bridge = pane();
      diffWrapper.remove();
      contextWrapper.remove();

      manager.toggleContextFileCollapse(CONTEXT);
      expect(manager.isFileCollapsed(CONTEXT)).toBe(true);
      expect([...manager.collapsedFiles]).toEqual([`context:${CONTEXT}`]);
      expect(bridge.setCollapsed.mock.calls).toEqual([[CONTEXT, true]]);

      manager.toggleContextFileCollapse(CONTEXT);
      expect(manager.isFileCollapsed(CONTEXT)).toBe(false);
      expect([...manager.collapsedFiles]).toEqual([]);
      expect(bridge.setCollapsed).toHaveBeenLastCalledWith(CONTEXT, false);
      // The changed file was never touched.
      expect(manager.isFileCollapsed(FILE)).toBe(false);
    });

    it('is a no-op for a path that is not a file of the pane', () => {
      const bridge = pane();
      expect(() => manager.toggleContextFileCollapse('nowhere.js')).not.toThrow();
      expect(bridge.setCollapsed).not.toHaveBeenCalled();
      expect(manager.collapsedFiles.size).toBe(0);
    });

    it('toggleContextFileViewed marks the context file viewed and collapses it, leaving every changed file alone', () => {
      const bridge = pane();
      manager.toggleContextFileViewed(CONTEXT, true);

      expect(manager.isFileCollapsed(CONTEXT)).toBe(true);
      expect(manager.isFileCollapsed(FILE)).toBe(false);
      expect([...manager.viewedFiles]).toEqual([`context:${CONTEXT}`]);
      expect(bridge.setCollapsed.mock.calls).toEqual([[CONTEXT, true]]);
      expect(manager.updateFileItemViewedState).toHaveBeenLastCalledWith(CONTEXT, true, { contextItem: true });
      expect(manager.saveViewedState).toHaveBeenCalled();

      manager.toggleContextFileViewed(CONTEXT, false);
      expect(manager.isFileCollapsed(CONTEXT)).toBe(false);
      expect([...manager.viewedFiles]).toEqual([]);
    });

    it('state stored under the context key of a path that is now a changed file is not that file\'s state (#540)', async () => {
      // The file was a context file when the reader marked it viewed and
      // collapsed it; a later commit changed it, so the pane shows it as a
      // changed file. The diff wins: its state is the plain key's.
      pane();
      manager.viewedFiles.add(`context:${FILE}`);
      manager.collapsedFiles.add(`context:${FILE}`);
      manager._fileCollapsed.set(`context:${FILE}`, true);

      expect(manager.fileKind(FILE)).toBe('diff');
      expect(manager._fileStateKey(FILE)).toBe(FILE);
      expect(manager.isFileCollapsed(FILE)).toBe(false);

      await manager.toggleFileViewed(FILE, true);
      expect(manager.viewedFiles.has(FILE)).toBe(true);
      expect(manager.collapsedFiles.has(FILE)).toBe(true);
      expect(manager.isFileCollapsed(FILE)).toBe(true);
      await manager.toggleFileCollapse(FILE);
      expect(manager.isFileCollapsed(FILE)).toBe(false);
      // The context-scoped keys are as they were.
      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(true);
      expect(manager._fileCollapsed.get(`context:${FILE}`)).toBe(true);
    });

    it('updateFileItemViewedState with contextItem only updates the context sidebar row, never a same-path diff row', () => {
      const diffItem = document.createElement('a');
      diffItem.className = 'file-item';
      diffItem.dataset.path = FILE;
      const contextItem = document.createElement('a');
      contextItem.className = 'file-item context-file-item';
      contextItem.dataset.path = FILE;
      document.body.append(diffItem, contextItem);

      manager.updateFileItemViewedState(FILE, true, { contextItem: true });

      expect(diffItem.classList.contains('viewed')).toBe(false);
      expect(contextItem.classList.contains('viewed')).toBe(true);
    });
  });

  describe('loadContextFiles remote-delete context-key scrub', () => {
    // A peer tab deleting a context file reaches this tab via the
    // review:context_files_changed WebSocket event -> loadContextFiles().
    // That path must scrub the `context:` viewed/collapsed keys too, or the
    // orphaned state resurrects on re-add and round-trips back into shared
    // storage via saveViewedState().
    beforeEach(() => {
      manager.currentPR = { id: 1 };
      manager.diffFiles = [];
      manager.renderContextFile = vi.fn().mockResolvedValue(undefined);
      manager.rebuildFileListWithContext = vi.fn();
      manager.loadUserComments = vi.fn().mockResolvedValue(undefined);
    });

    function stubContextFilesResponse(rows) {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ contextFiles: rows }),
      });
    }

    it('scrubs viewed and collapsed keys when a peer tab deleted the last entry for a path', async () => {
      manager.contextFiles = [{ id: 5, file: FILE, line_start: 1, line_end: 10 }];
      manager.viewedFiles.add(`context:${FILE}`);
      manager.collapsedFiles.add(`context:${FILE}`);
      stubContextFilesResponse([]);

      await manager.loadContextFiles();

      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(false);
      expect(manager.collapsedFiles.has(`context:${FILE}`)).toBe(false);
      expect(manager.saveViewedState).toHaveBeenCalled();
    });

    it('keeps the keys while another entry for the same path remains in the response', async () => {
      manager.contextFiles = [
        { id: 5, file: FILE, line_start: 1, line_end: 10 },
        { id: 6, file: FILE, line_start: 20, line_end: 30 },
      ];
      manager.viewedFiles.add(`context:${FILE}`);
      manager.collapsedFiles.add(`context:${FILE}`);
      stubContextFilesResponse([{ id: 6, file: FILE, line_start: 20, line_end: 30 }]);

      await manager.loadContextFiles();

      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(true);
      expect(manager.collapsedFiles.has(`context:${FILE}`)).toBe(true);
      expect(manager.saveViewedState).not.toHaveBeenCalled();
    });

    it('does not persist when only the in-memory collapsed key existed', async () => {
      manager.contextFiles = [{ id: 5, file: FILE, line_start: 1, line_end: 10 }];
      manager.collapsedFiles.add(`context:${FILE}`);
      stubContextFilesResponse([]);

      await manager.loadContextFiles();

      expect(manager.collapsedFiles.has(`context:${FILE}`)).toBe(false);
      expect(manager.saveViewedState).not.toHaveBeenCalled();
    });

    it('does not scrub a row suppressed by the diff-wins guard but still present in the response', async () => {
      // The row's file entered the diff: rendering is suppressed, but the DB
      // row still exists — its context-scoped state must survive.
      manager.diffFiles = [{ file: FILE }];
      const row = { id: 5, file: FILE, line_start: 1, line_end: 10 };
      manager.contextFiles = [row];
      manager.viewedFiles.add(`context:${FILE}`);
      manager.collapsedFiles.add(`context:${FILE}`);
      stubContextFilesResponse([row]);

      await manager.loadContextFiles();

      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(true);
      expect(manager.collapsedFiles.has(`context:${FILE}`)).toBe(true);
      expect(manager.saveViewedState).not.toHaveBeenCalled();
    });
  });

  describe('removeContextFile context-key scrub', () => {
    beforeEach(() => {
      manager.currentPR = { id: 1 };
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    });

    it('scrubs context-scoped keys when the last entry for a path is removed', async () => {
      manager.contextFiles = [{ id: 5, file: FILE }];
      manager.viewedFiles.add(`context:${FILE}`);
      manager.collapsedFiles.add(`context:${FILE}`);
      manager.loadContextFiles = vi.fn().mockImplementation(async () => {
        manager.contextFiles = [];
      });

      await manager.removeContextFile(5);

      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(false);
      expect(manager.collapsedFiles.has(`context:${FILE}`)).toBe(false);
      expect(manager.saveViewedState).toHaveBeenCalled();
    });

    it('keeps the keys while other entries for the same path remain', async () => {
      manager.contextFiles = [{ id: 5, file: FILE }, { id: 6, file: FILE }];
      manager.viewedFiles.add(`context:${FILE}`);
      manager.loadContextFiles = vi.fn().mockImplementation(async () => {
        manager.contextFiles = [{ id: 6, file: FILE }];
      });

      await manager.removeContextFile(5);

      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(true);
      expect(manager.saveViewedState).not.toHaveBeenCalled();
    });

    it('does not persist when only the in-memory collapsed key existed', async () => {
      manager.contextFiles = [{ id: 5, file: FILE }];
      manager.collapsedFiles.add(`context:${FILE}`);
      manager.loadContextFiles = vi.fn().mockImplementation(async () => {
        manager.contextFiles = [];
      });

      await manager.removeContextFile(5);

      expect(manager.collapsedFiles.has(`context:${FILE}`)).toBe(false);
      expect(manager.saveViewedState).not.toHaveBeenCalled();
    });

    it('does not scrub keys when the DELETE fails', async () => {
      manager.contextFiles = [{ id: 5, file: FILE }];
      manager.viewedFiles.add(`context:${FILE}`);
      manager.loadContextFiles = vi.fn();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

      await manager.removeContextFile(5);

      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(true);
      expect(manager.loadContextFiles).not.toHaveBeenCalled();
    });
  });

  describe('renderFileItem viewed key scoping', () => {
    it('a context sidebar row reads the context-scoped viewed key', () => {
      manager.viewedFiles.add(FILE); // diff viewed only

      const item = manager.renderFileItem({
        name: 'app.js', fullPath: FILE, status: 'modified',
        contextFile: true, contextId: 7, lineStart: 1,
      });
      expect(item.classList.contains('viewed')).toBe(false);

      manager.viewedFiles.add(`context:${FILE}`);
      const viewedItem = manager.renderFileItem({
        name: 'app.js', fullPath: FILE, status: 'modified',
        contextFile: true, contextId: 7, lineStart: 1,
      });
      expect(viewedItem.classList.contains('viewed')).toBe(true);
    });
  });
});
