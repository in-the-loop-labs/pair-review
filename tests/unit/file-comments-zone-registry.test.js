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
const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');

function makeManager() {
  const manager = makePageManager();
  manager.fileCommentManager = Object.create(FileCommentManager.prototype);
  manager.fileCommentManager.prManager = manager;
  return manager;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // Loading the module puts the class on `window`; a test that wants the
  // page's path matcher sets it itself.
  delete window.DiffRenderer;
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

  it('_clearDiffItems forgets every zone', () => {
    const manager = makeManager();
    manager.fileCommentManager.createFileCommentsZone('a.js');
    manager._clearDiffItems();
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
  /** A page whose viewer holds the given context files as items, each with its zone. */
  function paneWith(paths) {
    const manager = makeManager();
    manager.pierreBridge = { files: new Map(paths.map((path) => [path, { id: path, kind: 'context' }])) };
    manager.contextFiles = paths.map((path, index) => ({ id: index + 1, file: path }));
    for (const path of paths) manager.fileCommentManager.createFileCommentsZone(path, { context: true });
    // The page has seen these items.
    expect(manager._noteContextItems()).toEqual({ created: paths, removed: [] });
    return manager;
  }

  it('_noteContextItems releases the zone of a context item that went and keeps the others', () => {
    const manager = paneWith(['ctx.js', 'kept.js']);
    const keptZone = manager.getFileCommentsZone('kept.js');
    expect(manager.getFileCommentsZone('ctx.js')).not.toBeNull();

    // The viewer's list no longer has ctx.js (its rows were removed elsewhere).
    manager.pierreBridge.files.delete('ctx.js');
    manager.contextFiles = manager.contextFiles.filter((row) => row.file !== 'ctx.js');
    expect(manager._noteContextItems()).toEqual({ created: [], removed: ['ctx.js'] });

    expect(manager.getFileCommentsZone('ctx.js')).toBeNull();
    expect(manager.getFileCommentsZone('kept.js')).toBe(keptZone);
    const visited = [];
    manager.forEachFileCommentsZone((zone, file) => visited.push(file));
    expect(visited).toEqual(['kept.js']);
  });

  it('a path that left as a context file and is a changed file of the diff keeps its zone', () => {
    const manager = paneWith(['src/a.js']);
    const zone = manager.getFileCommentsZone('src/a.js');
    // The diff now has the file: the pane's item of that path is the changed file.
    manager.pierreBridge.files.set('src/a.js', { id: 'src/a.js', kind: 'diff' });
    manager.changedFilesByPath.set('src/a.js', { file: 'src/a.js' });
    expect(manager._noteContextItems()).toEqual({ created: [], removed: ['src/a.js'] });
    expect(manager.getFileCommentsZone('src/a.js')).toBe(zone);
  });
});

describe('a context file whose path ends like another file\'s has its own zone', () => {
  // With the page's own path matcher, as in the browser.
  beforeEach(() => { window.DiffRenderer = DiffRenderer; });
  afterEach(() => { delete window.DiffRenderer; });

  it('the zone that carries exactly the path wins over a file whose path it ends like', () => {
    const manager = makeManager();
    const root = manager.fileCommentManager.createFileCommentsZone('package.json');
    const nested = manager.fileCommentManager.createFileCommentsZone('packages/foo/package.json', { context: true });
    expect(manager.getFileCommentsZone('packages/foo/package.json')).toBe(nested);
    expect(manager.getFileCommentsZone('package.json')).toBe(root);
    // Another form of a path still finds its file, the changed file first.
    expect(manager.getFileCommentsZone('./package.json')).toBe(root);
    expect(manager.getFileCommentsZone('foo/package.json')).toBe(root);
    expect(manager.getFileCommentsZone('./packages/foo/package.json')).toBe(nested);
  });

  it('two context files, one path the end of the other, in either order of creation', () => {
    for (const order of [['index.js', 'src/index.js'], ['src/index.js', 'index.js']]) {
      const manager = makeManager();
      const zones = new Map(order.map((path) => [path, manager.fileCommentManager.createFileCommentsZone(path, { context: true })]));
      for (const path of order) expect(manager.getFileCommentsZone(path)).toBe(zones.get(path));
    }
  });

  it('_ensureFileCommentsZone answers the same zone however often it is asked, and the zone is released with its file', () => {
    const manager = makeManager();
    manager.changedFilesByPath.set('package.json', { file: 'package.json' });
    const twin = 'packages/foo/package.json';
    manager.pierreBridge = { files: new Map([['package.json', { id: 'package.json', kind: 'diff' }], [twin, { id: twin, kind: 'context' }]]) };
    manager.contextFiles = [{ id: 1, file: twin }];
    const root = manager._ensureFileCommentsZone('package.json');
    const first = manager._ensureFileCommentsZone(twin, { context: true });
    expect(first).not.toBe(root);
    expect(manager._ensureFileCommentsZone(twin, { context: true })).toBe(first);
    expect(manager._ensureFileCommentsZone(twin)).toBe(first);
    const visited = [];
    manager.forEachFileCommentsZone((zone, file) => visited.push(file));
    expect(visited).toEqual(['package.json', twin]);

    expect(manager._noteContextItems()).toEqual({ created: [twin], removed: [] });
    manager.pierreBridge.files.delete(twin);
    manager.contextFiles = [];
    expect(manager._noteContextItems()).toEqual({ created: [], removed: [twin] });
    expect(manager.getFileCommentsZone('package.json')).toBe(root);
    const left = [];
    manager.forEachFileCommentsZone((zone, file) => left.push(file));
    expect(left).toEqual(['package.json']);
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

describe('PRManager.countDisplayedSuggestions', () => {
  it('counts the suggestion annotations of every file and the suggestion cards of every zone, in the document or not', () => {
    const manager = makeManager();
    const annotations = {
      'src/a.js': [{ metadata: { type: 'suggestion' } }, { metadata: { type: 'comment' } }],
      'src/far.js': [{ metadata: { type: 'suggestion' } }, { metadata: { type: 'suggestion' } }],
    };
    manager.pierreBridge = {
      files: new Map(Object.keys(annotations).map((name) => [name, { id: name, kind: 'diff' }])),
      getAnnotations: (name, type) => annotations[name].filter((a) => a.metadata.type === type),
    };
    const attached = manager.fileCommentManager.createFileCommentsZone('src/a.js');
    document.body.appendChild(attached);
    const detached = manager.fileCommentManager.createFileCommentsZone('src/far.js');
    const card = (zone, suggestion) => {
      const el = document.createElement('div');
      el.className = suggestion ? 'file-comment-card ai-suggestion' : 'file-comment-card user-comment';
      if (suggestion) el.dataset.suggestionId = '7';
      zone.querySelector('.file-comments-container').appendChild(el);
    };
    card(attached, false);
    card(detached, true);
    expect(manager.countDisplayedSuggestions()).toBe(4);
  });

  it('is 0 without a viewer and without zones', () => {
    const manager = makeManager();
    manager.pierreBridge = null;
    expect(manager.countDisplayedSuggestions()).toBe(0);
  });
});
