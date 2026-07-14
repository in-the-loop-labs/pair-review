// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Regression tests for issue #540: Context entry controls must collapse
 * independently from a same-file diff entry.
 *
 * When an LLM chat brings in a section of a file that is ALSO changed in the
 * PR, the diff panel shows two wrappers with the same data-file-name: the
 * diff entry and the `.context-file` entry. Collapse/viewed actions on the
 * context entry must target the context wrapper (via context-scoped state
 * keys), never the diff wrapper — and vice versa.
 *
 * Shared by PR mode and Local mode: Local mode reuses PRManager's
 * renderContextFile/toggle* methods and only patches viewed-state persistence,
 * so these tests cover both modes.
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
  manager.ensureFileBodyRendered = vi.fn().mockResolvedValue(undefined);
  manager.pierreBridge = null;
  return manager;
}

describe('context entry collapse independence (#540)', () => {
  let manager, diffWrapper, contextWrapper;

  beforeEach(() => {
    document.body.innerHTML = '<div id="diff-container"></div>';
    window.DiffRenderer = DiffRenderer;

    manager = createManager();
    diffWrapper = buildWrapper(FILE);
    contextWrapper = buildWrapper(FILE, { context: true });
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

  describe('toggleContextFileCollapse', () => {
    it('collapses the context entry without expanding a viewed (collapsed) diff', () => {
      // Reproduce the issue: diff is marked viewed (collapsed), then the user
      // collapses the context entry for the same file.
      diffWrapper.classList.add('collapsed');
      manager.viewedFiles.add(FILE);
      manager.collapsedFiles.add(FILE);

      manager.toggleContextFileCollapse(FILE);

      expect(contextWrapper.classList.contains('collapsed')).toBe(true);
      expect(diffWrapper.classList.contains('collapsed')).toBe(true);
      // Diff-scoped state is untouched
      expect(manager.collapsedFiles.has(FILE)).toBe(true);
      expect(manager.collapsedFiles.has(`context:${FILE}`)).toBe(true);
    });

    it('expands a collapsed context entry and updates its chevron', () => {
      manager.toggleContextFileCollapse(FILE);
      expect(contextWrapper.classList.contains('collapsed')).toBe(true);
      expect(contextWrapper.querySelector('.file-collapse-toggle').title).toBe('Expand file');

      manager.toggleContextFileCollapse(FILE);
      expect(contextWrapper.classList.contains('collapsed')).toBe(false);
      expect(contextWrapper.querySelector('.file-collapse-toggle').title).toBe('Collapse file');
      expect(manager.collapsedFiles.has(`context:${FILE}`)).toBe(false);
    });

    it('is a no-op when no context wrapper exists', () => {
      contextWrapper.remove();
      expect(() => manager.toggleContextFileCollapse(FILE)).not.toThrow();
      expect(diffWrapper.classList.contains('collapsed')).toBe(false);
    });
  });

  describe('toggleContextFileViewed', () => {
    it('marks the context entry viewed and collapses it, leaving the diff alone', () => {
      manager.toggleContextFileViewed(FILE, true);

      expect(contextWrapper.classList.contains('collapsed')).toBe(true);
      expect(diffWrapper.classList.contains('collapsed')).toBe(false);
      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(true);
      // The plain path key (diff entry) is untouched
      expect(manager.viewedFiles.has(FILE)).toBe(false);
      expect(manager.saveViewedState).toHaveBeenCalled();
    });

    it('unchecking viewed expands the context entry only', () => {
      manager.toggleContextFileViewed(FILE, true);
      diffWrapper.classList.add('collapsed');

      manager.toggleContextFileViewed(FILE, false);

      expect(contextWrapper.classList.contains('collapsed')).toBe(false);
      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(false);
      // Diff stays collapsed — context actions never touch it
      expect(diffWrapper.classList.contains('collapsed')).toBe(true);
    });

    it('only updates the context sidebar row, never a same-path diff row', () => {
      const diffItem = document.createElement('a');
      diffItem.className = 'file-item';
      diffItem.dataset.path = FILE;
      const contextItem = document.createElement('a');
      contextItem.className = 'file-item context-file-item';
      contextItem.dataset.path = FILE;
      document.body.append(diffItem, contextItem);

      manager.toggleContextFileViewed(FILE, true);

      expect(diffItem.classList.contains('viewed')).toBe(false);
      expect(contextItem.classList.contains('viewed')).toBe(true);
    });
  });

  describe('diff entry actions leave the context entry alone', () => {
    it('toggleFileViewed collapses the diff wrapper, not the context wrapper', async () => {
      await manager.toggleFileViewed(FILE, true);

      expect(diffWrapper.classList.contains('collapsed')).toBe(true);
      expect(contextWrapper.classList.contains('collapsed')).toBe(false);
      expect(manager.viewedFiles.has(FILE)).toBe(true);
      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(false);
    });

    it('toggleFileCollapse toggles the diff wrapper, not the context wrapper', async () => {
      await manager.toggleFileCollapse(FILE);

      expect(diffWrapper.classList.contains('collapsed')).toBe(true);
      expect(contextWrapper.classList.contains('collapsed')).toBe(false);
    });
  });

  describe('renderContextFile', () => {
    function renderableManager() {
      manager.fetchFileContent = vi.fn().mockResolvedValue({ lines: ['a', 'b', 'c'] });
      manager._buildContextChunkTbody = vi.fn(() => {
        const tbody = document.createElement('tbody');
        tbody.className = 'context-chunk';
        return tbody;
      });
      manager.fileCommentManager = null;
      return manager;
    }

    beforeEach(() => {
      // renderContextFile builds its own context wrapper
      contextWrapper.remove();
      renderableManager();
    });

    it('does not render the viewed checkbox checked from the diff entry state', async () => {
      manager.viewedFiles.add(FILE); // diff marked viewed

      await manager.renderContextFile({ id: 1, file: FILE, line_start: 1, line_end: 3 });

      const wrapper = document.querySelector('.d2h-file-wrapper.context-file');
      expect(wrapper).not.toBeNull();
      expect(wrapper.querySelector('.file-viewed-checkbox').checked).toBe(false);
      expect(wrapper.classList.contains('collapsed')).toBe(false);
    });

    it('renders collapsed and checked when the context entry itself is viewed', async () => {
      manager.viewedFiles.add(`context:${FILE}`);

      await manager.renderContextFile({ id: 1, file: FILE, line_start: 1, line_end: 3 });

      const wrapper = document.querySelector('.d2h-file-wrapper.context-file');
      expect(wrapper.querySelector('.file-viewed-checkbox').checked).toBe(true);
      expect(wrapper.classList.contains('collapsed')).toBe(true);
    });

    it('chevron click toggles the context wrapper only', async () => {
      await manager.renderContextFile({ id: 1, file: FILE, line_start: 1, line_end: 3 });

      const wrapper = document.querySelector('.d2h-file-wrapper.context-file');
      wrapper.querySelector('.file-collapse-toggle').click();

      expect(wrapper.classList.contains('collapsed')).toBe(true);
      expect(diffWrapper.classList.contains('collapsed')).toBe(false);
    });

    it('viewed checkbox change routes to context-scoped viewed state', async () => {
      await manager.renderContextFile({ id: 1, file: FILE, line_start: 1, line_end: 3 });

      const wrapper = document.querySelector('.d2h-file-wrapper.context-file');
      const checkbox = wrapper.querySelector('.file-viewed-checkbox');
      checkbox.checked = true;
      checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));

      expect(wrapper.classList.contains('collapsed')).toBe(true);
      expect(manager.viewedFiles.has(`context:${FILE}`)).toBe(true);
      expect(manager.viewedFiles.has(FILE)).toBe(false);
      expect(diffWrapper.classList.contains('collapsed')).toBe(false);
    });
  });

  describe('loadContextFiles "diff wins" guard', () => {
    beforeEach(() => {
      manager.currentPR = { id: 1 };
      manager.contextFiles = [];
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

    it('suppresses rendering a context row whose file is now in the diff', async () => {
      manager.diffFiles = [{ file: FILE }];
      const inDiff = { id: 1, file: FILE, line_start: 1, line_end: 10 };
      const outside = { id: 2, file: 'src/other.js', line_start: 1, line_end: 10 };
      stubContextFilesResponse([inDiff, outside]);

      await manager.loadContextFiles();

      expect(manager.renderContextFile).toHaveBeenCalledTimes(1);
      expect(manager.renderContextFile).toHaveBeenCalledWith(outside);
      // The DB row is only suppressed at the view layer, never dropped
      expect(manager.contextFiles).toEqual([inDiff, outside]);
    });

    it('renders the same row again once its file leaves the diff', async () => {
      manager.diffFiles = [];
      const row = { id: 1, file: FILE, line_start: 1, line_end: 10 };
      stubContextFilesResponse([row]);

      await manager.loadContextFiles();

      expect(manager.renderContextFile).toHaveBeenCalledWith(row);
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
