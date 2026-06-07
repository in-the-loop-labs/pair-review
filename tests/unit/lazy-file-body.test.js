// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for lazy diff-body rendering (the large-PR performance fix):
 *   - renderFileDiff() builds an EMPTY tbody and registers a lazy entry rather
 *     than rendering rows up front.
 *   - ensureFileBodyRendered() / _renderFileBodyNow() render a body on demand,
 *     idempotently, sharing one promise across concurrent callers, and skip
 *     hunk-anchor registration for bodies left over from a superseded render.
 *   - _createFileBodyObserver() degrades gracefully where IntersectionObserver
 *     is unavailable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function makeManager() {
  const m = Object.create(PRManager.prototype);
  m.generatedFiles = new Map();
  m.viewedFiles = new Set();
  m.collapsedFiles = new Set();
  m.summariesHiddenFiles = new Set();
  m._summariesEnabled = false; // skip per-file summary-toggle block
  m._renderGen = 1;
  m._lazyFileBodies = new Map();
  m.fileCommentManager = null; // skip the file-comments-zone block
  // Fake observer so renderFileDiff can observe() without a real IO.
  m._fileBodyObserver = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  // Stubs used by _renderFileBodyNow.
  m.renderPatch = vi.fn();
  m.validatePendingEofGaps = vi.fn();
  m._registerHunkAnchorsForFile = vi.fn();
  return m;
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.DiffRenderer = {
    createFileHeader: vi.fn(() => document.createElement('div')),
    updateFileHeaderState: vi.fn(),
    // ensureFileBodyRendered's fuzzy fallback resolves a non-canonical path
    // through findFileElement; default to a miss so the strict-map path is
    // what's under test unless a case overrides it.
    findFileElement: vi.fn(() => null)
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.DiffRenderer;
});

describe('PRManager.renderFileDiff lazy bodies', () => {
  it('builds an empty tbody and does not call renderPatch up front', () => {
    const m = makeManager();
    const wrapper = m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n', insertions: 1, deletions: 0 });

    expect(wrapper.querySelectorAll('tbody tr').length).toBe(0);
    expect(m.renderPatch).not.toHaveBeenCalled();

    const entry = m._lazyFileBodies.get('a.js');
    expect(entry).toBeTruthy();
    expect(entry.rendered).toBe(false);
    expect(entry.gen).toBe(1);
    // Body is observed so it renders when scrolled near.
    expect(m._fileBodyObserver.observe).toHaveBeenCalledWith(entry.fileBody);
  });

  it('reserves placeholder height for an expanded file but not a collapsed one', () => {
    const m = makeManager();
    const expandedWrapper = m.renderFileDiff({ file: 'open.js', patch: 'a\nb\nc\nd\n' });
    const expandedBody = expandedWrapper.querySelector('.d2h-file-body');
    expect(expandedBody.style.minHeight).not.toBe('');

    // A viewed file starts collapsed → display:none → no placeholder needed.
    m.viewedFiles.add('seen.js');
    const collapsedWrapper = m.renderFileDiff({ file: 'seen.js', patch: 'a\nb\nc\nd\n' });
    const collapsedBody = collapsedWrapper.querySelector('.d2h-file-body');
    expect(collapsedBody.style.minHeight).toBe('');
  });
});

describe('PRManager.ensureFileBodyRendered', () => {
  it('renders the body once, clears the placeholder, and is idempotent', async () => {
    const m = makeManager();
    m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' });

    const body = await m.ensureFileBodyRendered('a.js');
    expect(m.renderPatch).toHaveBeenCalledTimes(1);
    expect(m.renderPatch).toHaveBeenCalledWith(expect.anything(), '@@ -1 +1 @@\n+x\n', 'a.js', null);
    expect(m._lazyFileBodies.get('a.js').rendered).toBe(true);
    expect(body.style.minHeight).toBe('');

    // Second call is a no-op (no second render).
    const again = await m.ensureFileBodyRendered('a.js');
    expect(again).toBe(body);
    expect(m.renderPatch).toHaveBeenCalledTimes(1);
  });

  it('shares one render across concurrent callers', async () => {
    const m = makeManager();
    m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' });

    const [b1, b2] = await Promise.all([
      m.ensureFileBodyRendered('a.js'),
      m.ensureFileBodyRendered('a.js')
    ]);
    expect(b1).toBe(b2);
    expect(m.renderPatch).toHaveBeenCalledTimes(1);
  });

  it('resolves null for an unknown / not-lazy file', async () => {
    const m = makeManager();
    await expect(m.ensureFileBodyRendered('nope.js')).resolves.toBeNull();
  });

  it('resolves a non-canonical path via the findFileElement fuzzy fallback', async () => {
    const m = makeManager();
    m.renderFileDiff({ file: 'src/a.js', patch: '@@ -1 +1 @@\n+x\n' });
    const entry = m._lazyFileBodies.get('src/a.js');

    // Caller passes a non-canonical form ('./src/a.js'). The strict Map.get
    // misses, but findFileElement (which normalizes './', '/', rename syntax)
    // resolves the wrapper whose data-file-name is the canonical key.
    const wrapper = document.createElement('div');
    wrapper.dataset.fileName = 'src/a.js';
    window.DiffRenderer.findFileElement = vi.fn(() => wrapper);

    const body = await m.ensureFileBodyRendered('./src/a.js');
    expect(window.DiffRenderer.findFileElement).toHaveBeenCalledWith('./src/a.js');
    expect(body).toBe(entry.fileBody);
    expect(m.renderPatch).toHaveBeenCalledTimes(1);
  });

  it('renders a binary placeholder for binary entries', async () => {
    const m = makeManager();
    m.renderFileDiff({ file: 'img.png', binary: true });
    const body = await m.ensureFileBodyRendered('img.png');
    expect(body.querySelector('td.binary-file')).toBeTruthy();
    expect(m.renderPatch).not.toHaveBeenCalled();
  });

  it('skips hunk-anchor registration for a body from a superseded render', async () => {
    const m = makeManager();
    m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' });
    // Simulate a new render generation arriving before this body renders.
    m._renderGen = 2;

    await m.ensureFileBodyRendered('a.js');
    expect(m.renderPatch).toHaveBeenCalledTimes(1); // body still built
    expect(m._registerHunkAnchorsForFile).not.toHaveBeenCalled(); // but not anchored
  });
});

describe('PRManager._createFileBodyObserver', () => {
  it('returns null when IntersectionObserver is unavailable', () => {
    const m = Object.create(PRManager.prototype);
    const saved = global.IntersectionObserver;
    // eslint-disable-next-line no-global-assign
    delete global.IntersectionObserver;
    try {
      expect(m._createFileBodyObserver()).toBeNull();
    } finally {
      if (saved) global.IntersectionObserver = saved;
    }
  });

  it('creates an observer when IntersectionObserver is available', () => {
    const m = Object.create(PRManager.prototype);
    const observed = [];
    global.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; }
      observe(el) { observed.push(el); }
      unobserve() {}
      disconnect() {}
    };
    try {
      const obs = m._createFileBodyObserver();
      expect(obs).toBeTruthy();
      const el = document.createElement('div');
      obs.observe(el);
      expect(observed).toContain(el);
    } finally {
      delete global.IntersectionObserver;
    }
  });

  it('renders and unobserves a body when it intersects, and is a no-op otherwise', () => {
    const m = makeManager();
    // Capture the real intersection callback so we can drive it directly —
    // headless browsers can't reliably trigger intersection, so this is the
    // only place the scroll-driven render path gets exercised.
    let cb = null;
    let instance = null;
    global.IntersectionObserver = class {
      constructor(fn) {
        cb = fn;
        instance = this;
        this.observe = vi.fn();
        this.unobserve = vi.fn();
        this.disconnect = vi.fn();
      }
    };
    try {
      m._fileBodyObserver = m._createFileBodyObserver();
      m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' });
      const entry = m._lazyFileBodies.get('a.js');

      // Non-intersecting entry: filtered out — no render, no unobserve.
      cb([{ isIntersecting: false, target: entry.fileBody }], instance);
      expect(entry.rendered).toBe(false);
      expect(m.renderPatch).not.toHaveBeenCalled();
      expect(instance.unobserve).not.toHaveBeenCalled();

      // Intersecting entry: renders the body and stops observing it.
      cb([{ isIntersecting: true, target: entry.fileBody }], instance);
      expect(entry.rendered).toBe(true);
      expect(m.renderPatch).toHaveBeenCalledTimes(1);
      expect(instance.unobserve).toHaveBeenCalledWith(entry.fileBody);
    } finally {
      delete global.IntersectionObserver;
    }
  });
});
