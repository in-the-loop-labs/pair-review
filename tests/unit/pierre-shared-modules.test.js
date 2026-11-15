// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The modules both diff bridges share: pierre-annotations.js (card builders,
 * display order, the element cache), pierre-gutter.js (what a gutter click
 * applies to) and pierre-styles.js (the shadow-DOM CSS).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

const MODULES = path.join(__dirname, '..', '..', 'public', 'js', 'modules');
const load = (name) => {
  const file = path.join(MODULES, name);
  delete require.cache[require.resolve(file)];
  return require(file);
};

let dom;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = () => 0;
});
afterEach(() => {
  delete global.window;
  delete global.document;
  delete global.requestAnimationFrame;
});

describe('PierreAnnotations.sortAnnotations', () => {
  const annotation = (lineNumber, side, type, id) => ({ lineNumber, side, metadata: { type, id, data: {} } });

  it('orders by line, then side, then type, and keeps the order equal annotations were added in', () => {
    const { sortAnnotations } = load('pierre-annotations.js');
    const input = [
      annotation(10, 'additions', 'comment', 'c1'),
      annotation(10, 'additions', 'external-comment', 'x1'),
      annotation(10, 'additions', 'suggestion', 's1'),
      annotation(10, 'additions', 'comment', 'c2'),
      annotation(10, 'additions', 'comment-form', 'f1'),
      annotation(10, 'additions', 'tour-stop', 't1'),
      annotation(10, 'additions', 'hunk-summary', 'h1'),
      annotation(10, 'deletions', 'comment', 'c3'),
      annotation(3, 'additions', 'comment', 'c0'),
      annotation(0, 'additions', 'notice', 'n'),
      annotation(0, 'additions', 'file-comments', 'z'),
      annotation(10, 'additions', 'unknown-type', 'u1'),
    ];
    const sorted = sortAnnotations(input);
    expect(sorted.map((a) => a.metadata.id)).toEqual(['z', 'n', 'c0', 'h1', 't1', 's1', 'f1', 'u1', 'c1', 'c2', 'x1', 'c3']);
    // A new array of the same objects; the input is untouched.
    expect(sorted).not.toBe(input);
    expect(input[0].metadata.id).toBe('c1');
    expect(sorted.find((a) => a.metadata.id === 'c1')).toBe(input[0]);
  });

  it('answers an empty array for no input', () => {
    const { sortAnnotations } = load('pierre-annotations.js');
    expect(sortAnnotations(null)).toEqual([]);
    expect(sortAnnotations([])).toEqual([]);
  });
});

describe('PierreAnnotations card builders take their collaborators as an argument', () => {
  it('renderComment builds the legacy card, escaping through the given escapeHtml and stamping through the given PostedComment', () => {
    const { renderComment } = load('pierre-annotations.js');
    const stampCommentStatus = vi.fn();
    const comment = { id: 7, file: 'a.js', line_start: 4, line_end: 6, side: 'LEFT', body: '<b>hi</b>' };
    const el = renderComment(comment, 'comment-7', {
      escapeHtml: (text) => String(text).replace(/</g, '&lt;'),
      PostedComment: { stampCommentStatus, getEditedSincePostedHtml: () => '<span class="edited-note">edited</span>' },
      getPostedCommentIcon: () => '<i class="posted-icon"></i>',
    });
    expect(el.className).toBe('user-comment-row');
    expect(el.dataset).toMatchObject({ commentId: '7', file: 'a.js', lineStart: '4', lineEnd: '6', side: 'LEFT' });
    expect(el.querySelector('.user-comment-line-info').textContent).toBe('Lines 4-6');
    expect(el.querySelector('.user-comment-body').innerHTML).toBe('&lt;b&gt;hi&lt;/b&gt;');
    expect(el.querySelector('.posted-icon')).not.toBeNull();
    expect(el.querySelector('.edited-note')).not.toBeNull();
    expect(el.querySelector('.user-comment').classList.contains('comment-user-origin')).toBe(true);
    expect(stampCommentStatus).toHaveBeenCalledWith(el, comment);
  });

  it('renderComment works with no collaborators at all, and with a function that returns them', () => {
    const { renderComment } = load('pierre-annotations.js');
    const bare = renderComment({ id: 1, file: 'a.js', line_start: 2, body: 'plain', parent_id: 9, type: 'praise', title: 'Nice' }, 'comment-1');
    expect(bare.querySelector('.user-comment-line-info').textContent).toBe('Line 2');
    expect(bare.querySelector('.user-comment-body').textContent).toBe('plain');
    expect(bare.querySelector('.adopted-praise-badge')).not.toBeNull();
    expect(bare.querySelector('.user-comment').classList.contains('adopted-comment')).toBe(true);
    const env = vi.fn(() => ({ renderMarkdown: (text) => `<p>${text}</p>` }));
    const viaFunction = renderComment({ id: 2, file: 'a.js', line_start: 2, body: 'md' }, 'comment-2', env);
    expect(env).toHaveBeenCalled();
    expect(viaFunction.querySelector('.user-comment-body').innerHTML).toBe('<p>md</p>');
  });

  it('renderSuggestion asks the given suggestion manager for the card, and falls back without one', () => {
    const { renderSuggestion } = load('pierre-annotations.js');
    const createSuggestionRow = vi.fn(() => {
      const row = document.createElement('tr');
      row.innerHTML = '<td><div class="ai-suggestion" data-suggestion-id="11"></div></td>';
      return row;
    });
    const suggestion = { id: 11, file: 'a.js', line_start: 5, side: 'LEFT', diff_position: 3, type: 'bug', title: 'T', body: 'B' };
    const el = renderSuggestion(suggestion, 'suggestion-11', { suggestionManager: { createSuggestionRow } });
    expect(el.dataset.suggestionId).toBe('11');
    expect(createSuggestionRow).toHaveBeenCalledWith([suggestion], { fileName: 'a.js', lineNumber: 5, side: 'LEFT', diffPosition: 3, isFileLevel: false });

    const fallback = renderSuggestion(suggestion, 'suggestion-11', {});
    expect(fallback.className).toBe('ai-suggestion ai-type-bug');
    expect(fallback.querySelector('.ai-title').textContent).toBe('T');
    // A manager whose row holds no card: the fallback too.
    const empty = renderSuggestion(suggestion, 'suggestion-11', { suggestionManager: { createSuggestionRow: () => document.createElement('tr') } });
    expect(empty.className).toBe('ai-suggestion ai-type-bug');
  });

  it('renderForm reuses the form of an id, and reads its handlers and the chat panel when they are needed', async () => {
    const { renderForm } = load('pierre-annotations.js');
    const forms = new Map();
    const handlers = {};
    const env = {};
    const data = { lineStart: 4, lineEnd: 6, side: 'LEFT', initialValue: 'draft', showSuggestionBtn: true };
    const form = renderForm(data, 'form-1', forms, 'a.js', handlers, () => env);
    expect(renderForm(data, 'form-1', forms, 'a.js', handlers, () => env)).toBe(form);
    expect(forms.get('form-1')).toBe(form);
    expect(form.querySelector('.line-range-indicator').textContent).toBe('Lines 4-6');
    const textarea = form.querySelector('textarea');
    expect(textarea.value).toBe('draft');
    expect(textarea.dataset).toMatchObject({ line: '4', lineEnd: '6', file: 'a.js', side: 'LEFT' });

    // Handlers that are set after the form was built are still the ones called.
    handlers.onCommentFormSubmit = vi.fn(async () => {});
    handlers.onCommentFormCancel = vi.fn();
    handlers.onSuggestionInsert = vi.fn();
    form.querySelector('.save-comment-btn').click();
    await Promise.resolve();
    expect(handlers.onCommentFormSubmit).toHaveBeenCalledWith('a.js', 'form-1', data, 'draft');
    form.querySelector('.suggestion-btn').click();
    expect(handlers.onSuggestionInsert).toHaveBeenCalledWith(textarea, form.querySelector('.suggestion-btn'));
    form.querySelector('.cancel-comment-btn').click();
    expect(handlers.onCommentFormCancel).toHaveBeenCalledWith('a.js', 'form-1', data);

    // No chat panel yet: the Chat button does nothing. Once there is one it opens it with the form's side.
    form.querySelector('.btn-chat-from-comment').click();
    expect(handlers.onCommentFormCancel).toHaveBeenCalledTimes(1);
    env.chatPanel = { open: vi.fn() };
    form.querySelector('.btn-chat-from-comment').click();
    expect(handlers.onCommentFormCancel).toHaveBeenCalledTimes(2);
    expect(env.chatPanel.open).toHaveBeenCalledWith({ commentContext: { type: 'line', body: 'draft', file: 'a.js', line_start: 4, line_end: 6, side: 'LEFT', source: 'user' } });
  });

  it('renderForm disables Save for an empty form and tolerates missing handlers', () => {
    const { renderForm } = load('pierre-annotations.js');
    const form = renderForm({ lineStart: 4 }, 'form-2', new Map(), 'a.js', undefined, undefined);
    expect(form.querySelector('.save-comment-btn').disabled).toBe(true);
    expect(form.querySelector('.suggestion-btn')).toBeNull();
    expect(() => form.querySelector('.cancel-comment-btn').click()).not.toThrow();
    const textarea = form.querySelector('textarea');
    textarea.value = 'text';
    textarea.dispatchEvent(new dom.window.Event('input'));
    expect(form.querySelector('.save-comment-btn').disabled).toBe(false);
  });
});

describe('PierreAnnotations.AnnotationElements: a draw syncs, a lookup never does', () => {
  function setUp() {
    const { AnnotationElements } = load('pierre-annotations.js');
    const syncCommentElement = vi.fn();
    const syncSuggestionElement = vi.fn();
    const createSuggestionRow = () => {
      const row = document.createElement('tr');
      row.innerHTML = '<td><div class="ai-suggestion"></div></td>';
      return row;
    };
    const env = { PostedComment: { syncCommentElement, stampCommentStatus: () => {}, getEditedSincePostedHtml: () => '' }, suggestionManager: { syncSuggestionElement, createSuggestionRow } };
    const elements = new AnnotationElements({ env: () => env, handlers: {} });
    return { elements, syncCommentElement, syncSuggestionElement };
  }
  const annotation = (type, data = {}, id = `${type}-1`, lineNumber = 5, side = 'additions') => ({ lineNumber, side, metadata: { type, data, id } });

  it('builds a card once, hands the same element back, and syncs it on every draw', () => {
    const { elements, syncCommentElement } = setUp();
    const comment = annotation('comment', { id: 1, file: 'a.js', line_start: 5, body: 'x' });
    const first = elements.draw(comment, 'a.js', new Map());
    expect(syncCommentElement).toHaveBeenCalledTimes(1);
    expect(elements.draw(comment, 'a.js', new Map())).toBe(first);
    expect(syncCommentElement).toHaveBeenCalledTimes(2);
    expect(syncCommentElement).toHaveBeenLastCalledWith(first, comment.metadata.data);
  });

  it('a lookup hands back a card that exists unchanged, and builds one only when asked to', () => {
    const { elements, syncCommentElement } = setUp();
    const comment = annotation('comment', { id: 1, file: 'a.js', line_start: 5, body: 'x' });
    expect(elements.lookup(comment, 'a.js', new Map())).toBeNull();
    expect(syncCommentElement).not.toHaveBeenCalled();
    const built = elements.lookup(comment, 'a.js', new Map(), { create: true });
    expect(built).not.toBeNull();
    // A new card is synced once, as the viewer's first draw would.
    expect(syncCommentElement).toHaveBeenCalledTimes(1);
    expect(elements.lookup(comment, 'a.js', new Map(), { create: true })).toBe(built);
    expect(elements.lookup(comment, 'a.js', new Map())).toBe(built);
    expect(syncCommentElement).toHaveBeenCalledTimes(1);
    // The viewer later draws that same element.
    expect(elements.draw(comment, 'a.js', new Map())).toBe(built);
  });

  it('the same data at another line or side, or under new metadata, is another card', () => {
    const { elements } = setUp();
    const data = { id: 1, file: 'a.js', line_start: 5, body: 'x' };
    const original = annotation('comment', data);
    const first = elements.draw(original, 'a.js', new Map());
    expect(elements.draw({ ...original, lineNumber: 6 }, 'a.js', new Map())).not.toBe(first);
    expect(elements.lookup({ ...original, side: 'deletions' }, 'a.js', new Map())).toBeNull();
    expect(elements.draw(annotation('comment', data), 'a.js', new Map())).not.toBe(first);
  });

  it('suggestions are synced through the suggestion manager, registered types through their own sync, others not at all', () => {
    const { elements, syncSuggestionElement } = setUp();
    const suggestion = annotation('suggestion', { id: 2, type: 'bug', title: 'T', body: 'B' });
    const card = elements.draw(suggestion, 'a.js', new Map());
    expect(syncSuggestionElement).toHaveBeenCalledWith(card, suggestion.metadata.data);

    const render = vi.fn(() => document.createElement('div'));
    const sync = vi.fn();
    elements.register('tour-stop', render, { sync });
    const stop = annotation('tour-stop', { n: 1 }, 'stop-1');
    const stopEl = elements.draw(stop, 'a.js', new Map());
    elements.draw(stop, 'a.js', new Map());
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(stop.metadata.data, 'stop-1', 'a.js');
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith(stopEl, stop.metadata.data, 'stop-1', 'a.js');

    // Registered again without a sync: the old one is gone.
    elements.register('tour-stop', render);
    elements.draw(stop, 'a.js', new Map());
    expect(sync).toHaveBeenCalledTimes(2);
    expect(elements.draw(annotation('nobody-registered-this'), 'a.js', new Map())).toBeUndefined();
  });

  it('a renderer or a sync that throws is reported and does not break the draw', () => {
    const { elements } = setUp();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    elements.register('broken', () => { throw new Error('boom'); });
    expect(elements.draw(annotation('broken'), 'a.js', new Map())).toBeUndefined();
    elements.register('half', () => document.createElement('div'), { sync: () => { throw new Error('boom'); } });
    expect(elements.draw(annotation('half'), 'a.js', new Map())).toBeInstanceOf(dom.window.HTMLElement);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('forms live in the file\'s own map, by id', () => {
    const { elements } = setUp();
    const forms = new Map();
    const form = annotation('comment-form', { lineStart: 5 }, 'form-1');
    expect(elements.lookup(form, 'a.js', forms)).toBeNull();
    const el = elements.draw(form, 'a.js', forms);
    expect(forms.get('form-1')).toBe(el);
    expect(elements.lookup(form, 'a.js', forms)).toBe(el);
    expect(elements.lookup(form, 'a.js', new Map(), { create: true })).not.toBe(el);
  });
});

describe('PierreAnnotations.applySplitAnnotationLayout', () => {
  function shadowWith(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  }

  it('does nothing in unified layout or without a shadow root', () => {
    const { applySplitAnnotationLayout } = load('pierre-annotations.js');
    const root = shadowWith('<pre data-diff-type="split"><div data-line-annotation="0,1"><slot></slot></div></pre>');
    applySplitAnnotationLayout(root, 'unified');
    applySplitAnnotationLayout(null, 'split');
    expect(root.querySelector('.pr-annotation-fullwidth')).toBeNull();
  });

  it('marks a card whose opposite cell is empty, and neither card when both sides hold one', () => {
    const { applySplitAnnotationLayout } = load('pierre-annotations.js');
    const root = shadowWith(`<pre data-diff-type="split">
      <div data-additions><div data-gutter></div></div>
      <div id="lone" data-line-annotation="0,1"><slot></slot></div><div id="empty" data-line-annotation="0,1"></div>
      <div id="left" data-line-annotation="0,2"><slot></slot></div><div id="right" data-line-annotation="0,2"><slot></slot></div>
    </pre>`);
    applySplitAnnotationLayout(root, 'split');
    const marked = (id) => root.querySelector(`#${id}`).classList.contains('pr-annotation-fullwidth');
    expect([marked('lone'), marked('empty'), marked('left'), marked('right')]).toEqual([true, false, false, false]);
    // A later pass takes the mark away again when the other side gained a card.
    root.querySelector('#empty').innerHTML = '<slot></slot>';
    applySplitAnnotationLayout(root, 'split');
    expect(marked('lone')).toBe(false);
  });
});

describe('PierreGutter.resolveClickTarget', () => {
  const { resolveClickTarget } = load('pierre-gutter.js');
  const hovered = (lineNumber, side = 'RIGHT') => ({ lineNumber, side });

  it('without a range selection the click is on the hovered line', () => {
    expect(resolveClickTarget(hovered(7), null)).toEqual({ target: { start: 7, end: 7, side: 'RIGHT', isRange: false }, clearSelection: false });
    // A one-line "selection" is not a range.
    expect(resolveClickTarget(hovered(7, 'LEFT'), { start: 7, end: 7, side: 'LEFT' })).toEqual({ target: { start: 7, end: 7, side: 'LEFT', isRange: false }, clearSelection: false });
  });

  it('inside the selected range, on its side, the click is on the range and the selection is consumed', () => {
    expect(resolveClickTarget(hovered(6), { start: 5, end: 9, side: 'RIGHT' })).toEqual({ target: { start: 5, end: 9, side: 'RIGHT', isRange: true }, clearSelection: true });
    expect(resolveClickTarget(hovered(9), { start: 5, end: 9, side: 'RIGHT' }).target.isRange).toBe(true);
  });

  it('outside the range, or on the other side, the range is cancelled and the click is on the hovered line', () => {
    expect(resolveClickTarget(hovered(12), { start: 5, end: 9, side: 'RIGHT' })).toEqual({ target: { start: 12, end: 12, side: 'RIGHT', isRange: false }, clearSelection: true });
    expect(resolveClickTarget(hovered(6, 'LEFT'), { start: 5, end: 9, side: 'RIGHT' })).toEqual({ target: { start: 6, end: 6, side: 'LEFT', isRange: false }, clearSelection: true });
  });

  it('nothing hovered: no target; a range is still cancelled', () => {
    expect(resolveClickTarget(null, null)).toEqual({ target: null, clearSelection: false });
    expect(resolveClickTarget(null, { start: 5, end: 9, side: 'RIGHT' })).toEqual({ target: null, clearSelection: true });
  });
});

describe('PierreGutter.createGutterButtons', () => {
  function build(overrides = {}) {
    const { createGutterButtons } = load('pierre-gutter.js');
    const deps = {
      getHoveredRow: vi.fn(() => ({ lineNumber: 7, side: 'RIGHT' })),
      getLineSelection: vi.fn(() => null),
      clearLineSelection: vi.fn(),
      selectLines: vi.fn(),
      onChatClick: vi.fn(),
      onCommentClick: vi.fn(),
      ...overrides,
    };
    const container = createGutterButtons(deps);
    document.body.appendChild(container);
    return { container, deps };
  }
  const pointer = (type, init = {}) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, ...init });
    return event;
  };

  it('is the container the page styles, with a chat and a comment button', () => {
    const { container } = build();
    expect(container.className).toBe('pierre-gutter-buttons');
    expect(container.hasAttribute('data-utility-button')).toBe(true);
    expect([...container.querySelectorAll('button')].map((b) => b.className)).toEqual(['pierre-gutter-btn pierre-chat-btn', 'pierre-gutter-btn pierre-comment-btn']);
  });

  it('has no chat button without a chat handler', () => {
    const { container } = build({ onChatClick: null });
    expect(container.querySelector('.pierre-chat-btn')).toBeNull();
  });

  it('a press and release on a button acts on the hovered line', () => {
    const { container, deps } = build();
    const comment = container.querySelector('.pierre-comment-btn');
    comment.dispatchEvent(pointer('pointerdown'));
    comment.click();
    expect(deps.onCommentClick).toHaveBeenCalledWith(7, 'RIGHT', { start: 7, end: 7, side: 'RIGHT', isRange: false });
    const chat = container.querySelector('.pierre-chat-btn');
    chat.dispatchEvent(pointer('pointerdown'));
    chat.click();
    expect(deps.onChatClick).toHaveBeenCalledWith(7, 'RIGHT', expect.objectContaining({ isRange: false }));
  });

  it('a click that no press on the button preceded does nothing', () => {
    const { container, deps } = build();
    container.querySelector('.pierre-comment-btn').click();
    expect(deps.onCommentClick).not.toHaveBeenCalled();
  });

  it('a drag from the button selects the lines between, and the release is not a click', () => {
    let row = { lineNumber: 7, side: 'LEFT' };
    const { container, deps } = build({ getHoveredRow: vi.fn(() => row) });
    const comment = container.querySelector('.pierre-comment-btn');
    comment.dispatchEvent(pointer('pointerdown'));
    row = { lineNumber: 4, side: 'LEFT' };
    document.dispatchEvent(pointer('pointermove'));
    expect(deps.selectLines).toHaveBeenLastCalledWith(4, 7, 'LEFT');
    row = { lineNumber: 10, side: 'LEFT' };
    document.dispatchEvent(pointer('pointermove'));
    expect(deps.selectLines).toHaveBeenLastCalledWith(7, 10, 'LEFT');
    // Another pointer's moves are not this drag's.
    document.dispatchEvent(pointer('pointermove', { pointerId: 2 }));
    expect(deps.selectLines).toHaveBeenCalledTimes(2);
    document.dispatchEvent(pointer('pointerup'));
    comment.click();
    expect(deps.onCommentClick).not.toHaveBeenCalled();
    // After the release, moves select nothing.
    document.dispatchEvent(pointer('pointermove'));
    expect(deps.selectLines).toHaveBeenCalledTimes(2);
  });

  it('a click inside the selected range acts on the range and clears the selection', () => {
    const { container, deps } = build({ getLineSelection: vi.fn(() => ({ start: 5, end: 9, side: 'RIGHT' })) });
    const comment = container.querySelector('.pierre-comment-btn');
    comment.dispatchEvent(pointer('pointerdown'));
    comment.click();
    expect(deps.clearLineSelection).toHaveBeenCalledTimes(1);
    expect(deps.onCommentClick).toHaveBeenCalledWith(5, 'RIGHT', { start: 5, end: 9, side: 'RIGHT', isRange: true });
  });

  it('with nothing hovered a press starts nothing', () => {
    const { container, deps } = build({ getHoveredRow: vi.fn(() => null) });
    const comment = container.querySelector('.pierre-comment-btn');
    comment.dispatchEvent(pointer('pointerdown'));
    comment.click();
    expect(deps.onCommentClick).not.toHaveBeenCalled();
  });
});

describe('PierreStyles', () => {
  const styles = load('pierre-styles.js');

  it('carries the three blocks and joins them in cascade order', () => {
    expect(styles.ANNOTATION_CSS).toContain('.pr-annotation-fullwidth');
    expect(styles.ANNOTATION_CSS).toContain('pierre-line-highlight-flash');
    expect(styles.ROWLESS_FIX.split('\n')).toHaveLength(2);
    expect(styles.unsafeCSS()).toBe([styles.ANNOTATION_CSS, styles.ROWLESS_FIX, styles.CONTEXT_CSS].join('\n'));
  });

  it('every rule of CONTEXT_CSS is scoped to a context file\'s host', () => {
    const withoutComments = styles.CONTEXT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = withoutComments.split('}').map((rule) => rule.split('{')[0].trim()).filter(Boolean);
    expect(selectors).toHaveLength(10);
    for (const selector of selectors) expect(selector.startsWith(':host(.context-file) ')).toBe(true);
  });

  it('the row-less fix is scoped by an annotation, in both layouts (ledger correction 4)', () => {
    const [unified, split] = styles.ROWLESS_FIX.split('\n');
    expect(unified.startsWith('[data-code]:has([data-line-annotation]):not(:has([data-line]))')).toBe(true);
    expect(split.startsWith('pre[data-diff]:has([data-line-annotation]):not(:has([data-line]))')).toBe(true);
  });

  it('the old bridge serves the same annotation CSS text', () => {
    const PierreBridge = load('pierre-bridge.js');
    expect(PierreBridge.ANNOTATION_CSS).toBe(styles.ANNOTATION_CSS);
  });
});

describe('both pages load the shared modules before the bridge that needs them', () => {
  for (const pageName of ['pr.html', 'local.html']) {
    it(pageName, () => {
      const html = fs.readFileSync(path.join(MODULES, '..', '..', pageName), 'utf8');
      const at = (name) => html.indexOf(`<script src="/js/modules/${name}"></script>`);
      expect(at('pierre-styles.js')).toBeGreaterThan(-1);
      expect(at('pierre-annotations.js')).toBeGreaterThan(-1);
      expect(at('pierre-styles.js')).toBeLessThan(at('pierre-bridge.js'));
      expect(at('pierre-annotations.js')).toBeLessThan(at('pierre-bridge.js'));
      // The CodeView bridge is not loaded by the app yet (phase 5).
      expect(at('pierre-codeview-bridge.js')).toBe(-1);
      expect(at('pierre-gutter.js')).toBe(-1);
    });
  }
});
