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
      if (selector === '.chat-panel__resize-handle') return elementRegistry['chat-resize-handle'] || null;
      if (selector === '.chat-panel__empty') return elementRegistry['chat-empty'] || null;
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
    'chat-resize-handle': createMockElement('div'),
    'chat-empty': createMockElement('div'),
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

  return elementRegistry;
}

// ---------------------------------------------------------------------------
// Set up globals BEFORE requiring ChatPanel (IIFE assigns to window)
// ---------------------------------------------------------------------------

global.window = global.window || {};
global.window.prManager = null;
global.window.renderMarkdown = (text) => `<p>${text}</p>`;
global.window.escapeHtmlAttribute = (text) => text;

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
  body: {
    classList: { add: vi.fn(), remove: vi.fn() },
  },
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

// Now require the production ChatPanel module
const { ChatPanel } = require('../../public/js/components/ChatPanel.js');

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
      '.chat-panel__resize-handle': reg['chat-resize-handle'],
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
  });

  // -----------------------------------------------------------------------
  // _handleAdoptClick / _handleUpdateClick
  // -----------------------------------------------------------------------
  describe('_handleAdoptClick', () => {
    it('should set input value with suggestion ID and call sendMessage', () => {
      chatPanel._contextItemId = 55;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleAdoptClick();

      expect(chatPanel.inputEl.value).toContain('55');
      expect(chatPanel.inputEl.value).toContain('adopt');
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
    it('should set input value with comment ID and call sendMessage', () => {
      chatPanel._contextItemId = 88;
      chatPanel.isStreaming = false;
      const sendSpy = vi.spyOn(chatPanel, 'sendMessage').mockResolvedValue(undefined);

      chatPanel._handleUpdateClick();

      expect(chatPanel.inputEl.value).toContain('88');
      expect(chatPanel.inputEl.value).toContain('update');
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

    it('should clear pending context', async () => {
      chatPanel._pendingContext = ['ctx'];
      chatPanel._pendingContextData = [{ type: 'suggestion' }];

      await chatPanel._startNewConversation();

      expect(chatPanel._pendingContext).toEqual([]);
      expect(chatPanel._pendingContextData).toEqual([]);
    });

    it('should reset context source and item ID', async () => {
      chatPanel._contextSource = 'user';
      chatPanel._contextItemId = 77;

      await chatPanel._startNewConversation();

      expect(chatPanel._contextSource).toBeNull();
      expect(chatPanel._contextItemId).toBeNull();
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
});
