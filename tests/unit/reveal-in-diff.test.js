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
