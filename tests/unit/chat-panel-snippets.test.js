// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the ChatPanel prompt-snippet picker wiring (Step 4 of the
 * chat-prompt-snippets feature).
 *
 * Covers:
 * - _insertPromptSnippet: insert into empty input; insert at caret mid-text;
 *   newline prefix when preceding char is non-whitespace; sendBtn.disabled
 *   recomputed; MRU touch fired (fire-and-forget, not awaited); {send:true}
 *   invokes sendMessage; cmd-click-while-streaming leaves text in the input.
 * - Dropdown mutual exclusion: showing the snippet dropdown hides the provider
 *   and session dropdowns, and vice versa.
 * - close() hides the snippet dropdown.
 *
 * These tests deliberately avoid vi.clearAllMocks() — per tests/CONVENTIONS.md,
 * files that build many vi.fn() per test must clear an explicit set instead.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal DOM harness. Every selector resolves to a persistent mock element so
// ChatPanel's ref-caching (no null guards) and _bindEvents never hit null.
// ---------------------------------------------------------------------------

/** Document-level click listeners registered via addEventListener. */
let documentClickListeners;

function makeClassList() {
  const set = new Set();
  return {
    _set: set,
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
  };
}

function createMockElement(tag = 'div') {
  let _innerHTML = '';
  let _textContent = '';
  const el = {
    tagName: tag.toUpperCase(),
    style: { display: '' },
    classList: makeClassList(),
    dataset: {},
    disabled: false,
    // textContent setter escapes into innerHTML so _escapeHtml (which round-
    // trips through a detached div) behaves like the real DOM.
    get innerHTML() { return _innerHTML; },
    set innerHTML(v) { _innerHTML = v; },
    get textContent() { return _textContent; },
    set textContent(v) {
      _textContent = String(v);
      _innerHTML = String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    children: [],
    _listeners: {},
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(function (ev, fn) {
      (this._listeners[ev] = this._listeners[ev] || []).push(fn);
    }),
    removeEventListener: vi.fn(),
    appendChild: vi.fn((c) => { el.children.push(c); return c; }),
    insertBefore: vi.fn((c) => { el.children.push(c); return c; }),
    removeChild: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn(() => false),
    closest: vi.fn(() => null),
    focus: vi.fn(),
    blur: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ top: 0, bottom: 20, left: 0, right: 40, width: 40, height: 20 })),
    setAttribute: vi.fn(),
    getAttribute: vi.fn(() => null),
    removeAttribute: vi.fn(),
  };
  return el;
}

/**
 * A textarea mock with working selection semantics so insert-at-caret can be
 * asserted precisely.
 */
function createInputMock() {
  const el = createMockElement('textarea');
  el.value = '';
  el.scrollHeight = 30;
  el.selectionStart = 0;
  el.selectionEnd = 0;
  el.setSelectionRange = vi.fn(function (s, e) {
    this.selectionStart = s;
    this.selectionEnd = e;
  });
  return el;
}

/**
 * Build a container whose querySelector returns a persistent mock per selector.
 * Specific elements (input, dropdowns, buttons) are pre-seeded so tests can
 * hold references to them.
 */
function buildContainer(refs) {
  const cache = new Map();
  const container = createMockElement('div');
  container.querySelector = vi.fn((selector) => {
    if (refs[selector]) return refs[selector];
    if (!cache.has(selector)) cache.set(selector, createMockElement('div'));
    return cache.get(selector);
  });
  return container;
}

// ---------------------------------------------------------------------------
// Globals — must exist BEFORE requiring ChatPanel (IIFE reads window/document).
// ---------------------------------------------------------------------------

global.window = global.window || {};
global.window.__pairReview = { chatProvider: 'pi', chatProviders: [], chatEnterToSend: true };
global.window.renderMarkdown = (t) => `<p>${t}</p>`;
global.window.escapeHtmlAttribute = (t) => String(t);
global.window.panelGroup = { _onChatVisibilityChanged: vi.fn() };
global.window.addEventListener = vi.fn();
global.window.removeEventListener = vi.fn();
global.window.innerWidth = 1200;
global.window.innerHeight = 800;

documentClickListeners = [];
global.document = {
  documentElement: {
    style: { setProperty: vi.fn(), getPropertyValue: vi.fn(() => '') },
    getAttribute: vi.fn(() => null),
  },
  body: {
    classList: makeClassList(),
    appendChild: vi.fn(),
    removeChild: vi.fn(),
  },
  activeElement: null,
  createElement: vi.fn((tag) => createMockElement(tag)),
  getElementById: vi.fn(() => null),
  querySelector: vi.fn(() => null),
  addEventListener: vi.fn((ev, fn) => {
    if (ev === 'click') documentClickListeners.push(fn);
  }),
  removeEventListener: vi.fn((ev, fn) => {
    if (ev === 'click') documentClickListeners = documentClickListeners.filter(h => h !== fn);
  }),
};

// Run setTimeout(fn, 0) callbacks synchronously so outside-click wiring is
// deterministic (mirrors the approach in chat-panel.test.js).
const _realSetTimeout = global.setTimeout;
global.setTimeout = vi.fn((cb) => { cb(); return 0; });
global.clearTimeout = vi.fn();
global.requestAnimationFrame = vi.fn((cb) => { cb(); return 0; });
global.fetch = vi.fn();

require('../../public/js/utils/time.js');
const { ChatPanel } = require('../../public/js/components/ChatPanel.js');

// ---------------------------------------------------------------------------
// Panel factory
// ---------------------------------------------------------------------------

function createPanel() {
  const refs = {
    '.chat-panel__input': createInputMock(),
    '.chat-panel__send-btn': createMockElement('button'),
    '.chat-panel__stop-btn': createMockElement('button'),
    '.chat-panel__snippet-picker': createMockElement('div'),
    '.chat-panel__snippet-picker-btn': createMockElement('button'),
    '.chat-panel__snippet-dropdown': createMockElement('div'),
    '.chat-panel__provider-picker': createMockElement('div'),
    '.chat-panel__provider-picker-btn': createMockElement('button'),
    '.chat-panel__provider-dropdown': createMockElement('div'),
    '.chat-panel__session-picker': createMockElement('div'),
    '.chat-panel__session-dropdown': createMockElement('div'),
    '.chat-panel__history-btn': createMockElement('button'),
  };
  // Dropdowns start hidden, matching the `style="display: none;"` in _render's
  // markup (our mock innerHTML doesn't parse inline styles).
  refs['.chat-panel__snippet-dropdown'].style.display = 'none';
  refs['.chat-panel__provider-dropdown'].style.display = 'none';
  refs['.chat-panel__session-dropdown'].style.display = 'none';

  const container = buildContainer(refs);
  global.document.getElementById = vi.fn((id) => (id === 'chat-container' ? container : null));

  const panel = new ChatPanel('chat-container');
  panel.isOpen = true;
  panel._refs = refs;
  return panel;
}

/** Give the panel a single active tab so _getActiveTab()/sendMessage resolve. */
function attachTab(panel, init = {}) {
  const tab = panel._createTab(init);
  panel.tabs = [tab];
  panel.activeTabKey = panel._tabKey(tab);
  return tab;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatPanel prompt-snippet picker', () => {
  let panel;
  let input;

  beforeEach(() => {
    global.fetch.mockReset();
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ snippets: [] }) });
    documentClickListeners = [];
    panel = createPanel();
    input = panel.inputEl;
  });

  describe('_insertPromptSnippet', () => {
    beforeEach(() => {
      panel._promptSnippetsById = new Map([['7', 'Review this for bugs']]);
    });

    it('inserts the body into an empty input and focuses it', () => {
      input.value = '';
      input.selectionStart = input.selectionEnd = 0;

      panel._insertPromptSnippet('7', {});

      expect(input.value).toBe('Review this for bugs');
      expect(input.selectionStart).toBe('Review this for bugs'.length);
      expect(input.focus).toHaveBeenCalled();
    });

    it('inserts at the caret in the middle of existing text', () => {
      input.value = 'abcXYZ';
      input.selectionStart = input.selectionEnd = 3; // between abc and XYZ
      panel._promptSnippetsById = new Map([['7', '--']]);

      panel._insertPromptSnippet('7', {});

      // preceding char 'c' is non-whitespace -> newline prefix
      expect(input.value).toBe('abc\n--XYZ');
      expect(input.selectionStart).toBe('abc\n--'.length);
    });

    it('does NOT prefix a newline when the preceding char is whitespace', () => {
      input.value = 'abc ';
      input.selectionStart = input.selectionEnd = 4;
      panel._promptSnippetsById = new Map([['7', 'X']]);

      panel._insertPromptSnippet('7', {});

      expect(input.value).toBe('abc X');
    });

    it('does NOT prefix a newline at the start of the input', () => {
      input.value = 'tail';
      input.selectionStart = input.selectionEnd = 0;
      panel._promptSnippetsById = new Map([['7', 'head']]);

      panel._insertPromptSnippet('7', {});

      expect(input.value).toBe('headtail');
    });

    it('recomputes sendBtn.disabled after inserting (was disabled, now enabled)', () => {
      panel.sendBtn.disabled = true;
      input.value = '';
      input.selectionStart = input.selectionEnd = 0;

      panel._insertPromptSnippet('7', {});

      expect(panel.sendBtn.disabled).toBe(false);
    });

    it('keeps sendBtn disabled while streaming even after insert', () => {
      const tab = attachTab(panel);
      tab.isStreaming = true;
      input.value = '';
      input.selectionStart = input.selectionEnd = 0;

      panel._insertPromptSnippet('7', {});

      expect(panel.sendBtn.disabled).toBe(true);
    });

    it('fires the MRU touch endpoint fire-and-forget (not awaited)', () => {
      // A touch fetch that never resolves must not block the synchronous insert.
      global.fetch.mockReturnValue(new Promise(() => {}));
      input.value = '';
      input.selectionStart = input.selectionEnd = 0;

      panel._insertPromptSnippet('7', {});

      expect(global.fetch).toHaveBeenCalledWith('/api/snippets/7/touch', { method: 'POST' });
      // Insert completed despite the pending promise.
      expect(input.value).toBe('Review this for bugs');
    });

    it('does not throw when the touch fetch rejects', () => {
      global.fetch.mockRejectedValue(new Error('network'));
      input.value = '';
      input.selectionStart = input.selectionEnd = 0;

      expect(() => panel._insertPromptSnippet('7', {})).not.toThrow();
    });

    it('invokes sendMessage when {send:true}', () => {
      const spy = vi.spyOn(panel, 'sendMessage').mockImplementation(() => {});
      input.value = '';
      input.selectionStart = input.selectionEnd = 0;

      panel._insertPromptSnippet('7', { send: true });

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does NOT invoke sendMessage when {send:false}', () => {
      const spy = vi.spyOn(panel, 'sendMessage').mockImplementation(() => {});
      panel._insertPromptSnippet('7', { send: false });
      expect(spy).not.toHaveBeenCalled();
    });

    it('cmd-click-while-streaming leaves the inserted text in the input (send guard)', () => {
      const tab = attachTab(panel);
      tab.isStreaming = true;
      input.value = '';
      input.selectionStart = input.selectionEnd = 0;

      // Real sendMessage: bails on tab.isStreaming BEFORE clearing input.
      panel._insertPromptSnippet('7', { send: true });

      expect(input.value).toBe('Review this for bugs');
    });

    it('is a no-op for an unknown snippet id', () => {
      input.value = 'keep';
      panel._insertPromptSnippet('999', {});
      expect(input.value).toBe('keep');
    });
  });

  describe('dropdown rendering', () => {
    it('populates _promptSnippetsById and renders truncated previews', () => {
      const longBody = 'x'.repeat(80);
      panel._renderSnippetDropdown([
        { id: 1, body: 'first line\nsecond line' },
        { id: 2, body: longBody },
      ]);

      expect(panel._promptSnippetsById.get('1')).toBe('first line\nsecond line');
      expect(panel._promptSnippetsById.get('2')).toBe(longBody);
      // First line only, sliced to 60 + ellipsis.
      expect(panel.snippetDropdown.innerHTML).toContain('first line');
      expect(panel.snippetDropdown.innerHTML).toContain('…');
    });

    it('renders an empty state with a Manage button when there are no snippets', () => {
      panel._renderSnippetDropdown([]);
      expect(panel.snippetDropdown.innerHTML).toContain('No snippets yet');
      expect(panel.snippetDropdown.innerHTML).toContain('chat-panel__snippet-manage-empty-btn');
    });
  });

  describe('mutual exclusion', () => {
    it('showing the snippet dropdown hides provider and session dropdowns', async () => {
      panel.providerDropdown.style.display = '';
      panel.sessionDropdown.style.display = '';

      await panel._showSnippetDropdown();

      expect(panel.providerDropdown.style.display).toBe('none');
      expect(panel.sessionDropdown.style.display).toBe('none');
      expect(panel.snippetDropdown.style.display).toBe('');
    });

    it('showing the provider dropdown hides the snippet dropdown', () => {
      panel.snippetDropdown.style.display = '';
      panel._showProviderDropdown();
      expect(panel.snippetDropdown.style.display).toBe('none');
    });

    it('showing the session dropdown hides the snippet dropdown', async () => {
      panel.snippetDropdown.style.display = '';
      vi.spyOn(panel, '_fetchSessions').mockResolvedValue([]);
      await panel._showSessionDropdown();
      expect(panel.snippetDropdown.style.display).toBe('none');
    });

    it('bails after the fetch await if the dropdown was dismissed meanwhile', async () => {
      // Defer the fetch so we can hide mid-flight.
      let resolveFetch;
      global.fetch.mockReturnValue(new Promise(r => { resolveFetch = r; }));

      const showPromise = panel._showSnippetDropdown();
      // Simulate a concurrent hide (e.g. panel close) while fetch is pending.
      panel._hideSnippetDropdown();
      resolveFetch({ ok: true, json: async () => ({ snippets: [] }) });
      await showPromise;

      expect(panel.snippetDropdown.style.display).toBe('none');
    });
  });

  describe('teardown', () => {
    it('close() hides the snippet dropdown', () => {
      panel.snippetDropdown.style.display = '';
      // close() reads a few tab-context fields; an active tab keeps it simple.
      attachTab(panel);
      panel.close();
      expect(panel.snippetDropdown.style.display).toBe('none');
    });

    it('_hideSnippetDropdown removes a registered outside-click listener', async () => {
      await panel._showSnippetDropdown();
      expect(documentClickListeners.length).toBe(1);
      panel._hideSnippetDropdown();
      expect(documentClickListeners.length).toBe(0);
    });

    it('destroy() removes a leaked provider-dropdown outside-click listener', () => {
      panel._showProviderDropdown();
      expect(documentClickListeners.length).toBe(1);
      panel.destroy();
      expect(documentClickListeners.length).toBe(0);
      expect(panel._providerOutsideClickHandler).toBeNull();
    });

    it('destroy() removes a leaked session-dropdown outside-click listener', async () => {
      vi.spyOn(panel, '_fetchSessions').mockResolvedValue([]);
      await panel._showSessionDropdown();
      expect(documentClickListeners.length).toBe(1);
      panel.destroy();
      expect(documentClickListeners.length).toBe(0);
      expect(panel._sessionOutsideClickHandler).toBeNull();
    });
  });

  describe('Escape ladder', () => {
    it('Escape with the snippet dropdown open hides it and does NOT close the panel', () => {
      const closeSpy = vi.spyOn(panel, 'close').mockImplementation(() => {});
      panel.snippetDropdown.style.display = ''; // open

      panel._onKeydown({ key: 'Escape' });

      expect(panel.snippetDropdown.style.display).toBe('none');
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('a second Escape (dropdown already closed) then closes the panel', () => {
      const closeSpy = vi.spyOn(panel, 'close').mockImplementation(() => {});
      panel.snippetDropdown.style.display = ''; // open

      panel._onKeydown({ key: 'Escape' }); // hides dropdown
      expect(closeSpy).not.toHaveBeenCalled();

      panel._onKeydown({ key: 'Escape' }); // nothing open -> close panel
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('_insertPromptSnippet — disabled input contract', () => {
    beforeEach(() => {
      panel._promptSnippetsById = new Map([['7', 'Review this for bugs']]);
    });

    it('bails when the input is disabled: value unchanged, sendBtn stays disabled, no touch', () => {
      input.value = 'existing';
      input.disabled = true;
      panel.sendBtn.disabled = true;

      panel._insertPromptSnippet('7', {});

      expect(input.value).toBe('existing');
      expect(panel.sendBtn.disabled).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('cmd-click on a disabled input does not reach sendMessage', () => {
      const sendSpy = vi.spyOn(panel, 'sendMessage').mockImplementation(() => {});
      input.disabled = true;

      panel._insertPromptSnippet('7', { send: true });

      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Save-as-snippet pill (alt-click a submitted user message)
  // -------------------------------------------------------------------------
  describe('save-as-snippet pill', () => {
    /** Invoke every click listener registered on the messages stack. */
    function fireStackClick(p, event) {
      const listeners = p.messagesStackEl?._listeners?.click || [];
      for (const fn of listeners) fn(event);
    }

    /** Build a fake click event whose target.closest resolves the given map. */
    function clickEvent({ altKey = false, closestMap = {}, clientX = 100, clientY = 200 } = {}) {
      return {
        altKey,
        clientX,
        clientY,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        target: { closest: (sel) => closestMap[sel] || null },
      };
    }

    function userMsg(content) {
      const el = createMockElement('div');
      el._chatRawContent = content;
      return el;
    }

    describe('alt-click delegation', () => {
      it('alt-click on a user message shows the pill', () => {
        const msg = userMsg('Save me please');
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: { '.chat-panel__message--user': msg } }));

        expect(panel._saveSnippetPill).toBeTruthy();
        expect(panel._saveSnippetPillContent).toBe('Save me please');
      });

      it('alt-click on an assistant message does nothing (no user match)', () => {
        // closest('.chat-panel__message--user') returns null for assistant.
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: {} }));
        expect(panel._saveSnippetPill).toBeFalsy();
      });

      it('a plain click (no Alt) never shows the pill', () => {
        const msg = userMsg('hi');
        fireStackClick(panel, clickEvent({ altKey: false, closestMap: { '.chat-panel__message--user': msg } }));
        expect(panel._saveSnippetPill).toBeFalsy();
      });

      it('only one pill at a time — alt-clicking another message moves it', () => {
        const a = userMsg('first');
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: { '.chat-panel__message--user': a } }));
        const firstPill = panel._saveSnippetPill;

        const b = userMsg('second');
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: { '.chat-panel__message--user': b } }));

        expect(firstPill.remove).toHaveBeenCalled();
        expect(panel._saveSnippetPillContent).toBe('second');
        expect(panel._saveSnippetPill).not.toBe(firstPill);
      });
    });

    describe('saving', () => {
      it('pill click POSTs the exact body and dismisses, then toasts success', async () => {
        global.window.toast = { showSuccess: vi.fn() };
        const body = 'Line one\nLine two';
        const msg = userMsg(body);
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: { '.chat-panel__message--user': msg } }));

        await panel._saveSnippetFromPill();

        expect(global.fetch).toHaveBeenCalledWith('/api/snippets', expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        }));
        expect(panel._saveSnippetPill).toBeNull();
        expect(global.window.toast.showSuccess).toHaveBeenCalled();
        delete global.window.toast;
      });

      it('a failed POST does not throw; pill shows "Failed" then dismisses', async () => {
        global.fetch.mockRejectedValue(new Error('network'));
        const msg = userMsg('body');
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: { '.chat-panel__message--user': msg } }));
        const pill = panel._saveSnippetPill;

        await expect(panel._saveSnippetFromPill()).resolves.toBeUndefined();

        expect(pill.textContent).toBe('Failed');
        // The synchronous fake setTimeout runs the deferred dismiss immediately.
        expect(panel._saveSnippetPill).toBeNull();
      });

      it('a non-ok response is treated as failure (no throw, no toast)', async () => {
        global.window.toast = { showSuccess: vi.fn() };
        global.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
        const msg = userMsg('body');
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: { '.chat-panel__message--user': msg } }));

        await expect(panel._saveSnippetFromPill()).resolves.toBeUndefined();

        expect(global.window.toast.showSuccess).not.toHaveBeenCalled();
        delete global.window.toast;
      });
    });

    describe('dismissal', () => {
      it('outside click dismisses the pill', () => {
        const msg = userMsg('body');
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: { '.chat-panel__message--user': msg } }));
        expect(documentClickListeners.length).toBe(1);

        // Simulate a document click on something other than the pill.
        documentClickListeners[0]({ target: createMockElement('div') });

        expect(panel._saveSnippetPill).toBeNull();
        expect(documentClickListeners.length).toBe(0);
      });

      it('Escape dismisses the pill and does NOT close the panel', () => {
        const closeSpy = vi.spyOn(panel, 'close').mockImplementation(() => {});
        const msg = userMsg('body');
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: { '.chat-panel__message--user': msg } }));

        panel._onKeydown({ key: 'Escape' });

        expect(panel._saveSnippetPill).toBeNull();
        expect(closeSpy).not.toHaveBeenCalled();

        // A second Escape (nothing open) then closes the panel.
        panel._onKeydown({ key: 'Escape' });
        expect(closeSpy).toHaveBeenCalledTimes(1);
      });

      it('destroy() removes the pill and its outside-click listener', () => {
        const msg = userMsg('body');
        fireStackClick(panel, clickEvent({ altKey: true, closestMap: { '.chat-panel__message--user': msg } }));
        expect(documentClickListeners.length).toBe(1);

        panel.destroy();

        expect(panel._saveSnippetPill).toBeNull();
        expect(documentClickListeners.length).toBe(0);
      });
    });
  });
});
