// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from 'vitest';

global.window = global.window || {};

const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');

function createTestFileCommentManager() {
  const fileCommentManager = Object.create(FileCommentManager.prototype);
  fileCommentManager.prManager = {
    currentPR: { id: 'test-review-1' }
  };
  return fileCommentManager;
}

describe('FileCommentManager.loadFileComments()', () => {
  afterEach(() => {
    delete global.document;
    delete global.window.DiffRenderer;
  });

  it('resolves file-level items through findZoneForFile before rendering', () => {
    const fileCommentManager = createTestFileCommentManager();
    const container = {
      querySelectorAll: vi.fn().mockReturnValue([])
    };
    const zone = {
      dataset: { fileName: 'src/file.js' },
      querySelector: vi.fn(selector => selector === '.file-comments-container' ? container : null)
    };

    global.document = {
      querySelectorAll: vi.fn().mockReturnValue([zone])
    };

    fileCommentManager.findZoneForFile = vi.fn(file => file === './src/file.js' ? zone : null);
    fileCommentManager.displayAISuggestion = vi.fn();
    fileCommentManager.displayUserComment = vi.fn();
    fileCommentManager.updateCommentCount = vi.fn();

    const comment = { file: './src/file.js', is_file_level: 1, body: 'User comment' };
    const suggestion = { file: './src/file.js', is_file_level: 1, body: 'AI suggestion' };

    fileCommentManager.loadFileComments([comment], [suggestion]);

    expect(fileCommentManager.findZoneForFile).toHaveBeenCalledWith('./src/file.js');
    expect(fileCommentManager.displayAISuggestion).toHaveBeenCalledWith(zone, suggestion);
    expect(fileCommentManager.displayUserComment).toHaveBeenCalledWith(zone, comment);
    expect(fileCommentManager.updateCommentCount).toHaveBeenCalledWith(zone);
  });
});

describe('FileCommentManager.findZoneForFile()', () => {
  afterEach(() => {
    delete global.document;
    delete global.CSS;
    delete global.window.DiffRenderer;
  });

  it('escapes CSS special characters in the fallback selector lookup', () => {
    const fileCommentManager = createTestFileCommentManager();
    const zone = { dataset: { fileName: 'src/routes/repos/"quoted"/route.tsx' } };
    const file = 'src/routes/repos/"quoted"/route.tsx';

    global.window.DiffRenderer = undefined;
    global.CSS = {
      escape: vi.fn(value => value.replace(/"/g, '\\"'))
    };
    global.document = {
      querySelector: vi.fn().mockReturnValue(zone)
    };

    const result = fileCommentManager.findZoneForFile(file);

    expect(global.CSS.escape).toHaveBeenCalledWith(file);
    expect(global.document.querySelector).toHaveBeenCalledWith(
      '.file-comments-zone[data-file-name="src/routes/repos/\\"quoted\\"/route.tsx"]'
    );
    expect(result).toBe(zone);
  });
});

describe('FileCommentManager.findZoneForFile() cached-zone fallback', () => {
  afterEach(() => {
    delete global.document;
    delete global.CSS;
    delete global.window.DiffRenderer;
  });

  it('returns the cached (detached) zone when no live DOM zone exists', () => {
    // A virtualized-out file has no DOM zone; its cards must still hydrate into
    // the SAME cached element the 'file-comments' CodeView renderer returns.
    const fcm = Object.create(FileCommentManager.prototype);
    const cachedZone = { dataset: { fileName: 'src/off.js' } };
    fcm.prManager = { _fileCommentZones: new Map([['src/off.js', cachedZone]]) };
    global.window.DiffRenderer = { findFileElement: () => null };
    global.document = { querySelector: () => null };
    global.CSS = { escape: (s) => s };

    expect(fcm.findZoneForFile('src/off.js')).toBe(cachedZone);
  });

  it('prefers a live DOM zone over the cached one', () => {
    const fcm = Object.create(FileCommentManager.prototype);
    const cachedZone = { tag: 'cached' };
    const liveZone = { tag: 'live' };
    fcm.prManager = { _fileCommentZones: new Map([['src/on.js', cachedZone]]) };
    const wrapper = { querySelector: (sel) => (sel === '.file-comments-zone' ? liveZone : null) };
    global.window.DiffRenderer = { findFileElement: (f) => (f === 'src/on.js' ? wrapper : null) };
    global.document = { querySelector: () => null };
    global.CSS = { escape: (s) => s };

    expect(fcm.findZoneForFile('src/on.js')).toBe(liveZone);
  });

  it('returns null when neither a DOM zone nor a cached zone exists', () => {
    const fcm = Object.create(FileCommentManager.prototype);
    fcm.prManager = { _fileCommentZones: new Map() };
    global.window.DiffRenderer = { findFileElement: () => null };
    global.document = { querySelector: () => null };
    global.CSS = { escape: (s) => s };

    expect(fcm.findZoneForFile('nope.js')).toBeNull();
  });
});

describe('FileCommentManager.loadFileComments() cached-zone union', () => {
  afterEach(() => {
    delete global.document;
    delete global.window.DiffRenderer;
  });

  it('populates a cached/detached zone that is NOT in the DOM', () => {
    // The zone resolves only via findZoneForFile (cached), and
    // document.querySelectorAll('.file-comments-zone') returns nothing — the
    // union with commentsByZone.keys() must still target the cached zone.
    const fcm = Object.create(FileCommentManager.prototype);
    fcm.prManager = { currentPR: { id: 1 } };
    const container = { querySelectorAll: vi.fn(() => []) };
    const cachedZone = {
      dataset: { fileName: 'src/off.js' },
      querySelector: (sel) => (sel === '.file-comments-container' ? container : null),
    };
    global.document = { querySelectorAll: vi.fn(() => []) }; // no live DOM zones
    fcm.findZoneForFile = vi.fn((f) => (f === 'src/off.js' ? cachedZone : null));
    fcm.displayUserComment = vi.fn();
    fcm.displayAISuggestion = vi.fn();
    fcm.updateCommentCount = vi.fn();

    fcm.loadFileComments([{ file: 'src/off.js', is_file_level: 1, body: 'c' }], []);

    expect(fcm.displayUserComment).toHaveBeenCalledWith(cachedZone, expect.objectContaining({ file: 'src/off.js' }));
    expect(fcm.updateCommentCount).toHaveBeenCalledWith(cachedZone);
  });
});

describe('FileCommentManager.saveFileComment routes through _registerOptimisticUserComment', () => {
  afterEach(() => { delete global.fetch; });

  it('registers the new file-level comment in the parent count-backing array', async () => {
    const fcm = Object.create(FileCommentManager.prototype);
    const registerSpy = vi.fn();
    fcm.prManager = { _registerOptimisticUserComment: registerSpy };
    fcm._getFileCommentEndpoint = vi.fn(() => ({ endpoint: '/api/x', requestBody: {} }));
    fcm.displayUserComment = vi.fn();
    fcm.hideCommentForm = vi.fn();
    fcm.updateCommentCount = vi.fn();
    const zone = { querySelector: () => null }; // no submit-btn guard, no card lookup
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 99 }) }));

    await fcm.saveFileComment(zone, 'a.js', 'hi');

    expect(registerSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: 99, file: 'a.js', body: 'hi', is_file_level: 1, source: 'user',
    }));
  });

  it('falls back to a bare updateCommentCount on an older PRManager without the register hook', async () => {
    const fcm = Object.create(FileCommentManager.prototype);
    const parentUpdate = vi.fn();
    fcm.prManager = { updateCommentCount: parentUpdate }; // no _registerOptimisticUserComment
    fcm._getFileCommentEndpoint = vi.fn(() => ({ endpoint: '/api/x', requestBody: {} }));
    fcm.displayUserComment = vi.fn();
    fcm.hideCommentForm = vi.fn();
    fcm.updateCommentCount = vi.fn();
    const zone = { querySelector: () => null };
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 7 }) }));

    await fcm.saveFileComment(zone, 'a.js', 'hi');

    expect(parentUpdate).toHaveBeenCalled();
  });
});

describe('FileCommentManager file-level adoption registers the new comment', () => {
  // The count is data-backed (PRManager._countActiveUserComments filters
  // prManager.userComments), so adoption must push into that array — a bare
  // parent updateCommentCount() would recompute from an array missing the
  // just-adopted comment and the count would stay off by one until reload.
  const suggestion = {
    id: 42, file: 'a.js', body: 'raw', type: 'bug', title: 'Nit',
  };

  function createAdoptingManager({ withRegisterHook = true } = {}) {
    const fcm = Object.create(FileCommentManager.prototype);
    const registerSpy = vi.fn();
    const parentUpdate = vi.fn();
    fcm.prManager = withRegisterHook
      ? { currentPR: { id: 1 }, _registerOptimisticUserComment: registerSpy, updateCommentCount: parentUpdate }
      : { currentPR: { id: 1 }, updateCommentCount: parentUpdate };
    fcm.displayUserComment = vi.fn();
    fcm.updateCommentCount = vi.fn();
    return { fcm, registerSpy, parentUpdate };
  }

  const zone = { querySelector: () => null }; // suggestion card / new card lookups miss

  afterEach(() => { delete global.fetch; });

  it('adoptAISuggestion registers the adopted comment with the count-backing shape', async () => {
    const { fcm, registerSpy, parentUpdate } = createAdoptingManager();
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ userCommentId: 101, formattedBody: '**Nit**\n\nraw' }),
    }));

    await fcm.adoptAISuggestion(zone, suggestion);

    expect(fcm.displayUserComment).toHaveBeenCalled();
    const commentData = registerSpy.mock.calls[0]?.[0];
    expect(commentData).toMatchObject({
      id: 101,
      file: 'a.js',
      body: '**Nit**\n\nraw',
      source: 'user',
      parent_id: 42,
      is_file_level: 1,
    });
    // Not counted as inactive by _countActiveUserComments.
    expect(commentData.status).not.toBe('inactive');
    // _registerOptimisticUserComment repaints the count itself.
    expect(parentUpdate).not.toHaveBeenCalled();
  });

  it('adoptWithEdit registers the edited adopted comment', async () => {
    const { fcm, registerSpy, parentUpdate } = createAdoptingManager();
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ userCommentId: 202, formattedBody: 'edited body' }),
    }));

    await fcm.adoptWithEdit(zone, suggestion, 'edited body');

    expect(fcm.displayUserComment).toHaveBeenCalled();
    expect(registerSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: 202, file: 'a.js', body: 'edited body', parent_id: 42, is_file_level: 1,
    }));
    expect(parentUpdate).not.toHaveBeenCalled();
  });

  it('falls back to a bare parent updateCommentCount without the register hook', async () => {
    const { fcm, parentUpdate } = createAdoptingManager({ withRegisterHook: false });
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ userCommentId: 303, formattedBody: 'b' }),
    }));

    await fcm.adoptAISuggestion(zone, suggestion);

    expect(parentUpdate).toHaveBeenCalled();
  });
});
