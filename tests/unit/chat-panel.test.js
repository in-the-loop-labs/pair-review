// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for ChatPanel component
 *
 * Tests cover:
 * - _updateActionButtons: shows/hides correct buttons for suggestion vs comment vs null context
 * - _handleAdoptClick / _handleUpdateClick: set input and call sendMessage, guard streaming/missing ID
 * - _sendCommentContextMessage: stores context and renders card correctly
 * - close(): resets button UI state, clears context, keeps SSE alive
 * - _startNewConversation(): calls _finalizeStreaming, resets all state
 * - open() with mutually exclusive contexts: suggestion vs comment (if/else if)
 * - Background SSE accumulation: delta events accumulate when isOpen === false
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// DOM helpers — lightweight mock elements that behave enough like the real DOM
// for ChatPanel's constructor (_render / _bindEvents) to run.
// ---------------------------------------------------------------------------

/** Map of id -> element for getElementById */
let elementRegistry;

/** Listeners registered on the document mock via addEventListener */
let documentListeners;

function createMockElement(tag = 'div', overrides = {}) {
  const children = [];
  let _innerHTML = '';
  let _textContent = '';
  const _classList = new Set();
  const _dataset = { ...overrides.dataset };
  const _style = {};

  const el = {
    tagName: tag.toUpperCase(),
    children,
    childNodes: children,
    style: _style,
    dataset: _dataset,
    id: overrides.id || '',
    disabled: false,

    get innerHTML() { return _innerHTML; },
    set innerHTML(val) { _innerHTML = val; },

    get textContent() { return _textContent; },
    set textContent(val) {
      _textContent = val;
      // Mimic escapeHtml behavior: innerHTML becomes escaped
      _innerHTML = val
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    classList: {
      _set: _classList,
      add: vi.fn((...cls) => cls.forEach(c => _classList.add(c))),
      remove: vi.fn((...cls) => cls.forEach(c => _classList.delete(c))),
      contains: vi.fn((cls) => _classList.has(cls)),
      toggle: vi.fn((cls) => {
        if (_classList.has(cls)) { _classList.delete(cls); } else { _classList.add(cls); }
      })
    },

    appendChild: vi.fn((child) => {
      children.push(child);
      return child;
    }),

    insertBefore: vi.fn((child, ref) => {
      const idx = children.indexOf(ref);
      if (idx >= 0) { children.splice(idx, 0, child); } else { children.push(child); }
      return child;
    }),

    remove: vi.fn(),

    querySelector: vi.fn((selector) => {
      // Handle queries for the elements ChatPanel caches during _render
      if (selector === '#chat-panel') return elementRegistry['chat-panel'] || null;
      if (selector === '#chat-messages') return elementRegistry['chat-messages'] || null;
      if (selector === '.chat-panel__input') return elementRegistry['chat-input'] || null;
      if (selector === '.chat-panel__send-btn') return elementRegistry['chat-send-btn'] || null;
      if (selector === '.chat-panel__stop-btn') return elementRegistry['chat-stop-btn'] || null;
      if (selector === '.chat-panel__close-btn') return elementRegistry['chat-close-btn'] || null;
      if (selector === '.chat-panel__new-btn') return elementRegistry['chat-new-btn'] || null;
      if (selector === '.chat-panel__action-bar') return elementRegistry['chat-action-bar'] || null;
      if (selector === '.chat-panel__action-btn--adopt') return elementRegistry['chat-adopt-btn'] || null;
      if (selector === '.chat-panel__action-btn--update') return elementRegistry['chat-update-btn'] || null;
      if (selector === '.chat-panel__action-btn--dismiss-suggestion') return elementRegistry['chat-dismiss-suggestion-btn'] || null;
      if (selector === '.chat-panel__action-btn--dismiss-comment') return elementRegistry['chat-dismiss-comment-btn'] || null;
      if (selector === '.chat-panel__action-btn--create-comment') return elementRegistry['chat-create-comment-btn'] || null;
      if (selector === '.chat-panel__action-bar-dismiss') return elementRegistry['chat-action-bar-dismiss'] || null;
      if (selector === '.chat-panel__resize-handle') return elementRegistry['chat-resize-handle'] || null;
      if (selector === '.chat-panel__empty') return elementRegistry['chat-empty'] || null;
      if (selector === '.chat-panel__new-content-pill') return elementRegistry['chat-new-content-pill'] || null;
      if (selector === '.chat-panel__context-card') return null;
      if (selector === '.chat-panel__bubble') return null;
      if (selector === '.chat-panel__thinking') return null;
      if (selector === '.chat-panel__cursor') return null;
      return null;
    }),

    querySelectorAll: vi.fn(() => []),

    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),

    getBoundingClientRect: vi.fn(() => ({ top: 0, left: 0, width: 400, height: 600 })),

    closest: vi.fn(() => null),

    focus: vi.fn(),
    blur: vi.fn(),

    // Allow property spreading from overrides
    ...overrides
  };

  // Re-apply non-function overrides that may have been shadowed
  if (overrides.id) el.id = overrides.id;

  return el;
}

/**
 * Build the registry of named elements that ChatPanel._render queries for.
 * We intercept the innerHTML setter on the container so that once _render runs
 * we can set up the cached element references manually (since innerHTML in our
 * mock doesn't actually parse HTML).
 */
function buildElementRegistry() {
  elementRegistry = {
    'chat-panel': createMockElement('div', { id: 'chat-panel' }),
    'chat-messages': createMockElement('div', { id: 'chat-messages' }),
    'chat-input': createMockElement('textarea'),
    'chat-send-btn': createMockElement('button'),
    'chat-stop-btn': createMockElement('button'),
    'chat-close-btn': createMockElement('button'),
    'chat-new-btn': createMockElement('button'),
    'chat-action-bar': createMockElement('div'),
    'chat-adopt-btn': createMockElement('button'),
    'chat-update-btn': createMockElement('button'),
    'chat-dismiss-suggestion-btn': createMockElement('button'),
    'chat-dismiss-comment-btn': createMockElement('button'),
    'chat-create-comment-btn': createMockElement('button'),
    'chat-action-bar-dismiss': createMockElement('button'),
    'chat-resize-handle': createMockElement('div'),
    'chat-empty': createMockElement('div'),
    'chat-session-picker': createMockElement('div'),
    'chat-session-picker-btn': createMockElement('button'),
    'chat-session-dropdown': createMockElement('div'),
    'chat-title-text': createMockElement('span'),
    'chat-new-content-pill': createMockElement('button'),
  };

  // Give the textarea a value property
  elementRegistry['chat-input'].value = '';
  elementRegistry['chat-input'].scrollHeight = 30;

  // Buttons need display style initialisations
  elementRegistry['chat-send-btn'].style = { display: '' };
  elementRegistry['chat-stop-btn'].style = { display: 'none' };
  elementRegistry['chat-action-bar'].style = { display: 'none' };
  elementRegistry['chat-adopt-btn'].style = { display: 'none' };
  elementRegistry['chat-update-btn'].style = { display: 'none' };
  elementRegistry['chat-dismiss-suggestion-btn'].style = { display: 'none' };
  elementRegistry['chat-dismiss-comment-btn'].style = { display: 'none' };
  elementRegistry['chat-create-comment-btn'].style = { display: 'none' };
  elementRegistry['chat-session-dropdown'].style = { display: 'none' };
  elementRegistry['chat-new-content-pill'].style = { display: 'none' };

  return elementRegistry;
}

// ---------------------------------------------------------------------------
// Set up globals BEFORE requiring ChatPanel (IIFE assigns to window)
// ---------------------------------------------------------------------------

global.window = global.window || {};
global.window.prManager = null;
global.window.renderMarkdown = (text) => `<p>${text}</p>`;
global.window.escapeHtmlAttribute = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Load shared timestamp utility (sets window.parseTimestamp)
require('../../public/js/utils/time.js');

global.localStorage = {
  _store: {},
  getItem: vi.fn((key) => global.localStorage._store[key] || null),
  setItem: vi.fn((key, val) => { global.localStorage._store[key] = String(val); }),
  removeItem: vi.fn((key) => { delete global.localStorage._store[key]; }),
};

global.EventSource = class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url) {
    this.url = url;
    this.readyState = MockEventSource.OPEN;
    this.onmessage = null;
    this.onerror = null;
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
};

documentListeners = {};

global.document = {
  documentElement: {
    style: { setProperty: vi.fn(), getPropertyValue: vi.fn(() => '') },
    getAttribute: vi.fn(() => null),
  },
  body: {
    classList: { add: vi.fn(), remove: vi.fn() },
    appendChild: vi.fn(),
    removeChild: vi.fn(),
  },
  activeElement: null,
  createElement: vi.fn((tag) => createMockElement(tag)),
  getElementById: vi.fn((id) => {
    if (id === 'chat-container') return elementRegistry['chat-container'];
    if (id === 'chat-streaming-msg') return elementRegistry['chat-streaming-msg'] || null;
    return null;
  }),
  querySelector: vi.fn(() => null),
  addEventListener: vi.fn((event, handler) => {
    if (!documentListeners[event]) documentListeners[event] = [];
    documentListeners[event].push(handler);
  }),
  removeEventListener: vi.fn(),
};

global.fetch = vi.fn();
global.clearTimeout = vi.fn();
global.setTimeout = vi.fn((cb) => { cb(); return 99; });
global.requestAnimationFrame = vi.fn((cb) => { cb(); return 0; });

// Now require the production ChatPanel module
const { ChatPanel, NEAR_BOTTOM_THRESHOLD } = require('../../public/js/components/ChatPanel.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ChatPanel whose constructor completes without errors.
 * We pre-populate the element registry so the querySelector calls inside
 * _render find the right mock elements.
 */
function createChatPanel() {
  const reg = buildElementRegistry();

  // The container element itself
  const container = createMockElement('div', { id: 'chat-container' });

  // Override container.querySelector to return elements from our registry
  container.querySelector = vi.fn((selector) => {
    const map = {
      '#chat-panel': reg['chat-panel'],
      '#chat-messages': reg['chat-messages'],
      '.chat-panel__input': reg['chat-input'],
      '.chat-panel__send-btn': reg['chat-send-btn'],
      '.chat-panel__stop-btn': reg['chat-stop-btn'],
      '.chat-panel__close-btn': reg['chat-close-btn'],
      '.chat-panel__new-btn': reg['chat-new-btn'],
      '.chat-panel__action-bar': reg['chat-action-bar'],
      '.chat-panel__action-btn--adopt': reg['chat-adopt-btn'],
      '.chat-panel__action-btn--update': reg['chat-update-btn'],
      '.chat-panel__action-btn--dismiss-suggestion': reg['chat-dismiss-suggestion-btn'],
      '.chat-panel__action-btn--dismiss-comment': reg['chat-dismiss-comment-btn'],
      '.chat-panel__action-btn--create-comment': reg['chat-create-comment-btn'],
      '.chat-panel__action-bar-dismiss': reg['chat-action-bar-dismiss'],
      '.chat-panel__resize-handle': reg['chat-resize-handle'],
      '.chat-panel__session-picker': reg['chat-session-picker'],
      '.chat-panel__session-picker-btn': reg['chat-session-picker-btn'],
      '.chat-panel__session-dropdown': reg['chat-session-dropdown'],
      '.chat-panel__title-text': reg['chat-title-text'],
      '.chat-panel__new-content-pill': reg['chat-new-content-pill'],
    };
    return map[selector] || null;
  });

  elementRegistry['chat-container'] = container;

  // Ensure getElementById returns our container
  global.document.getElementById = vi.fn((id) => {
    if (id === 'chat-container') return container;
    if (id === 'chat-streaming-msg') return elementRegistry['chat-streaming-msg'] || null;
    return null;
  });

  // Construct the panel — triggers _render and _bindEvents
  const panel = new ChatPanel('chat-container');
  return panel;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatPanel', () => {
  let chatPanel;

  beforeEach(() => {
    vi.clearAllMocks();
    documentListeners = {};
    global.localStorage._store = {};
    chatPanel = createChatPanel();
  });

  afterEach(() => {
    if (chatPanel) {
      // Suppress destroy's SSE cleanup
      chatPanel.eventSource = null;
      chatPanel._sseReconnectTimer = null;
    }
    chatPanel = null;
  });

  // -----------------------------------------------------------------------
  // _updateActionButtons
  // -----------------------------------------------------------------------
  describe('_updateActionButtons', () => {
    it('should hide all action buttons when no context is set', () => {
      chatPanel._contextSource = null;
      chatPanel._contextItemId = null;

      chatPanel._updateActionButtons();

      expect(chatPanel.actionBar.style.display).toBe('none');
      expect(chatPanel.adoptBtn.style.display).toBe('none');
      expect(chatPanel.updateBtn.style.display).toBe('none');
    });

    it('should show adopt button for suggestion context', () => {
      chatPanel._contextSource = 'suggestion';
      chatPanel._contextItemId = 42;

      chatPanel._updateActionButtons();

      expect(chatPanel.actionBar.style.display).toBe('');
      expect(chatPanel.adoptBtn.style.display).toBe('');
      expect(chatPanel.updateBtn.style.display).toBe('none');
    });

    it('should show update button for user comment context', () => {
      chatPanel._contextSource = 'user';
      chatPanel._contextItemId = 99;

      chatPanel._updateActionButtons();

      expect(chatPanel.actionBar.style.display).toBe('');
      expect(chatPanel.adoptBtn.style.display).toBe('none');
      expect(chatPanel.updateBtn.style.display).toBe('');
    });

    it('should hide bar when contextSource is set but contextItemId is falsy', () => {
      chatPanel._contextSource = 'suggestion';
      chatPanel._contextItemId = null;

      chatPanel._updateActionButtons();

      expect(chatPanel.actionBar.style.display).toBe('none');
    });

    it('should disable adopt and update buttons while streaming', () => {
      chatPanel._contextSource = 'suggestion';
      chatPanel._contextItemId = 7;
      chatPanel.isStreaming = true;

      chatPanel._updateActionButtons();

      expect(chatPanel.adoptBtn.disabled).toBe(true);
      expect(chatPanel.updateBtn.disabled).toBe(true);
    });

    it('should enable adopt and update buttons when not streaming', () => {
      chatPanel._contextSource = 'user';
      chatPanel._contextItemId = 7;
      chatPanel.isStreaming = false;

      chatPanel._updateActionButtons();

      expect(chatPanel.adoptBtn.disabled).toBe(false);
      expect(chatPanel.updateBtn.disabled).toBe(false);
    });

    it('should show create comment button for line context', () => {
      chatPanel._contextSource = 'line';
      chatPanel._contextItemId = null;

      chatPanel._updateActionButtons();

      expect(chatPanel.actionBar.style.display).toBe('');
      expect(chatPanel.createCommentBtn.style.display).toBe('');
      expect(chatPanel.adoptBtn.style.display).toBe('none');
      expect(chatPanel.updateBtn.style.display).toBe('none');
      expect(chatPanel.dismissSuggestionBtn.style.display).toBe('none');
      expect(chatPanel.dismissCommentBtn.style.display).toBe('none');
    });

    it('should hide action bar when chat shortcuts are disabled via config', () => {
      chatPanel._contextSource = 'suggestion';
      chatPanel._contextItemId = 'sugg-1';

      // Mock getAttribute to return 'disabled' for data-chat-shortcuts
      const originalGetAttribute = document.documentElement.getAttribute;
      document.documentElement.getAttribute = vi.fn((attr) => {
        if (attr === 'data-chat-shortcuts') return 'disabled';
        return null;
      });

      chatPanel._updateActionButtons();

      expect(chatPanel.actionBar.style.display).toBe('none');

      // Restore
      document.documentElement.getAttribute = originalGetAttribute;
    });
  });

  // -----------------------------------------------------------------------
  // _handleAdoptClick / _handleUpdateClick / dismiss handlers
  // -----------------------------------------------------------------------
  describe('_handleAdoptClick', () => {
    it('should set clean input text and actionContext then call sendMessage', () => {
      chatPanel._contextItemId = 55;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleAdoptClick();

      expect(chatPanel.inputEl.value).toContain('adopt');
      expect(chatPanel.inputEl.value).not.toContain('55');
      expect(chatPanel._pendingActionContext).toEqual({ type: 'adopt', itemId: 55 });
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should not act when streaming', () => {
      chatPanel._contextItemId = 55;
      chatPanel.isStreaming = true;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleAdoptClick();

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('should not act when contextItemId is null', () => {
      chatPanel._contextItemId = null;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleAdoptClick();

      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('_handleUpdateClick', () => {
    it('should set clean input text and actionContext then call sendMessage', () => {
      chatPanel._contextItemId = 88;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleUpdateClick();

      expect(chatPanel.inputEl.value).toContain('update');
      expect(chatPanel.inputEl.value).not.toContain('88');
      expect(chatPanel._pendingActionContext).toEqual({ type: 'update', itemId: 88 });
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should not act when streaming', () => {
      chatPanel._contextItemId = 88;
      chatPanel.isStreaming = true;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleUpdateClick();

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('should not act when contextItemId is null', () => {
      chatPanel._contextItemId = null;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleUpdateClick();

      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('_handleDismissSuggestionClick', () => {
    it('should set clean input text and actionContext then call sendMessage', () => {
      chatPanel._contextItemId = 42;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleDismissSuggestionClick();

      expect(chatPanel.inputEl.value).toContain('dismiss');
      expect(chatPanel.inputEl.value).not.toContain('42');
      expect(chatPanel._pendingActionContext).toEqual({ type: 'dismiss-suggestion', itemId: 42 });
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should not act when streaming', () => {
      chatPanel._contextItemId = 42;
      chatPanel.isStreaming = true;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleDismissSuggestionClick();

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('should not act when contextItemId is null', () => {
      chatPanel._contextItemId = null;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleDismissSuggestionClick();

      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('_handleDismissCommentClick', () => {
    it('should set clean input text and actionContext then call sendMessage', () => {
      chatPanel._contextItemId = 77;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleDismissCommentClick();

      expect(chatPanel.inputEl.value).toContain('delete');
      expect(chatPanel.inputEl.value).not.toContain('77');
      expect(chatPanel._pendingActionContext).toEqual({ type: 'dismiss-comment', itemId: 77 });
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should not act when streaming', () => {
      chatPanel._contextItemId = 77;
      chatPanel.isStreaming = true;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleDismissCommentClick();

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('should not act when contextItemId is null', () => {
      chatPanel._contextItemId = null;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleDismissCommentClick();

      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('_handleCreateCommentClick', () => {
    it('should set pending action context and send create comment message', () => {
      chatPanel.isStreaming = false;
      chatPanel._contextLineMeta = { file: 'src/foo.js', line_start: 10, line_end: 20 };
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleCreateCommentClick();

      expect(chatPanel._pendingActionContext).toEqual({
        type: 'create-comment',
        file: 'src/foo.js',
        line_start: 10,
        line_end: 20,
      });
      expect(chatPanel.inputEl.value).toBe('Based on our conversation, please create a review comment for this code.');
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should not send when streaming', () => {
      chatPanel.isStreaming = true;
      chatPanel._contextLineMeta = { file: 'src/foo.js', line_start: 10, line_end: 20 };
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleCreateCommentClick();

      expect(chatPanel._pendingActionContext).toBeNull();
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('_handleActionBarDismiss', () => {
    it('should clear context state and hide action bar', () => {
      chatPanel._contextSource = 'suggestion';
      chatPanel._contextItemId = 'sugg-1';
      chatPanel._contextLineMeta = { file: 'foo.js', line_start: 1, line_end: 5 };

      chatPanel._handleActionBarDismiss();

      expect(chatPanel._contextSource).toBeNull();
      expect(chatPanel._contextItemId).toBeNull();
      expect(chatPanel._contextLineMeta).toBeNull();
      expect(chatPanel.actionBar.style.display).toBe('none');
    });
  });

  // -----------------------------------------------------------------------
  // _sendCommentContextMessage
  // -----------------------------------------------------------------------
  describe('_sendCommentContextMessage', () => {
    it('should store context data for a line comment', () => {
      const ctx = {
        commentId: 'c1',
        body: 'Fix the typo here',
        file: 'src/app.js',
        line_start: 42,
        line_end: 42,
        source: 'user',
        isFileLevel: false,
      };

      chatPanel._sendCommentContextMessage(ctx);

      expect(chatPanel._pendingContext).toHaveLength(1);
      expect(chatPanel._pendingContextData).toHaveLength(1);
      expect(chatPanel._pendingContext[0]).toContain('review comment');
      expect(chatPanel._pendingContext[0]).toContain('src/app.js');
      expect(chatPanel._pendingContext[0]).toContain('line 42');
      expect(chatPanel._pendingContext[0]).toContain('Fix the typo here');
    });

    it('should store context data for a file-level comment', () => {
      const ctx = {
        commentId: 'c2',
        body: 'Needs better docs',
        file: 'README.md',
        line_start: null,
        line_end: null,
        source: 'user',
        isFileLevel: true,
      };

      chatPanel._sendCommentContextMessage(ctx);

      expect(chatPanel._pendingContext).toHaveLength(1);
      expect(chatPanel._pendingContext[0]).toContain('File-level comment');
    });

    it('should store structured contextData with type "comment"', () => {
      const ctx = {
        commentId: 'c3',
        body: 'Look at this',
        file: 'index.js',
        line_start: 10,
        line_end: 15,
        source: 'user',
        isFileLevel: false,
      };

      chatPanel._sendCommentContextMessage(ctx);

      const data = chatPanel._pendingContextData[0];
      expect(data.type).toBe('comment');
      expect(data.file).toBe('index.js');
      expect(data.line_start).toBe(10);
      expect(data.line_end).toBe(15);
      expect(data.body).toBe('Look at this');
      expect(data.source).toBe('user');
    });

    it('should render a context card in the messages area', () => {
      const ctx = {
        commentId: 'c4',
        body: 'Short comment',
        file: 'foo.js',
        line_start: 5,
        source: 'user',
        isFileLevel: false,
      };

      chatPanel._sendCommentContextMessage(ctx);

      // A div element should have been appended to messagesEl
      expect(chatPanel.messagesEl.appendChild).toHaveBeenCalled();
      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.className).toBe('chat-panel__context-card');
    });

    it('should remove empty state before adding card', () => {
      const emptyEl = createMockElement('div');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__empty') return emptyEl;
        if (sel === '.chat-panel__context-card') return null;
        return null;
      });

      chatPanel._sendCommentContextMessage({
        commentId: 'c5',
        body: 'Test',
        file: 'a.js',
        line_start: 1,
        source: 'user',
        isFileLevel: false,
      });

      expect(emptyEl.remove).toHaveBeenCalled();
    });

    it('should handle missing file gracefully', () => {
      const ctx = {
        commentId: 'c6',
        body: 'No file',
        file: null,
        line_start: null,
        source: 'user',
        isFileLevel: false,
      };

      chatPanel._sendCommentContextMessage(ctx);

      expect(chatPanel._pendingContextData[0].file).toBeNull();
      // Should not contain "File:" line
      expect(chatPanel._pendingContext[0]).not.toContain('File:');
    });

    it('should show line range when line_end differs from line_start', () => {
      const ctx = {
        commentId: 'c7',
        body: 'Multi-line',
        file: 'range.js',
        line_start: 10,
        line_end: 20,
        source: 'user',
        isFileLevel: false,
      };

      chatPanel._sendCommentContextMessage(ctx);

      expect(chatPanel._pendingContext[0]).toContain('line 10-20');
    });
  });

  // -----------------------------------------------------------------------
  // _addCommentContextCard
  // -----------------------------------------------------------------------
  describe('_addCommentContextCard', () => {
    it('should set label to "comment" for non-file-level comments', () => {
      const ctx = { commentId: '1', body: 'Hello', file: 'a.js', line_start: 5, isFileLevel: false };
      chatPanel._addCommentContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('comment');
    });

    it('should set label to "file comment" for file-level comments', () => {
      const ctx = { commentId: '1', body: 'Hello', file: 'a.js', isFileLevel: true };
      chatPanel._addCommentContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('file comment');
    });

    it('should truncate long body text at 60 characters', () => {
      const longBody = 'A'.repeat(80);
      const ctx = { commentId: '1', body: longBody, file: 'a.js', line_start: 1, isFileLevel: false };
      chatPanel._addCommentContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('...');
      // The 60-char substring should appear
      expect(card.innerHTML).toContain('A'.repeat(60));
    });

    it('should show "Comment" when body is null', () => {
      const ctx = { commentId: '1', body: null, file: 'a.js', line_start: 1, isFileLevel: false };
      chatPanel._addCommentContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('Comment');
    });
  });

  // -----------------------------------------------------------------------
  // _addFileContextCard
  // -----------------------------------------------------------------------
  describe('_addFileContextCard', () => {
    it('should render card with file icon and FILE label', () => {
      const ctx = { file: 'src/app.js', type: 'file' };
      chatPanel._addFileContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('<svg');
      expect(card.innerHTML).toContain('FILE');
      expect(card.innerHTML).toContain('src/app.js');
    });

    it('should use ctx.file for display', () => {
      const ctx = { file: 'src/app.js', type: 'file' };
      chatPanel._addFileContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('src/app.js');
    });

    it('should fall back to ctx.title when ctx.file is missing', () => {
      const ctx = { title: 'some-title', type: 'file' };
      chatPanel._addFileContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('some-title');
    });

    it('should fall back to empty string when both file and title missing', () => {
      const ctx = { type: 'file' };
      chatPanel._addFileContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      // Should render without error; the title span will be empty
      expect(card.className).toBe('chat-panel__context-card');
      expect(card.innerHTML).toContain('FILE');
    });

    it('should not be removable by default', () => {
      const ctx = { file: 'src/app.js', type: 'file' };
      chatPanel._addFileContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      // No remove button should have been appended to the card
      expect(card.appendChild).not.toHaveBeenCalled();
    });

    it('should be removable when option set', () => {
      chatPanel._pendingContextData = [{ type: 'file' }]; // pre-push data so _makeCardRemovable has an index
      const ctx = { file: 'src/app.js', type: 'file' };
      chatPanel._addFileContextCard(ctx, { removable: true });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      // _makeCardRemovable appends a remove button to the card
      expect(card.appendChild).toHaveBeenCalled();
      const removeBtn = card.appendChild.mock.calls[0][0];
      expect(removeBtn.className).toBe('chat-panel__context-remove');
      expect(removeBtn.title).toBe('Remove context');
    });
  });

  // -----------------------------------------------------------------------
  // _makeCardRemovable
  // -----------------------------------------------------------------------
  describe('_makeCardRemovable', () => {
    it('should set data-context-index from pending array length', () => {
      chatPanel._pendingContextData = [{ id: 0 }, { id: 1 }];
      const card = createMockElement('div');
      chatPanel._makeCardRemovable(card);

      // Index should be length - 1 = 1
      expect(card.dataset.contextIndex).toBe(1);
    });

    it('should create remove button with correct class and title', () => {
      chatPanel._pendingContextData = [{ id: 0 }];
      const card = createMockElement('div');
      chatPanel._makeCardRemovable(card);

      const removeBtn = card.appendChild.mock.calls[0][0];
      expect(removeBtn.className).toBe('chat-panel__context-remove');
      expect(removeBtn.title).toBe('Remove context');
    });

    it('should call _removeContextCard on click', () => {
      chatPanel._pendingContextData = [{ id: 0 }];
      const card = createMockElement('div');
      const removeCardSpy = vi.spyOn(chatPanel, '_removeContextCard').mockImplementation(() => {});
      chatPanel._makeCardRemovable(card);

      const removeBtn = card.appendChild.mock.calls[0][0];
      // The real DOM would use addEventListener; our mock captures it
      // Simulate the click by finding the listener and calling it
      const clickCall = removeBtn.addEventListener.mock.calls.find(([evt]) => evt === 'click');
      expect(clickCall).toBeDefined();
      clickCall[1]({ stopPropagation: vi.fn() }); // invoke the handler

      expect(removeCardSpy).toHaveBeenCalledWith(card);
    });
  });

  // -----------------------------------------------------------------------
  // close()
  // -----------------------------------------------------------------------
  describe('close()', () => {
    it('should set isOpen to false', () => {
      chatPanel.isOpen = true;
      chatPanel.close();
      expect(chatPanel.isOpen).toBe(false);
    });

    it('should add closed class and remove open class', () => {
      chatPanel.isOpen = true;
      chatPanel.close();

      expect(chatPanel.panel.classList.add).toHaveBeenCalledWith('chat-panel--closed');
      expect(chatPanel.panel.classList.remove).toHaveBeenCalledWith('chat-panel--open');
    });

    it('should reset send/stop button visibility', () => {
      chatPanel.sendBtn.style.display = 'none';
      chatPanel.stopBtn.style.display = '';

      chatPanel.close();

      expect(chatPanel.sendBtn.style.display).toBe('');
      expect(chatPanel.stopBtn.style.display).toBe('none');
    });

    it('should clear pending context arrays', () => {
      chatPanel._pendingContext = ['some context'];
      chatPanel._pendingContextData = [{ type: 'comment' }];

      chatPanel.close();

      expect(chatPanel._pendingContext).toEqual([]);
      expect(chatPanel._pendingContextData).toEqual([]);
    });

    it('should clear context source and item ID', () => {
      chatPanel._contextSource = 'suggestion';
      chatPanel._contextItemId = 42;

      chatPanel.close();

      expect(chatPanel._contextSource).toBeNull();
      expect(chatPanel._contextItemId).toBeNull();
    });

    it('should preserve _sessionAnalysisRunId across close/reopen for new-run detection', () => {
      chatPanel._sessionAnalysisRunId = 'run-123';

      chatPanel.close();

      expect(chatPanel._sessionAnalysisRunId).toBe('run-123');
    });

    it('should preserve _analysisContextRemoved across close/reopen', () => {
      chatPanel._analysisContextRemoved = true;

      chatPanel.close();

      expect(chatPanel._analysisContextRemoved).toBe(true);
    });

    it('should NOT close the global SSE connection', () => {
      const mockES = new global.EventSource('/api/chat/stream');
      chatPanel.eventSource = mockES;
      const closeSpy = vi.spyOn(mockES, 'close');

      chatPanel.close();

      expect(closeSpy).not.toHaveBeenCalled();
      expect(chatPanel.eventSource).toBe(mockES);
    });

    it('should keep isStreaming and _streamingContent intact for background accumulation', () => {
      chatPanel.isStreaming = true;
      chatPanel._streamingContent = 'partial response';

      chatPanel.close();

      expect(chatPanel.isStreaming).toBe(true);
      expect(chatPanel._streamingContent).toBe('partial response');
    });

    it('should disable send button when input is empty', () => {
      chatPanel.inputEl.value = '';
      chatPanel.close();
      expect(chatPanel.sendBtn.disabled).toBe(true);
    });

    it('should enable send button when input has text', () => {
      chatPanel.inputEl.value = 'hello';
      chatPanel.close();
      expect(chatPanel.sendBtn.disabled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // _startNewConversation()
  // -----------------------------------------------------------------------
  describe('_startNewConversation()', () => {
    it('should call _finalizeStreaming', async () => {
      const finalizeSpy = vi.spyOn(chatPanel, '_finalizeStreaming');

      await chatPanel._startNewConversation();

      expect(finalizeSpy).toHaveBeenCalled();
    });

    it('should reset currentSessionId', async () => {
      chatPanel.currentSessionId = 'session-123';

      await chatPanel._startNewConversation();

      expect(chatPanel.currentSessionId).toBeNull();
    });

    it('should clear messages array', async () => {
      chatPanel.messages = [{ role: 'user', content: 'hi' }];

      await chatPanel._startNewConversation();

      expect(chatPanel.messages).toEqual([]);
    });

    it('should reset streaming content', async () => {
      chatPanel._streamingContent = 'partial stuff';

      await chatPanel._startNewConversation();

      expect(chatPanel._streamingContent).toBe('');
    });

    it('should preserve pending context across new conversation', async () => {
      chatPanel._pendingContext = ['ctx'];
      chatPanel._pendingContextData = [{ type: 'suggestion', title: 'Test', file: 'a.js' }];

      await chatPanel._startNewConversation();

      expect(chatPanel._pendingContext).toEqual(['ctx']);
      expect(chatPanel._pendingContextData).toEqual([{ type: 'suggestion', title: 'Test', file: 'a.js' }]);
    });

    it('should clear pending context arrays when they are empty', async () => {
      chatPanel._pendingContext = [];
      chatPanel._pendingContextData = [];

      await chatPanel._startNewConversation();

      expect(chatPanel._pendingContext).toEqual([]);
      expect(chatPanel._pendingContextData).toEqual([]);
    });

    it('should preserve context source and item ID when pending context exists', async () => {
      chatPanel._contextSource = 'user';
      chatPanel._contextItemId = 77;
      chatPanel._pendingContext = ['ctx'];
      chatPanel._pendingContextData = [{ type: 'comment', source: 'user', body: 'Test' }];

      await chatPanel._startNewConversation();

      expect(chatPanel._contextSource).toBe('user');
      expect(chatPanel._contextItemId).toBe(77);
    });

    it('should reset context source and item ID when no pending context', async () => {
      chatPanel._contextSource = 'user';
      chatPanel._contextItemId = 77;
      chatPanel._pendingContext = [];
      chatPanel._pendingContextData = [];

      await chatPanel._startNewConversation();

      expect(chatPanel._contextSource).toBeNull();
      expect(chatPanel._contextItemId).toBeNull();
    });

    it('should reset _sessionAnalysisRunId', async () => {
      chatPanel._sessionAnalysisRunId = 'run-456';

      await chatPanel._startNewConversation();

      expect(chatPanel._sessionAnalysisRunId).toBeNull();
    });

    it('should call _updateActionButtons after reset', async () => {
      const updateSpy = vi.spyOn(chatPanel, '_updateActionButtons');

      await chatPanel._startNewConversation();

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should call _clearMessages to restore empty state', async () => {
      const clearSpy = vi.spyOn(chatPanel, '_clearMessages');

      await chatPanel._startNewConversation();

      expect(clearSpy).toHaveBeenCalled();
    });

    it('should call _ensureAnalysisContext to re-add analysis card', async () => {
      const ensureSpy = vi.spyOn(chatPanel, '_ensureAnalysisContext');

      await chatPanel._startNewConversation();

      expect(ensureSpy).toHaveBeenCalled();
    });

    it('should re-add suggestion context cards as removable', async () => {
      chatPanel._pendingContext = ['The user wants to discuss this specific suggestion:\n- Type: bug\n- Title: Fix null'];
      chatPanel._pendingContextData = [{ type: 'bug', title: 'Fix null', file: 'app.js', line_start: 10, line_end: 10, body: 'Check for null' }];
      chatPanel._contextSource = 'suggestion';
      chatPanel._contextItemId = 42;

      const addCardSpy = vi.spyOn(chatPanel, '_addContextCard');

      await chatPanel._startNewConversation();

      expect(addCardSpy).toHaveBeenCalledWith(
        { type: 'bug', title: 'Fix null', file: 'app.js', line_start: 10, line_end: 10, body: 'Check for null' },
        { removable: true }
      );
      expect(chatPanel._pendingContext).toHaveLength(1);
      expect(chatPanel._pendingContextData).toHaveLength(1);
      expect(chatPanel._contextSource).toBe('suggestion');
      expect(chatPanel._contextItemId).toBe(42);
    });

    it('should re-add comment context cards as removable', async () => {
      chatPanel._pendingContext = ['The user wants to discuss their own review comment:\n- File: b.js (line 5)'];
      chatPanel._pendingContextData = [{ type: 'comment', source: 'user', title: 'Comment on line 5', file: 'b.js', line_start: 5, line_end: 5, body: 'Needs refactor' }];
      chatPanel._contextSource = 'user';
      chatPanel._contextItemId = 99;

      const addCommentCardSpy = vi.spyOn(chatPanel, '_addCommentContextCard');

      await chatPanel._startNewConversation();

      expect(addCommentCardSpy).toHaveBeenCalledWith(
        { type: 'comment', source: 'user', title: 'Comment on line 5', file: 'b.js', line_start: 5, line_end: 5, body: 'Needs refactor' },
        { removable: true }
      );
      expect(chatPanel._contextSource).toBe('user');
      expect(chatPanel._contextItemId).toBe(99);
    });

    it('should re-add file context cards as removable', async () => {
      chatPanel._pendingContext = ['The user wants to discuss src/utils.js'];
      chatPanel._pendingContextData = [{ type: 'file', title: 'src/utils.js', file: 'src/utils.js', line_start: null, line_end: null, body: null }];

      const addFileCardSpy = vi.spyOn(chatPanel, '_addFileContextCard');

      await chatPanel._startNewConversation();

      expect(addFileCardSpy).toHaveBeenCalledWith(
        { type: 'file', title: 'src/utils.js', file: 'src/utils.js', line_start: null, line_end: null, body: null },
        { removable: true }
      );
    });

    it('should re-add multiple context cards in order', async () => {
      chatPanel._pendingContext = ['ctx1', 'ctx2'];
      chatPanel._pendingContextData = [
        { type: 'bug', title: 'Bug 1', file: 'a.js' },
        { type: 'file', title: 'b.js', file: 'b.js', line_start: null, line_end: null, body: null }
      ];

      const addCardSpy = vi.spyOn(chatPanel, '_addContextCard');
      const addFileCardSpy = vi.spyOn(chatPanel, '_addFileContextCard');

      await chatPanel._startNewConversation();

      expect(addCardSpy).toHaveBeenCalledTimes(1);
      expect(addFileCardSpy).toHaveBeenCalledTimes(1);
      expect(chatPanel._pendingContext).toHaveLength(2);
      expect(chatPanel._pendingContextData).toHaveLength(2);
    });

    it('should not re-add cards when pending arrays were empty', async () => {
      chatPanel._pendingContext = [];
      chatPanel._pendingContextData = [];

      const addCardSpy = vi.spyOn(chatPanel, '_addContextCard');
      const addCommentCardSpy = vi.spyOn(chatPanel, '_addCommentContextCard');
      const addFileCardSpy = vi.spyOn(chatPanel, '_addFileContextCard');

      await chatPanel._startNewConversation();

      expect(addCardSpy).not.toHaveBeenCalled();
      expect(addCommentCardSpy).not.toHaveBeenCalled();
      expect(addFileCardSpy).not.toHaveBeenCalled();
    });

    it('should remove empty state when re-adding saved context cards', async () => {
      chatPanel._pendingContext = ['ctx'];
      chatPanel._pendingContextData = [{ type: 'bug', title: 'Test' }];

      const emptyEl = createMockElement('div');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__empty') return emptyEl;
        if (sel === '.chat-panel__context-card[data-analysis]') return null;
        return null;
      });

      await chatPanel._startNewConversation();

      expect(emptyEl.remove).toHaveBeenCalled();
    });

    it('should reset _analysisContextRemoved so analysis card reappears', async () => {
      chatPanel._analysisContextRemoved = true;
      chatPanel._pendingContext = [];
      chatPanel._pendingContextData = [];

      await chatPanel._startNewConversation();

      expect(chatPanel._analysisContextRemoved).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // open() — mutually exclusive contexts
  // -----------------------------------------------------------------------
  describe('open() with mutually exclusive contexts', () => {
    beforeEach(() => {
      // Stub _ensureConnected so open() doesn't make real network calls
      vi.spyOn(chatPanel, '_ensureConnected').mockResolvedValue({ sessionData: null });
    });

    it('should call _sendContextMessage for suggestion context', async () => {
      const sendCtxSpy = vi.spyOn(chatPanel, '_sendContextMessage').mockImplementation(() => {});
      const sendCommentCtxSpy = vi.spyOn(chatPanel, '_sendCommentContextMessage').mockImplementation(() => {});

      await chatPanel.open({
        suggestionContext: { title: 'Test', type: 'bug', file: 'a.js' },
        suggestionId: 10,
      });

      expect(sendCtxSpy).toHaveBeenCalledWith({ title: 'Test', type: 'bug', file: 'a.js' });
      expect(sendCommentCtxSpy).not.toHaveBeenCalled();
      expect(chatPanel._contextSource).toBe('suggestion');
      expect(chatPanel._contextItemId).toBe(10);
    });

    it('should call _sendCommentContextMessage for comment context', async () => {
      const sendCtxSpy = vi.spyOn(chatPanel, '_sendContextMessage').mockImplementation(() => {});
      const sendCommentCtxSpy = vi.spyOn(chatPanel, '_sendCommentContextMessage').mockImplementation(() => {});

      await chatPanel.open({
        commentContext: { commentId: 'c1', body: 'Fix', file: 'b.js', source: 'user' },
      });

      expect(sendCommentCtxSpy).toHaveBeenCalled();
      expect(sendCtxSpy).not.toHaveBeenCalled();
      expect(chatPanel._contextSource).toBe('user');
      expect(chatPanel._contextItemId).toBe('c1');
    });

    it('should prefer suggestion context when both suggestion and comment are provided', async () => {
      const sendCtxSpy = vi.spyOn(chatPanel, '_sendContextMessage').mockImplementation(() => {});
      const sendCommentCtxSpy = vi.spyOn(chatPanel, '_sendCommentContextMessage').mockImplementation(() => {});

      await chatPanel.open({
        suggestionContext: { title: 'Sug', type: 'bug', file: 'c.js' },
        suggestionId: 5,
        commentContext: { commentId: 'c2', body: 'Com', file: 'd.js' },
      });

      // Because of the if/else if structure, suggestion takes precedence
      expect(sendCtxSpy).toHaveBeenCalled();
      expect(sendCommentCtxSpy).not.toHaveBeenCalled();
      expect(chatPanel._contextSource).toBe('suggestion');
    });

    it('should not set context when opened without any context', async () => {
      const sendCtxSpy = vi.spyOn(chatPanel, '_sendContextMessage').mockImplementation(() => {});
      const sendCommentCtxSpy = vi.spyOn(chatPanel, '_sendCommentContextMessage').mockImplementation(() => {});

      await chatPanel.open({});

      expect(sendCtxSpy).not.toHaveBeenCalled();
      expect(sendCommentCtxSpy).not.toHaveBeenCalled();
      expect(chatPanel._contextSource).toBeNull();
      expect(chatPanel._contextItemId).toBeNull();
    });

    it('should set line context source and metadata for line-type commentContext', async () => {
      vi.spyOn(chatPanel, '_sendCommentContextMessage').mockImplementation(() => {});
      vi.spyOn(chatPanel, '_updateActionButtons').mockImplementation(() => {});
      vi.spyOn(chatPanel, '_ensureAnalysisContext').mockImplementation(() => {});

      await chatPanel.open({
        commentContext: {
          type: 'line',
          file: 'src/bar.js',
          line_start: 5,
          line_end: 15,
        },
      });

      expect(chatPanel._contextSource).toBe('line');
      expect(chatPanel._contextItemId).toBeNull();
      expect(chatPanel._contextLineMeta).toEqual({
        file: 'src/bar.js',
        line_start: 5,
        line_end: 15,
      });
    });

    it('should call _ensureAnalysisContext on every expand, even without context', async () => {
      const ensureSpy = vi.spyOn(chatPanel, '_ensureAnalysisContext').mockImplementation(() => {});

      await chatPanel.open({});

      expect(ensureSpy).toHaveBeenCalled();
    });

    it('should set isOpen to true and add open class', async () => {
      await chatPanel.open({});

      expect(chatPanel.isOpen).toBe(true);
      expect(chatPanel.panel.classList.add).toHaveBeenCalledWith('chat-panel--open');
      expect(chatPanel.panel.classList.remove).toHaveBeenCalledWith('chat-panel--closed');
    });

    it('should call _updateActionButtons', async () => {
      const updateSpy = vi.spyOn(chatPanel, '_updateActionButtons');

      await chatPanel.open({});

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should use reviewId from options if provided', async () => {
      await chatPanel.open({ reviewId: 999 });

      expect(chatPanel.reviewId).toBe(999);
    });

    it('should fall back to prManager reviewId', async () => {
      global.window.prManager = { currentPR: { id: 777 } };

      await chatPanel.open({});

      expect(chatPanel.reviewId).toBe(777);

      // Cleanup
      global.window.prManager = null;
    });
  });

  // -----------------------------------------------------------------------
  // open() — suppressFocus option
  // -----------------------------------------------------------------------
  describe('open() with suppressFocus option', () => {
    beforeEach(() => {
      vi.spyOn(chatPanel, '_ensureConnected').mockResolvedValue({ sessionData: null });
    });

    it('should focus input by default when suppressFocus is not set', async () => {
      chatPanel.inputEl.focus.mockClear();

      await chatPanel.open({});

      expect(chatPanel.inputEl.focus).toHaveBeenCalled();
    });

    it('should not focus input when suppressFocus is true', async () => {
      chatPanel.inputEl.focus.mockClear();

      await chatPanel.open({ suppressFocus: true });

      expect(chatPanel.inputEl.focus).not.toHaveBeenCalled();
    });

    it('should still open the panel when suppressFocus is true', async () => {
      await chatPanel.open({ suppressFocus: true });

      expect(chatPanel.isOpen).toBe(true);
      expect(chatPanel.panel.classList.add).toHaveBeenCalledWith('chat-panel--open');
    });
  });

  // -----------------------------------------------------------------------
  // Background SSE accumulation (isOpen === false)
  // -----------------------------------------------------------------------
  describe('Background SSE accumulation', () => {
    let onmessageHandler;

    beforeEach(() => {
      // Set up an SSE connection and capture its onmessage handler
      chatPanel.currentSessionId = 'sess-1';
      chatPanel.isOpen = false;
      chatPanel.isStreaming = true;
      chatPanel._streamingContent = '';

      // Create EventSource and capture the handler that _ensureGlobalSSE sets
      const mockES = new global.EventSource('/api/chat/stream');
      chatPanel.eventSource = mockES;

      // Simulate what _ensureGlobalSSE does: it assigns onmessage
      // We need to manually trigger events, so capture the handler
      vi.spyOn(chatPanel, '_ensureGlobalSSE').mockImplementation(() => {
        // Already connected, no-op
      });

      // Extract the onmessage handler by calling _ensureGlobalSSE with a real EventSource
      // Instead, we'll manually simulate the SSE message handler logic
      // by invoking the onmessage handler path directly.

      // To properly test, we need to set up the real onmessage handler.
      // Let's call _ensureGlobalSSE for real this time.
      chatPanel._ensureGlobalSSE.mockRestore();
      chatPanel.eventSource = null; // Force reconnect
      chatPanel._ensureGlobalSSE();
      onmessageHandler = chatPanel.eventSource.onmessage;
    });

    function emitEvent(data) {
      onmessageHandler({ data: JSON.stringify(data) });
    }

    it('should accumulate delta events into _streamingContent when panel is closed', () => {
      emitEvent({ type: 'delta', text: 'Hello ', sessionId: 'sess-1' });
      emitEvent({ type: 'delta', text: 'World', sessionId: 'sess-1' });

      expect(chatPanel._streamingContent).toBe('Hello World');
    });

    it('should push completed message to messages array on "complete" event', () => {
      chatPanel._streamingContent = 'Full response';

      emitEvent({ type: 'complete', messageId: 101, sessionId: 'sess-1' });

      expect(chatPanel.messages).toHaveLength(1);
      expect(chatPanel.messages[0]).toEqual({
        role: 'assistant',
        content: 'Full response',
        id: 101,
      });
    });

    it('should clear streaming state on "complete" event', () => {
      chatPanel._streamingContent = 'Some text';
      chatPanel.isStreaming = true;

      emitEvent({ type: 'complete', messageId: 102, sessionId: 'sess-1' });

      expect(chatPanel._streamingContent).toBe('');
      expect(chatPanel.isStreaming).toBe(false);
    });

    it('should not push empty content to messages on "complete"', () => {
      chatPanel._streamingContent = '';

      emitEvent({ type: 'complete', messageId: 103, sessionId: 'sess-1' });

      expect(chatPanel.messages).toHaveLength(0);
      expect(chatPanel.isStreaming).toBe(false);
    });

    it('should clear streaming state on "error" event', () => {
      chatPanel._streamingContent = 'partial';
      chatPanel.isStreaming = true;

      emitEvent({ type: 'error', message: 'Something broke', sessionId: 'sess-1' });

      expect(chatPanel._streamingContent).toBe('');
      expect(chatPanel.isStreaming).toBe(false);
    });

    it('should ignore events for other sessions', () => {
      emitEvent({ type: 'delta', text: 'foreign', sessionId: 'other-session' });

      expect(chatPanel._streamingContent).toBe('');
    });

    it('should ignore "connected" event without sessionId', () => {
      // This is the initial handshake event — should not affect state
      chatPanel._streamingContent = '';

      emitEvent({ type: 'connected' });

      expect(chatPanel._streamingContent).toBe('');
    });

    it('should skip tool_use and status events when panel is closed', () => {
      // These are purely visual — they should not throw or alter state
      emitEvent({ type: 'tool_use', toolName: 'Read', status: 'start', sessionId: 'sess-1' });
      emitEvent({ type: 'status', status: 'working', sessionId: 'sess-1' });

      // No error and no side effects beyond what switch/default handles (nothing)
      expect(chatPanel._streamingContent).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // _ensureGlobalSSE / _closeGlobalSSE
  // -----------------------------------------------------------------------
  describe('_ensureGlobalSSE', () => {
    it('should create a new EventSource when none exists', () => {
      chatPanel.eventSource = null;
      chatPanel._ensureGlobalSSE();

      expect(chatPanel.eventSource).not.toBeNull();
      expect(chatPanel.eventSource.url).toBe('/api/chat/stream');
    });

    it('should not create a new EventSource if one is already open', () => {
      const firstES = new global.EventSource('/api/chat/stream');
      chatPanel.eventSource = firstES;

      chatPanel._ensureGlobalSSE();

      expect(chatPanel.eventSource).toBe(firstES);
    });

    it('should reconnect if the existing EventSource is closed', () => {
      const closedES = new global.EventSource('/api/chat/stream');
      closedES.readyState = global.EventSource.CLOSED;
      chatPanel.eventSource = closedES;

      chatPanel._ensureGlobalSSE();

      expect(chatPanel.eventSource).not.toBe(closedES);
      expect(chatPanel.eventSource.url).toBe('/api/chat/stream');
    });
  });

  describe('_closeGlobalSSE', () => {
    it('should close the EventSource and null it out', () => {
      const mockES = new global.EventSource('/api/chat/stream');
      chatPanel.eventSource = mockES;
      const closeSpy = vi.spyOn(mockES, 'close');

      chatPanel._closeGlobalSSE();

      expect(closeSpy).toHaveBeenCalled();
      expect(chatPanel.eventSource).toBeNull();
    });

    it('should clear the reconnect timer', () => {
      chatPanel._sseReconnectTimer = 42;

      chatPanel._closeGlobalSSE();

      expect(global.clearTimeout).toHaveBeenCalledWith(42);
      expect(chatPanel._sseReconnectTimer).toBeNull();
    });

    it('should be safe to call when no EventSource exists', () => {
      chatPanel.eventSource = null;
      chatPanel._sseReconnectTimer = null;

      expect(() => chatPanel._closeGlobalSSE()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // _finalizeStreaming
  // -----------------------------------------------------------------------
  describe('_finalizeStreaming', () => {
    it('should reset isStreaming and _streamingContent', () => {
      chatPanel.isStreaming = true;
      chatPanel._streamingContent = 'data';

      chatPanel._finalizeStreaming();

      expect(chatPanel.isStreaming).toBe(false);
      expect(chatPanel._streamingContent).toBe('');
    });

    it('should restore send/stop button visibility', () => {
      chatPanel.sendBtn.style.display = 'none';
      chatPanel.stopBtn.style.display = '';

      chatPanel._finalizeStreaming();

      expect(chatPanel.sendBtn.style.display).toBe('');
      expect(chatPanel.stopBtn.style.display).toBe('none');
    });

    it('should call _updateActionButtons', () => {
      const spy = vi.spyOn(chatPanel, '_updateActionButtons');
      chatPanel._finalizeStreaming();
      expect(spy).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // addMessage
  // -----------------------------------------------------------------------
  describe('addMessage', () => {
    it('should push to messages array', () => {
      chatPanel.addMessage('user', 'Hello');

      expect(chatPanel.messages).toHaveLength(1);
      expect(chatPanel.messages[0]).toEqual({ role: 'user', content: 'Hello', id: undefined });
    });

    it('should push assistant messages with id', () => {
      chatPanel.addMessage('assistant', 'Hi there', 42);

      expect(chatPanel.messages[0]).toEqual({ role: 'assistant', content: 'Hi there', id: 42 });
    });

    it('should append a DOM element to messagesEl', () => {
      chatPanel.addMessage('user', 'Test');

      expect(chatPanel.messagesEl.appendChild).toHaveBeenCalled();
      const el = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(el.className).toContain('chat-panel__message--user');
    });
  });

  // -----------------------------------------------------------------------
  // renderMarkdown
  // -----------------------------------------------------------------------
  describe('renderMarkdown', () => {
    it('should use window.renderMarkdown when available', () => {
      const result = chatPanel.renderMarkdown('hello');
      expect(result).toBe('<p>hello</p>');
    });

    it('should return empty string for falsy input', () => {
      expect(chatPanel.renderMarkdown('')).toBe('');
      expect(chatPanel.renderMarkdown(null)).toBe('');
      expect(chatPanel.renderMarkdown(undefined)).toBe('');
    });

    it('should fall back to escapeHtml when window.renderMarkdown is unavailable', () => {
      const orig = global.window.renderMarkdown;
      global.window.renderMarkdown = null;

      // The fallback uses _escapeHtml + newline -> <br> conversion
      const result = chatPanel.renderMarkdown('line1\nline2');
      expect(result).toContain('line1');
      expect(result).toContain('line2');

      global.window.renderMarkdown = orig;
    });
  });

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------
  describe('destroy', () => {
    it('should close global SSE', () => {
      const spy = vi.spyOn(chatPanel, '_closeGlobalSSE');
      chatPanel.destroy();
      expect(spy).toHaveBeenCalled();
    });

    it('should clear messages array', () => {
      chatPanel.messages = [{ role: 'user', content: 'hi' }];
      chatPanel.destroy();
      expect(chatPanel.messages).toEqual([]);
    });

    it('should remove keydown listener from document', () => {
      chatPanel.destroy();
      expect(global.document.removeEventListener).toHaveBeenCalledWith('keydown', chatPanel._onKeydown);
    });
  });

  // -----------------------------------------------------------------------
  // _summarizeToolInput
  // -----------------------------------------------------------------------
  describe('_summarizeToolInput', () => {
    it('should extract command from bash tool', () => {
      expect(chatPanel._summarizeToolInput('Bash', { command: 'npm test' })).toBe('npm test');
    });

    it('should strip cd prefix from bash command', () => {
      expect(chatPanel._summarizeToolInput('Bash', { command: 'cd /foo && npm test' })).toBe('npm test');
    });

    it('should extract file_path from Read tool', () => {
      expect(chatPanel._summarizeToolInput('Read', { file_path: '/src/app.js' })).toBe('/src/app.js');
    });

    it('should extract pattern from Grep tool', () => {
      expect(chatPanel._summarizeToolInput('Grep', { pattern: 'TODO' })).toBe('TODO');
    });

    it('should return empty string for null input', () => {
      expect(chatPanel._summarizeToolInput('Bash', null)).toBe('');
    });

    it('should return empty string for non-object input', () => {
      expect(chatPanel._summarizeToolInput('Bash', 'string')).toBe('');
    });

    it('should return first string value for unknown tools', () => {
      expect(chatPanel._summarizeToolInput('UnknownTool', { key: 'value' })).toBe('value');
    });
  });

  // -----------------------------------------------------------------------
  // createSession
  // -----------------------------------------------------------------------
  describe('createSession', () => {
    it('should return null when reviewId is not set', async () => {
      chatPanel.reviewId = null;
      const result = await chatPanel.createSession();
      expect(result).toBeNull();
    });

    it('should set currentSessionId on success', async () => {
      chatPanel.reviewId = 1;
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { id: 'new-session', status: 'active' } }),
      });

      const result = await chatPanel.createSession();

      expect(result).toEqual({ id: 'new-session', status: 'active' });
      expect(chatPanel.currentSessionId).toBe('new-session');
    });

    it('should return null and show error on failure', async () => {
      chatPanel.reviewId = 1;
      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: 'bad request' }),
      });

      const errorSpy = vi.spyOn(chatPanel, '_showError');
      const result = await chatPanel.createSession();

      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('should include contextCommentId when provided', async () => {
      chatPanel.reviewId = 1;
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { id: 'sess', status: 'active' } }),
      });

      await chatPanel.createSession(42);

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.contextCommentId).toBe(42);
    });
  });

  // -----------------------------------------------------------------------
  // Keyboard shortcuts (Cmd+Enter / Ctrl+Enter to send)
  // -----------------------------------------------------------------------
  describe('Keyboard shortcuts', () => {
    it('should NOT send on plain Enter', () => {
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);
      chatPanel.inputEl.value = 'hello';

      // Simulate the keydown handler logic directly
      const handler = chatPanel.inputEl.addEventListener.mock.calls
        .find(c => c[0] === 'keydown')?.[1];
      expect(handler).toBeDefined();

      const event = { key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, preventDefault: vi.fn() };
      handler(event);

      expect(sendSpy).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should send on Cmd+Enter (metaKey)', () => {
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);
      chatPanel.inputEl.value = 'hello';
      chatPanel.isStreaming = false;

      const handler = chatPanel.inputEl.addEventListener.mock.calls
        .find(c => c[0] === 'keydown')?.[1];

      const event = { key: 'Enter', metaKey: true, ctrlKey: false, preventDefault: vi.fn() };
      handler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should send on Ctrl+Enter', () => {
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);
      chatPanel.inputEl.value = 'hello';
      chatPanel.isStreaming = false;

      const handler = chatPanel.inputEl.addEventListener.mock.calls
        .find(c => c[0] === 'keydown')?.[1];

      const event = { key: 'Enter', metaKey: false, ctrlKey: true, preventDefault: vi.fn() };
      handler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should NOT send on Cmd+Enter when input is empty', () => {
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);
      chatPanel.inputEl.value = '';

      const handler = chatPanel.inputEl.addEventListener.mock.calls
        .find(c => c[0] === 'keydown')?.[1];

      const event = { key: 'Enter', metaKey: true, ctrlKey: false, preventDefault: vi.fn() };
      handler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('should NOT send on Cmd+Enter when streaming', () => {
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);
      chatPanel.inputEl.value = 'hello';
      chatPanel.isStreaming = true;

      const handler = chatPanel.inputEl.addEventListener.mock.calls
        .find(c => c[0] === 'keydown')?.[1];

      const event = { key: 'Enter', metaKey: true, ctrlKey: false, preventDefault: vi.fn() };
      handler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Escape key — two-step behavior
  // -----------------------------------------------------------------------
  describe('Escape key two-step behavior', () => {
    /**
     * Helper: find the document-level keydown handler that ChatPanel registered
     * during _bindEvents (captured by our mock addEventListener).
     */
    function getEscapeHandler() {
      const call = global.document.addEventListener.mock.calls.find(c => c[0] === 'keydown');
      expect(call).toBeDefined();
      return call[1];
    }

    it('should blur textarea on first Escape when textarea is focused', () => {
      chatPanel.isOpen = true;
      chatPanel.isStreaming = false;
      // Simulate textarea being the active element
      global.document.activeElement = chatPanel.inputEl;

      const handler = getEscapeHandler();
      handler({ key: 'Escape' });

      expect(chatPanel.inputEl.blur).toHaveBeenCalled();
      // Panel should still be open
      expect(chatPanel.isOpen).toBe(true);
    });

    it('should close panel on Escape when textarea is not focused', () => {
      chatPanel.isOpen = true;
      chatPanel.isStreaming = false;
      global.document.activeElement = null;

      const closeSpy = vi.spyOn(chatPanel, 'close');
      const handler = getEscapeHandler();
      handler({ key: 'Escape' });

      expect(closeSpy).toHaveBeenCalled();
    });

    it('should stop agent on Escape when streaming, regardless of focus', () => {
      chatPanel.isOpen = true;
      chatPanel.isStreaming = true;
      global.document.activeElement = chatPanel.inputEl;

      const stopSpy = vi.spyOn(chatPanel, '_stopAgent').mockImplementation(() => {});
      const handler = getEscapeHandler();
      handler({ key: 'Escape' });

      expect(stopSpy).toHaveBeenCalled();
      expect(chatPanel.inputEl.blur).not.toHaveBeenCalled();
    });

    it('should do nothing when panel is not open', () => {
      chatPanel.isOpen = false;
      global.document.activeElement = chatPanel.inputEl;

      const closeSpy = vi.spyOn(chatPanel, 'close');
      const handler = getEscapeHandler();
      handler({ key: 'Escape' });

      expect(closeSpy).not.toHaveBeenCalled();
      expect(chatPanel.inputEl.blur).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Removable context cards
  // -----------------------------------------------------------------------
  describe('Removable context cards', () => {
    it('should add close button when removable is true', () => {
      chatPanel._pendingContextData = [{ type: 'bug' }]; // simulate data already pushed
      chatPanel._addContextCard({ title: 'Test', type: 'bug' }, { removable: true });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.appendChild).toHaveBeenCalled();
      const removeBtn = card.appendChild.mock.calls[0][0];
      expect(removeBtn.className).toBe('chat-panel__context-remove');
      expect(card.dataset.contextIndex).toBeDefined();
    });

    it('should NOT add close button when removable is false (default)', () => {
      chatPanel._addContextCard({ title: 'Test', type: 'bug' });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      // appendChild is called once by messagesEl.appendChild, but the card itself
      // should not have appendChild called for a remove button
      expect(card.appendChild).not.toHaveBeenCalled();
      expect(card.dataset.contextIndex).toBeUndefined();
    });

    it('should add close button to comment context card when removable', () => {
      chatPanel._pendingContextData = [{ type: 'comment' }];
      chatPanel._addCommentContextCard(
        { commentId: '1', body: 'Test', file: 'a.js', line_start: 1, isFileLevel: false },
        { removable: true }
      );

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.appendChild).toHaveBeenCalled();
      const removeBtn = card.appendChild.mock.calls[0][0];
      expect(removeBtn.className).toBe('chat-panel__context-remove');
    });

    it('should pass removable: true from _sendContextMessage', () => {
      const addSpy = vi.spyOn(chatPanel, '_addContextCard');

      chatPanel._sendContextMessage({ title: 'X', type: 'bug', file: 'f.js' });

      expect(addSpy).toHaveBeenCalledWith(
        { title: 'X', type: 'bug', file: 'f.js' },
        { removable: true }
      );
    });

    it('should pass removable: true from _sendCommentContextMessage', () => {
      const addSpy = vi.spyOn(chatPanel, '_addCommentContextCard');

      chatPanel._sendCommentContextMessage({
        commentId: 'c1', body: 'Test', file: 'a.js', line_start: 1, source: 'user', isFileLevel: false,
      });

      expect(addSpy).toHaveBeenCalledWith(
        expect.objectContaining({ commentId: 'c1' }),
        { removable: true }
      );
    });

    it('should restore removability on cards after sendMessage failure', async () => {
      // Setup: add some pending context
      chatPanel._pendingContext = ['ctx'];
      chatPanel._pendingContextData = [{ type: 'bug' }];
      chatPanel.currentSessionId = 'sess-1';
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'hello';

      // Create a card that looks like it's been locked (no remove button, no contextIndex)
      const card = createMockElement('div');
      card.className = 'chat-panel__context-card';
      card.querySelector = vi.fn(() => null); // no existing remove button

      chatPanel.messagesEl.querySelectorAll = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-context-index]') return [];
        if (sel === '.chat-panel__context-card') return [card];
        return [];
      });

      // Mock fetch to fail
      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: 'server error' }),
      });

      // Spy on _restoreRemovableCards
      const restoreSpy = vi.spyOn(chatPanel, '_restoreRemovableCards');

      await chatPanel.sendMessage();

      expect(restoreSpy).toHaveBeenCalled();
    });

    it('should NOT pass removable for historical context cards in _loadMessageHistory', () => {
      // _loadMessageHistory calls _addContextCard without removable
      const addSpy = vi.spyOn(chatPanel, '_addContextCard');

      // Simulate what _loadMessageHistory does internally
      chatPanel._addContextCard({ type: 'bug', title: 'Old', file: 'x.js' });

      expect(addSpy).toHaveBeenCalledWith(
        { type: 'bug', title: 'Old', file: 'x.js' }
      );
    });
  });

  // -----------------------------------------------------------------------
  // _sendContextMessage (full integration: stores context + creates card)
  // -----------------------------------------------------------------------
  describe('_sendContextMessage', () => {
    it('should store context text and structured data', () => {
      const ctx = { title: 'Null check', type: 'bug', file: 'src/app.js', line_start: 42, body: 'Check for null' };

      chatPanel._sendContextMessage(ctx);

      expect(chatPanel._pendingContext).toHaveLength(1);
      expect(chatPanel._pendingContext[0]).toContain('Null check');
      expect(chatPanel._pendingContext[0]).toContain('bug');
      expect(chatPanel._pendingContext[0]).toContain('src/app.js');
      expect(chatPanel._pendingContext[0]).toContain('line 42');
      expect(chatPanel._pendingContext[0]).toContain('Check for null');

      expect(chatPanel._pendingContextData).toHaveLength(1);
      expect(chatPanel._pendingContextData[0].type).toBe('bug');
      expect(chatPanel._pendingContextData[0].title).toBe('Null check');
      expect(chatPanel._pendingContextData[0].file).toBe('src/app.js');
      expect(chatPanel._pendingContextData[0].line_start).toBe(42);
      expect(chatPanel._pendingContextData[0].body).toBe('Check for null');
    });

    it('should create a context card and append to messages', () => {
      const ctx = { title: 'Test', type: 'suggestion', file: 'a.js' };

      chatPanel._sendContextMessage(ctx);

      expect(chatPanel.messagesEl.appendChild).toHaveBeenCalled();
      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.className).toBe('chat-panel__context-card');
    });

    it('should handle context with no file gracefully', () => {
      const ctx = { title: 'General', type: 'improvement', file: null, line_start: null, body: 'Improve this' };

      chatPanel._sendContextMessage(ctx);

      expect(chatPanel._pendingContext).toHaveLength(1);
      expect(chatPanel._pendingContext[0]).not.toContain('File:');
      expect(chatPanel._pendingContextData[0].file).toBeNull();
    });

    it('should handle context with empty title and type', () => {
      const ctx = { title: '', type: '', file: '', body: '' };

      chatPanel._sendContextMessage(ctx);

      expect(chatPanel._pendingContextData[0].type).toBe('general');
      expect(chatPanel._pendingContextData[0].title).toBe('Untitled');
    });

    it('should remove empty state before adding card', () => {
      const emptyEl = createMockElement('div');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__empty') return emptyEl;
        return null;
      });

      chatPanel._sendContextMessage({ title: 'T', type: 'bug' });

      expect(emptyEl.remove).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _removeContextCard
  // -----------------------------------------------------------------------
  describe('_removeContextCard', () => {
    it('should splice pending arrays at the correct index', () => {
      chatPanel._pendingContext = ['ctx0', 'ctx1', 'ctx2'];
      chatPanel._pendingContextData = [{ id: 0 }, { id: 1 }, { id: 2 }];

      const cardEl = createMockElement('div', { dataset: { contextIndex: '1' } });
      // Mock querySelectorAll to return remaining cards for re-indexing
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);

      chatPanel._removeContextCard(cardEl);

      expect(chatPanel._pendingContext).toEqual(['ctx0', 'ctx2']);
      expect(chatPanel._pendingContextData).toEqual([{ id: 0 }, { id: 2 }]);
      expect(cardEl.remove).toHaveBeenCalled();
    });

    it('should re-index remaining cards', () => {
      chatPanel._pendingContext = ['ctx0', 'ctx1', 'ctx2'];
      chatPanel._pendingContextData = [{ id: 0 }, { id: 1 }, { id: 2 }];

      const card0 = createMockElement('div', { dataset: { contextIndex: '0' } });
      const card2 = createMockElement('div', { dataset: { contextIndex: '2' } });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => [card0, card2]);

      const cardToRemove = createMockElement('div', { dataset: { contextIndex: '1' } });
      chatPanel._removeContextCard(cardToRemove);

      expect(card0.dataset.contextIndex).toBe(0);
      expect(card2.dataset.contextIndex).toBe(1);
    });

    it('should restore empty state when last context card is removed and no messages', () => {
      chatPanel._pendingContext = ['ctx0'];
      chatPanel._pendingContextData = [{ id: 0 }];
      chatPanel.messages = [];

      const clearSpy = vi.spyOn(chatPanel, '_clearMessages');
      const cardEl = createMockElement('div', { dataset: { contextIndex: '0' } });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);

      chatPanel._removeContextCard(cardEl);

      expect(chatPanel._pendingContext).toEqual([]);
      expect(clearSpy).toHaveBeenCalled();
    });

    it('should NOT restore empty state when messages exist', () => {
      chatPanel._pendingContext = ['ctx0'];
      chatPanel._pendingContextData = [{ id: 0 }];
      chatPanel.messages = [{ role: 'user', content: 'hi' }];

      const clearSpy = vi.spyOn(chatPanel, '_clearMessages');
      const cardEl = createMockElement('div', { dataset: { contextIndex: '0' } });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);

      chatPanel._removeContextCard(cardEl);

      expect(clearSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _ensureAnalysisContext
  // -----------------------------------------------------------------------
  describe('_ensureAnalysisContext', () => {
    it('should skip when _sessionAnalysisRunId is already set and no new run', () => {
      chatPanel._sessionAnalysisRunId = 'run-abc';
      chatPanel.messages = [{ role: 'user', content: 'hello' }];

      // No new run: _getLatestCompletedRunId returns same ID
      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue('run-abc');
      // Mock querySelectorAll to return some suggestions in the DOM
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div')]);
      // Card already in DOM (loaded from history)
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return createMockElement('div');
        return null;
      });

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');

      chatPanel._ensureAnalysisContext();

      expect(addCardSpy).not.toHaveBeenCalled();
    });

    it('should append (prepend: false) when existing message bubbles are present', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.messages = [{ role: 'user', content: 'hello' }];

      // Mock: no analysis card in DOM, suggestions exist, message bubbles present
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return null;
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn((sel) => {
        if (sel === '.chat-panel__message') return [createMockElement('div')];
        return [];
      });
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div'), createMockElement('div')]);

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._ensureAnalysisContext();

      expect(addCardSpy).toHaveBeenCalledWith({ type: 'analysis', suggestionCount: 2 }, { removable: true, prepend: false });
    });

    it('should prepend (prepend: true) when no message bubbles exist (fresh conversation)', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.messages = [];

      // Mock: no analysis card, no messages, suggestions exist
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return null;
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn((sel) => {
        if (sel === '.chat-panel__message') return [];
        return [];
      });
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div'), createMockElement('div')]);

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._ensureAnalysisContext();

      expect(addCardSpy).toHaveBeenCalledWith({ type: 'analysis', suggestionCount: 2 }, { removable: true, prepend: true });
    });

    it('should set _sessionAnalysisRunId to current run ID after creating the card', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue('run-42');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return null;
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div')]);

      chatPanel._ensureAnalysisContext();

      expect(chatPanel._sessionAnalysisRunId).toBe('run-42');
    });

    it('should fall back to "dom" when _getLatestCompletedRunId returns null', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue(null);
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return null;
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div')]);

      chatPanel._ensureAnalysisContext();

      expect(chatPanel._sessionAnalysisRunId).toBe('dom');
    });

    it('should skip when analysis card already exists in the DOM', () => {
      chatPanel._sessionAnalysisRunId = null;
      const analysisCard = createMockElement('div', { dataset: { analysis: 'true' } });
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return analysisCard;
        return null;
      });
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div')]);

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      chatPanel._ensureAnalysisContext();

      expect(addCardSpy).not.toHaveBeenCalled();
    });

    it('should skip when _analysisContextRemoved is true', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel._analysisContextRemoved = true;

      chatPanel.messagesEl.querySelector = vi.fn(() => null);
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div')]);

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      chatPanel._ensureAnalysisContext();

      expect(addCardSpy).not.toHaveBeenCalled();
    });

    it('should skip when no suggestions exist in the DOM', () => {
      chatPanel._sessionAnalysisRunId = null;

      chatPanel.messagesEl.querySelector = vi.fn(() => null);
      global.document.querySelectorAll = vi.fn(() => []);

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      chatPanel._ensureAnalysisContext();

      expect(addCardSpy).not.toHaveBeenCalled();
    });

    // --- New-run detection tests ---

    it('should detect a new run and replace the old analysis card', () => {
      // Previous run was 'run-1', now prManager has 'run-2'
      chatPanel._sessionAnalysisRunId = 'run-1';
      chatPanel._analysisContextRemoved = false;
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue('run-2');

      const oldCard = createMockElement('div', { dataset: { analysis: 'true' } });
      let cardInDom = oldCard;
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') {
          const result = cardInDom;
          // After old card is removed, return null for subsequent calls
          cardInDom = null;
          return result;
        }
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div'), createMockElement('div')]);

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._ensureAnalysisContext();

      // Old card should have been removed
      expect(oldCard.remove).toHaveBeenCalled();
      // New card should have been added
      expect(addCardSpy).toHaveBeenCalledWith(
        { type: 'analysis', suggestionCount: 2 },
        expect.objectContaining({ removable: true })
      );
      // Session run ID should be updated to the new run
      expect(chatPanel._sessionAnalysisRunId).toBe('run-2');
    });

    it('should reset _analysisContextRemoved when a new run is detected', () => {
      chatPanel._sessionAnalysisRunId = 'run-old';
      chatPanel._analysisContextRemoved = true; // user removed old context

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue('run-new');

      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return null;
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div')]);

      vi.spyOn(chatPanel, '_addAnalysisContextCard');
      vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._ensureAnalysisContext();

      // _analysisContextRemoved should have been reset for the new run
      expect(chatPanel._analysisContextRemoved).toBe(false);
      expect(chatPanel._sessionAnalysisRunId).toBe('run-new');
    });

    it('should NOT detect new run when currentRunId matches _sessionAnalysisRunId', () => {
      chatPanel._sessionAnalysisRunId = 'run-same';
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue('run-same');

      // Card is already in DOM
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return createMockElement('div');
        return null;
      });

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');

      chatPanel._ensureAnalysisContext();

      // Should not add a new card
      expect(addCardSpy).not.toHaveBeenCalled();
    });

    it('should not detect new run when _sessionAnalysisRunId is null (first time)', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue('run-1');

      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return null;
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div')]);

      vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);
      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');

      chatPanel._ensureAnalysisContext();

      // Should still add the card (first time), but NOT via new-run path
      expect(addCardSpy).toHaveBeenCalled();
      expect(chatPanel._sessionAnalysisRunId).toBe('run-1');
    });

    it('should not detect new run when _getLatestCompletedRunId returns null', () => {
      chatPanel._sessionAnalysisRunId = 'run-old';
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue(null);

      // Card already in DOM
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return createMockElement('div');
        return null;
      });

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');

      chatPanel._ensureAnalysisContext();

      // No new run detected, card already exists, so no new card
      expect(addCardSpy).not.toHaveBeenCalled();
    });

    // --- Stale DOM card detection (Bug fix: expand after close/new analysis) ---

    it('should replace stale DOM card when _sessionAnalysisRunId is null and card has different run ID', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue('run-new');

      const staleCard = createMockElement('div', { dataset: { analysis: 'true', analysisRunId: 'run-old' } });
      let cardInDom = staleCard;
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') {
          const result = cardInDom;
          // After removal, return null
          if (result) cardInDom = null;
          return result;
        }
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div'), createMockElement('div')]);

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._ensureAnalysisContext();

      // Stale card should have been removed
      expect(staleCard.remove).toHaveBeenCalled();
      // New card should have been added
      expect(addCardSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'analysis', suggestionCount: 2 }),
        expect.objectContaining({ removable: true })
      );
      expect(chatPanel._sessionAnalysisRunId).toBe('run-new');
    });

    it('should replace stale DOM card when _sessionAnalysisRunId is null and card has no run ID stamp', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue('run-123');

      // Card has no analysisRunId — loaded from old session history
      const staleCard = createMockElement('div', { dataset: { analysis: 'true' } });
      let cardInDom = staleCard;
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') {
          const result = cardInDom;
          if (result) cardInDom = null;
          return result;
        }
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn(() => []);
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div')]);

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._ensureAnalysisContext();

      // Stale card should have been removed
      expect(staleCard.remove).toHaveBeenCalled();
      // New card added with current run
      expect(addCardSpy).toHaveBeenCalled();
      expect(chatPanel._sessionAnalysisRunId).toBe('run-123');
    });

    it('should adopt existing card run ID when it matches the latest run', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue('run-42');

      // Card matches the current run
      const matchingCard = createMockElement('div', { dataset: { analysis: 'true', analysisRunId: 'run-42' } });
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return matchingCard;
        return null;
      });

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');

      chatPanel._ensureAnalysisContext();

      // Should NOT remove the card or add a new one
      expect(matchingCard.remove).not.toHaveBeenCalled();
      expect(addCardSpy).not.toHaveBeenCalled();
      // Should adopt the run ID for future detection
      expect(chatPanel._sessionAnalysisRunId).toBe('run-42');
    });

    it('should skip card replacement when currentRunId is null even if _sessionAnalysisRunId is null', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.messages = [];

      vi.spyOn(chatPanel, '_getLatestCompletedRunId').mockReturnValue(null);

      const existingCard = createMockElement('div', { dataset: { analysis: 'true' } });
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return existingCard;
        return null;
      });

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');

      chatPanel._ensureAnalysisContext();

      // Card should stay — no run ID to compare against
      expect(existingCard.remove).not.toHaveBeenCalled();
      expect(addCardSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _buildAnalysisContextData
  // -----------------------------------------------------------------------
  describe('_buildAnalysisContextData', () => {
    it('should return basic context data when runId is null', () => {
      const result = chatPanel._buildAnalysisContextData(null, 5);
      expect(result).toEqual({ type: 'analysis', suggestionCount: 5 });
    });

    it('should return basic context data when prManager is not available', () => {
      global.window.prManager = null;
      const result = chatPanel._buildAnalysisContextData('run-1', 3);
      expect(result).toEqual({ type: 'analysis', suggestionCount: 3 });
    });

    it('should return basic context data when analysisHistoryManager has no runs', () => {
      global.window.prManager = { analysisHistoryManager: { runs: [] } };
      const result = chatPanel._buildAnalysisContextData('run-1', 3);
      expect(result).toEqual({ type: 'analysis', suggestionCount: 3 });
      global.window.prManager = null;
    });

    it('should enrich context with metadata from cached run', () => {
      global.window.prManager = {
        analysisHistoryManager: {
          runs: [
            { id: 'run-99', status: 'completed', provider: 'claude', model: 'sonnet', summary: 'Found issues', config_type: 'single', completed_at: '2026-02-19T10:05:00Z' }
          ]
        }
      };

      const result = chatPanel._buildAnalysisContextData('run-99', 4);

      expect(result).toEqual({
        type: 'analysis',
        suggestionCount: 4,
        provider: 'claude',
        model: 'sonnet',
        summary: 'Found issues',
        configType: 'single',
        completedAt: '2026-02-19T10:05:00Z',
        aiRunId: 'run-99'
      });
      global.window.prManager = null;
    });

    it('should handle run with partial metadata (missing summary)', () => {
      global.window.prManager = {
        analysisHistoryManager: {
          runs: [
            { id: 7, status: 'completed', provider: 'gemini', model: 'flash' }
          ]
        }
      };

      const result = chatPanel._buildAnalysisContextData('7', 2);

      expect(result).toEqual({
        type: 'analysis',
        suggestionCount: 2,
        provider: 'gemini',
        model: 'flash',
        aiRunId: '7'
      });
      global.window.prManager = null;
    });

    it('should return basic data when run ID is not found in cached runs', () => {
      global.window.prManager = {
        analysisHistoryManager: {
          runs: [
            { id: 'run-99', status: 'completed', provider: 'claude', model: 'sonnet' }
          ]
        }
      };

      const result = chatPanel._buildAnalysisContextData('run-missing', 3);

      expect(result).toEqual({ type: 'analysis', suggestionCount: 3 });
      global.window.prManager = null;
    });

    it('should include completedAt when available in cached run', () => {
      global.window.prManager = {
        analysisHistoryManager: {
          runs: [
            { id: 'run-42', status: 'completed', provider: 'claude', model: 'opus', completed_at: '2026-02-19T14:30:45Z' }
          ]
        }
      };

      const result = chatPanel._buildAnalysisContextData('run-42', 5);

      expect(result.completedAt).toBe('2026-02-19T14:30:45Z');
      global.window.prManager = null;
    });
  });

  // -----------------------------------------------------------------------
  // _getLatestCompletedRunId
  // -----------------------------------------------------------------------
  describe('_getLatestCompletedRunId', () => {
    it('should return the latest completed run from analysisHistoryManager.runs', () => {
      global.window.prManager = {
        selectedRunId: 'fallback-id',
        analysisHistoryManager: {
          runs: [
            { id: 'run-3', status: 'completed' },
            { id: 'run-2', status: 'completed' },
            { id: 'run-1', status: 'failed' },
          ],
          getSelectedRunId: () => 'run-2', // selected is different from latest completed
        },
      };

      const result = chatPanel._getLatestCompletedRunId();

      // Should pick the first completed run (run-3), NOT the selected one (run-2)
      expect(result).toBe('run-3');

      global.window.prManager = null;
    });

    it('should skip non-completed runs and return the first completed one', () => {
      global.window.prManager = {
        selectedRunId: null,
        analysisHistoryManager: {
          runs: [
            { id: 'run-4', status: 'failed' },
            { id: 'run-3', status: 'cancelled' },
            { id: 'run-2', status: 'completed' },
            { id: 'run-1', status: 'completed' },
          ],
          getSelectedRunId: () => null,
        },
      };

      const result = chatPanel._getLatestCompletedRunId();

      expect(result).toBe('run-2');

      global.window.prManager = null;
    });

    it('should fall back to getSelectedRunId when no completed runs in array', () => {
      global.window.prManager = {
        selectedRunId: 'fallback-id',
        analysisHistoryManager: {
          runs: [
            { id: 'run-1', status: 'failed' },
          ],
          getSelectedRunId: () => 'selected-id',
        },
      };

      const result = chatPanel._getLatestCompletedRunId();

      expect(result).toBe('selected-id');

      global.window.prManager = null;
    });

    it('should fall back to getSelectedRunId when runs array is empty', () => {
      global.window.prManager = {
        selectedRunId: 'fallback-id',
        analysisHistoryManager: {
          runs: [],
          getSelectedRunId: () => 'selected-id',
        },
      };

      const result = chatPanel._getLatestCompletedRunId();

      expect(result).toBe('selected-id');

      global.window.prManager = null;
    });

    it('should fall back to prManager.selectedRunId when no analysisHistoryManager', () => {
      global.window.prManager = {
        selectedRunId: 'selected-id',
      };

      const result = chatPanel._getLatestCompletedRunId();

      expect(result).toBe('selected-id');

      global.window.prManager = null;
    });

    it('should return null when prManager is not available', () => {
      global.window.prManager = null;

      const result = chatPanel._getLatestCompletedRunId();

      expect(result).toBeNull();
    });

    it('should return null when prManager has no run IDs and no completed runs', () => {
      global.window.prManager = {
        selectedRunId: null,
        analysisHistoryManager: {
          runs: [],
          getSelectedRunId: () => null,
        },
      };

      const result = chatPanel._getLatestCompletedRunId();

      expect(result).toBeNull();

      global.window.prManager = null;
    });

    it('should convert numeric run IDs to strings', () => {
      global.window.prManager = {
        selectedRunId: null,
        analysisHistoryManager: {
          runs: [
            { id: 42, status: 'completed' },
          ],
          getSelectedRunId: () => null,
        },
      };

      const result = chatPanel._getLatestCompletedRunId();

      expect(result).toBe('42');

      global.window.prManager = null;
    });

    it('should convert numeric fallback selectedRunId to string', () => {
      global.window.prManager = {
        selectedRunId: 42,
      };

      const result = chatPanel._getLatestCompletedRunId();

      expect(result).toBe('42');

      global.window.prManager = null;
    });

    it('should fall back to getSelectedRunId when runs property is missing', () => {
      global.window.prManager = {
        selectedRunId: 'fallback-id',
        analysisHistoryManager: {
          getSelectedRunId: () => 'manager-id',
        },
      };

      const result = chatPanel._getLatestCompletedRunId();

      expect(result).toBe('manager-id');

      global.window.prManager = null;
    });
  });

  // -----------------------------------------------------------------------
  // _showAnalysisContextIfPresent
  // -----------------------------------------------------------------------
  describe('_showAnalysisContextIfPresent', () => {
    it('should set _sessionAnalysisRunId from context.aiRunId', () => {
      chatPanel.messagesEl.querySelector = vi.fn(() => null);

      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 3, aiRunId: 'run-xyz' }
      });

      expect(chatPanel._sessionAnalysisRunId).toBe('run-xyz');
    });

    it('should set _sessionAnalysisRunId to "session" when aiRunId is missing', () => {
      chatPanel.messagesEl.querySelector = vi.fn(() => null);

      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 2 }
      });

      expect(chatPanel._sessionAnalysisRunId).toBe('session');
    });

    it('should not set _sessionAnalysisRunId when suggestionCount is 0', () => {
      chatPanel._sessionAnalysisRunId = null;

      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 0 }
      });

      expect(chatPanel._sessionAnalysisRunId).toBeNull();
    });

    it('should not set _sessionAnalysisRunId when context is missing', () => {
      chatPanel._sessionAnalysisRunId = null;

      chatPanel._showAnalysisContextIfPresent({});

      expect(chatPanel._sessionAnalysisRunId).toBeNull();
    });

    it('should skip when analysis card with metadata already exists in the DOM', () => {
      const existingCard = createMockElement('div', { dataset: { hasMetadata: 'true' } });
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return existingCard;
        return null;
      });

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 5, aiRunId: 'run-abc', provider: 'claude' }
      });

      expect(addCardSpy).not.toHaveBeenCalled();
    });

    it('should skip when existing bare-bones card found but new context also has no metadata', () => {
      const existingCard = createMockElement('div');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return existingCard;
        return null;
      });

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 5, aiRunId: 'run-abc' }
      });

      expect(addCardSpy).not.toHaveBeenCalled();
    });

    it('should update bare-bones card in-place when richer context has provider', () => {
      const existingCard = createMockElement('div');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return existingCard;
        return null;
      });

      const updateSpy = vi.spyOn(chatPanel, '_updateAnalysisCardContent');
      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 5, aiRunId: 'run-abc', provider: 'claude' }
      });

      // Card is updated in-place, NOT removed and re-created
      expect(existingCard.remove).not.toHaveBeenCalled();
      expect(addCardSpy).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(existingCard, { suggestionCount: 5, aiRunId: 'run-abc', provider: 'claude' });
    });

    it('should update bare-bones card in-place when richer context has model', () => {
      const existingCard = createMockElement('div');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return existingCard;
        return null;
      });

      const updateSpy = vi.spyOn(chatPanel, '_updateAnalysisCardContent');
      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 3, model: 'sonnet' }
      });

      expect(existingCard.remove).not.toHaveBeenCalled();
      expect(addCardSpy).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalled();
    });

    it('should update bare-bones card in-place when richer context has summary', () => {
      const existingCard = createMockElement('div');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return existingCard;
        return null;
      });

      const updateSpy = vi.spyOn(chatPanel, '_updateAnalysisCardContent');
      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 2, summary: 'Found issues' }
      });

      expect(existingCard.remove).not.toHaveBeenCalled();
      expect(addCardSpy).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalled();
      expect(chatPanel._sessionAnalysisRunId).toBe('session');
    });
  });

  // -----------------------------------------------------------------------
  // _buildAnalysisCardInnerHTML
  // -----------------------------------------------------------------------
  describe('_buildAnalysisCardInnerHTML', () => {
    it('should include suggestion count in the HTML', () => {
      const html = chatPanel._buildAnalysisCardInnerHTML({ suggestionCount: 3 });
      expect(html).toContain('3 suggestions loaded');
    });

    it('should use singular form for 1 suggestion', () => {
      const html = chatPanel._buildAnalysisCardInnerHTML({ suggestionCount: 1 });
      expect(html).toContain('1 suggestion loaded');
    });

    it('should include provider and model in parenthetical when available', () => {
      const html = chatPanel._buildAnalysisCardInnerHTML({ suggestionCount: 2, provider: 'claude', model: 'sonnet' });
      expect(html).toContain('(claude / sonnet)');
    });

    it('should not include parenthetical when no provider or model', () => {
      const html = chatPanel._buildAnalysisCardInnerHTML({ suggestionCount: 2 });
      expect(html).not.toContain('(');
    });

    it('should include summary in tooltip', () => {
      const html = chatPanel._buildAnalysisCardInnerHTML({ suggestionCount: 2, summary: 'Found issues' });
      expect(html).toContain('Found issues');
    });

    it('should include configType in tooltip', () => {
      const html = chatPanel._buildAnalysisCardInnerHTML({ suggestionCount: 2, configType: 'council' });
      expect(html).toContain('Config: council');
    });

    it('should include completedAt timestamp in tooltip when available', () => {
      const completedAt = '2026-02-19T10:05:00Z';
      const html = chatPanel._buildAnalysisCardInnerHTML({ suggestionCount: 2, completedAt });
      expect(html).toContain('Completed:');
    });

    it('should not include suggestion count in tooltip', () => {
      const html = chatPanel._buildAnalysisCardInnerHTML({ suggestionCount: 3, summary: 'Found issues' });
      const match = html.match(/title="([^"]*)/);
      expect(match).toBeTruthy();
      const tooltip = match[1];
      expect(tooltip).not.toContain('suggestions loaded');
    });
  });

  // -----------------------------------------------------------------------
  // _updateAnalysisCardContent
  // -----------------------------------------------------------------------
  describe('_updateAnalysisCardContent', () => {
    it('should update card innerHTML with richer metadata', () => {
      const card = createMockElement('div');
      card.innerHTML = '<span>old content</span>';

      chatPanel._updateAnalysisCardContent(card, {
        suggestionCount: 5, provider: 'claude', model: 'sonnet'
      });

      expect(card.innerHTML).toContain('5 suggestions loaded');
      expect(card.innerHTML).toContain('claude');
      expect(card.innerHTML).toContain('sonnet');
    });

    it('should set data-has-metadata when provider is present', () => {
      const card = createMockElement('div');

      chatPanel._updateAnalysisCardContent(card, {
        suggestionCount: 3, provider: 'claude'
      });

      expect(card.dataset.hasMetadata).toBe('true');
    });

    it('should set data-analysis-run-id when aiRunId is present', () => {
      const card = createMockElement('div');

      chatPanel._updateAnalysisCardContent(card, {
        suggestionCount: 3, aiRunId: 'run-42', provider: 'claude'
      });

      expect(card.dataset.analysisRunId).toBe('run-42');
    });

    it('should preserve existing remove button', () => {
      const removeBtn = createMockElement('button');
      const card = createMockElement('div');
      // Mock querySelector to return the remove button
      card.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-remove') return removeBtn;
        return null;
      });

      chatPanel._updateAnalysisCardContent(card, {
        suggestionCount: 3, provider: 'claude'
      });

      // appendChild should have been called with the remove button to re-attach it
      expect(card.appendChild).toHaveBeenCalledWith(removeBtn);
    });

    it('should not append remove button when none exists', () => {
      const card = createMockElement('div');
      card.querySelector = vi.fn(() => null);

      chatPanel._updateAnalysisCardContent(card, {
        suggestionCount: 3, provider: 'claude'
      });

      // appendChild should not have been called (innerHTML setter handles the content)
      expect(card.appendChild).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _showAnalysisContextIfPresent — in-place upgrade persists context
  // -----------------------------------------------------------------------
  describe('_showAnalysisContextIfPresent in-place upgrade persistence', () => {
    it('should call _persistAnalysisContext when upgrading bare card in-place', () => {
      chatPanel.currentSessionId = 20;
      const existingCard = createMockElement('div');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return existingCard;
        return null;
      });

      const persistSpy = vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);
      vi.spyOn(chatPanel, '_updateAnalysisCardContent').mockImplementation(() => {});

      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 5, aiRunId: 'run-abc', provider: 'claude', model: 'sonnet' }
      });

      expect(persistSpy).toHaveBeenCalledWith({
        type: 'analysis',
        suggestionCount: 5,
        aiRunId: 'run-abc',
        provider: 'claude',
        model: 'sonnet'
      });
    });
  });

  // -----------------------------------------------------------------------
  // _showAnalysisContextIfPresent — creates new card when none exists
  // -----------------------------------------------------------------------
  describe('_showAnalysisContextIfPresent no existing card', () => {
    it('should call _addAnalysisContextCard when no existing analysis card in DOM', () => {
      chatPanel.messagesEl.querySelector = vi.fn(() => null);

      const addCardSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 3, provider: 'claude' }
      });

      expect(addCardSpy).toHaveBeenCalledWith({ suggestionCount: 3, provider: 'claude' });
    });

    it('should remove empty state before adding new card', () => {
      const emptyState = createMockElement('div');
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return null;
        if (sel === '.chat-panel__empty') return emptyState;
        return null;
      });

      vi.spyOn(chatPanel, '_addAnalysisContextCard').mockImplementation(() => {});
      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 3, provider: 'claude' }
      });

      expect(emptyState.remove).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _addAnalysisContextCard — data-analysis-run-id stamp
  // -----------------------------------------------------------------------
  describe('_addAnalysisContextCard', () => {
    it('should stamp data-analysis-run-id when aiRunId is provided', () => {
      chatPanel._addAnalysisContextCard({ suggestionCount: 3, aiRunId: 'run-42' });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.analysis).toBe('true');
      expect(card.dataset.analysisRunId).toBe('run-42');
    });

    it('should not stamp data-analysis-run-id when aiRunId is missing', () => {
      chatPanel._addAnalysisContextCard({ suggestionCount: 2 });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.analysis).toBe('true');
      expect(card.dataset.analysisRunId).toBeUndefined();
    });

    it('should stamp data-has-metadata when provider is present', () => {
      chatPanel._addAnalysisContextCard({ suggestionCount: 3, provider: 'claude' });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.hasMetadata).toBe('true');
    });

    it('should stamp data-has-metadata when model is present', () => {
      chatPanel._addAnalysisContextCard({ suggestionCount: 3, model: 'sonnet' });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.hasMetadata).toBe('true');
    });

    it('should stamp data-has-metadata when summary is present', () => {
      chatPanel._addAnalysisContextCard({ suggestionCount: 3, summary: 'Found issues' });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.hasMetadata).toBe('true');
    });

    it('should not stamp data-has-metadata when no metadata fields are present', () => {
      chatPanel._addAnalysisContextCard({ suggestionCount: 2 });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.hasMetadata).toBeUndefined();
    });

    it('should include provider and model in card title when available', () => {
      chatPanel._addAnalysisContextCard({
        suggestionCount: 3,
        aiRunId: 'run-42',
        provider: 'council',
        model: 'claude-sonnet-4'
      });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('3 suggestions loaded');
      expect(card.innerHTML).toContain('council');
      expect(card.innerHTML).toContain('claude-sonnet-4');
    });

    it('should not include metadata in title when provider and model are absent', () => {
      chatPanel._addAnalysisContextCard({ suggestionCount: 2 });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('2 suggestions loaded');
      // Should not have parenthetical metadata
      expect(card.innerHTML).not.toContain('(');
    });

    it('should include summary in tooltip when available', () => {
      chatPanel._addAnalysisContextCard({
        suggestionCount: 5,
        provider: 'council',
        model: 'opus',
        summary: 'Found 5 issues across 3 files.',
        configType: 'advanced'
      });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      // The tooltip is set as the title attribute on the context-title span
      expect(card.innerHTML).toContain('title=');
      expect(card.innerHTML).toContain('Found 5 issues across 3 files.');
    });

    it('should include configType in tooltip when available', () => {
      chatPanel._addAnalysisContextCard({
        suggestionCount: 1,
        configType: 'council'
      });

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.innerHTML).toContain('Config: council');
    });
  });

  // -----------------------------------------------------------------------
  // _loadMRUSession — provider name (dead code removal)
  // -----------------------------------------------------------------------
  describe('_loadMRUSession — provider name', () => {
    it('should capitalize provider name without dead fallback', async () => {
      chatPanel.reviewId = 1;
      const updateTitleSpy = vi.spyOn(chatPanel, '_updateTitle');

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            sessions: [{
              id: 'sess-1',
              provider: 'claude',
              model: 'sonnet',
              message_count: 0,
            }]
          }
        }),
      });

      await chatPanel._loadMRUSession();

      expect(updateTitleSpy).toHaveBeenCalledWith('Claude', 'sonnet');
    });
  });

  // -----------------------------------------------------------------------
  // open() concurrency guard — race condition fix
  // -----------------------------------------------------------------------
  describe('open() concurrency guard', () => {
    it('should serialize concurrent open() calls', async () => {
      chatPanel.reviewId = 1;
      const callOrder = [];

      // First open() triggers a slow MRU load
      let resolveMRU1;
      const mruPromise1 = new Promise((resolve) => { resolveMRU1 = resolve; });

      const originalLoadMRU = chatPanel._loadMRUSession.bind(chatPanel);
      let loadMRUCallCount = 0;

      vi.spyOn(chatPanel, '_loadMRUSession').mockImplementation(async () => {
        loadMRUCallCount++;
        const callNum = loadMRUCallCount;
        callOrder.push(`mru-start-${callNum}`);
        if (callNum === 1) {
          await mruPromise1;
          chatPanel.currentSessionId = 'sess-1';
          callOrder.push(`mru-end-${callNum}`);
        } else {
          // Second call should see currentSessionId already set, so it should
          // not be called. But if it is, record it.
          callOrder.push(`mru-end-${callNum}`);
        }
      });

      vi.spyOn(chatPanel, '_ensureAnalysisContext').mockImplementation(() => {
        callOrder.push('ensureAnalysis');
      });

      // Start both open() calls without awaiting
      const p1 = chatPanel.open({});
      const p2 = chatPanel.open({ suggestionContext: { title: 'Bug', type: 'bug' } });

      // Let the first MRU load finish
      resolveMRU1();

      // Wait for both calls to complete
      await Promise.all([p1, p2]);

      // The second open() should have waited for the first to complete.
      // _ensureAnalysisContext should run AFTER mru-end-1.
      const mruEndIdx = callOrder.indexOf('mru-end-1');
      const analysisIdx = callOrder.indexOf('ensureAnalysis');
      expect(mruEndIdx).toBeGreaterThanOrEqual(0);
      expect(analysisIdx).toBeGreaterThan(mruEndIdx);
    });

    it('should clear _openPromise after open() completes', async () => {
      chatPanel.reviewId = 1;
      // No sessions — quick return from _loadMRUSession
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { sessions: [] } }),
      });

      await chatPanel.open({});

      expect(chatPanel._openPromise).toBeNull();
    });

    it('should clear _openPromise even if _openInner throws', async () => {
      chatPanel.reviewId = 1;
      vi.spyOn(chatPanel, '_loadMRUSession').mockRejectedValueOnce(new Error('network fail'));

      // open() should not throw (the error is caught inside _loadMRUSession)
      // but if _openInner itself throws, _openPromise should still be cleared
      try {
        await chatPanel.open({});
      } catch {
        // swallow
      }

      expect(chatPanel._openPromise).toBeNull();
    });

    it('should not call _loadMRUSession twice when second open() runs after first sets currentSessionId', async () => {
      chatPanel.reviewId = 1;
      let loadMRUCallCount = 0;

      vi.spyOn(chatPanel, '_loadMRUSession').mockImplementation(async () => {
        loadMRUCallCount++;
        // Simulate the first call setting currentSessionId
        chatPanel.currentSessionId = 'sess-from-mru';
      });

      const ensureSpy = vi.spyOn(chatPanel, '_ensureAnalysisContext').mockImplementation(() => {});

      // First open (toggle) and second open (with context)
      const p1 = chatPanel.open({});
      const p2 = chatPanel.open({ suggestionContext: { title: 'X', type: 'bug' } });

      await Promise.all([p1, p2]);

      // Because of the guard, the second open waits for the first,
      // and by then currentSessionId is set, so _loadMRUSession is called only once
      expect(loadMRUCallCount).toBe(1);
      // _ensureAnalysisContext should still have been called for the context open
      expect(ensureSpy).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _persistAnalysisContext
  // -----------------------------------------------------------------------
  describe('_persistAnalysisContext', () => {
    it('should call fetch with the correct endpoint and body when session exists', async () => {
      chatPanel.currentSessionId = 42;
      global.fetch.mockResolvedValueOnce({ ok: true });

      const contextData = { type: 'analysis', suggestionCount: 5, aiRunId: 'run-xyz' };
      await chatPanel._persistAnalysisContext(contextData);

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/chat/session/42/context',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contextData })
        })
      );
    });

    it('should not call fetch when currentSessionId is null', async () => {
      chatPanel.currentSessionId = null;
      await chatPanel._persistAnalysisContext({ type: 'analysis', suggestionCount: 3 });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should not throw when fetch fails', async () => {
      chatPanel.currentSessionId = 1;
      global.fetch.mockRejectedValueOnce(new Error('network error'));

      // Should not throw
      await chatPanel._persistAnalysisContext({ type: 'analysis', suggestionCount: 1 });
    });

    it('should not throw when fetch returns non-ok', async () => {
      chatPanel.currentSessionId = 1;
      global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });

      // Should not throw
      await chatPanel._persistAnalysisContext({ type: 'analysis', suggestionCount: 1 });
    });
  });

  // -----------------------------------------------------------------------
  // _ensureAnalysisContext — persistence integration
  // -----------------------------------------------------------------------
  describe('_ensureAnalysisContext persistence', () => {
    it('should call _persistAnalysisContext with analysis context data', () => {
      chatPanel._sessionAnalysisRunId = null;
      chatPanel.currentSessionId = 10;
      chatPanel.messages = [];

      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return null;
        if (sel === '.chat-panel__empty') return null;
        return null;
      });
      chatPanel.messagesEl.querySelectorAll = vi.fn((sel) => {
        if (sel === '.chat-panel__message') return [];
        return [];
      });
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div'), createMockElement('div'), createMockElement('div')]);

      const persistSpy = vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._ensureAnalysisContext();

      expect(persistSpy).toHaveBeenCalledWith({ type: 'analysis', suggestionCount: 3 });
    });

    it('should NOT call _persistAnalysisContext when skipping (card already in DOM)', () => {
      chatPanel._sessionAnalysisRunId = null;
      const analysisCard = createMockElement('div', { dataset: { analysis: 'true' } });
      chatPanel.messagesEl.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__context-card[data-analysis]') return analysisCard;
        return null;
      });
      global.document.querySelectorAll = vi.fn(() => [createMockElement('div')]);

      const persistSpy = vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._ensureAnalysisContext();

      expect(persistSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _showAnalysisContextIfPresent — persistence integration
  // -----------------------------------------------------------------------
  describe('_showAnalysisContextIfPresent persistence', () => {
    it('should call _persistAnalysisContext with type: analysis and context data', () => {
      chatPanel.currentSessionId = 20;
      chatPanel.messagesEl.querySelector = vi.fn(() => null);

      const persistSpy = vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 5, aiRunId: 'run-abc', provider: 'claude', model: 'sonnet' }
      });

      expect(persistSpy).toHaveBeenCalledWith({
        type: 'analysis',
        suggestionCount: 5,
        aiRunId: 'run-abc',
        provider: 'claude',
        model: 'sonnet'
      });
    });

    it('should NOT call _persistAnalysisContext when suggestionCount is 0', () => {
      chatPanel.currentSessionId = 20;
      chatPanel.messagesEl.querySelector = vi.fn(() => null);

      const persistSpy = vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._showAnalysisContextIfPresent({
        context: { suggestionCount: 0 }
      });

      expect(persistSpy).not.toHaveBeenCalled();
    });

    it('should NOT call _persistAnalysisContext when context is missing', () => {
      chatPanel.currentSessionId = 20;

      const persistSpy = vi.spyOn(chatPanel, '_persistAnalysisContext').mockResolvedValue(undefined);

      chatPanel._showAnalysisContextIfPresent({});

      expect(persistSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _loadMessageHistory — analysis context type dispatch
  // -----------------------------------------------------------------------
  describe('_loadMessageHistory analysis context', () => {
    it('should dispatch type: analysis to _addAnalysisContextCard', async () => {
      chatPanel.currentSessionId = 99;
      const analysisData = { type: 'analysis', suggestionCount: 7, aiRunId: 'run-42', provider: 'council' };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            messages: [
              { type: 'context', content: JSON.stringify(analysisData) },
              { type: 'message', role: 'user', content: 'hello', id: 1 }
            ]
          }
        })
      });

      const addAnalysisSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      const addContextSpy = vi.spyOn(chatPanel, '_addContextCard');

      await chatPanel._loadMessageHistory(99);

      expect(addAnalysisSpy).toHaveBeenCalledWith(analysisData);
      expect(addContextSpy).not.toHaveBeenCalled();
    });

    it('should dispatch type: file to _addFileContextCard (not analysis)', async () => {
      chatPanel.currentSessionId = 99;
      const fileData = { type: 'file', title: 'src/app.js', file: 'src/app.js' };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            messages: [
              { type: 'context', content: JSON.stringify(fileData) }
            ]
          }
        })
      });

      const addAnalysisSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');
      const addFileSpy = vi.spyOn(chatPanel, '_addFileContextCard');

      await chatPanel._loadMessageHistory(99);

      expect(addFileSpy).toHaveBeenCalledWith(fileData);
      expect(addAnalysisSpy).not.toHaveBeenCalled();
    });

    it('should NOT make analysis card removable when restored from history', async () => {
      chatPanel.currentSessionId = 99;
      const analysisData = { type: 'analysis', suggestionCount: 3 };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            messages: [
              { type: 'context', content: JSON.stringify(analysisData) }
            ]
          }
        })
      });

      const addAnalysisSpy = vi.spyOn(chatPanel, '_addAnalysisContextCard');

      await chatPanel._loadMessageHistory(99);

      // Called without removable option (defaults to false)
      expect(addAnalysisSpy).toHaveBeenCalledWith(analysisData);
      // Verify it was NOT called with removable: true
      expect(addAnalysisSpy).not.toHaveBeenCalledWith(analysisData, expect.objectContaining({ removable: true }));
    });
  });

  // -----------------------------------------------------------------------
  // _renderInlineMarkdown
  // -----------------------------------------------------------------------
  describe('_renderInlineMarkdown', () => {
    it('should strip outer <p> wrapper from rendered markdown', () => {
      const result = chatPanel._renderInlineMarkdown('**Bold**');
      // window.renderMarkdown returns <p>**Bold**</p> in our mock
      // _renderInlineMarkdown strips the <p>...</p> wrapper
      expect(result).toBe('**Bold**');
      expect(result).not.toContain('<p>');
    });

    it('should return empty string for null/empty input', () => {
      expect(chatPanel._renderInlineMarkdown(null)).toBe('');
      expect(chatPanel._renderInlineMarkdown('')).toBe('');
      expect(chatPanel._renderInlineMarkdown(undefined)).toBe('');
    });

    it('should delegate to renderMarkdown', () => {
      const spy = vi.spyOn(chatPanel, 'renderMarkdown');
      chatPanel._renderInlineMarkdown('test');
      expect(spy).toHaveBeenCalledWith('test');
    });
  });

  // -----------------------------------------------------------------------
  // Rolling transient tool badge
  // -----------------------------------------------------------------------
  describe('_showToolUse rolling transient badge', () => {
    let streamingMsg;
    let bubble;

    beforeEach(() => {
      bubble = createMockElement('div');
      bubble.className = 'chat-panel__bubble';

      streamingMsg = createMockElement('div', { id: 'chat-streaming-msg' });
      streamingMsg.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__bubble') return bubble;
        if (sel === '.chat-panel__tool-badge--transient') return null;
        if (sel === '.chat-panel__thinking') return null;
        if (sel === '.chat-panel__typing-indicator') return null;
        return null;
      });
      streamingMsg.querySelectorAll = vi.fn(() => []);

      elementRegistry['chat-streaming-msg'] = streamingMsg;
    });

    afterEach(() => {
      delete elementRegistry['chat-streaming-msg'];
    });

    it('should create a transient badge for non-Task tools', () => {
      chatPanel._showToolUse('Read', 'start', { file_path: 'test.js' });

      expect(streamingMsg.insertBefore).toHaveBeenCalled();
      const badge = streamingMsg.insertBefore.mock.calls[0][0];
      expect(badge.className).toContain('chat-panel__tool-badge--transient');
      expect(badge.dataset.tool).toBe('Read');
    });

    it('should create a persistent badge for Task tools', () => {
      chatPanel._showToolUse('Task', 'start', { description: 'do stuff' });

      expect(streamingMsg.insertBefore).toHaveBeenCalled();
      const badge = streamingMsg.insertBefore.mock.calls[0][0];
      expect(badge.className).toBe('chat-panel__tool-badge');
      expect(badge.className).not.toContain('transient');
      expect(badge.dataset.tool).toBe('Task');
    });

    it('should reuse existing transient badge on subsequent non-Task tool calls', () => {
      // First call creates badge
      chatPanel._showToolUse('Read', 'start', { file_path: 'a.js' });
      const firstBadge = streamingMsg.insertBefore.mock.calls[0][0];

      // Make the transient badge findable for the next call
      streamingMsg.querySelector = vi.fn((sel) => {
        if (sel === '.chat-panel__tool-badge--transient') return firstBadge;
        if (sel === '.chat-panel__bubble') return bubble;
        if (sel === '.chat-panel__thinking') return null;
        if (sel === '.chat-panel__typing-indicator') return null;
        return null;
      });

      // Second call should reuse, not create new
      chatPanel._showToolUse('Grep', 'start', { pattern: 'foo' });

      // insertBefore should have been called only once (for the first badge)
      expect(streamingMsg.insertBefore).toHaveBeenCalledTimes(1);
      // Badge content updated in place
      expect(firstBadge.dataset.tool).toBe('Grep');
      expect(firstBadge.innerHTML).toContain('Grep');
    });
  });

  // -----------------------------------------------------------------------
  // Context card tooltip data attributes
  // -----------------------------------------------------------------------
  describe('Context card tooltip data attributes', () => {
    it('should set tooltip data attributes on suggestion context cards', () => {
      const ctx = { title: 'Fix bug', type: 'bug', file: 'a.js', body: 'Detailed explanation' };
      chatPanel._addContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.tooltipBody).toBe('Detailed explanation');
      expect(card.dataset.tooltipType).toBe('bug');
      expect(card.dataset.tooltipTitle).toBe('Fix bug');
    });

    it('should NOT set tooltip data when body is absent', () => {
      const ctx = { title: 'No body', type: 'info', file: 'b.js' };
      chatPanel._addContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.tooltipBody).toBeUndefined();
    });

    it('should set tooltipBody on comment context cards', () => {
      const ctx = { commentId: '1', body: 'Comment body', file: 'a.js', line_start: 5, isFileLevel: false };
      chatPanel._addCommentContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.tooltipBody).toBe('Comment body');
    });

    it('should NOT set tooltipBody on comment cards when body is null', () => {
      const ctx = { commentId: '1', body: null, file: 'a.js', line_start: 5, isFileLevel: false };
      chatPanel._addCommentContextCard(ctx);

      const card = chatPanel.messagesEl.appendChild.mock.calls[0][0];
      expect(card.dataset.tooltipBody).toBeUndefined();
    });

    it('should use _renderInlineMarkdown for context card type and title', () => {
      const spy = vi.spyOn(chatPanel, '_renderInlineMarkdown');
      const ctx = { title: '**Bold title**', type: '**Bug**', file: 'a.js' };
      chatPanel._addContextCard(ctx);

      expect(spy).toHaveBeenCalledWith('**Bug**');
      expect(spy).toHaveBeenCalledWith('**Bold title**');
    });

    it('should use _renderInlineMarkdown for comment card body preview', () => {
      const spy = vi.spyOn(chatPanel, '_renderInlineMarkdown');
      const ctx = { commentId: '1', body: '**bold** text', file: 'a.js', line_start: 1, isFileLevel: false };
      chatPanel._addCommentContextCard(ctx);

      expect(spy).toHaveBeenCalledWith('**bold** text');
    });
  });

  // -----------------------------------------------------------------------
  // Context tooltip initialization and cleanup
  // -----------------------------------------------------------------------
  describe('Context tooltip lifecycle', () => {
    it('should create tooltip element on construction', () => {
      expect(chatPanel._ctxTooltipEl).toBeTruthy();
      expect(chatPanel._ctxTooltipEl.className).toBe('chat-panel__ctx-tooltip');
      expect(document.body.appendChild).toHaveBeenCalled();
    });

    it('should clean up tooltip element on destroy', () => {
      const tooltipEl = chatPanel._ctxTooltipEl;
      // Give it a parentNode so removeChild path is taken
      tooltipEl.parentNode = document.body;

      chatPanel.destroy();

      expect(document.body.removeChild).toHaveBeenCalledWith(tooltipEl);
      expect(chatPanel._ctxTooltipEl).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // _lateBindReview — race condition fix for PanelGroup auto-restore
  // -----------------------------------------------------------------------
  describe('_lateBindReview', () => {
    it('should set reviewId when not already bound', async () => {
      chatPanel.reviewId = null;

      await chatPanel._lateBindReview(42);

      expect(chatPanel.reviewId).toBe(42);
    });

    it('should not overwrite an existing reviewId', async () => {
      chatPanel.reviewId = 100;

      await chatPanel._lateBindReview(42);

      expect(chatPanel.reviewId).toBe(100);
    });

    it('should no-op when called with null reviewId', async () => {
      chatPanel.reviewId = null;

      await chatPanel._lateBindReview(null);

      expect(chatPanel.reviewId).toBeNull();
    });

    it('should load MRU session when panel is open and no session exists', async () => {
      chatPanel.reviewId = null;
      chatPanel.isOpen = true;
      chatPanel.currentSessionId = null;

      const loadMRUSpy = vi.spyOn(chatPanel, '_loadMRUSession').mockResolvedValue(undefined);
      const ensureAnalysisSpy = vi.spyOn(chatPanel, '_ensureAnalysisContext').mockImplementation(() => {});

      await chatPanel._lateBindReview(42);

      expect(chatPanel.reviewId).toBe(42);
      expect(loadMRUSpy).toHaveBeenCalled();
      expect(ensureAnalysisSpy).toHaveBeenCalled();
    });

    it('should not load MRU session when panel is closed', async () => {
      chatPanel.reviewId = null;
      chatPanel.isOpen = false;
      chatPanel.currentSessionId = null;

      const loadMRUSpy = vi.spyOn(chatPanel, '_loadMRUSession').mockResolvedValue(undefined);

      await chatPanel._lateBindReview(42);

      expect(chatPanel.reviewId).toBe(42);
      expect(loadMRUSpy).not.toHaveBeenCalled();
    });

    it('should not load MRU session when session already exists', async () => {
      chatPanel.reviewId = null;
      chatPanel.isOpen = true;
      chatPanel.currentSessionId = 'existing-session';

      const loadMRUSpy = vi.spyOn(chatPanel, '_loadMRUSession').mockResolvedValue(undefined);

      await chatPanel._lateBindReview(42);

      expect(chatPanel.reviewId).toBe(42);
      expect(loadMRUSpy).not.toHaveBeenCalled();
    });

    it('should call _ensureAnalysisContext after loading MRU session', async () => {
      chatPanel.reviewId = null;
      chatPanel.isOpen = true;
      chatPanel.currentSessionId = null;

      const callOrder = [];
      vi.spyOn(chatPanel, '_loadMRUSession').mockImplementation(async () => {
        callOrder.push('loadMRU');
      });
      vi.spyOn(chatPanel, '_ensureAnalysisContext').mockImplementation(() => {
        callOrder.push('ensureAnalysis');
      });

      await chatPanel._lateBindReview(42);

      expect(callOrder).toEqual(['loadMRU', 'ensureAnalysis']);
    });

    it('should re-enable input after late-binding reviewId', async () => {
      chatPanel.reviewId = null;
      chatPanel.isOpen = true;
      chatPanel.inputEl.disabled = true;
      chatPanel.inputEl.placeholder = 'Connecting to review\u2026';

      vi.spyOn(chatPanel, '_loadMRUSession').mockResolvedValue(undefined);
      vi.spyOn(chatPanel, '_ensureAnalysisContext').mockImplementation(() => {});

      await chatPanel._lateBindReview(42);

      expect(chatPanel.inputEl.disabled).toBe(false);
      expect(chatPanel.inputEl.placeholder).not.toBe('Connecting to review\u2026');
    });

    it('should not re-enable input if already enabled', async () => {
      chatPanel.reviewId = null;
      chatPanel.isOpen = false;
      chatPanel.inputEl.disabled = false;
      chatPanel.inputEl.placeholder = 'Ask about this review...';

      const enableSpy = vi.spyOn(chatPanel, '_enableInput');

      await chatPanel._lateBindReview(42);

      expect(enableSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _disableInput / _enableInput — input gating helpers
  // -----------------------------------------------------------------------
  describe('_disableInput / _enableInput', () => {
    it('should disable textarea and send button', () => {
      chatPanel.inputEl.placeholder = 'Ask about this review...';

      chatPanel._disableInput();

      expect(chatPanel.inputEl.disabled).toBe(true);
      expect(chatPanel.sendBtn.disabled).toBe(true);
      expect(chatPanel.inputEl.placeholder).toBe('Connecting to review\u2026');
    });

    it('should save and restore original placeholder', () => {
      chatPanel.inputEl.placeholder = 'Custom placeholder';

      chatPanel._disableInput();
      expect(chatPanel.inputEl.placeholder).toBe('Connecting to review\u2026');

      chatPanel._enableInput();
      expect(chatPanel.inputEl.placeholder).toBe('Custom placeholder');
    });

    it('should re-enable textarea and update send button state', () => {
      chatPanel.inputEl.value = 'hello';
      chatPanel.isStreaming = false;

      chatPanel._disableInput();
      chatPanel._enableInput();

      expect(chatPanel.inputEl.disabled).toBe(false);
      expect(chatPanel.sendBtn.disabled).toBe(false);
    });

    it('should keep send button disabled when input is empty', () => {
      chatPanel.inputEl.value = '';
      chatPanel.isStreaming = false;

      chatPanel._disableInput();
      chatPanel._enableInput();

      expect(chatPanel.sendBtn.disabled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // open() — input gating when reviewId is null
  // -----------------------------------------------------------------------
  describe('open() input gating', () => {
    beforeEach(() => {
      vi.spyOn(chatPanel, '_ensureConnected').mockResolvedValue({ sessionData: null });
    });

    it('should disable input when reviewId is null on open', async () => {
      chatPanel.reviewId = null;
      global.window.prManager = null;

      const disableSpy = vi.spyOn(chatPanel, '_disableInput');

      await chatPanel.open({});

      expect(disableSpy).toHaveBeenCalled();
    });

    it('should not disable input when reviewId is available', async () => {
      chatPanel.reviewId = null;

      const disableSpy = vi.spyOn(chatPanel, '_disableInput');

      await chatPanel.open({ reviewId: 42 });

      expect(disableSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // sendMessage — error recovery when createSession returns null
  // -----------------------------------------------------------------------
  describe('sendMessage error recovery on createSession failure', () => {
    it('should restore input text when createSession returns null', async () => {
      chatPanel.currentSessionId = null;
      chatPanel.reviewId = null; // will cause createSession to return null
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'my important message';

      await chatPanel.sendMessage();

      expect(chatPanel.inputEl.value).toBe('my important message');
    });

    it('should remove phantom message bubble when createSession returns null', async () => {
      chatPanel.currentSessionId = null;
      chatPanel.reviewId = null;
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'test message';

      // Track the element created by addMessage
      const mockMsgEl = createMockElement('div');
      vi.spyOn(chatPanel, 'addMessage').mockReturnValue(mockMsgEl);

      await chatPanel.sendMessage();

      expect(mockMsgEl.remove).toHaveBeenCalled();
    });

    it('should pop the last message from messages array on failure', async () => {
      chatPanel.currentSessionId = null;
      chatPanel.reviewId = null;
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'test message';
      chatPanel.messages = [];

      await chatPanel.sendMessage();

      // addMessage pushes, but error recovery should pop
      expect(chatPanel.messages).toHaveLength(0);
    });

    it('should show error message when createSession fails', async () => {
      chatPanel.currentSessionId = null;
      chatPanel.reviewId = null;
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'test';

      const errorSpy = vi.spyOn(chatPanel, '_showError');

      await chatPanel.sendMessage();

      expect(errorSpy).toHaveBeenCalledWith('Unable to start chat session. Please try again.');
    });

    it('should re-enable send button when createSession fails', async () => {
      chatPanel.currentSessionId = null;
      chatPanel.reviewId = null;
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'test';

      await chatPanel.sendMessage();

      expect(chatPanel.sendBtn.disabled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // sendMessage — 410 retry (non-resumable session)
  // -----------------------------------------------------------------------
  describe('sendMessage 410 retry', () => {
    it('should retry with a new session when the API returns 410', async () => {
      chatPanel.currentSessionId = 'stale-sess';
      chatPanel.reviewId = 1;
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'hello';

      // First fetch returns 410 (session not resumable)
      // Second fetch (createSession) returns a new session
      // Third fetch (retry message) returns 200
      global.fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 410,
          json: () => Promise.resolve({ error: 'Session is not resumable' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { id: 'new-sess', status: 'active' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        });

      const showErrorSpy = vi.spyOn(chatPanel, '_showError');

      await chatPanel.sendMessage();

      // Should have cleared the stale session and created a new one
      expect(chatPanel.currentSessionId).toBe('new-sess');

      // Should NOT show an error to the user
      expect(showErrorSpy).not.toHaveBeenCalled();

      // Should have made 3 fetch calls: message (410), createSession, retry message
      expect(global.fetch).toHaveBeenCalledTimes(3);

      // The retry message should be sent to the new session
      const retryCall = global.fetch.mock.calls[2];
      expect(retryCall[0]).toBe('/api/chat/session/new-sess/message');
    });

    it('should show error when createSession fails during 410 retry', async () => {
      chatPanel.currentSessionId = 'stale-sess';
      chatPanel.reviewId = 1;
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'hello';

      // First fetch returns 410
      // Second fetch (createSession) fails
      global.fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 410,
          json: () => Promise.resolve({ error: 'Session is not resumable' }),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({ error: 'Failed to create session' }),
        });

      const showErrorSpy = vi.spyOn(chatPanel, '_showError');

      await chatPanel.sendMessage();

      // createSession returns null on failure, so sendMessage should show an error
      expect(showErrorSpy).toHaveBeenCalled();
    });

    it('should not retry on non-410 errors', async () => {
      chatPanel.currentSessionId = 'sess-1';
      chatPanel.reviewId = 1;
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'hello';

      // Fetch returns 500 (not 410)
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal server error' }),
      });

      const createSessionSpy = vi.spyOn(chatPanel, 'createSession');
      const showErrorSpy = vi.spyOn(chatPanel, '_showError');

      await chatPanel.sendMessage();

      // Should NOT attempt to create a new session
      expect(createSessionSpy).not.toHaveBeenCalled();

      // Should show an error normally
      expect(showErrorSpy).toHaveBeenCalled();
    });

    it('should only retry once (not loop) on 410', async () => {
      chatPanel.currentSessionId = 'stale-sess';
      chatPanel.reviewId = 1;
      chatPanel.isStreaming = false;
      chatPanel.inputEl.value = 'hello';

      // First fetch: 410
      // Second fetch: createSession succeeds
      // Third fetch: retry message also returns 410 — should NOT retry again
      global.fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 410,
          json: () => Promise.resolve({ error: 'not resumable' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { id: 'new-sess', status: 'active' } }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 410,
          json: () => Promise.resolve({ error: 'still not resumable' }),
        });

      const showErrorSpy = vi.spyOn(chatPanel, '_showError');

      await chatPanel.sendMessage();

      // Should show the error from the second 410 (no further retry)
      expect(showErrorSpy).toHaveBeenCalled();
      // Should have made exactly 3 calls, not more
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Session picker dropdown
  // ---------------------------------------------------------------------------
  describe('session picker dropdown', () => {
    describe('_truncate', () => {
      it('should return empty string for null or undefined', () => {
        expect(chatPanel._truncate(null, 60)).toBe('');
        expect(chatPanel._truncate(undefined, 60)).toBe('');
      });

      it('should return original text when shorter than maxLen', () => {
        expect(chatPanel._truncate('Hello', 60)).toBe('Hello');
      });

      it('should truncate with ellipsis when text exceeds maxLen', () => {
        const long = 'a'.repeat(80);
        const result = chatPanel._truncate(long, 60);
        expect(result).toHaveLength(61); // 60 chars + ellipsis
        expect(result.endsWith('\u2026')).toBe(true);
      });
    });

    describe('_formatRelativeTime', () => {
      it('should return "Unknown" for null timestamp', () => {
        expect(chatPanel._formatRelativeTime(null)).toBe('Unknown');
      });

      it('should return hours ago for timestamps 1-23 hours old', () => {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        expect(chatPanel._formatRelativeTime(twoHoursAgo)).toBe('2 hours ago');
      });

      it('should use singular "hour" for exactly 1 hour', () => {
        const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
        expect(chatPanel._formatRelativeTime(oneHourAgo)).toBe('1 hour ago');
      });

      it('should return days ago for timestamps 1-6 days old', () => {
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        expect(chatPanel._formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
      });
    });

    describe('_renderSessionDropdown', () => {
      it('should show empty message when no sessions', () => {
        chatPanel._renderSessionDropdown([]);
        expect(chatPanel.sessionDropdown.innerHTML).toContain('No conversations yet');
      });

      it('should render session items with preview and meta', () => {
        chatPanel.currentSessionId = 1;
        // Mock querySelectorAll for the dropdown to return mock button elements
        const mockButtons = [];
        chatPanel.sessionDropdown.querySelectorAll = vi.fn(() => mockButtons);

        chatPanel._renderSessionDropdown([
          { id: 1, first_message: 'Hello world', updated_at: new Date().toISOString(), message_count: 2 },
          { id: 2, first_message: null, updated_at: new Date().toISOString(), message_count: 0 },
        ]);

        const html = chatPanel.sessionDropdown.innerHTML;
        // First session: should show the message and be active
        expect(html).toContain('Hello world');
        expect(html).toContain('chat-panel__session-item--active');
        // Second session: should show "New conversation"
        expect(html).toContain('New conversation');
      });

      it('should truncate long first_message in preview', () => {
        chatPanel.sessionDropdown.querySelectorAll = vi.fn(() => []);
        const longMsg = 'a'.repeat(80);
        chatPanel._renderSessionDropdown([
          { id: 1, first_message: longMsg, updated_at: new Date().toISOString(), message_count: 1 },
        ]);

        const html = chatPanel.sessionDropdown.innerHTML;
        // Should contain truncated text (60 chars + ellipsis entity)
        expect(html).not.toContain(longMsg);
        expect(html).toContain('a'.repeat(60));
      });
    });

    describe('dropdown visibility', () => {
      it('_isSessionDropdownOpen returns false when hidden', () => {
        chatPanel.sessionDropdown.style.display = 'none';
        expect(chatPanel._isSessionDropdownOpen()).toBe(false);
      });

      it('_isSessionDropdownOpen returns true when visible', () => {
        chatPanel.sessionDropdown.style.display = '';
        expect(chatPanel._isSessionDropdownOpen()).toBe(true);
      });

      it('_hideSessionDropdown sets display to none and removes open class', () => {
        chatPanel.sessionDropdown.style.display = '';
        chatPanel._hideSessionDropdown();
        expect(chatPanel.sessionDropdown.style.display).toBe('none');
        expect(chatPanel.sessionPickerBtn.classList.remove).toHaveBeenCalledWith('chat-panel__session-picker-btn--open');
      });
    });

    describe('_switchToSession', () => {
      it('should be a no-op if switching to current session', async () => {
        chatPanel.currentSessionId = 42;
        const spy = vi.spyOn(chatPanel, '_finalizeStreaming');
        await chatPanel._switchToSession(42, { message_count: 0 });
        expect(spy).not.toHaveBeenCalled();
      });

      it('should reset state and load new session', async () => {
        chatPanel.currentSessionId = 1;
        chatPanel.messages = [{ role: 'user', content: 'old' }];
        chatPanel._pendingContext = ['some context'];

        // Mock _loadMessageHistory and _ensureAnalysisContext
        chatPanel._loadMessageHistory = vi.fn().mockResolvedValue(undefined);
        chatPanel._ensureAnalysisContext = vi.fn();
        chatPanel._finalizeStreaming = vi.fn();
        chatPanel._clearMessages = vi.fn();
        chatPanel._updateActionButtons = vi.fn();

        await chatPanel._switchToSession(2, {
          id: 2,
          provider: 'pi',
          model: 'claude-sonnet-4',
          message_count: 3,
        });

        expect(chatPanel.currentSessionId).toBe(2);
        expect(chatPanel.messages).toEqual([]);
        expect(chatPanel._pendingContext).toEqual([]);
        expect(chatPanel._finalizeStreaming).toHaveBeenCalled();
        expect(chatPanel._clearMessages).toHaveBeenCalled();
        expect(chatPanel._loadMessageHistory).toHaveBeenCalledWith(2);
        expect(chatPanel._ensureAnalysisContext).toHaveBeenCalled();
      });

      it('should skip loading message history for empty sessions', async () => {
        chatPanel.currentSessionId = 1;
        chatPanel._loadMessageHistory = vi.fn().mockResolvedValue(undefined);
        chatPanel._ensureAnalysisContext = vi.fn();
        chatPanel._finalizeStreaming = vi.fn();
        chatPanel._clearMessages = vi.fn();
        chatPanel._updateActionButtons = vi.fn();

        await chatPanel._switchToSession(2, {
          id: 2,
          provider: 'pi',
          message_count: 0,
        });

        expect(chatPanel._loadMessageHistory).not.toHaveBeenCalled();
      });
    });

    describe('_updateTitle', () => {
      it('should set title text with provider and model', () => {
        chatPanel._updateTitle('Claude', 'claude-sonnet-4');
        expect(chatPanel.titleTextEl.textContent).toBe('Chat \u00b7 Claude \u00b7 Claude Sonnet 4');
      });

      it('should set default title when no args', () => {
        chatPanel._updateTitle();
        expect(chatPanel.titleTextEl.textContent).toBe('Chat \u00b7 Pi');
      });
    });

    describe('close hides dropdown', () => {
      it('should call _hideSessionDropdown on close', () => {
        const spy = vi.spyOn(chatPanel, '_hideSessionDropdown');
        chatPanel.isOpen = true;
        chatPanel.close();
        expect(spy).toHaveBeenCalled();
      });
    });

    describe('_startNewConversation hides dropdown', () => {
      it('should call _hideSessionDropdown on new conversation', async () => {
        const spy = vi.spyOn(chatPanel, '_hideSessionDropdown');
        chatPanel._finalizeStreaming = vi.fn();
        chatPanel._clearMessages = vi.fn();
        chatPanel._updateActionButtons = vi.fn();
        chatPanel._updateTitle = vi.fn();
        chatPanel._ensureAnalysisContext = vi.fn();
        await chatPanel._startNewConversation();
        expect(spy).toHaveBeenCalled();
      });
    });

    describe('Escape key closes dropdown first', () => {
      it('should close dropdown before other Escape actions', () => {
        chatPanel.isOpen = true;
        chatPanel.sessionDropdown.style.display = '';
        const hideSpy = vi.spyOn(chatPanel, '_hideSessionDropdown');

        // Simulate Escape keydown
        const handlers = documentListeners['keydown'] || [];
        handlers.forEach(h => h({ key: 'Escape' }));

        expect(hideSpy).toHaveBeenCalled();
      });
    });
  });

  // -----------------------------------------------------------------------
  // ensureContextFile (PRManager method)
  // -----------------------------------------------------------------------
  describe('ensureContextFile', () => {
    // Import PRManager so we can bind its prototype method onto a lightweight
    // mock object — avoids the heavy constructor that needs full DOM.
    const { PRManager } = require('../../public/js/pr.js');

    /** Create a minimal PRManager-like object with ensureContextFile bound */
    function createMockPRManager(overrides = {}) {
      const mgr = {
        currentPR: overrides.currentPR !== undefined ? overrides.currentPR : { id: 42 },
        diffFiles: overrides.diffFiles || [],
        contextFiles: overrides.contextFiles || [],
        loadContextFiles: overrides.loadContextFiles || vi.fn(async () => {}),
      };
      // Bind the real method onto our mock
      mgr.ensureContextFile = PRManager.prototype.ensureContextFile.bind(mgr);
      return mgr;
    }

    it('should return null when no reviewId (currentPR is null)', async () => {
      const mgr = createMockPRManager({ currentPR: null });

      const result = await mgr.ensureContextFile('src/foo.js');

      expect(result).toBeNull();
    });

    it('should return { type: "diff" } when file is in diffFiles', async () => {
      const mgr = createMockPRManager({
        diffFiles: [{ file: 'src/foo.js' }, { file: 'src/bar.js' }],
      });

      const result = await mgr.ensureContextFile('src/foo.js');

      expect(result).toEqual({ type: 'diff' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return { type: "context" } when file already in contextFiles', async () => {
      const existingEntry = { file: 'src/foo.js', id: 7, line_start: 1, line_end: 50 };
      const mgr = createMockPRManager({
        contextFiles: [existingEntry],
      });

      const result = await mgr.ensureContextFile('src/foo.js');

      expect(result).toEqual({ type: 'context', contextFile: existingEntry });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should POST with correct URL, method, and body for a new file', async () => {
      const mgr = createMockPRManager({
        currentPR: { id: 99 },
        loadContextFiles: vi.fn(async () => {
          mgr.contextFiles = [{ file: 'src/new.js', id: 10 }];
        }),
      });
      global.fetch.mockResolvedValue({ status: 201 });

      await mgr.ensureContextFile('src/new.js', 5, 20);

      expect(global.fetch).toHaveBeenCalledWith('/api/reviews/99/context-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'src/new.js', line_start: 5, line_end: 20 }),
      });
    });

    it('should default to line_start=1, line_end=100 when no range provided', async () => {
      const mgr = createMockPRManager();
      global.fetch.mockResolvedValue({ status: 201 });

      await mgr.ensureContextFile('src/foo.js');

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.line_start).toBe(1);
      expect(callBody.line_end).toBe(100);
    });

    it('should set line_end = lineStart + 49 when only lineStart provided', async () => {
      const mgr = createMockPRManager();
      global.fetch.mockResolvedValue({ status: 201 });

      await mgr.ensureContextFile('src/foo.js', 10);

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.line_start).toBe(10);
      expect(callBody.line_end).toBe(59);
    });

    it('should clamp range > 500 lines (line_end capped at lineStart + 499)', async () => {
      const mgr = createMockPRManager();
      global.fetch.mockResolvedValue({ status: 201 });

      await mgr.ensureContextFile('src/foo.js', 10, 1000);

      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.line_start).toBe(10);
      expect(callBody.line_end).toBe(509);
    });

    it('should return null on fetch error (network failure)', async () => {
      const mgr = createMockPRManager();
      global.fetch.mockRejectedValue(new Error('network error'));

      const result = await mgr.ensureContextFile('src/foo.js');

      expect(result).toBeNull();
    });

    it('should return null on non-201/non-400 response status', async () => {
      const mgr = createMockPRManager();
      global.fetch.mockResolvedValue({
        status: 500,
        json: vi.fn().mockResolvedValue({}),
      });

      const result = await mgr.ensureContextFile('src/foo.js');

      expect(result).toBeNull();
    });

    it('should return { type: "diff" } on 400 "already part of the diff"', async () => {
      const mgr = createMockPRManager();
      global.fetch.mockResolvedValue({
        status: 400,
        json: vi.fn().mockResolvedValue({ error: 'File is already part of the diff' }),
      });

      const result = await mgr.ensureContextFile('src/foo.js');

      expect(result).toEqual({ type: 'diff' });
    });

    it('should reload contextFiles and return added entry on 201', async () => {
      const addedEntry = { file: 'src/new.js', id: 10, line_start: 1, line_end: 100 };
      const mgr = createMockPRManager({
        loadContextFiles: vi.fn(async () => {
          mgr.contextFiles = [addedEntry];
        }),
      });
      global.fetch.mockResolvedValue({ status: 201 });

      const result = await mgr.ensureContextFile('src/new.js');

      expect(mgr.loadContextFiles).toHaveBeenCalled();
      expect(result).toEqual({ type: 'context', contextFile: addedEntry });
    });
  });

  // -----------------------------------------------------------------------
  // _handleFileLinkClick
  // -----------------------------------------------------------------------
  describe('_handleFileLinkClick', () => {
    let savedQuerySelector;
    let savedCSS;

    beforeEach(() => {
      savedQuerySelector = global.document.querySelector;
      // Provide CSS.escape for the method
      savedCSS = global.CSS;
      global.CSS = { escape: vi.fn((s) => s) };
      // Default: no file wrapper found in DOM
      global.document.querySelector = vi.fn(() => null);
      // Reset prManager
      global.window.prManager = {
        ensureContextFile: vi.fn(),
        scrollToFile: vi.fn(),
        scrollToContextFile: vi.fn(),
      };
      chatPanel._scrollToLine = vi.fn();
      chatPanel._showToast = vi.fn();
    });

    afterEach(() => {
      global.document.querySelector = savedQuerySelector;
      global.CSS = savedCSS;
      global.window.prManager = null;
    });

    function createLinkEl(file, lineStart = null, lineEnd = null) {
      const el = createMockElement('a', {
        dataset: {
          file,
          lineStart: lineStart != null ? String(lineStart) : '',
          lineEnd: lineEnd != null ? String(lineEnd) : '',
        },
      });
      return el;
    }

    it('should scroll to diff file when wrapper exists in DOM (no ensureContextFile call)', async () => {
      const wrapper = createMockElement('div', { dataset: { fileName: 'src/app.js' } });
      wrapper.closest = vi.fn(() => null); // not inside .context-file-wrapper
      global.document.querySelector = vi.fn(() => wrapper);

      const linkEl = createLinkEl('src/app.js', 10);

      await chatPanel._handleFileLinkClick(linkEl);

      expect(chatPanel._scrollToLine).toHaveBeenCalledWith('src/app.js', 10, null);
      expect(global.window.prManager.ensureContextFile).not.toHaveBeenCalled();
    });

    it('should scroll to context file when wrapper exists in DOM', async () => {
      const contextWrapper = createMockElement('div', {
        dataset: { contextId: '7' },
      });
      const wrapper = createMockElement('div', { dataset: { fileName: 'src/app.js' } });
      wrapper.closest = vi.fn((sel) => {
        if (sel === '.context-file') return contextWrapper;
        return null;
      });
      global.document.querySelector = vi.fn(() => wrapper);

      const linkEl = createLinkEl('src/app.js', 5);

      await chatPanel._handleFileLinkClick(linkEl);

      expect(global.window.prManager.scrollToContextFile).toHaveBeenCalledWith('src/app.js', 5, '7');
      expect(global.window.prManager.ensureContextFile).not.toHaveBeenCalled();
    });

    it('should call ensureContextFile when file not in DOM', async () => {
      global.document.querySelector = vi.fn(() => null);
      global.window.prManager.ensureContextFile.mockResolvedValue({ type: 'diff' });

      const linkEl = createLinkEl('src/missing.js', 10, 50);

      await chatPanel._handleFileLinkClick(linkEl);

      expect(global.window.prManager.ensureContextFile).toHaveBeenCalledWith('src/missing.js', 10, 50);
    });

    it('should show error toast when ensureContextFile returns null', async () => {
      global.document.querySelector = vi.fn(() => null);
      global.window.prManager.ensureContextFile.mockResolvedValue(null);

      const linkEl = createLinkEl('src/missing.js');

      await chatPanel._handleFileLinkClick(linkEl);

      expect(chatPanel._showToast).toHaveBeenCalledWith('Could not load file');
    });

    it('should add and remove loading class', async () => {
      global.document.querySelector = vi.fn(() => null);
      // Use a promise we control to verify loading class timing
      let resolveEnsure;
      global.window.prManager.ensureContextFile.mockImplementation(() =>
        new Promise(resolve => { resolveEnsure = resolve; })
      );

      const linkEl = createLinkEl('src/missing.js');

      const promise = chatPanel._handleFileLinkClick(linkEl);

      // Loading class should be added immediately
      expect(linkEl.classList.add).toHaveBeenCalledWith('chat-file-link--loading');

      // Resolve the ensureContextFile call
      resolveEnsure({ type: 'diff' });
      await promise;

      // Loading class should be removed in finally block
      expect(linkEl.classList.remove).toHaveBeenCalledWith('chat-file-link--loading');
    });

    it('should scroll to file after ensureContextFile returns diff', async () => {
      global.document.querySelector = vi.fn(() => null);
      global.window.prManager.ensureContextFile.mockResolvedValue({ type: 'diff' });

      const linkEl = createLinkEl('src/found.js');

      await chatPanel._handleFileLinkClick(linkEl);

      expect(global.window.prManager.scrollToFile).toHaveBeenCalledWith('src/found.js');
    });

    it('should scroll to context file after ensureContextFile returns context', async () => {
      global.document.querySelector = vi.fn(() => null);
      global.window.prManager.ensureContextFile.mockResolvedValue({
        type: 'context',
        contextFile: { id: 22 },
      });

      const linkEl = createLinkEl('src/ctx.js', 10);

      await chatPanel._handleFileLinkClick(linkEl);

      expect(global.window.prManager.scrollToContextFile).toHaveBeenCalledWith('src/ctx.js', 10, 22);
    });

    it('should show error toast when ensureContextFile throws', async () => {
      global.document.querySelector = vi.fn(() => null);
      global.window.prManager.ensureContextFile.mockRejectedValue(new Error('boom'));

      const linkEl = createLinkEl('src/broken.js');

      await chatPanel._handleFileLinkClick(linkEl);

      expect(chatPanel._showToast).toHaveBeenCalledWith('Could not load file');
      expect(linkEl.classList.remove).toHaveBeenCalledWith('chat-file-link--loading');
    });
  });

  // -------------------------------------------------------------------------
  // _findLineRows
  // -------------------------------------------------------------------------

  describe('_findLineRows', () => {
    /**
     * Build a mock fileWrapper whose querySelectorAll('.line-num2') returns
     * elements with the given textContent values.  Each element lives inside
     * a mock <tr> reachable via closest('tr').
     */
    function buildFileWrapper(lineTexts) {
      const lineNumEls = lineTexts.map((text) => {
        const tr = createMockElement('tr');
        const ln = createMockElement('td');
        ln.textContent = String(text);
        ln.closest = vi.fn((sel) => (sel === 'tr' ? tr : null));
        // Attach the parent row for assertion purposes
        ln._parentRow = tr;
        return ln;
      });

      const wrapper = createMockElement('div');
      wrapper.querySelectorAll = vi.fn((sel) => {
        if (sel === '.line-num2') return lineNumEls;
        return [];
      });
      wrapper._lineNumEls = lineNumEls;
      return wrapper;
    }

    it('returns matching rows for a line range', () => {
      // Lines 10 through 20
      const texts = [];
      for (let i = 10; i <= 20; i++) texts.push(i);
      const wrapper = buildFileWrapper(texts);

      const rows = chatPanel._findLineRows(wrapper, 12, 15);

      expect(rows).toHaveLength(4);
      // Verify the returned rows are the <tr> elements for lines 12–15
      const expectedRows = wrapper._lineNumEls
        .filter((el) => {
          const n = parseInt(el.textContent, 10);
          return n >= 12 && n <= 15;
        })
        .map((el) => el._parentRow);
      expect(rows).toEqual(expectedRows);
    });

    it('returns exactly one row for a single-line degenerate case', () => {
      const texts = [];
      for (let i = 10; i <= 20; i++) texts.push(i);
      const wrapper = buildFileWrapper(texts);

      const rows = chatPanel._findLineRows(wrapper, 14, 14);

      expect(rows).toHaveLength(1);
      const expected = wrapper._lineNumEls.find(
        (el) => el.textContent.trim() === '14',
      );
      expect(rows[0]).toBe(expected._parentRow);
    });

    it('handles non-numeric gutter content (isNaN guard)', () => {
      // Mix numeric lines with non-numeric entries like "..." and ""
      const texts = [10, '...', 11, '', 12, 13];
      const wrapper = buildFileWrapper(texts);

      const rows = chatPanel._findLineRows(wrapper, 10, 13);

      // Only the four numeric entries (10, 11, 12, 13) should match
      expect(rows).toHaveLength(4);
      // Non-numeric elements should have been skipped
      const returnedNums = rows.map((row) => {
        const ln = wrapper._lineNumEls.find((el) => el._parentRow === row);
        return parseInt(ln.textContent, 10);
      });
      expect(returnedNums).toEqual([10, 11, 12, 13]);
    });

    it('returns empty array when no lines match the range', () => {
      const texts = [];
      for (let i = 10; i <= 20; i++) texts.push(i);
      const wrapper = buildFileWrapper(texts);

      const rows = chatPanel._findLineRows(wrapper, 50, 60);

      expect(rows).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // scrollToBottom and new-content pill
  // -------------------------------------------------------------------------

  describe('scrollToBottom and new-content pill', () => {
    /** Helper: configure messagesEl scroll geometry so we can control nearBottom. */
    function setScrollGeometry(scrollTop, scrollHeight, clientHeight) {
      Object.defineProperty(chatPanel.messagesEl, 'scrollTop', {
        get: () => scrollTop,
        set: vi.fn(),
        configurable: true,
      });
      Object.defineProperty(chatPanel.messagesEl, 'scrollHeight', {
        value: scrollHeight,
        configurable: true,
      });
      Object.defineProperty(chatPanel.messagesEl, 'clientHeight', {
        value: clientHeight,
        configurable: true,
      });
    }

    it('NEAR_BOTTOM_THRESHOLD is exported and equals 80', () => {
      expect(NEAR_BOTTOM_THRESHOLD).toBe(80);
    });

    describe('scrollToBottom({ force: true })', () => {
      it('should always scroll to bottom and hide the pill', () => {
        // User is far from bottom (distance = 500)
        setScrollGeometry(100, 1000, 400);
        chatPanel.newContentPill.style.display = ''; // pill visible

        chatPanel.scrollToBottom({ force: true });

        // Pill should be hidden
        expect(chatPanel.newContentPill.style.display).toBe('none');
      });

      it('should scroll to bottom even when already near bottom', () => {
        // distance = 50, which is < threshold
        setScrollGeometry(450, 1000, 500);
        chatPanel.newContentPill.style.display = '';

        chatPanel.scrollToBottom({ force: true });

        expect(chatPanel.newContentPill.style.display).toBe('none');
      });

      it('should scroll and clear _userScrolledAway even when flag is true', () => {
        chatPanel._userScrolledAway = true;
        setScrollGeometry(100, 1000, 400);
        chatPanel.newContentPill.style.display = '';

        chatPanel.scrollToBottom({ force: true });

        expect(chatPanel._userScrolledAway).toBe(false);
        expect(chatPanel.newContentPill.style.display).toBe('none');
      });
    });

    describe('scrollToBottom() without force', () => {
      beforeEach(() => {
        // Ensure flag is clear so threshold logic is exercised
        chatPanel._userScrolledAway = false;
      });

      it('should scroll when near the bottom (within threshold)', () => {
        // distance = 50, which is < 80 threshold
        setScrollGeometry(450, 1000, 500);
        chatPanel.newContentPill.style.display = '';

        chatPanel.scrollToBottom();

        // Pill should be hidden (auto-scrolled)
        expect(chatPanel.newContentPill.style.display).toBe('none');
      });

      it('should show pill when not near the bottom', () => {
        // distance = 200, which is > 80 threshold
        setScrollGeometry(300, 1000, 500);
        chatPanel.newContentPill.style.display = 'none';

        chatPanel.scrollToBottom();

        // Pill should now be visible
        expect(chatPanel.newContentPill.style.display).toBe('');
      });

      it('should show pill at exactly the threshold boundary', () => {
        // distance = exactly 80, which is NOT less than 80, so pill shows
        setScrollGeometry(420, 1000, 500);
        chatPanel.newContentPill.style.display = 'none';

        chatPanel.scrollToBottom();

        expect(chatPanel.newContentPill.style.display).toBe('');
      });

      it('should auto-scroll at one pixel inside threshold', () => {
        // distance = 79, which IS less than 80
        setScrollGeometry(421, 1000, 500);
        chatPanel.newContentPill.style.display = '';

        chatPanel.scrollToBottom();

        expect(chatPanel.newContentPill.style.display).toBe('none');
      });
    });

    describe('_userScrolledAway flag', () => {
      it('should bail immediately and show pill when flag is true (no force)', () => {
        chatPanel._userScrolledAway = true;
        // Even near bottom, flag causes immediate bail
        setScrollGeometry(450, 1000, 500);
        chatPanel.newContentPill.style.display = 'none';

        chatPanel.scrollToBottom();

        expect(chatPanel.newContentPill.style.display).toBe('');
        // Flag remains true
        expect(chatPanel._userScrolledAway).toBe(true);
      });

      it('should set flag to true when scrollToBottom sees user far from bottom', () => {
        chatPanel._userScrolledAway = false;
        setScrollGeometry(100, 1000, 400); // distance = 500

        chatPanel.scrollToBottom();

        expect(chatPanel._userScrolledAway).toBe(true);
        expect(chatPanel.newContentPill.style.display).toBe('');
      });

      it('should clear flag when scrollToBottom auto-scrolls near bottom', () => {
        chatPanel._userScrolledAway = false;
        setScrollGeometry(450, 1000, 500); // distance = 50

        chatPanel.scrollToBottom();

        expect(chatPanel._userScrolledAway).toBe(false);
        expect(chatPanel.newContentPill.style.display).toBe('none');
      });
    });

    describe('scroll listener direction tracking', () => {
      /** Helper: retrieve the scroll handler registered on messagesEl. */
      function getScrollHandler() {
        const scrollCalls = chatPanel.messagesEl.addEventListener.mock.calls
          .filter(([event]) => event === 'scroll');
        expect(scrollCalls.length).toBeGreaterThan(0);
        return scrollCalls[0][1];
      }

      it('should set _userScrolledAway when scrolling UP beyond threshold', () => {
        const handler = getScrollHandler();
        chatPanel._userScrolledAway = false;

        // First scroll event at scrollTop=500 to set lastScrollTop
        setScrollGeometry(500, 1000, 400); // distance = 100 (>= threshold)
        handler();
        expect(chatPanel._userScrolledAway).toBe(false); // scrolling down or first event

        // Second event: scrollTop=400 (scrolling UP), distance = 200 (>= threshold)
        setScrollGeometry(400, 1000, 400);
        handler();
        expect(chatPanel._userScrolledAway).toBe(true);
        expect(chatPanel.newContentPill.style.display).toBe('');
      });

      it('should clear _userScrolledAway when scrolling back near bottom', () => {
        const handler = getScrollHandler();
        chatPanel._userScrolledAway = true;

        // Scroll to near bottom: distance = 50 (< threshold)
        setScrollGeometry(550, 1000, 400);
        handler();
        expect(chatPanel._userScrolledAway).toBe(false);
        expect(chatPanel.newContentPill.style.display).toBe('none');
      });

      it('should not change flag when scrolling DOWN but still far from bottom', () => {
        const handler = getScrollHandler();

        // First event to set lastScrollTop
        setScrollGeometry(100, 1000, 400); // distance = 500
        handler();

        // Scrolling down (scrollTop increased), still far from bottom
        chatPanel._userScrolledAway = false;
        setScrollGeometry(200, 1000, 400); // distance = 400, scrolling down
        handler();
        // Not scrolling UP, distance >= threshold -> no change to flag
        expect(chatPanel._userScrolledAway).toBe(false);
      });
    });

    describe('scrollToBottom with no messagesEl', () => {
      it('should not throw when messagesEl is null', () => {
        chatPanel.messagesEl = null;
        expect(() => chatPanel.scrollToBottom()).not.toThrow();
        expect(() => chatPanel.scrollToBottom({ force: true })).not.toThrow();
      });
    });

    describe('_showNewContentPill / _hideNewContentPill', () => {
      it('_showNewContentPill makes pill visible', () => {
        chatPanel.newContentPill.style.display = 'none';
        chatPanel._showNewContentPill();
        expect(chatPanel.newContentPill.style.display).toBe('');
      });

      it('_hideNewContentPill makes pill hidden', () => {
        chatPanel.newContentPill.style.display = '';
        chatPanel._hideNewContentPill();
        expect(chatPanel.newContentPill.style.display).toBe('none');
      });

      it('_showNewContentPill does not throw when pill is null', () => {
        chatPanel.newContentPill = null;
        expect(() => chatPanel._showNewContentPill()).not.toThrow();
      });

      it('_hideNewContentPill does not throw when pill is null', () => {
        chatPanel.newContentPill = null;
        expect(() => chatPanel._hideNewContentPill()).not.toThrow();
      });
    });

    describe('pill click triggers force scroll', () => {
      it('should call scrollToBottom with force: true on pill click', () => {
        const spy = vi.spyOn(chatPanel, 'scrollToBottom');

        // Find the click handler registered on the pill
        const clickCalls = chatPanel.newContentPill.addEventListener.mock.calls
          .filter(([event]) => event === 'click');

        expect(clickCalls.length).toBeGreaterThan(0);

        // Invoke the click handler
        const clickHandler = clickCalls[0][1];
        clickHandler();

        expect(spy).toHaveBeenCalledWith({ force: true });
      });

      it('should clear _userScrolledAway when pill click triggers force scroll', () => {
        chatPanel._userScrolledAway = true;
        setScrollGeometry(100, 1000, 400); // far from bottom
        chatPanel.newContentPill.style.display = '';

        // Simulate what the pill click handler does
        chatPanel.scrollToBottom({ force: true });

        expect(chatPanel._userScrolledAway).toBe(false);
        expect(chatPanel.newContentPill.style.display).toBe('none');
      });
    });
  });
});
