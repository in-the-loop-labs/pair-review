// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Unit tests for lazy Pierre (@pierre/diffs) diff-body rendering — the Pierre
 * analogue of lazy-file-body.test.js. renderFileDiff()'s Pierre branch must
 * register an EMPTY placeholder body and observe it rather than calling
 * pierreBridge.renderFile() up front; the actual render is driven by
 * ensureFileBodyRendered() / the IntersectionObserver, via
 * _renderPierreFileBodyNow(). Covers:
 *   - initial render registers a lazy entry and does NOT call renderFile;
 *   - collapsed (viewed/generated) files reserve no height and never render
 *     until expanded;
 *   - ensureFileBodyRendered materializes the body once (idempotent, shared
 *     promise), clears the placeholder, wires hunk anchors, lands the file in
 *     pierreBridge.files;
 *   - intersection triggers the render;
 *   - a superseded render generation skips renderFile (no pierreBridge.files
 *     pollution);
 *   - annotations added before render are dropped by pierreBridge but retained
 *     once the caller materializes the body first (the contract callers rely on).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function makePierreBridge() {
  const files = new Map();
  return {
    _disabled: false,
    files,
    renderFile: vi.fn((fileName, container, patch, opts = {}) => {
      const state = {
        fileName,
        container,
        patch,
        annotations: [],
        collapsed: !!opts.collapsed,
        forcePlainText: !!opts.forcePlainText,
      };
      files.set(fileName, state);
      return state;
    }),
    renderBinaryFile: vi.fn((container) => {
      container.innerHTML = '<div class="pierre-binary-file">Binary file</div>';
    }),
    // Mirrors the real bridge: a no-op drop when the file hasn't rendered yet
    // (no fileState). This is exactly why callers must materialize the body
    // before adding annotations.
    addAnnotation: vi.fn((fileName, annotation) => {
      const state = files.get(fileName);
      if (!state) return;
      state.annotations.push(annotation);
    }),
  };
}

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
  m._fileBodyObserver = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  m.pierreBridge = makePierreBridge();
  // Isolate _renderPierreFileBodyNow's collaborators.
  m._registerPierreHunkAnchorsForFile = vi.fn();
  // _pierreUpgradeCandidates is null → _enqueuePierreContentUpgrade is a no-op.
  m._pierreUpgradeCandidates = null;
  m._fileContentsAbort = null;
  return m;
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.DiffRenderer = {
    createFileHeader: vi.fn(() => document.createElement('div')),
    updateFileHeaderState: vi.fn(),
    findFileElement: vi.fn(() => null),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.DiffRenderer;
  delete window.ScrollUtils;
});

describe('PRManager.renderFileDiff — lazy Pierre bodies', () => {
  it('registers a lazy pierre entry and does NOT call renderFile up front', () => {
    const m = makeManager();
    const wrapper = m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n', insertions: 1, deletions: 0 });

    expect(m.pierreBridge.renderFile).not.toHaveBeenCalled();
    expect(m._registerPierreHunkAnchorsForFile).not.toHaveBeenCalled();

    const body = wrapper.querySelector('.pierre-diff-body');
    expect(body).toBeTruthy();

    const entry = m._lazyFileBodies.get('a.js');
    expect(entry).toBeTruthy();
    expect(entry.pierre).toBe(true);
    expect(entry.rendered).toBe(false);
    expect(entry.gen).toBe(1);
    expect(entry.fileBody).toBe(body);
    // Body is observed so it renders when scrolled near.
    expect(m._fileBodyObserver.observe).toHaveBeenCalledWith(body);
  });

  it('reserves placeholder height for an expanded file but not a collapsed one', () => {
    const m = makeManager();
    const openWrapper = m.renderFileDiff({ file: 'open.js', patch: 'a\nb\nc\nd\n' });
    expect(openWrapper.querySelector('.pierre-diff-body').style.minHeight).not.toBe('');

    // A viewed file starts collapsed → display:none → no placeholder needed.
    m.viewedFiles.add('seen.js');
    const seenWrapper = m.renderFileDiff({ file: 'seen.js', patch: 'a\nb\nc\nd\n' });
    expect(seenWrapper.querySelector('.pierre-diff-body').style.minHeight).toBe('');
    // Still registered + observed, but NOT rendered.
    expect(m.pierreBridge.renderFile).not.toHaveBeenCalled();
    expect(m._lazyFileBodies.get('seen.js').rendered).toBe(false);
  });
});

describe('PRManager.ensureFileBodyRendered — pierre entries', () => {
  it('renders the body once, clears the placeholder, wires anchors, is idempotent', async () => {
    const m = makeManager();
    m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' });
    const entry = m._lazyFileBodies.get('a.js');

    const body = await m.ensureFileBodyRendered('a.js');
    expect(body).toBe(entry.fileBody);
    expect(m.pierreBridge.renderFile).toHaveBeenCalledTimes(1);
    expect(m.pierreBridge.renderFile).toHaveBeenCalledWith(
      'a.js', entry.fileBody, '@@ -1 +1 @@\n+x\n',
      { collapsed: false, forcePlainText: false }
    );
    expect(m._registerPierreHunkAnchorsForFile).toHaveBeenCalledTimes(1);
    expect(entry.rendered).toBe(true);
    expect(body.style.minHeight).toBe('');
    // File is now in pierreBridge.files so downstream annotation adds land.
    expect(m.pierreBridge.files.has('a.js')).toBe(true);

    const again = await m.ensureFileBodyRendered('a.js');
    expect(again).toBe(body);
    expect(m.pierreBridge.renderFile).toHaveBeenCalledTimes(1);
  });

  it('shares one render across concurrent callers', async () => {
    const m = makeManager();
    m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' });
    const [b1, b2] = await Promise.all([
      m.ensureFileBodyRendered('a.js'),
      m.ensureFileBodyRendered('a.js'),
    ]);
    expect(b1).toBe(b2);
    expect(m.pierreBridge.renderFile).toHaveBeenCalledTimes(1);
  });

  it('renders a collapsed file with collapsed:true (setCollapsed rerenders on expand)', async () => {
    const m = makeManager();
    m.viewedFiles.add('seen.js');
    m.renderFileDiff({ file: 'seen.js', patch: '@@ -1 +1 @@\n+x\n' });

    await m.ensureFileBodyRendered('seen.js');
    expect(m.pierreBridge.renderFile).toHaveBeenCalledWith(
      'seen.js', expect.anything(), '@@ -1 +1 @@\n+x\n',
      { collapsed: true, forcePlainText: false }
    );
  });

  it('routes a binary file (no patch) through the legacy path, not the pierre branch', async () => {
    // _getPierreRenderDecision returns usePierre:false when !file.patch, so a
    // binary file never enters the Pierre branch — it registers a legacy lazy
    // entry and renders the legacy binary <td>. (The eager Pierre branch's
    // renderBinaryFile call was likewise unreachable for the same reason.)
    const m = makeManager();
    m.renderFileDiff({ file: 'img.png', binary: true });
    const entry = m._lazyFileBodies.get('img.png');
    expect(entry.pierre).toBeUndefined();

    const body = await m.ensureFileBodyRendered('img.png');
    expect(m.pierreBridge.renderFile).not.toHaveBeenCalled();
    expect(m.pierreBridge.renderBinaryFile).not.toHaveBeenCalled();
    expect(body.querySelector('td.binary-file')).toBeTruthy();
  });

  it('skips renderFile for a body from a superseded render generation', async () => {
    const m = makeManager();
    m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' });
    // A new render generation arrives before this body renders.
    m._renderGen = 2;

    const body = await m.ensureFileBodyRendered('a.js');
    const entry = m._lazyFileBodies.get('a.js');
    expect(entry.rendered).toBe(true);          // marked done...
    expect(body.style.minHeight).toBe('');
    expect(m.pierreBridge.renderFile).not.toHaveBeenCalled();     // ...but not rendered
    expect(m.pierreBridge.files.has('a.js')).toBe(false);          // no bridge pollution
    expect(m._registerPierreHunkAnchorsForFile).not.toHaveBeenCalled();
  });
});

describe('PRManager pierre lazy render — annotation safety (hazard 2)', () => {
  it('drops an annotation added before render, retains it once materialized', async () => {
    const m = makeManager();
    m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' });

    // Pre-render: the file is not yet in pierreBridge.files, so a direct
    // addAnnotation is dropped (mirrors the real bridge). Callers must NOT do
    // this — they materialize first; assert the drop so the contract is explicit.
    m.pierreBridge.addAnnotation('a.js', { lineNumber: 1, side: 'RIGHT', type: 'comment', id: 'c1' });
    expect(m.pierreBridge.files.has('a.js')).toBe(false);

    // Materialize the body first (what ensureLinesVisible / suggestion-manager
    // now do before adding annotations), then add — it is retained.
    await m.ensureFileBodyRendered('a.js');
    m.pierreBridge.addAnnotation('a.js', { lineNumber: 1, side: 'RIGHT', type: 'comment', id: 'c2' });
    const state = m.pierreBridge.files.get('a.js');
    expect(state.annotations.map(a => a.id)).toEqual(['c2']);
  });
});

describe('PRManager pierre lazy render — background content upgrade (hazard 7)', () => {
  it('enqueues a file for content upgrade only when its body renders', async () => {
    const m = makeManager();
    m.currentPR = { id: 42 };
    const started = [];
    // Capture what the queue is asked to process without touching the network.
    m._startFileContentUpgradeQueue = vi.fn((files) => {
      started.push(...files.map(f => f.file));
    });
    m._drainFileContentUpgradeQueue = vi.fn();

    const files = [
      { file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' },
      { file: 'b.js', patch: '@@ -1 +1 @@\n+y\n' },
    ];
    m.renderFileDiff(files[0]);
    m.renderFileDiff(files[1]);

    // Establishes the candidate set + abort signal. At this point nothing has
    // rendered, so the queue must NOT have been seeded with anything.
    m._upgradeFilesWithContents(files);
    expect(m._fileContentsAbort).toBeTruthy();
    expect(started).toEqual([]);

    // a.js renders → it (and only it) is enqueued.
    await m.ensureFileBodyRendered('a.js');
    expect(started).toEqual(['a.js']);

    // b.js renders later → enqueued too.
    await m.ensureFileBodyRendered('b.js');
    expect(started).toEqual(['a.js', 'b.js']);
  });

  it('does not enqueue a non-candidate file, and de-dupes an in-flight file', () => {
    const m = makeManager();
    m.currentPR = { id: 42 };
    m._fileContentsAbort = new AbortController();
    m._pierreUpgradeCandidates = new Set(['a.js']);
    const state = { pending: [], inFlight: new Set(), completed: new Set(), signal: m._fileContentsAbort.signal };
    m._fileContentsUpgradeState = state;
    m._drainFileContentUpgradeQueue = vi.fn();

    // Not a candidate → ignored.
    m._enqueuePierreContentUpgrade({ file: 'z.js', patch: 'p' });
    expect(state.pending).toEqual([]);

    // Candidate, no queue entry yet → pushed once.
    m._enqueuePierreContentUpgrade({ file: 'a.js', patch: 'p' });
    expect(state.pending.map(f => f.file)).toEqual(['a.js']);

    // Already pending → not pushed again.
    m._enqueuePierreContentUpgrade({ file: 'a.js', patch: 'p' });
    expect(state.pending.map(f => f.file)).toEqual(['a.js']);

    // Already in-flight → not re-pushed.
    state.pending.length = 0;
    state.inFlight.add('a.js');
    m._enqueuePierreContentUpgrade({ file: 'a.js', patch: 'p' });
    expect(state.pending).toEqual([]);
  });

  it('does not enqueue when the upgrade signal is aborted', () => {
    const m = makeManager();
    m._pierreUpgradeCandidates = new Set(['a.js']);
    const controller = new AbortController();
    controller.abort();
    m._fileContentsAbort = controller;
    m._startFileContentUpgradeQueue = vi.fn();
    m._enqueuePierreContentUpgrade({ file: 'a.js', patch: 'p' });
    expect(m._startFileContentUpgradeQueue).not.toHaveBeenCalled();
  });
});

describe('PRManager.scrollToFile — Pierre content-upgrade priority hint', () => {
  it('prioritizes a not-yet-rendered file AFTER its body renders (not the silent no-op)', async () => {
    const m = makeManager();
    window.ScrollUtils = { scrollIntoViewStable: vi.fn(async () => {}) };

    // A live upgrade queue already holding some other file. The scroll target
    // is a candidate but has NOT rendered yet, so it is absent from pending —
    // exactly the lazy-render state the fix must handle.
    const controller = new AbortController();
    m._fileContentsAbort = controller;
    m._pierreUpgradeCandidates = new Set(['target.js', 'other.js']);
    const state = {
      pending: [{ file: 'other.js', patch: 'p' }],
      inFlight: new Set(),
      completed: new Set(),
      signal: controller.signal,
    };
    m._fileContentsUpgradeState = state;
    // Keep the queue inert: we assert on pending ordering, not on real fetches.
    m._drainFileContentUpgradeQueue = vi.fn();

    // Lay down the lazy wrapper and expose it to findFileElement (uncollapsed).
    const wrapper = m.renderFileDiff({ file: 'target.js', patch: '@@ -1 +1 @@\n+x\n' });
    window.DiffRenderer.findFileElement = vi.fn(() => wrapper);

    // Prioritizing BEFORE the body renders is the silent no-op the fix guards
    // against: target.js is not in pending yet, so findIndex misses it.
    expect(m._prioritizePierreContentUpgrade('target.js')).toBe(false);
    expect(state.pending.map(f => f.file)).toEqual(['other.js']);

    await m.scrollToFile('target.js');

    // scrollToFile rendered the body (enqueuing target.js at the tail) and only
    // THEN prioritized it → it now sits at the FRONT of the queue.
    expect(m._lazyFileBodies.get('target.js').rendered).toBe(true);
    expect(state.pending.map(f => f.file)).toEqual(['target.js', 'other.js']);
  });

  it('gives a collapsed file no priority hint and does not render its body', async () => {
    const m = makeManager();
    window.ScrollUtils = { scrollIntoViewStable: vi.fn(async () => {}) };

    const wrapper = m.renderFileDiff({ file: 'target.js', patch: '@@ -1 +1 @@\n+x\n' });
    wrapper.classList.add('collapsed');
    window.DiffRenderer.findFileElement = vi.fn(() => wrapper);

    const ensureSpy = vi.spyOn(m, 'ensureFileBodyRendered');
    const prioritizeSpy = vi.spyOn(m, '_prioritizePierreContentUpgrade');

    await m.scrollToFile('target.js');

    // Hidden body → no forced render, no reorder (nothing to upgrade).
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(prioritizeSpy).not.toHaveBeenCalled();
    expect(m._lazyFileBodies.get('target.js').rendered).toBe(false);
  });
});

describe('PRManager pierre lazy render — IntersectionObserver', () => {
  it('renders and unobserves a pierre body when it intersects', () => {
    const m = makeManager();
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
      const wrapper = m.renderFileDiff({ file: 'a.js', patch: '@@ -1 +1 @@\n+x\n' });
      document.body.appendChild(wrapper); // so closest('.d2h-file-wrapper') resolves
      const entry = m._lazyFileBodies.get('a.js');

      // Not intersecting: no render.
      cb([{ isIntersecting: false, target: entry.fileBody }], instance);
      expect(entry.rendered).toBe(false);
      expect(m.pierreBridge.renderFile).not.toHaveBeenCalled();

      // Intersecting: renders and stops observing.
      cb([{ isIntersecting: true, target: entry.fileBody }], instance);
      expect(entry.rendered).toBe(true);
      expect(m.pierreBridge.renderFile).toHaveBeenCalledTimes(1);
      expect(instance.unobserve).toHaveBeenCalledWith(entry.fileBody);
    } finally {
      delete global.IntersectionObserver;
    }
  });
});
