// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

  it('resolves file-level items through the zone registry before rendering', () => {
    const fileCommentManager = createTestFileCommentManager();
    const container = {
      querySelectorAll: vi.fn().mockReturnValue([])
    };
    const zone = {
      dataset: { fileName: 'src/file.js' },
      querySelector: vi.fn(selector => selector === '.file-comments-container' ? container : null)
    };

    // The document is never asked for zones: a zone need not be attached.
    global.document = {
      querySelectorAll: vi.fn(() => { throw new Error('zones must come from the registry'); }),
      querySelector: vi.fn(() => { throw new Error('zones must come from the registry'); })
    };
    global.window.DiffRenderer = {
      normalizeFilePath: path => path.replace(/^\.\//, ''),
      pathsMatch: (a, b) => a === b
    };

    fileCommentManager._registerZone(zone, 'src/file.js', false);
    fileCommentManager.displayAISuggestion = vi.fn();
    fileCommentManager.displayUserComment = vi.fn();
    fileCommentManager.updateCommentCount = vi.fn();

    const comment = { file: './src/file.js', is_file_level: 1, body: 'User comment' };
    const suggestion = { file: './src/file.js', is_file_level: 1, body: 'AI suggestion' };

    fileCommentManager.loadFileComments([comment], [suggestion]);

    expect(fileCommentManager.displayAISuggestion).toHaveBeenCalledWith(zone, suggestion);
    expect(fileCommentManager.displayUserComment).toHaveBeenCalledWith(zone, comment);
    expect(fileCommentManager.updateCommentCount).toHaveBeenCalledWith(zone);
    delete global.window.DiffRenderer;
  });
});

describe('FileCommentManager zone registry', () => {
  const diffRenderer = {
    normalizeFilePath: path => (path || '').replace(/^\.\//, ''),
    pathsMatch: (a, b) => !!a && !!b && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`))
  };
  const zoneFor = fileName => ({ dataset: { fileName } });

  beforeEach(() => {
    global.window.DiffRenderer = diffRenderer;
  });

  afterEach(() => {
    delete global.document;
    delete global.window.DiffRenderer;
  });

  it('createFileCommentsZone registers the zone it creates, attached or not', () => {
    const created = [];
    global.document = {
      createElement: vi.fn(() => {
        const element = { dataset: {}, className: '', children: [], appendChild(child) { this.children.push(child); } };
        created.push(element);
        return element;
      })
    };
    const fileCommentManager = createTestFileCommentManager();

    const zone = fileCommentManager.createFileCommentsZone('src/a.js');

    expect(zone.className).toBe('file-comments-zone');
    expect(zone.dataset.fileName).toBe('src/a.js');
    expect(fileCommentManager.getZone('src/a.js')).toBe(zone);
    expect(fileCommentManager.findZoneForFile('src/a.js')).toBe(zone);
  });

  it('resolves the exact path, a normalized path and a tolerant path match', () => {
    const fileCommentManager = createTestFileCommentManager();
    const zone = zoneFor('src/file.js');
    fileCommentManager._registerZone(zone, 'src/file.js', false);

    expect(fileCommentManager.getZone('src/file.js')).toBe(zone);
    expect(fileCommentManager.getZone('./src/file.js')).toBe(zone);
    expect(fileCommentManager.getZone('file.js')).toBe(zone);
  });

  it('prefers a changed file\'s zone over a context entry\'s zone for the same path', () => {
    const fileCommentManager = createTestFileCommentManager();
    const contextZone = zoneFor('src/file.js');
    const diffZone = zoneFor('src/file.js');
    fileCommentManager._registerZone(contextZone, 'src/file.js', true);
    expect(fileCommentManager.getZone('src/file.js')).toBe(contextZone);

    fileCommentManager._registerZone(diffZone, 'src/file.js', false);
    expect(fileCommentManager.getZone('src/file.js')).toBe(diffZone);
  });

  it('returns null for a missing path, an unknown path and an empty registry', () => {
    const fileCommentManager = createTestFileCommentManager();
    expect(fileCommentManager.getZone('src/file.js')).toBeNull();
    fileCommentManager._registerZone(zoneFor('src/file.js'), 'src/file.js', false);
    expect(fileCommentManager.getZone('')).toBeNull();
    expect(fileCommentManager.getZone(undefined)).toBeNull();
    expect(fileCommentManager.getZone('other/thing.js')).toBeNull();
  });

  it('works without DiffRenderer: exact paths only', () => {
    delete global.window.DiffRenderer;
    const fileCommentManager = createTestFileCommentManager();
    const zone = zoneFor('src/file.js');
    const contextZone = zoneFor('docs/readme.md');
    fileCommentManager._registerZone(zone, 'src/file.js', false);
    fileCommentManager._registerZone(contextZone, 'docs/readme.md', true);

    expect(fileCommentManager.getZone('src/file.js')).toBe(zone);
    expect(fileCommentManager.getZone('docs/readme.md')).toBe(contextZone);
    expect(fileCommentManager.getZone('./src/file.js')).toBeNull();
  });

  it('forEachZone visits every zone in creation order and tolerates a zone released during the sweep', () => {
    const fileCommentManager = createTestFileCommentManager();
    const first = zoneFor('a.js');
    const second = zoneFor('b.js');
    fileCommentManager._registerZone(first, 'a.js', false);
    fileCommentManager._registerZone(second, 'b.js', true);

    const seen = [];
    fileCommentManager.forEachZone((zone, fileName) => {
      seen.push([zone, fileName]);
      fileCommentManager.releaseZone(second);
    });

    expect(seen).toEqual([[first, 'a.js'], [second, 'b.js']]);
    expect(fileCommentManager.getZone('b.js')).toBeNull();
    expect(() => fileCommentManager.forEachZone(null)).not.toThrow();
  });

  it('releaseZone forgets one zone and releaseAllZones forgets them all', () => {
    const fileCommentManager = createTestFileCommentManager();
    const first = zoneFor('a.js');
    const second = zoneFor('b.js');
    fileCommentManager._registerZone(first, 'a.js', false);
    fileCommentManager._registerZone(second, 'b.js', false);

    fileCommentManager.releaseZone(first);
    fileCommentManager.releaseZone(null);
    expect(fileCommentManager.getZone('a.js')).toBeNull();
    expect(fileCommentManager.getZone('b.js')).toBe(second);

    fileCommentManager.releaseAllZones();
    expect(fileCommentManager.getZone('b.js')).toBeNull();
    const seen = [];
    fileCommentManager.forEachZone(zone => seen.push(zone));
    expect(seen).toEqual([]);
  });
});
