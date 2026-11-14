// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * One registry, one resolver for file-comment zones.
 *
 * PRManager.getFileCommentsZone(path) is the only way to get a file's zone
 * and forEachFileCommentsZone(fn) the only sweep; both answer from
 * FileCommentManager's registry, which holds a zone whether or not it is
 * attached to the document. Nothing queries the document for
 * `.file-comments-zone`. (The registry itself is tested in
 * file-comment-manager.test.js.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const path = require('path');
const { makePageManager } = require('../utils/page-manager.js');
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');
const PostedComment = require('../../public/js/utils/posted-comment.js');

function makeManager() {
  const manager = makePageManager();
  manager.fileCommentManager = Object.create(FileCommentManager.prototype);
  manager.fileCommentManager.prManager = manager;
  return manager;
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.PostedComment = PostedComment;
  PostedComment.setShowPostedOverride(null);
});

afterEach(() => {
  delete window.PostedComment;
  delete window.aiPanel;
  PostedComment.setShowPostedOverride(null);
  vi.restoreAllMocks();
});

describe('PRManager.getFileCommentsZone / forEachFileCommentsZone', () => {
  it('resolve zones the file comment manager created, attached to the document or not', () => {
    const manager = makeManager();
    const attached = manager.fileCommentManager.createFileCommentsZone('a.js');
    document.body.appendChild(attached);
    const detached = manager.fileCommentManager.createFileCommentsZone('b.js');
    const context = manager.fileCommentManager.createFileCommentsZone('docs/readme.md', { context: true });

    expect(manager.getFileCommentsZone('a.js')).toBe(attached);
    expect(manager.getFileCommentsZone('b.js')).toBe(detached);
    expect(manager.getFileCommentsZone('docs/readme.md')).toBe(context);
    expect(manager.getFileCommentsZone('missing.js')).toBeNull();
    expect(manager.getFileCommentsZone(undefined)).toBeNull();

    const seen = [];
    manager.forEachFileCommentsZone((zone, file) => seen.push([file, zone]));
    expect(seen).toEqual([['a.js', attached], ['b.js', detached], ['docs/readme.md', context]]);
  });

  it('are harmless without a file comment manager', () => {
    const manager = makePageManager();
    expect(manager.getFileCommentsZone('a.js')).toBeNull();
    const fn = vi.fn();
    expect(() => manager.forEachFileCommentsZone(fn)).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('_removeRenderedFiles forgets every zone', () => {
    const manager = makeManager();
    manager.fileCommentManager.createFileCommentsZone('a.js');
    manager._removeRenderedFiles(document.createElement('div'));
    expect(manager.getFileCommentsZone('a.js')).toBeNull();
  });
});

describe('sweeps reach zones that are not attached to the document', () => {
  it('applyPostedCommentVisibility hides posted cards and recounts in a detached zone', () => {
    const manager = makeManager();
    manager.fileCommentManager.updateCommentCount = vi.fn();
    manager.userComments = [];
    window.aiPanel = {
      getCommentFilterState: () => ({ includeDismissed: false, showPosted: false }),
      setHiddenCommentCounts: vi.fn(),
      setComments: vi.fn(),
    };
    const zone = manager.fileCommentManager.createFileCommentsZone('a.js');
    zone.querySelector('.file-comments-container').innerHTML =
      '<div class="file-comment-card" data-comment-status="active" data-comment-publication="posted"></div>' +
      '<div class="file-comment-card" data-comment-status="active" data-comment-publication="none"></div>';
    expect(zone.isConnected).toBe(false);

    manager.applyPostedCommentVisibility();

    const [postedCard, pendingCard] = zone.querySelectorAll('.file-comment-card');
    expect(postedCard.classList.contains('posted-comment-hidden')).toBe(true);
    expect(pendingCard.classList.contains('posted-comment-hidden')).toBe(false);
    expect(manager.fileCommentManager.updateCommentCount).toHaveBeenCalledWith(zone);
  });

  it('loadFileComments replaces the cards of a detached zone', () => {
    const manager = makeManager();
    const fcm = manager.fileCommentManager;
    fcm.displayUserComment = vi.fn();
    fcm.displayAISuggestion = vi.fn();
    fcm.updateCommentCount = vi.fn();
    const zone = fcm.createFileCommentsZone('a.js');
    zone.querySelector('.file-comments-container').innerHTML =
      '<div class="file-comment-card user-comment" data-id="stale"></div>';
    const comment = { id: 1, file: 'a.js', is_file_level: 1 };

    fcm.loadFileComments([comment], null);

    expect(zone.querySelector('[data-id="stale"]')).toBeNull();
    expect(fcm.displayUserComment).toHaveBeenCalledWith(zone, comment);
  });
});

describe('a context file that leaves the pane takes its zone out of the registry', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function contextWrapper(manager, file, contextId, { chunk = false } = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper context-file';
    wrapper.dataset.fileName = file;
    wrapper._fileCommentsZone = manager.fileCommentManager.createFileCommentsZone(file, { context: true });
    wrapper.appendChild(wrapper._fileCommentsZone);
    if (chunk) {
      wrapper.insertAdjacentHTML('beforeend',
        `<table><tbody class="context-chunk" data-context-id="${contextId}"></tbody></table>`);
    } else {
      wrapper.dataset.contextId = String(contextId);
    }
    document.body.appendChild(wrapper);
    return wrapper;
  }

  function managerWithRows(rows) {
    const manager = makeManager();
    Object.assign(manager, {
      contextFiles: rows,
      diffFiles: [],
      _scrubRemovedContextState: vi.fn(),
      rebuildFileListWithContext: vi.fn(),
      renderContextFile: vi.fn(),
    });
    return manager;
  }

  it.each([
    ['a standalone context wrapper', false],
    ['the last chunk of a merged context wrapper', true],
  ])('loadContextFiles: %s removed elsewhere', async (_, chunk) => {
    const manager = managerWithRows([{ id: 5, file: 'ctx.js' }, { id: 6, file: 'kept.js' }]);
    const gone = contextWrapper(manager, 'ctx.js', 5, { chunk });
    const kept = contextWrapper(manager, 'kept.js', 6, { chunk });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ contextFiles: [{ id: 6, file: 'kept.js' }] }),
    })));

    await manager.loadContextFiles();

    expect(gone.isConnected).toBe(false);
    expect(manager.getFileCommentsZone('ctx.js')).toBeNull();
    expect(kept.isConnected).toBe(true);
    expect(manager.getFileCommentsZone('kept.js')).toBe(kept._fileCommentsZone);
    const visited = [];
    manager.forEachFileCommentsZone((zone, file) => visited.push(file));
    expect(visited).toEqual(['kept.js']);
  });
});

describe('the sources', () => {
  it('nothing queries the document, or a wrapper, for a file-comment zone', () => {
    const root = path.join(__dirname, '../../public/js');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'vendor') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        fs.readFileSync(full, 'utf-8').split('\n').forEach((line, index) => {
          // `closest('.file-comments-zone')` from a card up to its own zone is
          // fine; a query down from the document or a wrapper is not.
          if (/querySelector(All)?\([^)]*file-comments-zone/.test(line)) {
            offenders.push(`${path.relative(root, full)}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
