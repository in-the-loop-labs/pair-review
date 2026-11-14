// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';

// @pierre/diffs 1.6 calls renderAnnotation for every annotation whenever the
// fileDiff object changes (context ranges, gap expansion), not only when the
// annotation changed. The bridge must hand back the element it already built
// for an unchanged annotation, so elements callers hold (e.g. a sidebar
// scroll-to-finding in flight) stay connected across those re-renders.

describe('PierreBridge annotation element reuse', () => {
  let PierreBridge;
  let bridge;
  let custom;

  beforeEach(() => {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = {
      PierreDiffs: undefined,
      matchMedia: vi.fn(() => ({ matches: false })),
    };
    PierreBridge = require(BRIDGE_PATH);
    bridge = new PierreBridge({});
    custom = vi.fn((data) => {
      const el = document.createElement('div');
      el.textContent = data.text;
      return el;
    });
    bridge.registerAnnotationRenderer('note', custom);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  function annotation(metadata, lineNumber = 10, side = 'additions') {
    return { lineNumber, side, metadata };
  }

  it('reuses the element when the same annotation is rendered again', () => {
    const metadata = { type: 'note', data: { text: 'a' }, id: 'n-1' };
    const first = bridge._renderAnnotation(annotation(metadata), 'a.js', new Map());
    const second = bridge._renderAnnotation(annotation(metadata), 'a.js', new Map());
    expect(second).toBe(first);
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the annotation metadata is replaced', () => {
    const first = bridge._renderAnnotation(
      annotation({ type: 'note', data: { text: 'a' }, id: 'n-1' }), 'a.js', new Map());
    const second = bridge._renderAnnotation(
      annotation({ type: 'note', data: { text: 'b' }, id: 'n-1' }), 'a.js', new Map());
    expect(second).not.toBe(first);
    expect(second.textContent).toBe('b');
  });

  it('rebuilds when the same metadata moves to another line or side', () => {
    const metadata = { type: 'note', data: { text: 'a' }, id: 'n-1' };
    const first = bridge._renderAnnotation(annotation(metadata, 10), 'a.js', new Map());
    const moved = bridge._renderAnnotation(annotation(metadata, 11), 'a.js', new Map());
    const flipped = bridge._renderAnnotation(annotation(metadata, 11, 'deletions'), 'a.js', new Map());
    expect(moved).not.toBe(first);
    expect(flipped).not.toBe(moved);
    expect(custom).toHaveBeenCalledTimes(3);
  });

  it('does not cache an annotation that rendered nothing', () => {
    custom.mockReturnValueOnce(null);
    const metadata = { type: 'note', data: { text: 'a' }, id: 'n-1' };
    expect(bridge._renderAnnotation(annotation(metadata), 'a.js', new Map())).toBeUndefined();
    expect(bridge._renderAnnotation(annotation(metadata), 'a.js', new Map()).textContent).toBe('a');
  });

  // ─── sync: bring a card in line with its data on every render ─────────────

  describe('sync on every render', () => {
    it('runs a custom renderer\'s sync after the build and again on a cache hit, with the same element', () => {
      const sync = vi.fn();
      bridge.registerAnnotationRenderer('note', custom, { sync });
      const metadata = { type: 'note', data: { text: 'a' }, id: 'n-1' };

      const first = bridge._renderAnnotation(annotation(metadata), 'a.js', new Map());
      const second = bridge._renderAnnotation(annotation(metadata), 'a.js', new Map());

      expect(second).toBe(first);
      expect(custom).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledTimes(2);
      expect(sync).toHaveBeenNthCalledWith(1, first, metadata.data, 'n-1', 'a.js');
      expect(sync).toHaveBeenNthCalledWith(2, first, metadata.data, 'n-1', 'a.js');
    });

    it('a sync sees what changed in the data while the card was not on screen', () => {
      const sync = vi.fn((element, data) => { element.dataset.state = data.state; });
      bridge.registerAnnotationRenderer('note', custom, { sync });
      const metadata = { type: 'note', data: { text: 'a', state: 'open' }, id: 'n-1' };
      const element = bridge._renderAnnotation(annotation(metadata), 'a.js', new Map());
      expect(element.dataset.state).toBe('open');

      metadata.data.state = 'closed';
      expect(bridge._renderAnnotation(annotation(metadata), 'a.js', new Map())).toBe(element);
      expect(element.dataset.state).toBe('closed');
    });

    it('does not sync an annotation that rendered nothing, and a failing sync does not lose the card', () => {
      const sync = vi.fn(() => { throw new Error('sync failed'); });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      bridge.registerAnnotationRenderer('note', custom, { sync });
      custom.mockReturnValueOnce(null);
      const metadata = { type: 'note', data: { text: 'a' }, id: 'n-1' };

      expect(bridge._renderAnnotation(annotation(metadata), 'a.js', new Map())).toBeUndefined();
      expect(sync).not.toHaveBeenCalled();

      const element = bridge._renderAnnotation(annotation(metadata), 'a.js', new Map());
      expect(element.textContent).toBe('a');
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('re-registering a renderer without a sync drops the old sync; unregistering drops both', () => {
      const sync = vi.fn();
      bridge.registerAnnotationRenderer('note', custom, { sync });
      bridge.registerAnnotationRenderer('note', custom);
      bridge._renderAnnotation(annotation({ type: 'note', data: { text: 'a' }, id: 'n-1' }), 'a.js', new Map());
      expect(sync).not.toHaveBeenCalled();

      bridge.registerAnnotationRenderer('note', custom, { sync });
      bridge.unregisterAnnotationRenderer('note');
      expect(bridge._renderAnnotation(annotation({ type: 'note', data: { text: 'b' }, id: 'n-2' }), 'a.js', new Map()))
        .toBeUndefined();
      expect(sync).not.toHaveBeenCalled();
    });

    it('syncs comment cards through PostedComment and suggestion cards through the suggestion manager', () => {
      const syncCommentElement = vi.fn();
      const syncSuggestionElement = vi.fn();
      const card = document.createElement('div');
      global.window.PostedComment = { syncCommentElement, stampCommentStatus: vi.fn(), getEditedSincePostedHtml: () => '' };
      global.window.prManager = {
        suggestionManager: {
          syncSuggestionElement,
          createSuggestionRow: () => {
            const row = document.createElement('div');
            card.className = 'ai-suggestion';
            row.appendChild(card);
            return row;
          },
        },
      };
      const comment = { id: 1, file: 'a.js', line_start: 10, body: 'x' };
      const suggestion = { id: 2, file: 'a.js', line_start: 10 };

      const commentCard = bridge._renderAnnotation(
        annotation({ type: 'comment', data: comment, id: 'comment-1' }), 'a.js', new Map());
      bridge._renderAnnotation(annotation({ type: 'suggestion', data: suggestion, id: 'suggestion-2' }), 'a.js', new Map());

      expect(syncCommentElement).toHaveBeenCalledWith(commentCard, comment);
      expect(syncSuggestionElement).toHaveBeenCalledWith(card, suggestion);
    });
  });

  // ─── The element of an annotation, whether or not it is on screen ─────────

  describe('getAnnotationElement and the annotation lookups', () => {
    function addFile(name) {
      const state = { annotations: [], formElements: new Map(), instance: null };
      bridge.files.set(name, state);
      return state;
    }

    beforeEach(() => {
      addFile('a.js');
      addFile('b.js');
    });

    it('returns null until the card is built, builds it with create, and then always the same element', () => {
      bridge.addAnnotation('a.js', { lineNumber: 10, side: 'RIGHT', type: 'note', id: 'n-1', data: { text: 'a' } });

      expect(bridge.getAnnotationElement('a.js', 'n-1')).toBeNull();
      expect(custom).not.toHaveBeenCalled();

      const built = bridge.getAnnotationElement('a.js', 'n-1', { create: true });
      expect(built.textContent).toBe('a');
      expect(built.isConnected).toBe(false);
      expect(bridge.getAnnotationElement('a.js', 'n-1')).toBe(built);
      expect(custom).toHaveBeenCalledTimes(1);
    });

    it('hands out the element the engine\'s render callback built, and the engine gets the one built here', () => {
      bridge.addAnnotation('a.js', { lineNumber: 10, side: 'RIGHT', type: 'note', id: 'n-1', data: { text: 'a' } });
      bridge.addAnnotation('a.js', { lineNumber: 11, side: 'RIGHT', type: 'note', id: 'n-2', data: { text: 'b' } });
      const [first, second] = bridge.files.get('a.js').annotations;

      const fromEngine = bridge._renderAnnotation(first, 'a.js', new Map());
      expect(bridge.getAnnotationElement('a.js', 'n-1')).toBe(fromEngine);

      const fromHere = bridge.getAnnotationElement('a.js', 'n-2', { create: true });
      expect(bridge._renderAnnotation(second, 'a.js', new Map())).toBe(fromHere);
      expect(custom).toHaveBeenCalledTimes(2);
    });

    it('a lookup never syncs a card that exists; only building it and the engine\'s draw do', () => {
      // The flows that look a card up (adopt, dismiss, restore, delete,
      // edit) are about to update it themselves; a sync inside the lookup
      // would overwrite what the reader did to the card before the flow ran.
      const sync = vi.fn((element, data) => { element.dataset.state = data.state; });
      bridge.registerAnnotationRenderer('note', custom, { sync });
      bridge.addAnnotation('a.js', { lineNumber: 10, side: 'RIGHT', type: 'note', id: 'n-1', data: { text: 'a', state: 'open' } });
      const [annotation] = bridge.files.get('a.js').annotations;

      // Built by the lookup: synced once, as part of the build.
      const built = bridge.getAnnotationElement('a.js', 'n-1', { create: true });
      expect(sync).toHaveBeenCalledTimes(1);
      expect(built.dataset.state).toBe('open');

      // The data changes while the reader has put the card in a state of their own.
      annotation.metadata.data.state = 'closed';
      built.dataset.state = 'reader';
      expect(bridge.getAnnotationElement('a.js', 'n-1', { create: true })).toBe(built);
      expect(bridge.getAnnotationElement('a.js', 'n-1')).toBe(built);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(built.dataset.state).toBe('reader');

      // The engine draws the card: now it is brought in line with its data.
      expect(bridge._renderAnnotation(annotation, 'a.js', new Map())).toBe(built);
      expect(sync).toHaveBeenCalledTimes(2);
      expect(built.dataset.state).toBe('closed');
    });

    it('returns null for an unknown file, an unknown id, a removed annotation and a renderer that builds nothing', () => {
      bridge.addAnnotation('a.js', { lineNumber: 10, side: 'RIGHT', type: 'note', id: 'n-1', data: { text: 'a' } });
      expect(bridge.getAnnotationElement('missing.js', 'n-1', { create: true })).toBeNull();
      expect(bridge.getAnnotationElement('a.js', 'n-404', { create: true })).toBeNull();
      expect(bridge.getAnnotationElement('a.js', undefined, { create: true })).toBeNull();

      bridge.getAnnotationElement('a.js', 'n-1', { create: true });
      bridge.removeAnnotation('a.js', 'n-1');
      expect(bridge.getAnnotationElement('a.js', 'n-1', { create: true })).toBeNull();

      custom.mockReturnValueOnce(null);
      bridge.addAnnotation('a.js', { lineNumber: 10, side: 'RIGHT', type: 'note', id: 'n-3', data: { text: 'c' } });
      expect(bridge.getAnnotationElement('a.js', 'n-3', { create: true })).toBeNull();
    });

    it('hasAnnotation, findAnnotationFile and findAnnotationByData answer from the annotation lists', () => {
      bridge.addAnnotation('b.js', { lineNumber: 5, side: 'LEFT', type: 'note', id: 'n-9', data: { text: 'z', key: 42 } });

      expect(bridge.hasAnnotation('b.js', 'n-9')).toBe(true);
      expect(bridge.hasAnnotation('a.js', 'n-9')).toBe(false);
      expect(bridge.hasAnnotation('missing.js', 'n-9')).toBe(false);
      expect(bridge.hasAnnotation('b.js', null)).toBe(false);

      expect(bridge.findAnnotationFile('n-9')).toBe('b.js');
      expect(bridge.findAnnotationFile('n-9', 'a.js')).toBe('b.js');
      expect(bridge.findAnnotationFile('n-9', 'b.js')).toBe('b.js');
      expect(bridge.findAnnotationFile('n-404')).toBeNull();
      expect(bridge.findAnnotationFile(null)).toBeNull();

      const hit = bridge.findAnnotationByData('note', data => data.key === 42);
      expect(hit.fileName).toBe('b.js');
      expect(hit.annotation.metadata.id).toBe('n-9');
      expect(bridge.findAnnotationByData('note', data => data.key === 43)).toBeNull();
      expect(bridge.findAnnotationByData('other', () => true)).toBeNull();
      expect(bridge.findAnnotationByData('note', null)).toBeNull();
    });
  });

  // ─── Waiting for the engine to attach a card ──────────────────────────────

  describe('whenAnnotationRendered', () => {
    let frames;
    let now;

    /** Run every animation-frame callback queued so far, once. */
    function frame(advanceMs = 16) {
      now += advanceMs;
      const due = frames.splice(0);
      due.forEach(callback => callback(now));
    }

    beforeEach(() => {
      frames = [];
      now = 1000;
      global.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      // A file whose diff shows lines 1-100. The vendor instance is a spy:
      // it records what the bridge sends and draws nothing.
      bridge.files.set('a.js', {
        annotations: [],
        formElements: new Map(),
        collapsed: false,
        _splitLayoutRaf: 0,
        instance: {
          fileDiff: { isPartial: true, hunks: [{ additionStart: 1, additionCount: 100, deletionStart: 1, deletionCount: 100 }] },
          setLineAnnotations: vi.fn(),
          rerender: vi.fn(),
        },
      });
      bridge.addAnnotation('a.js', { lineNumber: 10, side: 'RIGHT', type: 'note', id: 'n-1', data: { text: 'a' } });
    });

    afterEach(() => {
      delete global.requestAnimationFrame;
      vi.restoreAllMocks();
    });

    it('resolves at once, without waiting a frame, when the card is attached', async () => {
      const card = bridge.getAnnotationElement('a.js', 'n-1', { create: true });
      document.body.appendChild(card);

      await expect(bridge.whenAnnotationRendered('a.js', 'n-1')).resolves.toBe(card);
      expect(frames).toHaveLength(0);
    });

    it('waits until the engine attaches the card (a pending diff), building it first if need be', async () => {
      let settled = null;
      const waiting = bridge.whenAnnotationRendered('a.js', 'n-1').then((element) => { settled = element; });
      const card = bridge.getAnnotationElement('a.js', 'n-1');
      expect(card).not.toBeNull();

      frame();
      frame();
      await Promise.resolve();
      expect(settled).toBeNull();

      document.body.appendChild(card);
      frame();
      await waiting;
      expect(settled).toBe(card);
    });

    it('resolves null at once for an annotation that does not exist, and when it goes away while waiting', async () => {
      await expect(bridge.whenAnnotationRendered('a.js', 'n-404')).resolves.toBeNull();
      await expect(bridge.whenAnnotationRendered('missing.js', 'n-1')).resolves.toBeNull();

      const waiting = bridge.whenAnnotationRendered('a.js', 'n-1');
      bridge.removeAnnotation('a.js', 'n-1');
      frame();
      await expect(waiting).resolves.toBeNull();
    });

    it('does not wait for a card the diff will not attach: a line that is not shown, a collapsed file', async () => {
      bridge.addAnnotation('a.js', { lineNumber: 500, side: 'RIGHT', type: 'note', id: 'n-hidden', data: { text: 'h' } });
      await expect(bridge.whenAnnotationRendered('a.js', 'n-hidden')).resolves.toBeNull();
      expect(frames).toHaveLength(0);

      // The file is collapsed while a wait is in flight.
      const waiting = bridge.whenAnnotationRendered('a.js', 'n-1');
      bridge.files.get('a.js').collapsed = true;
      frame();
      await expect(waiting).resolves.toBeNull();
      expect(frames).toHaveLength(0);
    });

    it('stops when the caller cancels', async () => {
      let cancelled = false;
      const waiting = bridge.whenAnnotationRendered('a.js', 'n-1', { isCancelled: () => cancelled });
      frame();
      cancelled = true;
      frame();
      await expect(waiting).resolves.toBeNull();
      expect(frames).toHaveLength(0);
    });

    it('gives up after the time allowed', async () => {
      const waiting = bridge.whenAnnotationRendered('a.js', 'n-1', { timeoutMs: 100 });
      frame(60);
      expect(frames).toHaveLength(1);
      frame(60);
      await expect(waiting).resolves.toBeNull();
      expect(frames).toHaveLength(0);
    });
  });
});
