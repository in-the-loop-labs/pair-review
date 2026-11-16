// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * PRManager.revealInDiff: the one navigation helper.
 *
 * Its callers (the review panel's three jumps, the suggestion navigator,
 * the tour) each used to carry a copy of this sequence and their own DOM
 * lookups. These tests pin the sequence, the cancellation after every
 * await, and where the card comes from: the bridge (by annotation id, after
 * waiting for the diff to attach it), then the file's comment zone, then
 * the caller's last resort.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { makePageManager } = require('../utils/page-manager.js');
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');

function attached(className = 'card') {
  const element = document.createElement('div');
  element.className = className;
  element.scrollIntoView = vi.fn();
  document.body.appendChild(element);
  return element;
}

/** A bridge stub exposing what revealInDiff asks of the bridge. */
function bridgeWith(card, { file = 'a.js', id = 'comment-1' } = {}) {
  return {
    findAnnotationFile: vi.fn((annotationId) => (annotationId === id ? file : null)),
    whenAnnotationRendered: vi.fn(async () => card),
  };
}

function makeManager(overrides = {}) {
  return makePageManager({
    ensureFileBodyRendered: vi.fn(async () => null),
    ensureLinesVisible: vi.fn(async () => {}),
    ...overrides,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  delete window.ScrollUtils;
  vi.restoreAllMocks();
});

describe('PRManager.revealInDiff: the sequence', () => {
  it('expands, renders the body, reveals the lines, resolves the card and scrolls, in that order', async () => {
    const order = [];
    const card = attached();
    card.scrollIntoView.mockImplementation(() => order.push('scroll'));
    const bridge = bridgeWith(card);
    bridge.whenAnnotationRendered.mockImplementation(async () => { order.push('card'); return card; });
    const manager = makeManager({
      pierreBridge: bridge,
      isFileCollapsed: vi.fn(() => true),
      setFileCollapsed: vi.fn(async () => { order.push('expand'); return true; }),
      ensureFileBodyRendered: vi.fn(async () => { order.push('render'); }),
      ensureLinesVisible: vi.fn(async () => { order.push('lines'); }),
    });

    const result = await manager.revealInDiff({
      file: 'a.js', line_start: 10, line_end: 12, side: 'LEFT', annotationId: 'comment-1',
      prepare: () => order.push('prepare'),
    });

    expect(order).toEqual(['expand', 'render', 'lines', 'card', 'prepare', 'scroll']);
    expect(manager.setFileCollapsed).toHaveBeenCalledWith('a.js', false);
    expect(manager.ensureLinesVisible).toHaveBeenCalledWith([{ file: 'a.js', line_start: 10, line_end: 12, side: 'LEFT' }]);
    expect(bridge.whenAnnotationRendered).toHaveBeenCalledWith('a.js', 'comment-1', { isCancelled: expect.any(Function) });
    expect(card.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(result).toEqual({ element: card, cancelled: false });
  });

  it('expands a collapsed file reached by a path that is not in the diff\'s own form', async () => {
    // A finding carries its path as the model wrote it ('./src/a.js' for the
    // changed file 'src/a.js'). The real collapse reader and writer run here,
    // over the real file-element lookup.
    const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');
    vi.spyOn(DiffRenderer, 'updateFileHeaderState').mockImplementation(() => {});
    window.DiffRenderer = DiffRenderer;
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper collapsed';
    wrapper.dataset.fileName = 'src/a.js';
    wrapper.innerHTML = '<div class="d2h-file-header"></div>';
    document.body.appendChild(wrapper);
    const card = attached();
    const bridge = {
      ...bridgeWith(card, { file: 'src/a.js' }),
      files: new Map([['src/a.js', {}]]),
      setCollapsed: vi.fn(),
    };
    const manager = makeManager({
      pierreBridge: bridge,
      changedFilesByPath: new Map([['src/a.js', {}]]),
      collapsedFiles: new Set(['src/a.js']),
      findFileElement: (file) => DiffRenderer.findFileElement(file),
    });

    try {
      const result = await manager.revealInDiff({ file: './src/a.js', line_start: 3, annotationId: 'comment-1' });

      expect(result).toEqual({ element: card, cancelled: false });
      expect(wrapper.classList.contains('collapsed')).toBe(false);
      expect([...manager.collapsedFiles]).toEqual([]);
      expect(bridge.setCollapsed.mock.calls).toEqual([['src/a.js', false]]);
      expect(manager.isFileCollapsed('src/a.js')).toBe(false);
    } finally {
      delete window.DiffRenderer;
    }
  });

  it('leaves an expanded file alone, and reveals no lines when none are given', async () => {
    const card = attached();
    const manager = makeManager({
      pierreBridge: bridgeWith(card),
      isFileCollapsed: vi.fn(() => false),
      setFileCollapsed: vi.fn(),
    });

    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });

    expect(manager.setFileCollapsed).not.toHaveBeenCalled();
    expect(manager.ensureFileBodyRendered).toHaveBeenCalledWith('a.js');
    expect(manager.ensureLinesVisible).not.toHaveBeenCalled();
  });

  it('parses line numbers given as strings, defaults the end to the start and the side to RIGHT', async () => {
    const manager = makeManager({ findElement: undefined });
    await manager.revealInDiff({ file: 'a.js', line_start: '30' });
    expect(manager.ensureLinesVisible).toHaveBeenCalledWith([{ file: 'a.js', line_start: 30, line_end: 30, side: 'RIGHT' }]);

    manager.ensureLinesVisible.mockClear();
    await manager.revealInDiff({ file: 'a.js', line_start: 'not a number' });
    await manager.revealInDiff({ file: 'a.js', line_start: '' });
    expect(manager.ensureLinesVisible).not.toHaveBeenCalled();
  });

  it('uses the stable scroll when it is there, with the caller\'s options', async () => {
    window.ScrollUtils = { scrollIntoViewStable: vi.fn() };
    const card = attached();
    const manager = makeManager({ pierreBridge: bridgeWith(card) });

    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', scroll: { behavior: 'auto', block: 'center' } });

    expect(window.ScrollUtils.scrollIntoViewStable).toHaveBeenCalledWith(card, { behavior: 'auto', block: 'center' });
    expect(card.scrollIntoView).not.toHaveBeenCalled();
  });

  it('scroll: false resolves the card and scrolls nothing', async () => {
    const card = attached();
    const manager = makeManager({ pierreBridge: bridgeWith(card) });

    const result = await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', scroll: false });

    expect(result.element).toBe(card);
    expect(card.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('PRManager.revealInDiff: where the card comes from', () => {
  it('looks for the annotation in the given file first, then wherever it is', async () => {
    const card = attached();
    const bridge = bridgeWith(card, { file: 'elsewhere.js' });
    const manager = makeManager({ pierreBridge: bridge });

    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });

    expect(bridge.findAnnotationFile).toHaveBeenCalledWith('comment-1', 'a.js');
    expect(bridge.whenAnnotationRendered).toHaveBeenCalledWith('elsewhere.js', 'comment-1', expect.anything());
  });

  it('takes a card from the file\'s comment zone, then from any zone, attached or not', async () => {
    const manager = makeManager();
    manager.fileCommentManager = Object.create(FileCommentManager.prototype);
    const zoneA = attached('file-comments-zone');
    zoneA.innerHTML = '<div class="file-comment-card" data-comment-id="5"></div>';
    const zoneB = attached('file-comments-zone');
    zoneB.innerHTML = '<div class="file-comment-card" data-comment-id="6"></div>';
    manager.fileCommentManager._registerZone(zoneA, 'a.js', false);
    manager.fileCommentManager._registerZone(zoneB, 'b.js', false);
    for (const card of document.querySelectorAll('.file-comment-card')) card.scrollIntoView = vi.fn();

    const own = await manager.revealInDiff({ file: 'a.js', zoneCardSelector: '.file-comment-card[data-comment-id="5"]' });
    expect(own.element).toBe(zoneA.firstElementChild);

    // The caller named the wrong file: the card is still found by its selector.
    const other = await manager.revealInDiff({ file: 'a.js', zoneCardSelector: '.file-comment-card[data-comment-id="6"]' });
    expect(other.element).toBe(zoneB.firstElementChild);
  });

  it('falls back to findElement only when the bridge and the zones have nothing', async () => {
    const row = attached('user-comment-row');
    const findElement = vi.fn(() => row);
    const card = attached();
    const withAnnotation = makeManager({ pierreBridge: bridgeWith(card) });
    await withAnnotation.revealInDiff({ file: 'a.js', annotationId: 'comment-1', findElement });
    expect(findElement).not.toHaveBeenCalled();

    const without = makeManager({ pierreBridge: bridgeWith(card) });
    const result = await without.revealInDiff({ file: 'ctx.js', annotationId: 'comment-404', findElement });
    expect(findElement).toHaveBeenCalledTimes(1);
    expect(result.element).toBe(row);
    expect(row.scrollIntoView).toHaveBeenCalled();
  });

  it('reports no element, and scrolls nothing, when nothing is found', async () => {
    const manager = makeManager();
    await expect(manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', findElement: () => null }))
      .resolves.toEqual({ element: null, cancelled: false });
    await expect(manager.revealInDiff({ file: 'a.js' })).resolves.toEqual({ element: null, cancelled: false });
    await expect(manager.revealInDiff()).resolves.toEqual({ element: null, cancelled: false });
  });

  it('treats a card that is still not attached after the wait as not revealed', async () => {
    const detached = document.createElement('div');
    detached.scrollIntoView = vi.fn();
    const prepare = vi.fn();
    const manager = makeManager({ pierreBridge: bridgeWith(null) });

    const result = await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', findElement: () => detached, prepare });

    expect(result).toEqual({ element: null, cancelled: false });
    expect(prepare).not.toHaveBeenCalled();
    expect(detached.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('PRManager.revealInDiff: minimize mode', () => {
  it('expands the card\'s line and scrolls to that line instead of the hidden card', async () => {
    const line = attached('annotation-slot');
    const card = attached();
    const minimizer = { active: true, expandForElement: vi.fn(), findDiffRowFor: vi.fn(() => line) };
    const manager = makeManager({ pierreBridge: bridgeWith(card), commentMinimizer: minimizer });

    const result = await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });

    expect(minimizer.expandForElement).toHaveBeenCalledWith(card);
    expect(line.scrollIntoView).toHaveBeenCalled();
    expect(card.scrollIntoView).not.toHaveBeenCalled();
    // The caller still gets the card: that is what it flashes.
    expect(result.element).toBe(card);
  });

  it('scrolls to a card that has no line (a file-level card), and to the card itself when minimize is off or not wanted', async () => {
    const card = attached();
    const minimizer = { active: true, expandForElement: vi.fn(), findDiffRowFor: vi.fn(() => null) };
    const manager = makeManager({ pierreBridge: bridgeWith(card), commentMinimizer: minimizer });

    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(card.scrollIntoView).toHaveBeenCalledTimes(1);

    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', expandMinimized: false });
    expect(minimizer.expandForElement).toHaveBeenCalledTimes(1);
    expect(card.scrollIntoView).toHaveBeenCalledTimes(2);

    minimizer.active = false;
    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(minimizer.expandForElement).toHaveBeenCalledTimes(1);
  });
});

describe('PRManager.revealInDiff: cancellation and errors', () => {
  it.each([
    ['the file is prepared', 'ensureFileBodyRendered'],
    ['the lines are revealed', 'ensureLinesVisible'],
  ])('stops after %s when a newer navigation took over', async (_, method) => {
    let cancelled = false;
    const card = attached();
    const bridge = bridgeWith(card);
    const manager = makeManager({ pierreBridge: bridge });
    manager[method] = vi.fn(async () => { cancelled = true; });

    const result = await manager.revealInDiff({
      file: 'a.js', line_start: 3, annotationId: 'comment-1', isCancelled: () => cancelled,
    });

    expect(result).toEqual({ element: null, cancelled: true });
    expect(bridge.whenAnnotationRendered).not.toHaveBeenCalled();
    expect(card.scrollIntoView).not.toHaveBeenCalled();
  });

  it('stops after the wait for the card when a newer navigation took over', async () => {
    let cancelled = false;
    const card = attached();
    const bridge = bridgeWith(card);
    bridge.whenAnnotationRendered.mockImplementation(async () => { cancelled = true; return card; });
    const manager = makeManager({ pierreBridge: bridge });

    const result = await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', isCancelled: () => cancelled });

    expect(result.cancelled).toBe(true);
    expect(card.scrollIntoView).not.toHaveBeenCalled();
  });

  it('hands its cancel check to the wait for the card', async () => {
    let cancelled = false;
    const bridge = bridgeWith(attached());
    const manager = makeManager({ pierreBridge: bridge });
    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', isCancelled: () => cancelled });
    const { isCancelled } = bridge.whenAnnotationRendered.mock.calls[0][2];
    expect(isCancelled()).toBe(false);
    cancelled = true;
    expect(isCancelled()).toBe(true);
  });

  it('still looks for the card when the file could not be prepared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const card = attached();
    const manager = makeManager({
      pierreBridge: bridgeWith(card),
      ensureFileBodyRendered: vi.fn(async () => { throw new Error('render failed'); }),
    });

    const result = await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });

    expect(warn).toHaveBeenCalled();
    expect(result.element).toBe(card);
    expect(card.scrollIntoView).toHaveBeenCalled();
  });

  it('lets a failing line reveal reach the caller', async () => {
    const manager = makeManager({ ensureLinesVisible: vi.fn(async () => { throw new Error('reveal failed'); }) });
    await expect(manager.revealInDiff({ file: 'a.js', line_start: 3 })).rejects.toThrow('reveal failed');
  });
});

describe('PRManager.revealInDiff on the virtualized viewer: what is not mounted', () => {
  /**
   * A bridge stub of the virtualized viewer. The viewer draws a card once it
   * was told to go to it. "Drawn" is its own state, not "in the document":
   * the card of a line outside a long file's row window is in the document
   * and not drawn (`bridge.outsideRowWindow(element)`).
   */
  function viewerBridge({ file = 'a.js', id = 'comment-1', card, zoneFiles = [] } = {}) {
    const notDrawn = new Set();
    const bridge = {
      files: new Map([[file, { kind: 'diff' }], ...zoneFiles.map((name) => [name, { kind: 'diff' }])]),
      findAnnotationFile: vi.fn((annotationId) => (annotationId === id ? file : null)),
      getAnnotationElement: vi.fn(() => card),
      isElementDrawn: vi.fn((element) => !!element && element.isConnected && !notDrawn.has(element)),
      scrollToAnnotation: vi.fn(() => {
        if (card) {
          document.body.appendChild(card);
          notDrawn.delete(card);
        }
        return true;
      }),
      whenAnnotationRendered: vi.fn(async () => (bridge.isElementDrawn(card) ? card : null)),
      scrollToItem: vi.fn(() => true),
      whenElementDrawn: vi.fn(async (element) => bridge.isElementDrawn(element)),
      outsideRowWindow: (element) => { notDrawn.add(element); },
    };
    return bridge;
  }
  const detached = () => {
    const element = document.createElement('div');
    element.scrollIntoView = vi.fn();
    return element;
  };

  it('takes the pane to a card that is not in the document, waits for it, then scrolls to it', async () => {
    const card = detached();
    const bridge = viewerBridge({ card });
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge });
    const result = await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(bridge.scrollToAnnotation).toHaveBeenCalledWith('a.js', 'comment-1');
    expect(bridge.scrollToAnnotation.mock.invocationCallOrder[0]).toBeLessThan(bridge.whenAnnotationRendered.mock.invocationCallOrder[0]);
    expect(result).toEqual({ element: card, cancelled: false });
    expect(card.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('takes the pane to a card that is in the document without being drawn: a line outside a long file\'s row window', async () => {
    const card = attached();
    const bridge = viewerBridge({ card });
    bridge.outsideRowWindow(card);
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge });
    const result = await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(bridge.scrollToAnnotation).toHaveBeenCalledWith('a.js', 'comment-1');
    expect(bridge.scrollToAnnotation.mock.invocationCallOrder[0]).toBeLessThan(bridge.whenAnnotationRendered.mock.invocationCallOrder[0]);
    expect(result).toEqual({ element: card, cancelled: false });
    expect(card.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('answers with no card, and scrolls to nothing, when the viewer never draws the card', async () => {
    const card = attached();
    const bridge = viewerBridge({ card });
    bridge.outsideRowWindow(card);
    // The pane was taken there and the wait ran out.
    bridge.scrollToAnnotation = vi.fn(() => true);
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge });
    const result = await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(bridge.scrollToAnnotation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ element: null, cancelled: false });
    expect(card.scrollIntoView).not.toHaveBeenCalled();
  });

  it('hands over a card that is attached while its file\'s new diff awaits display: the scroll waits for its box', async () => {
    const card = attached();
    const bridge = viewerBridge({ card });
    bridge.outsideRowWindow(card);
    // The bridge's answers for that state: nothing to send, and the card as it is.
    bridge.scrollToAnnotation = vi.fn(() => true);
    bridge.whenAnnotationRendered = vi.fn(async () => card);
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge });
    const result = await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(result).toEqual({ element: card, cancelled: false });
    expect(card.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('moves nothing for a card that is drawn already', async () => {
    const card = attached();
    const bridge = viewerBridge({ card });
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge });
    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(bridge.scrollToAnnotation).not.toHaveBeenCalled();
    expect(card.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('the per-file renderer is never asked to go to an annotation', async () => {
    const card = attached();
    const bridge = { ...viewerBridge({ card }), scrollToAnnotation: vi.fn() };
    const manager = makeManager({ pierreBridge: bridge });
    card.remove();
    bridge.whenAnnotationRendered = vi.fn(async () => null);
    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(bridge.scrollToAnnotation).not.toHaveBeenCalled();
  });

  it('a card in a comment zone of a file that is not mounted: the pane goes to the file first', async () => {
    const fileCommentManager = new FileCommentManager({});
    const zone = fileCommentManager.createFileCommentsZone('far.js');
    const card = document.createElement('div');
    card.className = 'file-comment-card';
    card.dataset.commentId = '7';
    card.scrollIntoView = vi.fn();
    (zone.querySelector('.file-comments-container') || zone).appendChild(card);
    const bridge = viewerBridge({ zoneFiles: ['far.js'] });
    bridge.findAnnotationFile = vi.fn(() => null);
    // The viewer mounts the file: its zone is drawn from then on.
    bridge.whenElementDrawn = vi.fn(async () => { document.body.appendChild(zone); return true; });
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge, fileCommentManager });
    const result = await manager.revealInDiff({ file: 'far.js', zoneCardSelector: '.file-comment-card[data-comment-id="7"]' });
    expect(bridge.scrollToItem).toHaveBeenCalledWith('far.js', { align: 'start', behavior: 'instant' });
    expect(bridge.whenElementDrawn).toHaveBeenCalledWith(card, expect.objectContaining({ isCancelled: expect.any(Function) }));
    expect(result.element).toBe(card);
    expect(card.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('a card in the comment zone of a mounted long file whose first rows are not drawn: the pane goes to the file first', async () => {
    const fileCommentManager = new FileCommentManager({});
    const zone = fileCommentManager.createFileCommentsZone('long.js');
    const card = document.createElement('div');
    card.className = 'file-comment-card';
    card.dataset.commentId = '8';
    card.scrollIntoView = vi.fn();
    (zone.querySelector('.file-comments-container') || zone).appendChild(card);
    // The reader is far down the file: the zone is in the document, under a header whose rows are not drawn.
    document.body.appendChild(zone);
    const bridge = viewerBridge({ zoneFiles: ['long.js'] });
    bridge.findAnnotationFile = vi.fn(() => null);
    bridge.outsideRowWindow(card);
    bridge.scrollToItem = vi.fn(() => true);
    let drawn = false;
    bridge.isElementDrawn = vi.fn(() => drawn);
    bridge.whenElementDrawn = vi.fn(async () => { drawn = true; return true; });
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge, fileCommentManager });
    const result = await manager.revealInDiff({ file: 'long.js', zoneCardSelector: '.file-comment-card[data-comment-id="8"]' });
    expect(bridge.scrollToItem).toHaveBeenCalledWith('long.js', { align: 'start', behavior: 'instant' });
    expect(bridge.scrollToItem.mock.invocationCallOrder[0]).toBeLessThan(bridge.whenElementDrawn.mock.invocationCallOrder[0]);
    expect(result.element).toBe(card);
    expect(card.scrollIntoView).toHaveBeenCalledTimes(1);

    // The viewer never draws the zone (the wait runs out): no card, nothing scrolled to.
    drawn = false;
    bridge.whenElementDrawn = vi.fn(async () => false);
    const none = await manager.revealInDiff({ file: 'long.js', zoneCardSelector: '.file-comment-card[data-comment-id="8"]' });
    expect(none).toEqual({ element: null, cancelled: false });
    expect(card.scrollIntoView).toHaveBeenCalledTimes(1);
    zone.remove();
  });

  it('of two navigations started by one event the later one wins, and the earlier one has not moved the pane', async () => {
    // The review panel and the suggestion navigator both answer `j`: two
    // navigations, one after the other, in the same task.
    const far = detached();
    const near = attached();
    const bridge = viewerBridge({ card: far });
    bridge.findAnnotationFile = vi.fn((annotationId) => (annotationId === 'far' ? 'a.js' : annotationId === 'near' ? 'a.js' : null));
    bridge.getAnnotationElement = vi.fn((file, annotationId) => (annotationId === 'far' ? far : near));
    bridge.whenAnnotationRendered = vi.fn(async (file, annotationId) => (annotationId === 'far' ? (bridge.isElementDrawn(far) ? far : null) : near));
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge });
    const first = manager.revealInDiff({ file: 'a.js', annotationId: 'far' });
    const second = manager.revealInDiff({ file: 'a.js', annotationId: 'near' });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ element: null, cancelled: true });
    expect(b).toEqual({ element: near, cancelled: false });
    expect(bridge.scrollToAnnotation).not.toHaveBeenCalled();
    expect(near.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(far.scrollIntoView).not.toHaveBeenCalled();
  });

  it('holds changes of the pane\'s list nobody asked for until the navigation has landed', async () => {
    const card = attached();
    const bridge = viewerBridge({ card });
    const release = vi.fn();
    bridge.holdListWrites = vi.fn(() => release);
    let land;
    window.ScrollUtils = { scrollIntoViewStable: vi.fn(() => new Promise((resolve) => { land = resolve; })) };
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge });
    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(bridge.holdListWrites).toHaveBeenCalledTimes(1);
    // The helper has answered; the scroll is still under way.
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    land();
    await new Promise(setImmediate);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('lets go of the list when the navigation ends without a scroll: cancelled, nothing found, a failure, a lookup', async () => {
    const release = vi.fn();
    const bridge = viewerBridge({ card: null });
    bridge.holdListWrites = vi.fn(() => release);
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge });
    await manager.revealInDiff({ file: 'a.js', annotationId: 'nothing' });
    await new Promise(setImmediate);
    expect(release).toHaveBeenCalledTimes(1);

    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', isCancelled: () => true });
    await new Promise(setImmediate);
    expect(release).toHaveBeenCalledTimes(2);

    manager.ensureLinesVisible = vi.fn(async () => { throw new Error('reveal failed'); });
    await expect(manager.revealInDiff({ file: 'a.js', line_start: 3, annotationId: 'comment-1' })).rejects.toThrow('reveal failed');
    await new Promise(setImmediate);
    expect(release).toHaveBeenCalledTimes(3);

    // A lookup holds nothing, and neither does the per-file renderer.
    await manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', scroll: false });
    const other = makeManager({ pierreBridge: bridge });
    await other.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    expect(bridge.holdListWrites).toHaveBeenCalledTimes(3);
  });

  it('a lookup that scrolls nothing (scroll: false) supersedes no navigation', async () => {
    const card = detached();
    const bridge = viewerBridge({ card });
    const manager = makeManager({ _diffEngine: 'codeview', pierreBridge: bridge });
    const navigation = manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1' });
    const lookup = manager.revealInDiff({ file: 'a.js', annotationId: 'comment-1', scroll: false });
    const [a] = await Promise.all([navigation, lookup]);
    expect(a.cancelled).toBe(false);
    expect(a.element).toBe(card);
  });
});

describe('PRManager.revealInDiff: a line target (a chat link)', () => {
  function lineBridge({ visible = true, mounted = true, displayed = true } = {}) {
    const state = { mounted, displayed };
    return {
      state,
      files: new Map([['a.js', { kind: 'diff' }]]),
      isLineVisible: vi.fn(() => visible),
      findFileElement: vi.fn(() => (state.mounted ? document.body : null)),
      isDiffDisplayed: vi.fn(() => state.displayed),
      whenLineDisplayed: vi.fn(async () => { state.displayed = true; return true; }),
      scrollToLine: vi.fn(() => { state.mounted = true; return true; }),
    };
  }

  /** A page on the virtualized viewer whose pane knows the bridge's files by their own paths. */
  const lineManager = (bridge, extra = {}) => makeManager({
    _diffEngine: 'codeview',
    pierreBridge: bridge,
    _canonicalFilePath: (path) => (bridge.files.has(path) ? path : null),
    ...extra,
  });

  it('is not served by the per-file renderer, which is left untouched: handled false, nothing expanded or revealed', async () => {
    const manager = makeManager({ isFileCollapsed: vi.fn(() => true), setFileCollapsed: vi.fn() });
    const result = await manager.revealInDiff({ file: 'a.js', line_start: 30, flashLines: true });
    expect(result).toEqual({ element: null, cancelled: false, revealed: false, handled: false });
    expect(manager.setFileCollapsed).not.toHaveBeenCalled();
    expect(manager.ensureLinesVisible).not.toHaveBeenCalled();
  });

  it('a line of a mounted file that is drawn: revealed, then scrolled to unless on screen, the range flashed', async () => {
    const bridge = lineBridge();
    const manager = lineManager(bridge);
    const result = await manager.revealInDiff({ file: 'a.js', line_start: '4', line_end: '6', flashLines: true });
    expect(manager.ensureLinesVisible).toHaveBeenCalledWith([{ file: 'a.js', line_start: 4, line_end: 6, side: 'RIGHT' }]);
    expect(bridge.whenLineDisplayed).not.toHaveBeenCalled();
    expect(bridge.scrollToLine.mock.calls).toEqual([['a.js', 4, 'RIGHT', { align: 'center', behavior: 'smooth', ifNeeded: true, endLine: 6 }]]);
    expect(result).toEqual({ element: null, cancelled: false, revealed: true, handled: true });
  });

  it('a file that is not mounted: the pane goes to the line at once, without a flash, and the flash waits for the line to be drawn', async () => {
    const bridge = lineBridge({ mounted: false, displayed: false });
    const manager = lineManager(bridge);
    await manager.revealInDiff({ file: 'a.js', line_start: 30, flashLines: true });
    expect(bridge.scrollToLine.mock.calls).toEqual([
      ['a.js', 30, 'RIGHT', { align: 'center', behavior: 'instant', flash: false }],
      ['a.js', 30, 'RIGHT', { align: 'center', behavior: 'smooth', ifNeeded: true, endLine: 30 }],
    ]);
    expect(bridge.whenLineDisplayed).toHaveBeenCalledWith('a.js', 30, 'RIGHT', expect.objectContaining({ isCancelled: expect.any(Function) }));
    expect(bridge.whenLineDisplayed.mock.invocationCallOrder[0]).toBeLessThan(bridge.scrollToLine.mock.invocationCallOrder[1]);
  });

  it('a line that was just revealed in a mounted file: no jump, the flash waits for the new diff', async () => {
    const bridge = lineBridge({ mounted: true, displayed: false });
    const manager = lineManager(bridge);
    await manager.revealInDiff({ file: 'a.js', line_start: 30, flashLines: true });
    expect(bridge.whenLineDisplayed).toHaveBeenCalledTimes(1);
    expect(bridge.scrollToLine).toHaveBeenCalledTimes(1);
    expect(bridge.scrollToLine.mock.calls[0][3]).toMatchObject({ behavior: 'smooth', ifNeeded: true });
  });

  it('does not open a collapsed file: the line is not shown, and the caller goes to the file instead', async () => {
    const bridge = lineBridge({ visible: false });
    const manager = lineManager(bridge, { isFileCollapsed: vi.fn(() => true), setFileCollapsed: vi.fn() });
    const result = await manager.revealInDiff({ file: 'a.js', line_start: 30, flashLines: true });
    expect(manager.setFileCollapsed).not.toHaveBeenCalled();
    expect(bridge.scrollToLine).not.toHaveBeenCalled();
    expect(result).toEqual({ element: null, cancelled: false, revealed: false, handled: true });
  });

  it('a file the pane does not have, or no line: handled, not revealed', async () => {
    const bridge = lineBridge();
    const manager = lineManager(bridge);
    expect(await manager.revealInDiff({ file: 'nope.js', line_start: 3, flashLines: true })).toMatchObject({ revealed: false, handled: true });
    expect(await manager.revealInDiff({ file: 'a.js', flashLines: true })).toMatchObject({ revealed: false, handled: true });
    expect(bridge.scrollToLine).not.toHaveBeenCalled();
  });
});

