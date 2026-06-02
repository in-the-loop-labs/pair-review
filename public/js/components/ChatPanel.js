// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * ChatPanel - AI chat sidebar component
 * Provides a sliding chat panel for conversing with AI about the current review.
 * Works in both PR mode and Local mode.
 */

const DISMISS_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`;

/** Pixel threshold for considering the user "near the bottom" of the messages container. */
const NEAR_BOTTOM_THRESHOLD = 80;

const LOOP_SPINNER_HTML = `<span class="chat-panel__loop-spinner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path transform="rotate(-50 12 12)" d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.356-8-5.096 0-5.096 8 0 8 5.223 0 7.26-8 12.356-8z"/></svg></span>`;
const DOTS_SPINNER_HTML = '<span class="chat-panel__typing-indicator"><span></span><span></span><span></span></span>';

function getChatSpinnerHTML() {
  return window.__pairReview?.chatSpinner === 'loop' ? LOOP_SPINNER_HTML : DOTS_SPINNER_HTML;
}

/**
 * @typedef {Object} ChatTab
 * @property {number|null} sessionId - Backend session ID (null for an unsaved new tab)
 * @property {string} title - Tab title shown in the strip
 * @property {'idle'|'streaming'|'error'} status - Drives the status dot color
 * @property {string|null} errorMessage - Last error, cleared on next successful send
 * @property {Array<{role: string, content: string, id?: number}>} messages
 * @property {boolean} isStreaming
 * @property {string} streamingContent - Accumulated stream text (delta concatenation)
 * @property {boolean} sessionWarm - True once the session has been used this page load (ACP resume flag)
 * @property {string} provider - Provider id assigned to this tab when its session was created
 * @property {string|null} model - Model id for header label
 * @property {string|null} contextSource - 'suggestion' | 'user' | 'line' | 'file' | null
 * @property {(string|number)|null} contextItemId
 * @property {Object|null} contextLineMeta - { file, line_start, line_end }
 * @property {Object|null} pendingActionContext - Set by action buttons, consumed in sendMessage
 * @property {string[]} pendingContext - Unsent context text blocks for next send
 * @property {Object[]} pendingContextData - Structured context data parallel to pendingContext
 * @property {string|null} latestDiffState - Latest diff snapshot (idempotent, overwrites)
 * @property {string[]} pendingUserActionHints - Ordered log of UI actions, drained on send
 * @property {boolean} analysisContextRemoved
 * @property {string|null} sessionAnalysisRunId
 * @property {HTMLElement} messagesEl - Per-tab scrollable messages container
 * @property {HTMLElement|null} streamingMsgEl - Reference to the in-progress assistant bubble
 * @property {boolean} userScrolledAway - Auto-scroll engagement flag
 * @property {Function|null} wsUnsub - Unsubscribe handle for the per-session WS topic
 * @property {Promise<void>|null} historyLoadPromise - Set while history is loading
 */

let _newTabCounter = 0;
function _nextNewTabTitle() {
  _newTabCounter += 1;
  return _newTabCounter === 1 ? 'New Chat' : `New Chat ${_newTabCounter}`;
}

class ChatPanel {
  constructor(containerId) {
    this.containerId = containerId;
    this.container = document.getElementById(containerId);
    this.reviewId = null;
    this.isOpen = false;
    this._reviewUnsub = null;
    this._resizeConfig = ChatPanel.RESIZE_CONFIG;
    this._openPromise = null;
    this._activeProvider = window.__pairReview?.chatProvider || 'pi';
    this._chatProviders = window.__pairReview?.chatProviders || [];
    this._enterToSend = window.__pairReview?.chatEnterToSend ?? true;

    /** @type {ChatTab[]} Open tabs, in display order (left to right). */
    this.tabs = [];
    /** @type {number|null} Sentinel ID of the active tab; matches sessionId once saved. */
    this.activeTabKey = null;
    /** Counter used as a sentinel key for tabs that haven't been assigned a sessionId yet. */
    this._tabKeyCounter = -1;

    this._render();
    this._bindEvents();
    this._initContextTooltip();
    this._updateTitle();
  }

  // ── Tab helpers ─────────────────────────────────────────────────────────

  _getActiveTab() {
    if (this.activeTabKey == null) return null;
    return this.tabs.find(t => this._tabKey(t) === this.activeTabKey) || null;
  }

  _tabKey(tab) {
    return tab.sessionId != null ? tab.sessionId : tab._localKey;
  }

  _findTabBySessionId(sessionId) {
    if (sessionId == null) return null;
    return this.tabs.find(t => t.sessionId === sessionId) || null;
  }

  /**
   * Allocate a per-tab descriptor with sensible defaults. Caller is responsible
   * for appending it to this.tabs and creating its messagesEl.
   * @param {Object} [init]
   * @returns {ChatTab}
   */
  _createTab(init = {}) {
    const tab = {
      sessionId: init.sessionId ?? null,
      _localKey: this._tabKeyCounter--,
      title: init.title || _nextNewTabTitle(),
      // 'pending' = fresh tab, no messages exchanged yet (gray dot).
      // Transitions to 'idle'/'streaming'/'error' once the conversation
      // is underway. See _updateTabStatus for the demote rule.
      status: 'pending',
      errorMessage: null,
      messages: [],
      isStreaming: false,
      streamingContent: '',
      sessionWarm: !!init.sessionWarm,
      provider: init.provider || this._activeProvider,
      model: init.model || null,
      contextSource: null,
      contextItemId: null,
      contextLineMeta: null,
      pendingActionContext: null,
      pendingContext: [],
      pendingContextData: [],
      latestDiffState: init.latestDiffState !== undefined ? init.latestDiffState : (this._initialDiffState || null),
      pendingUserActionHints: [],
      analysisContextRemoved: false,
      sessionAnalysisRunId: null,
      messagesEl: null,
      streamingMsgEl: null,
      userScrolledAway: false,
      wsUnsub: null,
      titleFromUser: false,
      historyLoadPromise: null,
    };
    return tab;
  }

  // ── Per-tab state delegation (SYNC ONLY) ────────────────────────────────
  //
  // These getters/setters forward to the active tab so synchronous helpers
  // (context-card builders, sync handler callers) don't need a tab parameter.
  // SYNC ONLY — do NOT read across awaits. Async code paths (`sendMessage`,
  // `_handleChatMessageForTab`, WS reconnect) capture `tab` at function entry
  // and write through `tab.*` directly.
  //
  // Array-valued state (`tab.messages`, `tab.pendingContext`,
  // `tab.pendingContextData`, `tab.pendingActionContext`,
  // `tab.pendingUserActionHints`) and per-tab snapshot state
  // (`tab.latestDiffState`) are deliberately NOT exposed via shims —
  // callers must use the explicit tab reference to avoid silent cross-tab
  // bleed across awaits.

  get currentSessionId() {
    return this._getActiveTab()?.sessionId ?? null;
  }
  set currentSessionId(v) {
    const tab = this._getActiveTab();
    if (!tab) return;
    const prev = tab.sessionId;
    tab.sessionId = v;
    if (prev !== v) {
      this.activeTabKey = this._tabKey(tab);
      this._renderTabStrip();
    }
  }
  get isStreaming() {
    return this._getActiveTab()?.isStreaming ?? false;
  }
  set isStreaming(v) {
    const tab = this._getActiveTab();
    if (!tab) return;
    tab.isStreaming = v;
    this._updateTabStatus(tab, v ? 'streaming' : (tab.errorMessage ? 'error' : 'idle'));
  }
  get _streamingContent() {
    return this._getActiveTab()?.streamingContent ?? '';
  }
  set _streamingContent(v) {
    const tab = this._getActiveTab();
    if (tab) tab.streamingContent = v;
  }
  get _sessionWarm() {
    return this._getActiveTab()?.sessionWarm ?? false;
  }
  set _sessionWarm(v) {
    const tab = this._getActiveTab();
    if (tab) tab.sessionWarm = v;
  }
  get _contextSource() {
    return this._getActiveTab()?.contextSource ?? null;
  }
  set _contextSource(v) {
    const tab = this._getActiveTab();
    if (tab) tab.contextSource = v;
  }
  get _contextItemId() {
    return this._getActiveTab()?.contextItemId ?? null;
  }
  set _contextItemId(v) {
    const tab = this._getActiveTab();
    if (tab) tab.contextItemId = v;
  }
  get _contextLineMeta() {
    return this._getActiveTab()?.contextLineMeta ?? null;
  }
  set _contextLineMeta(v) {
    const tab = this._getActiveTab();
    if (tab) tab.contextLineMeta = v;
  }
  get _analysisContextRemoved() {
    return this._getActiveTab()?.analysisContextRemoved ?? false;
  }
  set _analysisContextRemoved(v) {
    const tab = this._getActiveTab();
    if (tab) tab.analysisContextRemoved = v;
  }
  get _sessionAnalysisRunId() {
    return this._getActiveTab()?.sessionAnalysisRunId ?? null;
  }
  set _sessionAnalysisRunId(v) {
    const tab = this._getActiveTab();
    if (tab) tab.sessionAnalysisRunId = v;
  }
  get _userScrolledAway() {
    return this._getActiveTab()?.userScrolledAway ?? false;
  }
  set _userScrolledAway(v) {
    const tab = this._getActiveTab();
    if (tab) tab.userScrolledAway = v;
  }
  get messagesEl() {
    return this._getActiveTab()?.messagesEl || null;
  }

  /**
   * Allocate a new <div class="chat-panel__messages"> for a tab and append it
   * into the stack. Hidden by default; _switchToTab toggles the .--active class.
   */
  _createTabMessagesEl(tab) {
    const el = document.createElement('div');
    el.className = 'chat-panel__messages';
    el.dataset.tabKey = String(this._tabKey(tab));
    el.style.display = 'none';
    el.innerHTML = `
      <div class="chat-panel__empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
          <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
        </svg>
        <p>Ask questions about this review, or the changes</p>
      </div>
    `;
    let lastScrollTop = 0;
    el.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const distance = scrollHeight - scrollTop - clientHeight;
      if (scrollTop < lastScrollTop && distance >= NEAR_BOTTOM_THRESHOLD) {
        tab.userScrolledAway = true;
        if (this._getActiveTab() === tab) this._showNewContentPill();
      } else if (distance < NEAR_BOTTOM_THRESHOLD) {
        tab.userScrolledAway = false;
        if (this._getActiveTab() === tab) this._hideNewContentPill();
      }
      lastScrollTop = scrollTop;
    }, { passive: true });
    tab.messagesEl = el;
    return el;
  }

  /**
   * Insert a new tab into the strip and the messages stack.
   * @param {ChatTab} tab
   * @param {{focus?: boolean, position?: number}} [opts]
   */
  _appendTab(tab, { focus = true, position } = {}) {
    const el = this._createTabMessagesEl(tab);
    if (typeof position === 'number' && position < this.tabs.length) {
      this.tabs.splice(position, 0, tab);
    } else {
      this.tabs.push(tab);
    }
    this.messagesStackEl.appendChild(el);
    if (focus) {
      this._switchToTab(this._tabKey(tab));
    } else {
      this._renderTabStrip();
    }
    this._updateNoTabsEmptyState();
    // Persist if the tab already has a sessionId (history-picker restore path).
    // For new tabs that get a session async, persistence fires from the place
    // that assigns sessionId.
    if (tab.sessionId != null) this._persistOpenTabs();
    return tab;
  }

  /**
   * Activate a tab by key. Hides other tabs' message containers without
   * tearing down their state or subscriptions.
   * @param {number} key
   */
  _switchToTab(key) {
    const tab = this.tabs.find(t => this._tabKey(t) === key);
    if (!tab) return;
    if (this.activeTabKey === key && tab.messagesEl?.style.display !== 'none') {
      this._renderTabStrip();
      return;
    }
    this.activeTabKey = key;
    this._persistOpenTabs();
    // Toggle visibility of message containers
    for (const t of this.tabs) {
      if (!t.messagesEl) continue;
      t.messagesEl.style.display = (t === tab) ? '' : 'none';
    }
    // Header should reflect the focused tab's provider/model
    if (tab.provider) {
      this._activeProvider = tab.provider;
      this._updateTitle(tab.provider, tab.model);
    } else {
      this._updateTitle();
    }
    this._renderTabStrip();
    this._updateActionButtons();
    // Adjust send/stop buttons to reflect the new active tab's streaming state
    this.sendBtn.style.display = tab.isStreaming ? 'none' : '';
    this.stopBtn.style.display = tab.isStreaming ? '' : 'none';
    this.sendBtn.disabled = tab.isStreaming || !this.inputEl?.value?.trim();
    // Re-anchor scroll
    if (!tab.userScrolledAway) this.scrollToBottom({ force: true });
  }

  /**
   * Close a tab: kills its bridge, removes its DOM, unsubscribes from its
   * WebSocket topic. If it was active, focuses the rightmost remaining tab
   * (or shows the empty state if none).
   * @param {number} key
   */
  async _closeTab(key) {
    const idx = this.tabs.findIndex(t => this._tabKey(t) === key);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    this._removeTabFromDom(tab);
  }

  /**
   * Remove a tab from the strip and the DOM without contacting the backend.
   * Shared by _closeTab (which additionally fires the DELETE) and the 404
   * branch in _loadMessageHistory (which must NOT, since the session is
   * already gone). Idempotent: a no-op for tabs that have already been
   * removed.
   *
   * Always preserves the "no tabs left → reset Send/Stop" behavior so the
   * input chrome doesn't get stranded in a streaming state.
   *
   * @param {ChatTab} tab
   * @param {{ skipDelete?: boolean }} [opts]
   */
  _removeTabFromDom(tab, { skipDelete = false } = {}) {
    if (!tab) return;
    const idx = this.tabs.indexOf(tab);
    if (idx === -1) return; // already removed

    const key = this._tabKey(tab);

    // Unsubscribe immediately so we stop receiving events for this session
    if (tab.wsUnsub) { try { tab.wsUnsub(); } catch { /* noop */ } tab.wsUnsub = null; }

    // Fire-and-forget DELETE — server-side closeSession is idempotent
    if (!skipDelete && tab.sessionId != null) {
      fetch(`/api/chat/session/${tab.sessionId}`, { method: 'DELETE' })
        .catch(err => console.warn('[ChatPanel] Failed to close session:', err));
    }

    // Remove the DOM container
    if (tab.messagesEl?.parentNode) {
      tab.messagesEl.parentNode.removeChild(tab.messagesEl);
    }

    // Remove from the array
    this.tabs.splice(idx, 1);
    this._persistOpenTabs();

    if (this.activeTabKey === key) {
      // Focus the tab to the right (or last) if any remain
      const next = this.tabs[idx] || this.tabs[idx - 1] || this.tabs[this.tabs.length - 1] || null;
      if (next) {
        this._switchToTab(this._tabKey(next));
      } else {
        this.activeTabKey = null;
        this._renderTabStrip();
        this._updateNoTabsEmptyState();
        this._updateTitle();
        this._updateActionButtons();
        this.sendBtn.style.display = '';
        this.stopBtn.style.display = 'none';
        this.sendBtn.disabled = true;
      }
    } else {
      this._renderTabStrip();
    }
  }

  /**
   * Render or re-render the tab strip from this.tabs.
   */
  _renderTabStrip() {
    if (!this.tabStripItemsEl) return;
    if (this.tabs.length === 0) {
      this.tabStripItemsEl.innerHTML = '';
      this.tabStripEl.classList.add('chat-panel__tab-strip--empty');
      return;
    }
    this.tabStripEl.classList.remove('chat-panel__tab-strip--empty');
    const items = this.tabs.map((tab) => {
      const key = this._tabKey(tab);
      const isActive = key === this.activeTabKey;
      const dotClass = `chat-panel__tab-dot chat-panel__tab-dot--${tab.status || 'idle'}`;
      const tooltip = tab.errorMessage
        ? `${this._escapeAttr(tab.title)} (error: ${this._escapeAttr(tab.errorMessage)})`
        : this._escapeAttr(tab.title);
      const sessionIdAttr = tab.sessionId != null ? ` data-session-id="${tab.sessionId}"` : '';
      return `
        <div class="chat-panel__tab${isActive ? ' chat-panel__tab--active' : ''}"
             role="tab"
             data-tab-key="${key}"${sessionIdAttr}
             title="${tooltip}">
          <span class="${dotClass}" aria-hidden="true"></span>
          <span class="chat-panel__tab-title">${this._escapeHtml(tab.title)}</span>
          <button class="chat-panel__tab-close" title="Close conversation" data-tab-key="${key}" aria-label="Close conversation">
            <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>
          </button>
        </div>
      `;
    }).join('');
    this.tabStripItemsEl.innerHTML = items;
    // Bind click handlers
    this.tabStripItemsEl.querySelectorAll('.chat-panel__tab').forEach((el) => {
      const key = parseInt(el.dataset.tabKey, 10);
      el.addEventListener('click', (e) => {
        if (e.target.closest('.chat-panel__tab-close')) return;
        this._switchToTab(key);
      });
    });
    this.tabStripItemsEl.querySelectorAll('.chat-panel__tab-close').forEach((btn) => {
      const key = parseInt(btn.dataset.tabKey, 10);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeTab(key);
      });
    });
  }

  /**
   * Update a tab's status (and its dot in the strip).
   * @param {ChatTab} tab
   * @param {'pending'|'idle'|'streaming'|'error'} status
   */
  _updateTabStatus(tab, status) {
    if (!tab) return;
    if (status === 'idle') tab.errorMessage = null;
    // A tab with no exchanged messages stays in the 'pending' (gray) state
    // even when callers request 'idle' — the conversation hasn't started yet,
    // so the active-affordance blue would over-signal. 'streaming' and
    // 'error' always win.
    if (status === 'idle' && (tab.messages?.length ?? 0) === 0) {
      status = 'pending';
    }
    tab.status = status;
    if (this.tabStripItemsEl) {
      const dot = this.tabStripItemsEl.querySelector(`.chat-panel__tab[data-tab-key="${this._tabKey(tab)}"] .chat-panel__tab-dot`);
      if (dot) {
        dot.className = `chat-panel__tab-dot chat-panel__tab-dot--${status}`;
      }
    }
  }

  /**
   * Update a tab's title (and re-render the strip).
   * @param {ChatTab} tab
   * @param {string} title
   */
  _setTabTitle(tab, title) {
    if (!tab || !title) return;
    tab.title = title;
    if (this.tabStripItemsEl) {
      const titleEl = this.tabStripItemsEl.querySelector(`.chat-panel__tab[data-tab-key="${this._tabKey(tab)}"] .chat-panel__tab-title`);
      if (titleEl) titleEl.textContent = title;
      const tabEl = this.tabStripItemsEl.querySelector(`.chat-panel__tab[data-tab-key="${this._tabKey(tab)}"]`);
      if (tabEl) tabEl.title = this._escapeAttr(title);
    }
  }

  /**
   * Show or hide the "no tabs open" empty state.
   */
  _updateNoTabsEmptyState() {
    const noTabsEmpty = this.messagesStackEl?.querySelector('.chat-panel__empty--no-tabs');
    if (!noTabsEmpty) return;
    noTabsEmpty.style.display = this.tabs.length === 0 ? '' : 'none';
  }

  // ── Persistence (open tabs in localStorage) ────────────────────────────
  //
  // Per-review key holds an ordered list of session IDs plus the active one.
  // Format: { version: 1, tabs: [sessionId, ...], activeSessionId: number|null }
  // Writes are debounced (100ms trailing) to coalesce bursts during open/restore.
  // Reads/writes are wrapped in try/catch — localStorage failures are soft.

  _chatTabsStorageKey() {
    if (!this.reviewId) return null;
    return `pair-review:chat-tabs:${this.reviewId}`;
  }

  /**
   * Serialize open tabs and schedule a write. Only tabs with a saved sessionId
   * are persisted — unsaved (just-opened, pre-session) tabs are ignored.
   */
  _persistOpenTabs() {
    const key = this._chatTabsStorageKey();
    if (!key) return;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
    }
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        const ids = this.tabs.map(t => t.sessionId).filter(id => id != null);
        if (ids.length === 0) {
          window.localStorage.removeItem(key);
          return;
        }
        const active = this._getActiveTab();
        const activeSessionId = active?.sessionId ?? null;
        const payload = { version: 1, tabs: ids, activeSessionId };
        window.localStorage.setItem(key, JSON.stringify(payload));
      } catch (err) {
        console.warn('[ChatPanel] Failed to persist open tabs:', err);
      }
    }, 100);
  }

  /**
   * Read the persisted tab list for the current reviewId. Returns null when
   * absent, malformed, or the wrong shape.
   * @returns {{ tabs: number[], activeSessionId: number|null }|null}
   */
  _loadPersistedTabs() {
    const key = this._chatTabsStorageKey();
    if (!key) return null;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tabs)) return null;
      const tabs = parsed.tabs
        .map(n => parseInt(n, 10))
        .filter(n => Number.isFinite(n));
      if (tabs.length === 0) return null;
      const active = Number.isFinite(parsed.activeSessionId)
        ? parseInt(parsed.activeSessionId, 10)
        : null;
      return { tabs, activeSessionId: active };
    } catch (err) {
      console.warn('[ChatPanel] Failed to read persisted tabs:', err);
      return null;
    }
  }

  /**
   * Restore tabs from a persisted descriptor. Fetches session metadata from
   * the review's sessions list (for first-message titles, provider, model)
   * and renders each tab. Stale session IDs (404 from messages endpoint) are
   * silently dropped and the storage entry is rewritten without them.
   *
   * Returns true if at least one tab was restored.
   *
   * @param {{ tabs: number[], activeSessionId: number|null }} saved
   * @returns {Promise<boolean>}
   */
  async _restoreTabs(saved) {
    if (!saved || !this.reviewId) return false;

    // Fetch all sessions for this review once for metadata lookup
    const sessions = await this._fetchSessions();
    const sessionById = new Map(sessions.map(s => [s.id, s]));

    const surviving = [];
    for (const sid of saved.tabs) {
      const meta = sessionById.get(sid);
      // If the session doesn't appear in the sessions list, it's been deleted
      // out-of-band. Skip it — it'll be pruned from storage by the write at
      // the end of this function.
      if (!meta) continue;

      const tab = this._createTab({
        sessionId: sid,
        provider: meta.provider || this._activeProvider,
        model: meta.model || null,
        sessionWarm: false,
      });
      if (meta.first_message) {
        tab.title = this._truncate(meta.first_message, 28);
        tab.titleFromUser = true;
      }
      // Append without focus — we focus the chosen tab in one go below
      this._appendTab(tab, { focus: false });
      this._subscribeTab(tab);

      // Load history without blocking other tabs — race-guarded load knows how
      // to discard responses that arrive after the tab has been closed/swapped.
      // Track the in-flight promise on the tab so sendMessage can await before
      // mutating its message list.
      if (meta.message_count > 0) {
        const p = this._loadMessageHistory(sid, tab)
          .catch(err => console.warn('[ChatPanel] Restore: history load failed for', sid, err))
          .finally(() => {
            if (tab.historyLoadPromise === p) tab.historyLoadPromise = null;
          });
        tab.historyLoadPromise = p;
      }

      surviving.push({ tab, meta });
    }

    if (surviving.length === 0) return false;

    // Choose which tab gets focus: prefer the saved activeSessionId, else
    // the rightmost restored tab.
    let focusTab = null;
    if (saved.activeSessionId != null) {
      const found = surviving.find(s => s.meta.id === saved.activeSessionId);
      if (found) focusTab = found.tab;
    }
    if (!focusTab) focusTab = surviving[surviving.length - 1].tab;
    this._switchToTab(this._tabKey(focusTab));

    // Re-persist to prune any stale IDs that were dropped above
    this._persistOpenTabs();

    // Await the focused tab's history before returning so the panel doesn't
    // expose an empty conversation to the user mid-load.
    if (focusTab.historyLoadPromise) {
      try { await focusTab.historyLoadPromise; } catch { /* swallow */ }
    }
    // A 404 in _loadMessageHistory silently closes the tab via the in-line
    // removal path. If the focused tab was the casualty (or every tab was),
    // signal failure so the caller falls through to _loadMRUSession.
    if (this.tabs.length === 0 || !this.tabs.includes(focusTab)) {
      return false;
    }
    return true;
  }

  /**
   * Escape a string for safe use in an HTML attribute value.
   */
  _escapeAttr(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Open a fresh tab and focus it. Does NOT eagerly POST to the backend —
   * the session is lazily created on first send by sendMessage. Side effects:
   *   - Allocates a tab descriptor with sessionId=null.
   *   - Appends it to the strip and focuses it.
   *   - Surfaces analysis context (when one is available locally) so the user
   *     sees the card before they ever type a message.
   * @returns {Promise<void>}
   */
  async _openNewTab() {
    if (!this.reviewId) {
      console.warn('[ChatPanel] _openNewTab: no reviewId yet');
      return;
    }
    const tab = this._createTab({ provider: this._activeProvider });
    this._appendTab(tab, { focus: true });
    // No session yet, so _showAnalysisContextIfPresent gets a null sessionData.
    // We still want the auto-detected analysis card surfaced on the fresh tab
    // — that's what _ensureAnalysisContext handles. Route it through the
    // captured tab so a focus change can't bleed the card elsewhere.
    this._ensureAnalysisContext(tab);
    if (this.isOpen) this.inputEl?.focus();
  }

  /**
   * Create a backend chat session bound to a specific tab. Subscribes the tab
   * to its session's WebSocket topic and updates the tab's sessionId.
   * @param {ChatTab} tab
   * @returns {Promise<Object|null>}
   */
  async _createSessionForTab(tab) {
    if (!this.reviewId) return null;
    if (!tab) return null;
    // Capture the provider at entry. If the user swaps providers on this tab
    // while the POST is in flight, the response describes a session for the
    // wrong provider — we must abandon it and let the next send (with the new
    // provider) start fresh.
    const capturedProvider = tab.provider;
    const isAcp = this._getProviderType(capturedProvider) === 'acp';
    if (isAcp) this._showStatusFlash('Starting Agent Client Protocol');
    try {
      const body = { provider: capturedProvider, reviewId: this.reviewId };
      if (tab.analysisContextRemoved) body.skipAnalysisContext = true;
      const response = await fetch('/api/chat/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (isAcp) this._hideStatusFlash();
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create chat session');
      }
      const result = await response.json();
      // The tab may have been closed while the POST was in flight. Hand the
      // server-side session back so it can be cleaned up, and bail.
      if (!this.tabs.includes(tab)) {
        fetch(`/api/chat/session/${result.data.id}`, { method: 'DELETE' }).catch(() => {});
        return null;
      }
      // Provider was swapped between our captured snapshot and the response.
      // The session belongs to capturedProvider — let it be cleaned up and
      // signal failure so the caller's lazy-create path can retry under the
      // new provider.
      if (tab.provider !== capturedProvider) {
        fetch(`/api/chat/session/${result.data.id}`, { method: 'DELETE' }).catch(() => {});
        return null;
      }
      tab.sessionId = result.data.id;
      tab.sessionWarm = true;
      if (tab.messagesEl) tab.messagesEl.dataset.tabKey = String(tab.sessionId);
      // Re-key the active marker if this is the focused tab (so getters work)
      if (this.activeTabKey === tab._localKey) this.activeTabKey = tab.sessionId;
      this._subscribeTab(tab);
      this._renderTabStrip();
      this._persistOpenTabs();
      return result.data;
    } catch (error) {
      if (isAcp) this._hideStatusFlash();
      console.error('[ChatPanel] Error creating session:', error);
      this._showError('Failed to start chat session. ' + error.message, tab);
      return null;
    }
  }

  /**
   * Subscribe a tab to its session's WebSocket topic. Idempotent: if a
   * subscription handle already exists, it is left in place.
   * @param {ChatTab} tab
   */
  _subscribeTab(tab) {
    if (!tab || tab.sessionId == null) return;
    if (tab.wsUnsub) return;
    window.wsClient.connect();
    tab.wsUnsub = window.wsClient.subscribe('chat:' + tab.sessionId, (msg) => {
      this._handleChatMessageForTab(tab, msg);
    });
  }

  _getProviderType(providerId) {
    const entry = this._chatProviders.find(p => p.id === providerId);
    return entry?.type;
  }

  /**
   * Render the chat panel DOM structure into the container
   */
  _render() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div id="chat-panel" class="chat-panel chat-panel--closed">
        <div class="chat-panel__resize-handle" title="Drag to resize"></div>
        <div class="chat-panel__header">
          <div class="chat-panel__provider-picker">
            <button class="chat-panel__provider-picker-btn" title="Switch provider">
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/>
              </svg>
              <span class="chat-panel__title-text">Chat &middot; Pi</span>
              <svg class="chat-panel__provider-chevron" viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
                <path d="M4.427 7.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"/>
              </svg>
            </button>
            <div class="chat-panel__provider-dropdown" style="display: none;"></div>
          </div>
          <div class="chat-panel__session-picker">
            <div class="chat-panel__session-dropdown" style="display: none;"></div>
          </div>
          <div class="chat-panel__actions">
            <button class="chat-panel__history-btn" title="Session history">
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="m.427 1.927 1.215 1.215a8.002 8.002 0 1 1-1.6 5.685.75.75 0 1 1 1.493-.154 6.5 6.5 0 1 0 1.18-4.458l1.358 1.358A.25.25 0 0 1 3.896 6H.25A.25.25 0 0 1 0 5.75V2.104a.25.25 0 0 1 .427-.177ZM7.75 4a.75.75 0 0 1 .75.75v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5A.75.75 0 0 1 7.75 4Z"/>
              </svg>
            </button>
            <button class="chat-panel__close-btn" title="Close">
              <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="chat-panel__tab-strip" role="tablist">
          <div class="chat-panel__tab-strip-items"></div>
          <button class="chat-panel__tab-new-btn" title="New conversation">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/>
            </svg>
          </button>
        </div>
        <div class="chat-panel__status-flash" style="display:none">
          <span class="chat-panel__status-flash-text">Starting Agent Client Protocol</span>
        </div>
        <div class="chat-panel__messages-wrapper">
          <div class="chat-panel__messages-stack" id="chat-messages-stack">
            <div class="chat-panel__empty chat-panel__empty--no-tabs">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
                <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
              </svg>
              <p>No conversation open.</p>
              <button class="chat-panel__empty-new-btn">Start a new chat</button>
            </div>
          </div>
          <button class="chat-panel__new-content-pill" style="display:none">\u2193 New content</button>
        </div>
        <div class="chat-panel__action-bar" style="display: none;">
          <button class="chat-panel__action-btn chat-panel__action-btn--adopt" style="display: none;" title="Adopt this suggestion with edits based on the conversation">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
            </svg>
            Adopt with AI edits
          </button>
          <button class="chat-panel__action-btn chat-panel__action-btn--update" style="display: none;" title="Update the comment based on the conversation">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/>
            </svg>
            Update comment
          </button>
          <button class="chat-panel__action-btn chat-panel__action-btn--dismiss-suggestion" style="display: none;" title="Dismiss this AI suggestion">
            ${DISMISS_ICON}
            Dismiss suggestion
          </button>
          <button class="chat-panel__action-btn chat-panel__action-btn--dismiss-comment" style="display: none;" title="Dismiss this comment">
            ${DISMISS_ICON}
            Dismiss comment
          </button>
          <button class="chat-panel__action-btn chat-panel__action-btn--create-comment" style="display: none;" title="Create a review comment for this line">
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
            </svg>
            Create comment
          </button>
          <button class="chat-panel__action-bar-dismiss" title="Dismiss shortcuts">
            ${DISMISS_ICON}
          </button>
        </div>
        <div class="chat-panel__input-area">
          <textarea class="chat-panel__input" placeholder="Ask about this review..." rows="1"></textarea>
          <div class="chat-panel__input-footer">
            <span class="chat-panel__input-hint" title="Configure with chat.enter_to_send">${this._enterToSend ? 'Enter to send, Shift+Enter for newline' : `${typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to send`}</span>
            <div class="chat-panel__input-actions">
              <button class="chat-panel__send-btn" title="Send" disabled>
                <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                  <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.463L.99 8Zm.603-4.776L2.296 7.25h5.954a.75.75 0 0 1 0 1.5H2.296l-.704 4.026L13.788 8Z"/>
                </svg>
              </button>
              <button class="chat-panel__stop-btn" title="Stop" style="display: none;">
                <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                  <path d="M4.5 2A2.5 2.5 0 0 0 2 4.5v7A2.5 2.5 0 0 0 4.5 14h7a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 11.5 2h-7Z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Cache element references
    this.panel = this.container.querySelector('#chat-panel');
    this.messagesStackEl = this.container.querySelector('#chat-messages-stack');
    this.tabStripEl = this.container.querySelector('.chat-panel__tab-strip');
    this.tabStripItemsEl = this.container.querySelector('.chat-panel__tab-strip-items');
    this.tabNewBtn = this.container.querySelector('.chat-panel__tab-new-btn');
    this.inputEl = this.container.querySelector('.chat-panel__input');
    this.sendBtn = this.container.querySelector('.chat-panel__send-btn');
    this.stopBtn = this.container.querySelector('.chat-panel__stop-btn');
    this.closeBtn = this.container.querySelector('.chat-panel__close-btn');
    this.emptyNewBtn = this.container.querySelector('.chat-panel__empty-new-btn');
    this.actionBar = this.container.querySelector('.chat-panel__action-bar');
    this.adoptBtn = this.container.querySelector('.chat-panel__action-btn--adopt');
    this.updateBtn = this.container.querySelector('.chat-panel__action-btn--update');
    this.dismissSuggestionBtn = this.container.querySelector('.chat-panel__action-btn--dismiss-suggestion');
    this.dismissCommentBtn = this.container.querySelector('.chat-panel__action-btn--dismiss-comment');
    this.createCommentBtn = this.container.querySelector('.chat-panel__action-btn--create-comment');
    this.actionBarDismissBtn = this.container.querySelector('.chat-panel__action-bar-dismiss');
    this.providerPickerEl = this.container.querySelector('.chat-panel__provider-picker');
    this.providerPickerBtn = this.container.querySelector('.chat-panel__provider-picker-btn');
    this.providerDropdown = this.container.querySelector('.chat-panel__provider-dropdown');
    this.sessionPickerEl = this.container.querySelector('.chat-panel__session-picker');
    this.sessionDropdown = this.container.querySelector('.chat-panel__session-dropdown');
    this.historyBtn = this.container.querySelector('.chat-panel__history-btn');
    this.titleTextEl = this.container.querySelector('.chat-panel__title-text');
    this.newContentPill = this.container.querySelector('.chat-panel__new-content-pill');
    this.statusFlash = this.container.querySelector('.chat-panel__status-flash');
  }

  /**
   * Bind event listeners
   */
  _bindEvents() {
    if (!this.panel) return;

    // Close button
    this.closeBtn.addEventListener('click', () => this.close());

    // New tab button (in tab strip)
    this.tabNewBtn?.addEventListener('click', () => this._openNewTab());
    this.emptyNewBtn?.addEventListener('click', () => this._openNewTab());

    // Provider picker button
    this.providerPickerBtn.addEventListener('click', () => this._toggleProviderDropdown());

    // Session history button
    this.historyBtn.addEventListener('click', () => this._toggleSessionDropdown());

    // Send button
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    // Stop button
    this.stopBtn.addEventListener('click', () => this._stopAgent());

    // Action buttons
    this.adoptBtn.addEventListener('click', () => this._handleAdoptClick());
    this.updateBtn.addEventListener('click', () => this._handleUpdateClick());
    this.dismissSuggestionBtn.addEventListener('click', () => this._handleDismissSuggestionClick());
    this.dismissCommentBtn.addEventListener('click', () => this._handleDismissCommentClick());
    this.createCommentBtn.addEventListener('click', () => this._handleCreateCommentClick());
    this.actionBarDismissBtn.addEventListener('click', () => this._handleActionBarDismiss());

    // New-content pill: click to scroll to bottom
    if (this.newContentPill) {
      this.newContentPill.addEventListener('click', () => this.scrollToBottom({ force: true }));
    }

    // Textarea input handling
    this.inputEl.addEventListener('input', () => {
      this._autoResizeTextarea();
      this.sendBtn.disabled = !this.inputEl.value.trim() || this.isStreaming;
    });

    // Keyboard shortcuts
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // Ignore Enter during IME composition (e.g. CJK input) so the
        // composition-confirming keystroke is not swallowed.
        if (e.isComposing) return;

        if (this._enterToSend) {
          // Enter sends, Shift+Enter inserts newline
          if (e.shiftKey) return; // let browser insert newline
          e.preventDefault();
          if (this.inputEl.value.trim() && !this.isStreaming) {
            this.sendMessage();
          }
        } else {
          // Cmd+Enter / Ctrl+Enter sends, plain Enter inserts newline
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            if (this.inputEl.value.trim() && !this.isStreaming) {
              this.sendMessage();
            }
          }
        }
      }
    });

    // Escape: close dropdown if open, stop agent if streaming, blur textarea if focused, otherwise close panel
    this._onKeydown = (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        if (this._isProviderDropdownOpen()) {
          this._hideProviderDropdown();
        } else if (this._isSessionDropdownOpen()) {
          this._hideSessionDropdown();
        } else if (this.isStreaming) {
          this._stopAgent();
        } else if (document.activeElement === this.inputEl) {
          this.inputEl.blur();
        } else {
          this.close();
        }
      }
    };
    document.addEventListener('keydown', this._onKeydown);

    // Chat file link click handler (event delegation on the per-tab stack)
    this.messagesStackEl?.addEventListener('click', (e) => {
      const link = e.target.closest('.chat-file-link');
      if (link) {
        e.preventDefault();
        this._handleFileLinkClick(link);
      }
    });

    // Re-read chat providers once the <head> config fetch resolves
    this._onChatStateChanged = () => {
      this._chatProviders = window.__pairReview?.chatProviders || [];
      this._updateTitle();
    };
    window.addEventListener('chat-state-changed', this._onChatStateChanged);

    this._bindResizeEvents();
  }

  /**
   * Bind resize drag events on the left edge handle
   */
  _bindResizeEvents() {
    const handle = this.panel.querySelector('.chat-panel__resize-handle');
    if (!handle) return;

    const { min, storageKey } = this._resizeConfig;

    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e) => {
      // Compute dynamic max: leave room for the sidebar and a minimum content area
      const sidebarWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || 260;
      const dynamicMax = window.innerWidth - sidebarWidth - 100;

      // Panel is right-anchored, so dragging left (decreasing clientX) should increase width
      const delta = startX - e.clientX;
      const newWidth = Math.max(min, Math.min(dynamicMax, startWidth + delta));
      document.documentElement.style.setProperty('--chat-panel-width', newWidth + 'px');
    };

    const onMouseUp = () => {
      // Persist the final width
      const finalWidth = this.panel.getBoundingClientRect().width;
      localStorage.setItem(storageKey, Math.round(finalWidth));

      handle.classList.remove('dragging');
      this.panel.classList.remove('chat-panel--resizing');
      document.body.classList.remove('resizing');

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Notify PanelGroup so --right-panel-group-width stays in sync
      window.panelGroup?._updateRightPanelGroupWidth();
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = this.panel.getBoundingClientRect().width;

      handle.classList.add('dragging');
      this.panel.classList.add('chat-panel--resizing');
      document.body.classList.add('resizing');

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  /**
   * Auto-resize textarea based on content.
   * Grows with content up to maxHeight, then switches to scrollable overflow.
   * Shrinks back down when content is deleted.
   */
  _autoResizeTextarea() {
    const el = this.inputEl;
    const maxHeight = 120;

    // Collapse to auto so scrollHeight reflects actual content height
    el.style.height = 'auto';
    el.style.overflowY = 'hidden';

    const contentHeight = el.scrollHeight;
    if (contentHeight > maxHeight) {
      el.style.height = maxHeight + 'px';
      el.style.overflowY = 'auto';
    } else {
      el.style.height = contentHeight + 'px';
    }
  }

  /**
   * Disable chat input and send button (e.g. while reviewId is unavailable).
   * Saves the original placeholder so _enableInput() can restore it.
   */
  _disableInput() {
    this._savedPlaceholder = this.inputEl.placeholder;
    this.inputEl.disabled = true;
    this.inputEl.placeholder = 'Connecting to review\u2026';
    this.sendBtn.disabled = true;
  }

  /**
   * Re-enable chat input and send button after reviewId becomes available.
   * Restores the original placeholder saved by _disableInput().
   */
  _enableInput() {
    this.inputEl.disabled = false;
    this.inputEl.placeholder = this._savedPlaceholder || 'Ask about this review...';
    this._savedPlaceholder = null;
    this.sendBtn.disabled = !this.inputEl.value.trim() || this.isStreaming;
  }

  /**
   * Update the chat panel title with provider and model info.
   * @param {string} [providerId] - Provider ID (looked up in _chatProviders for display name)
   * @param {string} [model] - Model ID or display name (e.g. 'default', 'multi-model')
   */
  _updateTitle(providerId, model) {
    if (!this.titleTextEl) return;
    const providerName = this._getProviderDisplayName(providerId || this._activeProvider);
    const modelDisplay = model
      ? model.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      : null;
    const parts = ['Chat', providerName];
    if (modelDisplay) parts.push(modelDisplay);
    this.titleTextEl.textContent = parts.join(' \u00b7 ');
  }

  /**
   * Get display name for a provider ID from the _chatProviders array.
   * Falls back to capitalized provider ID if not found.
   * @param {string} providerId
   * @returns {string}
   */
  _getProviderDisplayName(providerId) {
    const entry = this._chatProviders.find(p => p.id === providerId);
    if (entry) return entry.name;
    return providerId.charAt(0).toUpperCase() + providerId.slice(1);
  }

  /**
   * Check if the active provider uses ACP (Agent Client Protocol).
   * @returns {boolean}
   */
  _isAcpProvider() {
    const entry = this._chatProviders.find(p => p.id === this._activeProvider);
    return entry?.type === 'acp';
  }

  /**
   * Show a transient status flash pill (e.g. "Starting Agent Client Protocol").
   * Auto-hides after the given timeout.
   * @param {string} text - Text to display
   * @param {number} [timeout=5000] - Max display time in ms
   */
  _showStatusFlash(text, timeout = 5000) {
    if (!this.statusFlash) return;
    if (this._hideAnimationTimeout) {
      clearTimeout(this._hideAnimationTimeout);
      this._hideAnimationTimeout = null;
    }
    const textEl = this.statusFlash.querySelector('.chat-panel__status-flash-text');
    if (textEl) textEl.textContent = text;
    this.statusFlash.style.display = '';
    // Force reflow to ensure the fade-in animation triggers
    void this.statusFlash.offsetHeight;
    this.statusFlash.classList.add('chat-panel__status-flash--visible');
    this._statusFlashTimeout = setTimeout(() => this._hideStatusFlash(), timeout);
  }

  /**
   * Hide the status flash pill with a fade-out animation.
   */
  _hideStatusFlash() {
    if (this._statusFlashTimeout) {
      clearTimeout(this._statusFlashTimeout);
      this._statusFlashTimeout = null;
    }
    if (!this.statusFlash) return;
    this.statusFlash.classList.remove('chat-panel__status-flash--visible');
    // Hide after transition completes
    this._hideAnimationTimeout = setTimeout(() => {
      if (this.statusFlash) this.statusFlash.style.display = 'none';
      this._hideAnimationTimeout = null;
    }, 300);
  }

  /**
   * Open the chat panel
   * @param {Object} options - Optional context
   * @param {number} options.reviewId - Review ID
   * @param {number} options.suggestionId - Suggestion ID to ask about
   * @param {Object} options.suggestionContext - AI suggestion details for context
   * @param {Object} options.commentContext - Comment details for context
   * @param {string} options.commentContext.commentId - Comment ID
   * @param {string} options.commentContext.body - Comment body text
   * @param {string} options.commentContext.file - File path
   * @param {number} options.commentContext.line_start - Start line number
   * @param {number} options.commentContext.line_end - End line number
   * @param {string} options.commentContext.source - 'user' for user comments, 'external' for external systems (e.g. GitHub)
   * @param {string} [options.commentContext.externalSource] - When source === 'external', the external system id (e.g. 'github'). Drives theming.
   * @param {string} [options.commentContext.externalUrl] - Permalink to the comment in the external system.
   * @param {boolean} [options.commentContext.isOutdated] - Whether the external comment is anchored to an outdated diff position.
   * @param {string} [options.commentContext.author] - External author/username.
   * @param {boolean} options.commentContext.isFileLevel - True if file-level comment
   * @param {Object} options.threadContext - Multi-comment thread context (external systems only)
   * @param {number|string} options.threadContext.rootId - Local id of the thread root
   * @param {string} options.threadContext.source - Always 'external' for now
   * @param {string} options.threadContext.externalSource - e.g. 'github'; drives theming + label
   * @param {string} options.threadContext.file - File path
   * @param {number|null} options.threadContext.line_start - Start line (null if outdated)
   * @param {number|null} options.threadContext.line_end - End line (null if outdated)
   * @param {Array<Object>} options.threadContext.comments - Ordered comments in the thread
   * @param {string|null} options.threadContext.comments[].author - Author name
   * @param {string} options.threadContext.comments[].body - Comment markdown
   * @param {boolean} options.threadContext.comments[].isOutdated - Whether this comment is outdated
   * @param {string|null} options.threadContext.comments[].externalUrl - Permalink in the source system
   * @param {string|null} options.threadContext.comments[].externalCreatedAt - ISO timestamp of creation
   */
  async open(options = {}) {
    // Concurrency guard: if a previous open() is still loading MRU / messages,
    // wait for it to finish before proceeding.  This prevents a race where a
    // second open() call sees `currentSessionId` already set (by the first
    // call's _loadMRUSession midway through) and skips MRU loading, causing
    // _ensureAnalysisContext to run before message history is rendered.
    if (this._openPromise) {
      await this._openPromise;
    }

    // Wrap the async body in a tracked promise so subsequent callers can wait
    this._openPromise = this._openInner(options);
    try {
      await this._openPromise;
    } finally {
      this._openPromise = null;
    }
  }

  /**
   * Inner implementation of open(), separated so the concurrency guard in
   * open() can track the full async lifecycle.
   * @param {Object} options - Same options as open()
   */
  async _openInner(options) {
    // Resolve reviewId from options or from prManager
    if (options.reviewId) {
      this.reviewId = options.reviewId;
    } else if (window.prManager?.currentPR?.id) {
      this.reviewId = window.prManager.currentPR.id;
    }

    // Restore persisted width before opening (mirrors AIPanel.expand pattern)
    const { min, default: defaultWidth, storageKey } = this._resizeConfig;
    const savedWidth = localStorage.getItem(storageKey);
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      if (width >= min) {
        document.documentElement.style.setProperty('--chat-panel-width', width + 'px');
      } else {
        document.documentElement.style.setProperty('--chat-panel-width', defaultWidth + 'px');
      }
    } else {
      document.documentElement.style.setProperty('--chat-panel-width', defaultWidth + 'px');
    }

    this.isOpen = true;
    this.panel.classList.remove('chat-panel--closed');
    this.panel.classList.add('chat-panel--open');

    // Ensure review-scope subscription is active. Per-tab subscriptions are
    // attached as tabs are created/restored.
    this._ensureSubscriptions();

    // Recognise thread context (external systems) and tour context alongside
    // suggestion / user comment / file when deciding whether to open with
    // explicit context.
    const hasExplicitContext = !!(
      options.suggestionContext ||
      options.commentContext ||
      options.threadContext ||
      options.fileContext ||
      options.tourContext
    );

    // First-time open behaviour:
    //   1. If localStorage has a tab list for this review, restore those tabs.
    //   2. Else, fall back to the legacy single-tab + MRU-load path.
    // Explicit context (Ask about this / Chat about this file) lands in the
    // currently-active tab — the user is augmenting the conversation they're
    // already in. Only spin up a fresh tab when there isn't one yet.
    if (this.tabs.length === 0) {
      let restored = false;
      if (this.reviewId && !hasExplicitContext) {
        const saved = this._loadPersistedTabs();
        if (saved) {
          restored = await this._restoreTabs(saved);
        }
      }
      if (!restored) {
        const tab = this._createTab({ provider: this._activeProvider });
        this._appendTab(tab, { focus: true });
        if (!hasExplicitContext) {
          await this._loadMRUSession();
        }
      }
    }

    // Resync the Send/Stop controls from the active tab's streaming state on
    // every open so a reopen mid-stream shows the Stop button.
    const activeOnOpen = this._getActiveTab();
    if (activeOnOpen) {
      this.sendBtn.style.display = activeOnOpen.isStreaming ? 'none' : '';
      this.stopBtn.style.display = activeOnOpen.isStreaming ? '' : 'none';
      this.sendBtn.disabled = activeOnOpen.isStreaming || !this.inputEl?.value?.trim();
    }

    // Ensure analysis context is added on every expand — not just when opening
    // with suggestion/comment context. This detects new analysis runs that
    // completed while the panel was closed and adds them as pending context.
    this._ensureAnalysisContext();

    // If opening with suggestion context, inject it as a context card
    if (options.suggestionContext) {
      this._sendContextMessage(options.suggestionContext);
      this._contextSource = 'suggestion';
      this._contextItemId = options.suggestionId || null;
    } else if (options.commentContext) {
      // If opening with user comment context, inject it as a context card
      this._sendCommentContextMessage(options.commentContext);
      if (options.commentContext.type === 'line') {
        this._contextSource = 'line';
        this._contextItemId = null;
        this._contextLineMeta = {
          file: options.commentContext.file,
          line_start: options.commentContext.line_start,
          line_end: options.commentContext.line_end,
        };
      } else if (options.commentContext.source === 'external') {
        // External comments are read-only — no adopt/update/dismiss actions
        this._contextSource = 'external-comment';
        this._contextItemId = options.commentContext.commentId || null;
      } else {
        this._contextSource = 'user';
        this._contextItemId = options.commentContext.commentId || null;
      }
    } else if (options.threadContext) {
      // If opening with thread context (external systems only), inject as a card
      this._sendThreadContextMessage(options.threadContext);
      this._contextSource = 'external-thread';
      this._contextItemId = options.threadContext.rootId || null;
    } else if (options.fileContext) {
      // If opening with file context, inject it as a context card
      this._sendFileContextMessage(options.fileContext);
      this._contextSource = 'file';
      this._contextItemId = null;
    } else if (options.tourContext) {
      // If opening with tour-stop context, inject it as a context card.
      // Awaited because tour stops on context files (outside the PR diff)
      // need an async file-content fetch to populate the snippet.
      await this._sendTourContextMessage(options.tourContext);
      this._contextSource = 'tour';
      this._contextItemId = options.tourContext.stopIndex != null
        ? String(options.tourContext.stopIndex)
        : null;
    }

    // Gate input when reviewId is not yet available (PanelGroup auto-restore race)
    if (!this.reviewId) {
      this._disableInput();
    }

    this._updateActionButtons();
    window.panelGroup?._onChatVisibilityChanged(true);
    if (!options.suppressFocus) {
      this.inputEl.focus();
    }
  }

  /**
   * Close the chat panel
   */
  close() {
    this._hideProviderDropdown();
    this._hideSessionDropdown();
    // Reset UI streaming state (buttons) but keep isStreaming and _streamingContent
    // intact so the background WebSocket handler can continue accumulating events.
    this.sendBtn.style.display = '';
    this.stopBtn.style.display = 'none';
    this.sendBtn.disabled = !this.inputEl?.value?.trim();

    this.isOpen = false;
    this.panel.classList.remove('chat-panel--open');
    this.panel.classList.add('chat-panel--closed');
    const closeTab = this._getActiveTab();
    if (closeTab) {
      closeTab.pendingContext = [];
      closeTab.pendingContextData = [];
      closeTab.contextSource = null;
      closeTab.contextItemId = null;
      closeTab.contextLineMeta = null;
    }
    // Zero out CSS variable so max-width calcs don't reserve space (mirrors AIPanel.collapse)
    document.documentElement.style.setProperty('--chat-panel-width', '0px');
    // Preserve _analysisContextRemoved and _sessionAnalysisRunId across
    // close/reopen so _ensureAnalysisContext can detect NEW runs on the next
    // expand. These are reset by _startNewConversation() or when a new run
    // is detected in _ensureAnalysisContext().
    window.panelGroup?._onChatVisibilityChanged(false);
  }

  /**
   * Toggle panel visibility
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Start a new conversation by opening a fresh tab.
   * Unlike the legacy single-tab implementation this no longer destroys the
   * current conversation — it simply adds a new tab and focuses it. Any
   * unsent pending context is left on the previous tab.
   */
  async _startNewConversation() {
    this._hideProviderDropdown();
    this._hideSessionDropdown();
    // Multi-chat replaces the legacy in-place reset with a fresh tab; the
    // per-tab restore path inside _appendTab handles context cards
    // (including thread cards introduced by external-comments) so the
    // savedContext / ctxData.type === 'thread' branch is no longer needed
    // at this entry point.
    await this._openNewTab();
  }

  /**
   * Fetch sessions for the current review.
   * Extracted from _loadMRUSession for reuse by the session picker dropdown.
   * @returns {Promise<Array>} Array of session objects with message_count and first_message
   */
  async _fetchSessions() {
    if (!this.reviewId) return [];
    try {
      const response = await fetch(`/api/review/${this.reviewId}/chat/sessions`);
      if (!response.ok) return [];
      const result = await response.json();
      return result.data?.sessions || [];
    } catch (err) {
      console.warn('[ChatPanel] Failed to fetch sessions:', err);
      return [];
    }
  }

  /**
   * Load the most recently used session into the active tab.
   * Picks the first session (MRU) and loads its message history. Assumes the
   * caller has already created an active tab via _appendTab().
   */
  async _loadMRUSession() {
    const tab = this._getActiveTab();
    if (!tab || !this.reviewId) return;
    // Capture the messagesEl reference for the race-guard after the fetch.
    const capturedEl = tab.messagesEl;

    try {
      const sessions = await this._fetchSessions();
      if (sessions.length === 0) return;

      // Race guard: by the time _fetchSessions resolved, the user may have
      // closed this tab or swapped its session. If anything looks stale,
      // abandon the load.
      if (!this.tabs.includes(tab)) return;
      if (tab.sessionId != null) return; // tab was assigned a session by another path
      if (tab.messagesEl !== capturedEl) return;
      if (!capturedEl?.isConnected) return;

      // Skip MRU candidates already open in another tab — picking one would
      // create a duplicate. Walk down the list (most-recent first) until we
      // find one that no surviving tab is bound to.
      let mru = null;
      for (const candidate of sessions) {
        if (!this._findTabBySessionId(candidate.id)) {
          mru = candidate;
          break;
        }
      }
      if (!mru) {
        // Every recent session is already open — focus the most recent one
        // and drop the empty placeholder so we don't litter the strip.
        const firstOpen = this._findTabBySessionId(sessions[0].id);
        if (firstOpen && firstOpen !== tab) {
          this._switchToTab(this._tabKey(firstOpen));
          // The placeholder may be the originating `tab`. Remove it so the
          // user doesn't see an empty extra tab alongside the focused one.
          if (this.tabs.includes(tab) && tab.sessionId == null) {
            this._removeTabFromDom(tab, { skipDelete: true });
          }
        }
        return;
      }

      tab.sessionId = mru.id;
      // Re-key the active marker only if this tab is still the active one
      // (don't yank focus from a tab the user switched to during the fetch).
      const wasActive = this.activeTabKey === tab._localKey;
      if (wasActive) this.activeTabKey = mru.id;
      tab.sessionWarm = false;
      if (tab.messagesEl) tab.messagesEl.dataset.tabKey = String(tab.sessionId);
      this._subscribeTab(tab);
      this._persistOpenTabs();
      console.debug('[ChatPanel] Loaded MRU session:', mru.id, 'messages:', mru.message_count);

      if (mru.provider) {
        tab.provider = mru.provider;
        tab.model = mru.model;
        // Only update the global header/active provider when this tab is in the
        // foreground; otherwise a stale MRU load would yank the header out from
        // under the user's currently focused tab.
        if (this._getActiveTab() === tab) {
          this._activeProvider = mru.provider;
          this._updateTitle(mru.provider, mru.model);
        }
      }

      // Title heuristic: prefer first user message preview if available
      if (mru.first_message) {
        tab.titleFromUser = true;
        this._setTabTitle(tab, this._truncate(mru.first_message, 28));
      } else {
        this._setTabTitle(tab, tab.title);
      }
      this._renderTabStrip();

      if (mru.message_count > 0) {
        await this._loadMessageHistory(mru.id, tab);
      }
    } catch (err) {
      console.warn('[ChatPanel] Failed to load MRU session:', err);
    }
  }

  /**
   * Load and render message history for a session.
   * Fetches messages from the API and renders context cards and message bubbles.
   *
   * Race-safe: captures the target tab at call time. If the response arrives
   * after the user switched tabs, closed this tab, or swapped its session via
   * the history picker, the write is abandoned and the response is discarded.
   *
   * Stale-tolerant: a 404 (session deleted out-of-band) prunes the tab from
   * the persisted list and silently closes it. Other errors are warned.
   *
   * @param {number} sessionId - Session ID to fetch messages for
   * @param {ChatTab} [targetTab] - Tab to render into. Defaults to the active
   *   tab at call time. Tests + the restore path pass this explicitly so the
   *   tab is not derived from the active-tab getter.
   */
  async _loadMessageHistory(sessionId, targetTab) {
    const tab = targetTab || this._getActiveTab();
    if (!tab) return;
    // Capture the messagesEl reference at call time. If the tab is later
    // closed, messagesEl is detached from the DOM — we check via isConnected
    // before writing.
    const capturedEl = tab.messagesEl;
    if (!capturedEl) return;

    let response;
    try {
      response = await fetch(`/api/chat/session/${sessionId}/messages`);
    } catch (err) {
      console.warn('[ChatPanel] Failed to load message history:', err);
      return;
    }

    // Stale-session tolerance: the session was deleted out-of-band.
    if (response.status === 404) {
      // Apply the same captured-tab guards as the success branch below — the
      // tab may have been closed, repointed to a different session, or had
      // its messagesEl re-created while the request was in flight.
      if (!this.tabs.includes(tab)) return;
      if (tab.sessionId !== sessionId) return;
      if (tab.messagesEl !== capturedEl) return;
      if (!capturedEl.isConnected) return;
      console.debug('[ChatPanel] Session', sessionId, 'returned 404, removing tab');
      this._removeTabFromDom(tab, { skipDelete: true });
      return;
    }
    if (!response.ok) return;

    let result;
    try {
      result = await response.json();
    } catch (err) {
      console.warn('[ChatPanel] Failed to parse message history:', err);
      return;
    }
    const messages = result.data?.messages || [];
    if (messages.length === 0) return;

    // Race guard: by the time the fetch resolved, the tab may have been
    // closed, had its session swapped via the history picker, or had its
    // messagesEl re-created. Bail in any of those cases.
    if (!this.tabs.includes(tab)) return;
    if (tab.sessionId !== sessionId) return;
    if (tab.messagesEl !== capturedEl) return;
    if (!capturedEl.isConnected) return;

    // Remove empty state
    const emptyState = capturedEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Render into the target tab. The helper methods (_addContextCard,
    // addMessage, etc.) read `this.messagesEl` via the active-tab getter, so
    // we temporarily redirect the active marker for the synchronous render
    // loop. _switchToTab toggles visibility — we use a lower-level swap
    // (_renderInTab) so the user's actual focused tab stays focused.
    this._renderInTab(tab, () => {
      for (const msg of messages) {
        if (msg.type === 'context') {
          // Render context card from stored context data
          try {
            const ctxData = JSON.parse(msg.content);
            if (ctxData.type === 'analysis') {
              this._addAnalysisContextCard(ctxData);
            } else if (ctxData.type === 'file') {
              this._addFileContextCard(ctxData);
            } else if (ctxData.type === 'line') {
              this._addLineContextCard(ctxData);
            } else if (ctxData.type === 'comment') {
              this._addCommentContextCard(ctxData);
            } else if (ctxData.type === 'thread') {
              this._addThreadContextCard(ctxData);
            } else {
              this._addContextCard(ctxData);
            }
          } catch {
            // Not JSON — skip malformed context
          }
        } else if (msg.type === 'message') {
          this.addMessage(msg.role, msg.content, msg.id);
        }
      }
    });

    // The tab was initialized as 'pending' (gray dot) before history loaded.
    // Now that messages exist, promote to 'idle' (blue dot) — but don't
    // override a streaming/error state that may have started up in parallel.
    if (tab.status === 'pending' && tab.messages.length > 0) {
      this._updateTabStatus(tab, 'idle');
    }
  }

  /**
   * Synchronously run a render block as if `tab` were the active tab so the
   * shared render helpers (which read `this.messagesEl` via the active-tab
   * getter) write into the right per-tab container. Restores the original
   * active marker after the block.
   *
   * Strictly synchronous: do not pass an async function here. The visible
   * focused tab is preserved because we touch only `activeTabKey`, not the
   * DOM visibility toggles in `_switchToTab`.
   *
   * @param {ChatTab} tab - The tab to render into
   * @param {Function} fn - Synchronous render callback
   */
  _renderInTab(tab, fn) {
    if (!tab) return;
    const prev = this.activeTabKey;
    const key = this._tabKey(tab);
    if (prev === key) {
      fn();
      return;
    }
    this.activeTabKey = key;
    try {
      fn();
    } finally {
      this.activeTabKey = prev;
    }
  }

  // ── Provider picker dropdown ──────────────────────────────────────────

  _isProviderDropdownOpen() {
    return this.providerDropdown && this.providerDropdown.style.display !== 'none';
  }

  _toggleProviderDropdown() {
    if (this._isProviderDropdownOpen()) {
      this._hideProviderDropdown();
    } else {
      this._showProviderDropdown();
    }
  }

  _showProviderDropdown() {
    if (!this.providerDropdown) return;
    // Close session dropdown if open
    this._hideSessionDropdown();

    this._renderProviderDropdown();
    this.providerDropdown.style.display = '';
    this.providerPickerBtn.classList.add('chat-panel__provider-picker-btn--open');

    // Bind outside-click-to-close (one-shot)
    this._providerOutsideClickHandler = (e) => {
      if (!this.providerPickerEl.contains(e.target)) {
        this._hideProviderDropdown();
      }
    };
    setTimeout(() => {
      document.addEventListener('click', this._providerOutsideClickHandler);
    }, 0);
  }

  _hideProviderDropdown() {
    if (!this.providerDropdown) return;
    this.providerDropdown.style.display = 'none';
    this.providerPickerBtn.classList.remove('chat-panel__provider-picker-btn--open');
    if (this._providerOutsideClickHandler) {
      document.removeEventListener('click', this._providerOutsideClickHandler);
      this._providerOutsideClickHandler = null;
    }
  }

  _renderProviderDropdown() {
    if (!this.providerDropdown) return;
    const providers = [...this._chatProviders].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

    if (providers.length === 0) {
      this.providerDropdown.innerHTML = `
        <div class="chat-panel__provider-empty">No providers configured</div>
      `;
      return;
    }

    const items = providers.map(p => {
      const isActive = p.id === this._activeProvider;
      const isUnavailable = !p.available;
      const classes = ['chat-panel__provider-item'];
      if (isActive) classes.push('chat-panel__provider-item--active');
      if (isUnavailable) classes.push('chat-panel__provider-item--unavailable');

      const checkmark = isActive
        ? `<svg class="chat-panel__provider-check" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
             <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
           </svg>`
        : '';

      return `
        <button class="${classes.join(' ')}"
                data-provider-id="${this._escapeHtml(p.id)}"
                ${isUnavailable ? 'disabled' : ''}>
          <span class="chat-panel__provider-name">${this._escapeHtml(p.name)}</span>
          ${checkmark}
        </button>
      `;
    }).join('');

    this.providerDropdown.innerHTML = items;

    // Bind click handlers
    this.providerDropdown.querySelectorAll('.chat-panel__provider-item:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        this._selectProvider(btn.dataset.providerId);
        this._hideProviderDropdown();
      });
    });
  }

  /**
   * Select a provider. Reuses the currently active tab when it is "fresh"
   * (no messages, no streaming, no user-renamed title) — that's the common
   * just-opened-a-tab case where spawning a sibling would just litter the
   * strip. Otherwise opens a new tab so the prior conversation isn't lost.
   *
   * Note: with lazy session creation, a fresh tab typically has sessionId
   * null and we simply swap `tab.provider`. If the tab already got a session
   * (e.g. a previous lazy send just resolved), DELETE the old one so the
   * next send creates a fresh session under the new provider.
   *
   * @param {string} id - Provider ID to activate
   */
  async _selectProvider(id) {
    if (id === this._activeProvider) return;
    this._activeProvider = id;
    this._updateTitle();

    const tab = this._getActiveTab();
    const isFresh = tab
      && tab.messages.length === 0
      && !tab.isStreaming
      && !tab.streamingContent
      && !tab.titleFromUser;

    if (!isFresh) {
      await this._openNewTab();
      return;
    }

    tab.provider = id;
    if (tab.wsUnsub) { try { tab.wsUnsub(); } catch { /* noop */ } tab.wsUnsub = null; }
    if (tab.sessionId != null) {
      const staleId = tab.sessionId;
      tab.sessionId = null;
      tab.sessionWarm = false;
      // Restore the active marker so getter delegation still finds this tab.
      if (this.activeTabKey === staleId) this.activeTabKey = tab._localKey;
      fetch(`/api/chat/session/${staleId}`, { method: 'DELETE' }).catch(() => {});
    }
    this._renderTabStrip();
  }

  // ── Session picker dropdown ────────────────────────────────────────────

  _isSessionDropdownOpen() {
    return this.sessionDropdown && this.sessionDropdown.style.display !== 'none';
  }

  _toggleSessionDropdown() {
    if (this._isSessionDropdownOpen()) {
      this._hideSessionDropdown();
    } else {
      this._showSessionDropdown();
    }
  }

  async _showSessionDropdown() {
    if (!this.sessionDropdown) return;
    // Close provider dropdown if open
    this._hideProviderDropdown();

    const sessions = await this._fetchSessions();
    this._renderSessionDropdown(sessions);
    this.sessionDropdown.style.display = '';
    this.historyBtn.classList.add('chat-panel__history-btn--open');

    // Position the fixed dropdown relative to the history button
    this._positionSessionDropdown();

    // Bind outside-click-to-close (one-shot)
    this._sessionOutsideClickHandler = (e) => {
      if (!this.sessionPickerEl.contains(e.target) && !this.historyBtn.contains(e.target)) {
        this._hideSessionDropdown();
      }
    };
    // Use setTimeout so the current click event doesn't immediately trigger close
    setTimeout(() => {
      document.addEventListener('click', this._sessionOutsideClickHandler);
    }, 0);
  }

  _positionSessionDropdown() {
    if (!this.sessionDropdown || !this.historyBtn) return;
    const rect = this.historyBtn.getBoundingClientRect();
    this.sessionDropdown.style.top = `${rect.bottom + 4}px`;
    this.sessionDropdown.style.right = `${window.innerWidth - rect.right}px`;
  }

  _hideSessionDropdown() {
    if (!this.sessionDropdown) return;
    this.sessionDropdown.style.display = 'none';
    this.historyBtn.classList.remove('chat-panel__history-btn--open');
    if (this._sessionOutsideClickHandler) {
      document.removeEventListener('click', this._sessionOutsideClickHandler);
      this._sessionOutsideClickHandler = null;
    }
  }

  _renderSessionDropdown(sessions) {
    if (!this.sessionDropdown) return;

    if (sessions.length === 0) {
      this.sessionDropdown.innerHTML = `
        <div class="chat-panel__session-empty">No conversations yet</div>
      `;
      return;
    }

    // Build a set of sessionIds currently open in any tab so the dropdown can
    // mark them as "(open)" — clicking one focuses the existing tab rather
    // than duplicating it into the active tab via _switchToSession.
    const openSessionIds = new Set(
      this.tabs.map(t => t.sessionId).filter(id => id != null)
    );
    const activeSessionId = this.currentSessionId;

    const items = sessions.map(s => {
      const isActive = s.id === activeSessionId;
      const isOpenElsewhere = openSessionIds.has(s.id) && !isActive;
      const preview = s.first_message
        ? this._truncate(s.first_message, 60)
        : 'New conversation';
      const timeAgo = this._formatRelativeTime(s.updated_at);
      const providerLabel = s.provider
        ? `<span class="chat-panel__session-provider">${this._escapeHtml(this._getProviderDisplayName(s.provider))}</span>`
        : '';
      const openTag = (isActive || isOpenElsewhere)
        ? '<span class="chat-panel__session-open-tag">open</span>'
        : '';

      const classes = ['chat-panel__session-item'];
      if (isActive) classes.push('chat-panel__session-item--active');
      if (isOpenElsewhere) classes.push('chat-panel__session-item--open');

      return `
        <button class="${classes.join(' ')}"
                data-session-id="${s.id}">
          <span class="chat-panel__session-preview">${this._escapeHtml(preview)}${openTag}</span>
          <span class="chat-panel__session-meta">${providerLabel}${this._escapeHtml(timeAgo)}</span>
        </button>
      `;
    }).join('');

    this.sessionDropdown.innerHTML = items;

    // Bind click handlers on each item
    this.sessionDropdown.querySelectorAll('.chat-panel__session-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const sessionId = parseInt(btn.dataset.sessionId, 10);
        const sessionData = sessions.find(s => s.id === sessionId);
        if (!sessionData) {
          this._hideSessionDropdown();
          return;
        }
        // If this session is already open in another tab, focus that tab
        // instead of swapping the active tab's session (avoid duplicates).
        const existingTab = this._findTabBySessionId(sessionId);
        if (existingTab && this._tabKey(existingTab) !== this.activeTabKey) {
          this._switchToTab(this._tabKey(existingTab));
        } else if (!existingTab) {
          // Not currently open — swap the active tab to it (legacy behavior)
          this._switchToSession(sessionId, sessionData);
        }
        // If it's already the active tab, clicking is a no-op (re-focuses, but no work needed)
        this._hideSessionDropdown();
      });
    });
  }

  /**
   * Swap the active tab's session for a different one (e.g. via the history
   * picker). Tears down current state on this tab and loads the target
   * session's messages. Other tabs are untouched.
   * @param {number} sessionId - The session ID to switch to
   * @param {Object} sessionData - Session metadata (provider, model, message_count, etc.)
   */
  async _switchToSession(sessionId, sessionData) {
    const tab = this._getActiveTab();
    if (!tab) return;
    if (sessionId === tab.sessionId) return;

    // 1. Finalize any active stream on this tab
    this._finalizeStreaming();

    // 2. Tear down the existing subscription so events for the old session
    //    don't keep flowing into this tab
    if (tab.wsUnsub) { try { tab.wsUnsub(); } catch { /* noop */ } tab.wsUnsub = null; }

    // 3. Reset per-tab state
    tab.sessionId = sessionId;
    this.activeTabKey = sessionId;
    if (tab.messagesEl) tab.messagesEl.dataset.tabKey = String(sessionId);
    tab.sessionWarm = false;
    tab.messages = [];
    tab.streamingContent = '';
    tab.streamingMsgEl = null;
    tab.pendingContext = [];
    tab.pendingContextData = [];
    tab.latestDiffState = null;
    tab.pendingUserActionHints = [];
    tab.contextSource = null;
    tab.contextItemId = null;
    tab.contextLineMeta = null;
    tab.pendingActionContext = null;
    tab.analysisContextRemoved = false;
    tab.sessionAnalysisRunId = null;
    tab.errorMessage = null;
    tab.isStreaming = false;
    tab.titleFromUser = !!sessionData.first_message;
    this._updateTabStatus(tab, 'idle');

    // 4. Subscribe to the new session
    this._subscribeTab(tab);
    this._persistOpenTabs();

    // 5. Clear UI and update title
    this._clearMessages();
    this._updateActionButtons();
    if (sessionData.provider) {
      tab.provider = sessionData.provider;
      tab.model = sessionData.model;
      this._activeProvider = sessionData.provider;
      this._updateTitle(sessionData.provider, sessionData.model);
    } else {
      this._updateTitle();
    }

    // 6. Update tab title from the session's first user message
    if (sessionData.first_message) {
      this._setTabTitle(tab, this._truncate(sessionData.first_message, 28));
    } else {
      this._setTabTitle(tab, _nextNewTabTitle());
      tab.titleFromUser = false;
    }
    this._renderTabStrip();

    // 7. Load message history (race-guarded — passes explicit tab so a
    //    subsequent tab switch can't reroute the render)
    if (sessionData.message_count > 0) {
      await this._loadMessageHistory(sessionId, tab);
    }

    // Re-check after the await: the user may have closed the tab or swapped
    // it again. Route _ensureAnalysisContext through the captured tab so the
    // analysis card lands on the right messages container.
    if (!this.tabs.includes(tab) || tab.sessionId !== sessionId) return;

    // 8. Ensure analysis context for the new session
    this._ensureAnalysisContext(tab);
  }

  /**
   * Format a timestamp as relative time (same logic as AnalysisHistoryManager.formatRelativeTime).
   * @param {string} timestamp - ISO or SQLite timestamp
   * @returns {string} Relative time string
   */
  _formatRelativeTime(timestamp) {
    if (!timestamp) return 'Unknown';

    const now = new Date();
    const date = window.parseTimestamp ? window.parseTimestamp(timestamp) : new Date(timestamp);
    const diffMs = now - date;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }

  /**
   * Truncate text to maxLen characters with ellipsis.
   * @param {string} text
   * @param {number} maxLen
   * @returns {string}
   */
  _truncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text || '';
    return text.substring(0, maxLen) + '\u2026';
  }

  /**
   * Clear all messages from the active tab's display and show empty state.
   */
  _clearMessages() {
    const tab = this._getActiveTab();
    if (!tab?.messagesEl) return;
    tab.messagesEl.innerHTML = `
      <div class="chat-panel__empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
          <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
        </svg>
        <p>Ask questions about this review, or click "Ask about this" on any suggestion.</p>
      </div>
    `;
    tab.streamingMsgEl = null;
  }

  /**
   * Ensure WebSocket subscriptions are established for review and chat topics.
   * No longer creates sessions — that happens lazily on first message.
   * @returns {{sessionData: null}}
   */
  _ensureConnected() {
    this._ensureSubscriptions();
    return { sessionData: null };
  }

  /**
   * Late-bind a reviewId after the panel has already been opened.
   * Called by PRManager._initReviewEventListeners() (or equivalent in local.js)
   * to handle the race condition where PanelGroup auto-restores an open chat
   * panel during DOMContentLoaded, before prManager has loaded the review.
   * If the panel is open and has no reviewId yet, this sets it and loads
   * the MRU session so the user sees their previous conversation.
   * @param {number} reviewId - The review ID from prManager
   */
  async _lateBindReview(reviewId) {
    if (!reviewId) return;
    if (this.reviewId) return; // already bound
    this.reviewId = reviewId;
    console.debug('[ChatPanel] Late-bound reviewId:', reviewId);

    // Subscribe to review topic now that reviewId is available.
    // _ensureSubscriptions() skips this when reviewId is null at panel open time,
    // so we must subscribe here. The chat subscription is a benign no-op when
    // currentSessionId is null.
    this._ensureSubscriptions();

    // Re-enable input now that reviewId is available
    if (this.inputEl.disabled) {
      this._enableInput();
    }

    // If the panel is already open, restore tabs (or fall back to MRU load).
    // open() may have ran before reviewId was bound; tabs in that case are
    // empty or contain a single empty tab.
    if (this.isOpen && !this.currentSessionId) {
      let restored = false;
      const saved = this._loadPersistedTabs();
      if (saved) {
        // If a placeholder tab was created by open() with no sessionId, drop
        // it so restored tabs don't appear alongside an unused "New Chat".
        if (this.tabs.length === 1 && this.tabs[0].sessionId == null) {
          const placeholder = this.tabs[0];
          if (placeholder.messagesEl?.parentNode) {
            placeholder.messagesEl.parentNode.removeChild(placeholder.messagesEl);
          }
          this.tabs = [];
          this.activeTabKey = null;
        }
        restored = await this._restoreTabs(saved);
      }
      if (!restored) {
        if (this.tabs.length === 0) {
          const tab = this._createTab({ provider: this._activeProvider });
          this._appendTab(tab, { focus: true });
        }
        await this._loadMRUSession();
      }
      this._ensureAnalysisContext();
    }
  }

  /**
   * Create a new chat session via API for the active tab.
   * @param {number} contextCommentId - Optional AI suggestion ID for context
   * @returns {Object|null} Session data ({ id, status, context? }) or null on failure
   */
  async createSession(contextCommentId) {
    // Ensure there is an active tab to bind the new session to. This happens
    // for lazy-creation paths (first sendMessage on an empty panel).
    if (!this._getActiveTab()) {
      const tab = this._createTab({ provider: this._activeProvider });
      this._appendTab(tab, { focus: true });
    }
    if (!this.reviewId) {
      console.warn('[ChatPanel] No reviewId available');
      return null;
    }
    const tab = this._getActiveTab();
    if (!tab) return null;

    const isAcp = this._isAcpProvider();
    if (isAcp) this._showStatusFlash('Starting Agent Client Protocol');

    try {
      const body = {
        provider: tab.provider || this._activeProvider,
        reviewId: this.reviewId
      };
      if (contextCommentId) body.contextCommentId = contextCommentId;
      if (tab.analysisContextRemoved) body.skipAnalysisContext = true;

      console.debug('[ChatPanel] Creating session for review', this.reviewId);
      const response = await fetch('/api/chat/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (isAcp) this._hideStatusFlash();

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create chat session');
      }

      const result = await response.json();
      if (!this.tabs.includes(tab)) {
        fetch(`/api/chat/session/${result.data.id}`, { method: 'DELETE' }).catch(() => {});
        return null;
      }
      tab.sessionId = result.data.id;
      this.activeTabKey = result.data.id;
      tab.sessionWarm = true;
      if (tab.messagesEl) tab.messagesEl.dataset.tabKey = String(tab.sessionId);
      this._subscribeTab(tab);
      this._renderTabStrip();
      this._persistOpenTabs();
      console.debug('[ChatPanel] Session created:', tab.sessionId);
      return result.data;
    } catch (error) {
      if (isAcp) this._hideStatusFlash();
      console.error('[ChatPanel] Error creating session:', error);
      this._showError('Failed to start chat session. ' + error.message, tab);
      return null;
    }
  }

  /**
   * Send the current input text as a message.
   *
   * Captures the originating tab once at entry. All subsequent state reads
   * and writes go through that explicit reference so awaits cannot reroute
   * the send to whichever tab is active when the promise resolves.
   */
  async sendMessage() {
    const content = this.inputEl.value.trim();
    if (!content) return;

    // Capture the originating tab BEFORE any awaits. Bail if no tab.
    let tab = this._getActiveTab();
    if (!tab) {
      tab = this._createTab({ provider: this._activeProvider });
      this._appendTab(tab, { focus: true });
    }
    if (tab.isStreaming) return;

    // Save message text before clearing (for error recovery)
    const messageText = content;

    // Clear input UP FRONT — BEFORE the historyLoadPromise await — so a tab
    // switch during the wait doesn't leave the typed content sitting in the
    // shared textarea on someone else's tab. We only restore on error if the
    // user hasn't moved on.
    this.inputEl.value = '';
    this._autoResizeTextarea();
    this.sendBtn.disabled = true;

    // If history is still loading for this tab, wait for it to finish so we
    // don't race with the renderer.
    if (tab.historyLoadPromise) {
      try { await tab.historyLoadPromise; } catch { /* swallow */ }
      if (!this.tabs.includes(tab)) return;
    }

    // Remove empty state if present
    const emptyState = tab.messagesEl?.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Display user message (just the user's actual text)
    const msgElRef = this.addMessage('user', content, undefined, tab);

    // Lazy session creation: create on first message, not on panel open
    if (tab.sessionId == null) {
      this._ensureSubscriptions();
      const sessionData = await this._createSessionForTab(tab);
      if (!this.tabs.includes(tab)) return;
      if (!sessionData) {
        // Restore the user's message text into the input — but ONLY if the
        // user is still focused on the originating tab. Otherwise they may
        // have moved on and typed something on a sibling; we mustn't clobber.
        if (this._getActiveTab() === tab && !this.inputEl.value) {
          this.inputEl.value = messageText;
          this._autoResizeTextarea();
          this.sendBtn.disabled = false;
        }
        // Remove the phantom message bubble
        if (msgElRef) msgElRef.remove();
        tab.messages.pop();
        // Show error
        this._showError('Unable to start chat session. Please try again.', tab);
        return;
      }
      // Route through the captured tab so a focus change between the POST
      // and the response can't bleed the analysis card into a sibling tab.
      this._showAnalysisContextIfPresent(sessionData, tab);
    }
    // If sessionId is set (from MRU), just send — server auto-resumes

    // Prepare streaming UI. Clear any previous error on this tab.
    tab.errorMessage = null;
    tab.isStreaming = true;
    this._updateTabStatus(tab, 'streaming');
    if (this._getActiveTab() === tab) {
      this.sendBtn.disabled = true;
      this.sendBtn.style.display = 'none';
      this.stopBtn.style.display = '';
      this._updateActionButtons();
    }
    tab.streamingContent = '';
    this._addStreamingPlaceholder(tab);

    // Build the API payload — may include pending context from "Ask about this"
    const payload = { content };

    // Snapshot diff-state for error recovery (invisible to user, no UI cards).
    // Diff state is a snapshot — one latest value per tab. Drain via copy-and-clear.
    const savedDiffState = tab.latestDiffState;
    let diffStatePrefix = '';
    if (savedDiffState) {
      diffStatePrefix = '[Diff State Update]\n' + savedDiffState;
      tab.latestDiffState = null;
    }

    // Snapshot user-action-hints queue for error recovery (ordered, per-tab)
    const savedUserActionHints = tab.pendingUserActionHints.slice();
    let userActionPrefix = '';
    if (tab.pendingUserActionHints.length > 0) {
      userActionPrefix = '[User Action Hints]\n' + tab.pendingUserActionHints.join('\n');
      tab.pendingUserActionHints = [];
    }

    // Combine invisible prefixes (diff state + user action hints)
    let invisiblePrefix = '';
    if (diffStatePrefix && userActionPrefix) {
      invisiblePrefix = diffStatePrefix + '\n\n' + userActionPrefix;
    } else {
      invisiblePrefix = diffStatePrefix || userActionPrefix;
    }

    const savedContext = tab.pendingContext.slice();
    const savedContextData = tab.pendingContextData.slice();
    if (tab.pendingContext.length > 0) {
      const userContext = tab.pendingContext.join('\n\n');
      payload.context = invisiblePrefix
        ? invisiblePrefix + '\n\n' + userContext
        : userContext;
      payload.contextData = tab.pendingContextData;
      tab.pendingContext = [];
      tab.pendingContextData = [];

      // Lock context cards — remove close buttons and index attributes
      const removableCards = tab.messagesEl?.querySelectorAll('.chat-panel__context-card[data-context-index]') || [];
      removableCards.forEach((card) => {
        const btn = card.querySelector('.chat-panel__context-remove');
        if (btn) btn.remove();
        delete card.dataset.contextIndex;
      });
    } else if (invisiblePrefix) {
      payload.context = invisiblePrefix;
    }

    // Lock analysis context card (not indexed, handled separately from pending context)
    const analysisRemoveBtn = tab.messagesEl?.querySelector('.chat-panel__context-card[data-analysis] .chat-panel__context-remove');
    if (analysisRemoveBtn) analysisRemoveBtn.remove();

    // Attach action context (set by action button handlers — adopt, update, dismiss)
    const savedActionContext = tab.pendingActionContext;
    if (tab.pendingActionContext) {
      payload.actionContext = tab.pendingActionContext;
      tab.pendingActionContext = null;
    }

    // Show ACP resume flash when the session may need server-side auto-resume
    const acpResuming = this._isAcpProvider() && !tab.sessionWarm;
    if (acpResuming) {
      this._showStatusFlash('Resuming Agent Client Protocol');
    }

    // Send to API
    try {
      console.debug('[ChatPanel] Sending message to session', tab.sessionId);
      let response = await fetch(`/api/chat/session/${tab.sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!this.tabs.includes(tab)) return;

      if (acpResuming) {
        this._hideStatusFlash();
        tab.sessionWarm = true;
      }

      // Handle 410 Gone: session is not resumable — transparently create a new
      // one bound to the SAME tab and retry once.
      if (response.status === 410) {
        console.debug('[ChatPanel] Session not resumable (410), creating new session and retrying');
        if (tab.wsUnsub) { try { tab.wsUnsub(); } catch { /* noop */ } tab.wsUnsub = null; }
        // Re-anchor the active marker to the tab's local key BEFORE nulling
        // sessionId so _createSessionForTab can re-bind the SAME tab via the
        // _localKey check (rather than orphaning this tab and spawning a new).
        const wasActive = this._getActiveTab() === tab;
        tab.sessionId = null;
        if (wasActive) this.activeTabKey = tab._localKey;
        const sessionData = await this._createSessionForTab(tab);
        if (!this.tabs.includes(tab)) return;
        if (!sessionData) {
          throw new Error('Failed to create replacement session');
        }

        response = await fetch(`/api/chat/session/${tab.sessionId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!this.tabs.includes(tab)) return;
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to send message');
      }
      console.debug('[ChatPanel] Message accepted, waiting for WebSocket events');
    } catch (error) {
      if (!this.tabs.includes(tab)) return;
      if (acpResuming) this._hideStatusFlash();
      // Restore pending state on the originating tab so it's not lost.
      tab.pendingContext = savedContext;
      tab.pendingContextData = savedContextData;
      // Only restore the snapshot if no newer one arrived during the send.
      // Diff state is a snapshot — a freshly queued value supersedes the old.
      if (savedDiffState && !tab.latestDiffState) tab.latestDiffState = savedDiffState;
      tab.pendingUserActionHints = [...savedUserActionHints, ...tab.pendingUserActionHints];
      if (savedActionContext && !tab.pendingActionContext) tab.pendingActionContext = savedActionContext;
      // Restore removability on context cards that were locked before the failed send
      this._restoreRemovableCards(tab);
      console.error('[ChatPanel] Error sending message:', error);
      this._showError('Failed to send message. ' + error.message, tab);
      this._finalizeStreaming(tab);
    }
  }

  /**
   * Queue an invisible diff-state notification for the chat agent.
   *
   * Diff state is a SNAPSHOT — every tab gets the same latest value, and a
   * subsequent call overwrites the prior value rather than appending. Drained
   * from the originating tab on its next sendMessage(). If no tabs are open
   * yet, the value is stashed on the panel so the next tab created inherits
   * it.
   * @param {string} message - Description of the diff state change
   */
  queueDiffStateNotification(message) {
    // Always cache the latest snapshot so tabs created later inherit it.
    // Without this, a tab opened between the first notification and the first
    // send would never see the snapshot.
    this._initialDiffState = message;
    if (this.tabs.length === 0) return;
    for (const tab of this.tabs) tab.latestDiffState = message;
  }

  /**
   * Queue an invisible user-action hint for the chat agent.
   *
   * Hints are ordered events and attribution matters: they belong to the tab
   * that was active when the action happened. Background tabs never
   * accumulate. Silent no-op when no active tab.
   * @param {string} message - Description of the user action
   */
  queueUserActionHint(message) {
    const active = this._getActiveTab();
    if (!active) return;
    active.pendingUserActionHints.push(message);
  }

  /**
   * Store pending context and render a compact context card in the UI.
   * Called when the user clicks "Ask about this" on a suggestion.
   * The context is NOT sent to the agent immediately — it is prepended
   * to the next user message so the agent receives question + context together.
   * @param {Object} ctx - Suggestion context {title, type, file, line_start, line_end, body}
   */
  _sendContextMessage(ctx) {
    const tab = this._getActiveTab();
    if (!tab) return;
    // Remove empty state if present
    const emptyState = tab.messagesEl?.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Store structured context data for DB persistence (session resumption)
    const contextData = {
      type: ctx.type || 'general',
      title: ctx.title || 'Untitled',
      file: ctx.file || null,
      line_start: ctx.line_start || null,
      line_end: ctx.line_end || null,
      side: ctx.side || null,
      body: ctx.body || null
    };
    tab.pendingContextData.push(contextData);

    // Build the plain text context for the agent (will be prepended to next message)
    const lines = ['The user wants to discuss this specific suggestion:'];
    lines.push(`- Type: ${contextData.type}`);
    lines.push(`- Title: ${contextData.title}`);
    if (contextData.file) {
      let fileLine = `- File: ${contextData.file}`;
      if (contextData.line_start) {
        fileLine += ` (line ${contextData.line_start}${contextData.line_end && contextData.line_end !== contextData.line_start ? '-' + contextData.line_end : ''})`;
      }
      lines.push(fileLine);
    }
    if (contextData.body) {
      lines.push(`- Details: ${contextData.body}`);
    }

    // Enrich with diff hunk if available
    const patch = window.prManager?.filePatches?.get(contextData.file);
    if (patch && window.DiffContext) {
      if (contextData.line_start) {
        const hunk = window.DiffContext.extractHunkForLines(
          patch, contextData.line_start, contextData.line_end || contextData.line_start, contextData.side
        );
        if (hunk) {
          lines.push(`- Diff hunk:\n\`\`\`\n${hunk}\n\`\`\``);
        }
      } else {
        const ranges = window.DiffContext.extractHunkRangesForFile(patch);
        if (ranges.length) {
          lines.push(`- Diff hunk ranges: ${JSON.stringify(ranges)}`);
        }
      }
    }

    tab.pendingContext.push(lines.join('\n'));

    // Render the compact context card in the UI
    this._addContextCard(ctx, { removable: true });
  }

  /**
   * Store pending context and render a compact context card for a user/external comment or line reference.
   * Called when the user clicks "Ask about this" on a user comment, an external (e.g. GitHub) comment,
   * or clicks the gutter chat button (line reference with no comment body).
   * The context is NOT sent to the agent immediately -- it is prepended
   * to the next user message so the agent receives question + context together.
   * @param {Object} ctx - Comment context. When `source === 'external'`, additional fields are honored:
   *   `externalSource` (string, e.g. 'github'), `externalUrl` (permalink), `isOutdated` (boolean), `author` (string).
   */
  _sendCommentContextMessage(ctx) {
    const tab = this._getActiveTab();
    if (!tab) return;
    // Remove empty state if present
    const emptyState = tab.messagesEl?.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    const isLine = ctx.type === 'line';
    const isExternal = ctx.source === 'external';

    // Store structured context data for DB persistence
    const lineLabel = !ctx.line_start
      ? (ctx.file || 'File').split('/').pop()
      : (ctx.line_end && ctx.line_end !== ctx.line_start ? `Lines ${ctx.line_start}-${ctx.line_end}` : `Line ${ctx.line_start}`);
    const contextData = {
      type: isLine ? 'line' : 'comment',
      title: isLine
        ? lineLabel
        : (ctx.isFileLevel ? 'File comment' : `Comment on line ${ctx.line_start || '?'}`),
      file: ctx.file || null,
      side: ctx.side || null,
      line_start: ctx.line_start || null,
      line_end: ctx.line_end || null,
      body: ctx.body || null,
      source: isExternal ? 'external' : 'user'
    };
    if (isExternal) {
      contextData.externalSource = ctx.externalSource || null;
      contextData.externalUrl = ctx.externalUrl || null;
      contextData.isOutdated = !!ctx.isOutdated;
      contextData.author = ctx.author || null;
    }
    tab.pendingContextData.push(contextData);

    // Build the plain text context for the agent
    const sourceLabel = isExternal
      ? (ctx.externalSource ? this._formatExternalSourceLabel(ctx.externalSource) : 'an external system')
      : null;
    const lines = isLine
      ? [ctx.line_start
        ? `The user wants to discuss code at ${lineLabel} in ${contextData.file || 'unknown file'}:`
        : `The user wants to discuss the file ${contextData.file || 'unknown file'}:`]
      : isExternal
        ? [ctx.author
          ? `The user wants to discuss a review comment posted on ${sourceLabel} by ${ctx.author}:`
          : `The user wants to discuss a review comment posted on ${sourceLabel}:`]
        : ['The user wants to discuss a review comment:'];
    if (contextData.file) {
      let fileLine = `- File: ${contextData.file}`;
      if (contextData.line_start) {
        fileLine += ` (line ${contextData.line_start}${contextData.line_end && contextData.line_end !== contextData.line_start ? '-' + contextData.line_end : ''})`;
      }
      lines.push(fileLine);
    }
    if (ctx.isFileLevel) {
      lines.push('- Scope: File-level comment');
    }
    if (ctx.parentId && !isExternal) {
      lines.push('- Origin: adopted from AI suggestion');
    }
    if (isExternal) {
      if (ctx.author) {
        lines.push(`- Author: ${ctx.author}`);
      }
      if (ctx.isOutdated) {
        lines.push('- Status: outdated (the diff position no longer exists in the current PR head)');
      }
      if (ctx.externalUrl) {
        lines.push(`- Link: ${ctx.externalUrl}`);
      }
    }
    if (contextData.body) {
      lines.push(`- Comment: ${contextData.body}`);
    }

    // Enrich with diff hunk if available
    const patch = window.prManager?.filePatches?.get(contextData.file);
    if (patch && window.DiffContext) {
      if (contextData.line_start && !ctx.isFileLevel) {
        const hunk = window.DiffContext.extractHunkForLines(
          patch, contextData.line_start, contextData.line_end || contextData.line_start, contextData.side
        );
        if (hunk) {
          lines.push(`- Diff hunk:\n\`\`\`\n${hunk}\n\`\`\``);
        }
      } else {
        const ranges = window.DiffContext.extractHunkRangesForFile(patch);
        if (ranges.length) {
          lines.push(`- Diff hunk ranges: ${JSON.stringify(ranges)}`);
        }
      }
    }

    tab.pendingContext.push(lines.join('\n'));

    // Render the compact context card in the UI
    if (isLine) {
      this._addLineContextCard(ctx, { removable: true });
    } else {
      this._addCommentContextCard(ctx, { removable: true });
    }
  }

  /**
   * Format an externalSource identifier into a human-readable label.
   * @param {string} externalSource - e.g. 'github', 'gitlab'
   * @returns {string}
   */
  _formatExternalSourceLabel(externalSource) {
    if (!externalSource) return 'an external system';
    switch (externalSource) {
      case 'github': return 'GitHub';
      case 'gitlab': return 'GitLab';
      case 'linear': return 'Linear';
      default:
        return externalSource.charAt(0).toUpperCase() + externalSource.slice(1);
    }
  }

  /**
   * Store pending context and render a compact context card for a comment thread.
   * Called when the user clicks "chat about this thread" on an external thread (e.g. GitHub).
   * Threads are external systems only -- internal user comments don't have a thread shape.
   * @param {Object} threadContext - See JSDoc on open() for full shape.
   */
  _sendThreadContextMessage(threadContext) {
    const tab = this._getActiveTab();
    if (!tab) return;
    // Remove empty state if present
    const emptyState = tab.messagesEl?.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    const comments = Array.isArray(threadContext.comments) ? threadContext.comments : [];
    const externalSource = threadContext.externalSource || null;
    const sourceLabel = this._formatExternalSourceLabel(externalSource);

    // Store structured context data for DB persistence
    const contextData = {
      type: 'thread',
      title: `${sourceLabel} thread`,
      file: threadContext.file || null,
      side: threadContext.side || null,
      line_start: threadContext.line_start || null,
      line_end: threadContext.line_end || null,
      body: null,
      source: 'external',
      externalSource,
      rootId: threadContext.rootId || null,
      comments: comments.map((c) => ({
        author: c.author || null,
        body: c.body || '',
        isOutdated: !!c.isOutdated,
        externalUrl: c.externalUrl || null,
        externalCreatedAt: c.externalCreatedAt || null,
      })),
    };
    tab.pendingContextData.push(contextData);

    // Build the plain text context for the agent
    const fileLabel = contextData.file || 'unknown file';
    let anchor = fileLabel;
    if (contextData.line_start) {
      anchor += `:${contextData.line_start}`;
      if (contextData.line_end && contextData.line_end !== contextData.line_start) {
        anchor += `-${contextData.line_end}`;
      }
    }
    const lines = [
      `The user wants to discuss a thread of ${comments.length} comment${comments.length === 1 ? '' : 's'} from ${sourceLabel} on ${anchor}:`,
    ];
    if (contextData.file) {
      let fileLine = `- File: ${contextData.file}`;
      if (contextData.line_start) {
        fileLine += ` (line ${contextData.line_start}${contextData.line_end && contextData.line_end !== contextData.line_start ? '-' + contextData.line_end : ''})`;
      }
      lines.push(fileLine);
    }
    lines.push(`- Source: ${sourceLabel}`);
    lines.push(`- Comment count: ${comments.length}`);

    comments.forEach((c, idx) => {
      const author = c.author || 'unknown';
      const parts = [`Comment ${idx + 1} by ${author}`];
      if (c.externalCreatedAt) parts.push(`at ${c.externalCreatedAt}`);
      if (c.isOutdated) parts.push('(outdated)');
      if (c.externalUrl) parts.push(`(${c.externalUrl})`);
      lines.push(`- ${parts.join(' ')}:`);
      const body = (c.body || '').trim() || '(no body)';
      // Indent body so it renders as a quote block
      const indented = body.split('\n').map((ln) => `  > ${ln}`).join('\n');
      lines.push(indented);
    });

    // Enrich with diff hunk if available
    const patch = window.prManager?.filePatches?.get(contextData.file);
    if (patch && window.DiffContext) {
      if (contextData.line_start) {
        const hunk = window.DiffContext.extractHunkForLines(
          patch, contextData.line_start, contextData.line_end || contextData.line_start, contextData.side
        );
        if (hunk) {
          lines.push(`- Diff hunk:\n\`\`\`\n${hunk}\n\`\`\``);
        }
      } else {
        const ranges = window.DiffContext.extractHunkRangesForFile(patch);
        if (ranges.length) {
          lines.push(`- Diff hunk ranges: ${JSON.stringify(ranges)}`);
        }
      }
    }

    tab.pendingContext.push(lines.join('\n'));

    // Render the compact context card in the UI
    this._addThreadContextCard(contextData, { removable: true });
  }

  /**
   * Send a file context message to the chat panel.
   * Called when the user clicks "Chat about file" on a file header.
   * @param {Object} fileContext - File context data
   * @param {string} fileContext.file - File path
   */
  _sendFileContextMessage(fileContext) {
    const tab = this._getActiveTab();
    if (!tab) return;
    let contextText = `The user wants to discuss ${fileContext.file}`;

    // Check for duplicate context (use startsWith because contextText may
    // get enriched with diff hunk ranges after this check)
    const isDuplicate = tab.pendingContext.some(c => c === contextText || c.startsWith(contextText)) ||
      tab.messages.some(m => m.role === 'context' && (m.content === contextText || m.content.startsWith(contextText)));
    if (isDuplicate) return;

    // Remove empty state if present
    const emptyState = tab.messagesEl?.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Store structured context data for DB persistence
    const contextData = {
      type: 'file',
      title: fileContext.file,
      file: fileContext.file,
      line_start: null,
      line_end: null,
      body: null
    };
    tab.pendingContextData.push(contextData);

    // Enrich with diff hunk ranges if available
    const patch = window.prManager?.filePatches?.get(fileContext.file);
    if (patch && window.DiffContext) {
      const ranges = window.DiffContext.extractHunkRangesForFile(patch);
      if (ranges.length) {
        contextText += `\n- Diff hunk ranges: ${JSON.stringify(ranges)}`;
      }
    }

    tab.pendingContext.push(contextText);

    // Render the compact context card in the UI
    this._addFileContextCard(contextData, { removable: true });
  }

  /**
   * Store pending context and render a compact context card for a tour stop.
   * Called when the user clicks "Chat about" on a tour-stop annotation.
   * The context is NOT sent to the agent immediately — it is prepended to
   * the next user message so the agent receives question + context together.
   *
   * Async because tour stops on context files (files NOT in the PR diff) need
   * to fetch a code snippet via the file-content API so the agent receives a
   * meaningful snippet — same shape as the diff-hunk enrichment used for stops
   * inside the diff.
   *
   * @param {Object} ctx - Tour stop context
   *   {stopIndex, totalStops, title, description, file, line_start, line_end, side}
   * @returns {Promise<void>}
   */
  async _sendTourContextMessage(ctx) {
    const tab = this._getActiveTab();
    if (!tab) return;

    // Remove empty state if present
    const emptyState = this.messagesEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    const stopLabel = (typeof ctx.stopIndex === 'number' && typeof ctx.totalStops === 'number')
      ? `Stop ${ctx.stopIndex + 1} of ${ctx.totalStops}`
      : 'Tour stop';

    // Store structured context data for DB persistence (session resumption).
    const contextData = {
      type: 'tour stop',
      title: ctx.title || stopLabel,
      file: ctx.file || null,
      line_start: ctx.line_start || null,
      line_end: ctx.line_end || null,
      side: ctx.side || null,
      body: ctx.description || null,
      stopIndex: typeof ctx.stopIndex === 'number' ? ctx.stopIndex : null,
      totalStops: typeof ctx.totalStops === 'number' ? ctx.totalStops : null
    };
    tab.pendingContextData.push(contextData);

    // Build the plain-text context for the agent.
    const lines = [`The user wants to discuss this tour stop (${stopLabel}):`];
    if (contextData.title) {
      lines.push(`- Title: ${contextData.title}`);
    }
    if (contextData.file) {
      let fileLine = `- File: ${contextData.file}`;
      if (contextData.line_start) {
        fileLine += ` (line ${contextData.line_start}${contextData.line_end && contextData.line_end !== contextData.line_start ? '-' + contextData.line_end : ''})`;
      }
      lines.push(fileLine);
    }
    if (contextData.body) {
      lines.push(`- Description: ${contextData.body}`);
    }

    // Enrich with code snippet.
    //
    // Primary path: pull from the in-memory PR diff via DiffContext. This is
    // synchronous and matches the shape used by suggestion/comment context.
    //
    // Fallback path: tour-renderer.prepareStop auto-adds context files (files
    // outside the PR diff) via prManager.ensureContextFile. Those files have
    // no entry in filePatches, so the lookup misses — but the agent benefits
    // most from a snippet in exactly that case (file isn't visible in the
    // diff). Fetch the file content and slice [line_start-5, line_end+5].
    //
    // Both paths render as a fenced code block so the agent sees a consistent
    // shape. A failed fetch logs a warning and falls through to no snippet.
    const patch = window.prManager?.filePatches?.get(contextData.file);
    let snippet = null;
    if (patch && window.DiffContext && contextData.line_start) {
      const hunk = window.DiffContext.extractHunkForLines(
        patch,
        contextData.line_start,
        contextData.line_end || contextData.line_start,
        contextData.side
      );
      if (hunk) {
        snippet = `- Diff hunk:\n\`\`\`\n${hunk}\n\`\`\``;
      }
    } else if (!patch && contextData.file && contextData.line_start) {
      const sliced = await this._fetchContextFileSnippet(
        contextData.file,
        contextData.line_start,
        contextData.line_end || contextData.line_start
      );
      if (sliced) {
        snippet = `- File snippet:\n\`\`\`\n${sliced}\n\`\`\``;
      }
    }
    if (snippet) {
      lines.push(snippet);
    }

    tab.pendingContext.push(lines.join('\n'));

    // Render the compact context card in the UI (reuses suggestion card shape).
    this._addContextCard(contextData, { removable: true });
  }

  /**
   * Fetch a small slice of file content for tour stops on context files
   * (files outside the PR diff). Returns the slice with line numbers prefixed
   * so the agent can correlate with the stop's line range, or null on failure.
   *
   * @param {string} file - File path (will be URI-encoded)
   * @param {number} lineStart - 1-based first line of the stop range
   * @param {number} lineEnd   - 1-based last line of the stop range (inclusive)
   * @param {number} [padding=5] - Extra lines to include on each side
   * @returns {Promise<string|null>}
   */
  async _fetchContextFileSnippet(file, lineStart, lineEnd, padding = 5) {
    const reviewId = this.reviewId || window.prManager?.currentPR?.id;
    if (!reviewId || !file || !lineStart) return null;

    try {
      const resp = await fetch(
        `/api/reviews/${reviewId}/file-content/${encodeURIComponent(file)}`
      );
      if (!resp || !resp.ok) {
        console.warn(
          '[ChatPanel] context-file snippet fetch failed',
          { file, status: resp && resp.status }
        );
        return null;
      }
      const data = await resp.json();
      const allLines = Array.isArray(data?.lines) ? data.lines : null;
      if (!allLines || allLines.length === 0) return null;

      // Clamp to file bounds; convert to 0-based slice indices.
      const startIdx = Math.max(0, lineStart - 1 - padding);
      const endIdx = Math.min(allLines.length, lineEnd + padding);
      if (endIdx <= startIdx) return null;

      const out = [];
      const pad = String(endIdx).length;
      for (let i = startIdx; i < endIdx; i++) {
        out.push(`${String(i + 1).padStart(pad, ' ')}: ${allLines[i]}`);
      }
      return out.join('\n');
    } catch (err) {
      console.warn('[ChatPanel] context-file snippet fetch threw', { file, err });
      return null;
    }
  }

  /**
   * Add an analysis run as context for the chat conversation.
   * Fetches run metadata from the backend and creates a removable context card
   * that participates in the pending context arrays (data-context-index path).
   * Unlike the auto-added analysis card (data-analysis="true"), this is a
   * manually-added card that goes through the standard pending context flow.
   * @param {string} runId - The analysis run ID to add as context
   */
  async addAnalysisRunContext(runId) {
    // 1. Check for duplicate - look for any card with this run ID (both auto-added and manually-added)
    const existingCard = this.messagesEl?.querySelector(`[data-analysis-run-id="${runId}"]`);
    if (existingCard) {
      this._showToast('Analysis run already added');
      return;
    }

    // 2. Open panel if closed
    await this.open({ suppressFocus: true });

    // Capture the tab AFTER open() so any restoration/new-tab work is done.
    const tab = this._getActiveTab();
    if (!tab) return;

    // Re-check: open() may have auto-added a card for this run via _ensureAnalysisContext
    const existingCardPostOpen = tab.messagesEl?.querySelector(
      `[data-analysis-run-id="${runId}"]`
    );
    if (existingCardPostOpen) {
      this._showToast('Analysis run already added');
      return;
    }

    // 3. Fetch context from backend
    const response = await fetch(`/api/chat/analysis-context/${runId}?reviewId=${this.reviewId}`);
    if (!this.tabs.includes(tab)) return;
    if (!response.ok) {
      console.error('[ChatPanel] Failed to fetch analysis context:', response.statusText);
      return;
    }
    const result = await response.json();
    if (!this.tabs.includes(tab)) return;
    const data = result.data;

    // 4. Push to pending context arrays
    tab.pendingContext.push(data.text);
    const contextData = {
      type: 'analysis-run',
      aiRunId: runId,
      provider: data.run.provider,
      model: data.run.model,
      summary: data.run.summary,
      suggestionCount: data.suggestionCount,
      configType: data.run.configType,
      completedAt: data.run.completedAt
    };
    tab.pendingContextData.push(contextData);

    // 5. Remove empty state if present
    const emptyState = tab.messagesEl?.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // 6. Create the card and append — pass captured tab so a focus change
    //    during the fetch doesn't write the card into a sibling.
    this._addAnalysisRunContextCard(contextData, { removable: true }, tab);

    // 7. Focus input
    if (this.inputEl) this.inputEl.focus();
  }

  /**
   * Make a context card removable by adding a data-context-index and a remove button.
   * Shared helper used by _addContextCard, _addCommentContextCard, and _addFileContextCard.
   * @param {HTMLElement} card - The context card element
   */
  _makeCardRemovable(card) {
    const tab = this._getActiveTab();
    const idx = (tab?.pendingContextData.length ?? 0) - 1;
    card.dataset.contextIndex = idx;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'chat-panel__context-remove';
    removeBtn.title = 'Remove context';
    removeBtn.innerHTML = '\u00d7';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._removeContextCard(card);
    });
    card.appendChild(removeBtn);
  }

  /**
   * Add a compact file context card to the messages area.
   * @param {Object} ctx - File context data { file, title }
   * @param {Object} [options] - Options
   * @param {boolean} [options.removable=false] - Whether the card should have a remove button
   */
  _addFileContextCard(ctx, { removable = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';

    const filePath = ctx.file || ctx.title || '';

    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>
      </svg>
      <span class="chat-panel__context-label"><strong>FILE</strong></span>
      <span class="chat-panel__context-title">${this._escapeHtml(filePath)}</span>
    `;

    if (removable) this._makeCardRemovable(card);

    this.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom({ force: true }));
  }

  /**
   * Ensure the latest AI analysis context is added as the first context item.
   * Called on every panel expand (not just when opening with specific context).
   * Detects new analysis runs by comparing the latest completed run ID
   * against the one already loaded in the session. Only adds if suggestions exist.
   */
  _ensureAnalysisContext(targetTab) {
    const tab = targetTab || this._getActiveTab();
    if (!tab || !tab.messagesEl) return;

    // Determine the latest completed run ID from the analysis history manager or prManager
    const currentRunId = this._getLatestCompletedRunId();

    // Detect whether a NEW analysis run has appeared since we last loaded context.
    // If the run ID changed, we need to replace the old card with a new one.
    // This handles the case where sessionAnalysisRunId was explicitly set.
    const isNewRunVsSession = currentRunId && tab.sessionAnalysisRunId &&
      String(currentRunId) !== String(tab.sessionAnalysisRunId);

    if (isNewRunVsSession) {
      console.debug('[ChatPanel] _ensureAnalysisContext: new run detected:', currentRunId, '(was:', tab.sessionAnalysisRunId + ')');
      // Remove the old analysis card from the DOM (if present)
      const oldCard = tab.messagesEl.querySelector('.chat-panel__context-card[data-analysis]');
      if (oldCard) oldCard.remove();
      // Reset flags — the user removed the OLD run's context, but this is a different run
      tab.analysisContextRemoved = false;
      tab.sessionAnalysisRunId = null;
    }

    // Check for an existing card in the DOM (e.g., loaded from MRU session history).
    // If sessionAnalysisRunId is not set, this card may be stale — compare its
    // stamped run ID against the latest completed run to detect new analyses that
    // completed while the panel was closed.
    const existingCard = tab.messagesEl.querySelector('.chat-panel__context-card[data-analysis]');
    if (existingCard) {
      if (!tab.sessionAnalysisRunId && currentRunId) {
        const cardRunId = existingCard.dataset.analysisRunId || null;
        if (cardRunId && String(cardRunId) === String(currentRunId)) {
          // Card matches the latest run — adopt its run ID so future opens can detect changes
          console.debug('[ChatPanel] _ensureAnalysisContext: adopting existing card runId:', cardRunId);
          tab.sessionAnalysisRunId = String(currentRunId);
          return;
        }
        // Card has no run ID stamp or a different run ID — it's stale.
        // Remove it so a fresh card for the current run is added below.
        console.debug('[ChatPanel] _ensureAnalysisContext: replacing stale DOM card (card:', cardRunId, 'latest:', currentRunId + ')');
        existingCard.remove();
        tab.analysisContextRemoved = false;
      } else {
        console.debug('[ChatPanel] _ensureAnalysisContext: skipped — card already in DOM');
        return;
      }
    }

    // Skip if the current session already has analysis context loaded (by run ID)
    // and no new run was detected (handled above)
    if (tab.sessionAnalysisRunId) {
      console.debug('[ChatPanel] _ensureAnalysisContext: skipped — runId already set:', tab.sessionAnalysisRunId);
      return;
    }

    // Skip if analysis context was explicitly removed in this conversation
    if (tab.analysisContextRemoved) {
      console.debug('[ChatPanel] _ensureAnalysisContext: skipped — explicitly removed');
      return;
    }

    // Count suggestions from the DOM (from the latest analysis run)
    const suggestionEls = typeof document !== 'undefined' && document.querySelectorAll
      ? document.querySelectorAll('.ai-suggestion[data-suggestion-id]')
      : [];
    const count = suggestionEls.length;
    if (count === 0) {
      console.debug('[ChatPanel] _ensureAnalysisContext: skipped — no suggestions in DOM');
      return;
    }
    console.debug('[ChatPanel] _ensureAnalysisContext: adding card with', count, 'suggestions');

    // Remove empty state
    const emptyState = tab.messagesEl.querySelector('.chat-panel__empty');
    if (emptyState) emptyState.remove();

    // Render the analysis context card (removable).
    // Prepend only when the messages area is empty (fresh conversation) so the card
    // appears first.  When re-opening an existing chat that already has messages,
    // append instead so the card lands at the bottom where the user can see it
    // (prepending + scrollToBottom would hide it above the fold).
    // Note: analysis card is NOT added to _pendingContext/_pendingContextData —
    // the backend includes full suggestion data via initialContext at session creation.
    // The card is a visual indicator that controls whether the backend includes it.
    const hasExistingMessages = tab.messagesEl.querySelectorAll('.chat-panel__message').length > 0;
    const contextData = this._buildAnalysisContextData(currentRunId, count);
    this._renderInTab(tab, () => {
      this._addAnalysisContextCard(contextData, { removable: true, prepend: !hasExistingMessages });
    });

    // Persist to DB so the card is restored on session reload. Defer when the
    // tab has no sessionId yet (lazy-create path) — the sendMessage flow will
    // re-run _ensureAnalysisContext after the session is born.
    if (tab.sessionId != null) {
      this._persistAnalysisContext(contextData, tab.sessionId);
    }

    // Mark that analysis context is loaded for this session.
    // Use the actual run ID if available, otherwise fall back to 'dom'.
    tab.sessionAnalysisRunId = currentRunId || 'dom';
  }

  /**
   * Build enriched analysis context data for the card.
   * Pulls metadata (provider, model, summary, configType) from the
   * cached runs in analysisHistoryManager so the card's tooltip
   * shows rich info even before a session is created.
   * @param {string|null} runId - The run ID to look up metadata for
   * @param {number} count - Number of suggestions in the DOM
   * @returns {Object} Context data with type, suggestionCount, and optional metadata
   */
  _buildAnalysisContextData(runId, count) {
    const contextData = { type: 'analysis', suggestionCount: count };

    if (!runId) return contextData;

    // Look up the run in the cached analysisHistoryManager.runs array
    const mgr = window.prManager;
    const historyMgr = mgr?.analysisHistoryManager;
    if (!historyMgr?.runs?.length) return contextData;

    const run = historyMgr.runs.find(r => String(r.id) === String(runId));
    if (!run) return contextData;

    // Enrich with available metadata
    if (run.provider) contextData.provider = run.provider;
    if (run.model) contextData.model = run.model;
    if (run.summary) contextData.summary = run.summary;
    if (run.config_type) contextData.configType = run.config_type;
    if (run.completed_at) contextData.completedAt = run.completed_at;
    contextData.aiRunId = String(run.id);

    return contextData;
  }

  /**
   * Get the ID of the latest completed (successful) analysis run.
   * Looks at the cached runs in analysisHistoryManager (sorted by date DESC)
   * and returns the first one with status 'completed'.
   * Falls back to the selected run ID or prManager.selectedRunId for
   * backward compatibility when the runs array is not available.
   * @returns {string|null}
   */
  _getLatestCompletedRunId() {
    const mgr = window.prManager;
    if (!mgr) return null;

    // Prefer the analysisHistoryManager's runs array — find latest completed run
    const historyMgr = mgr.analysisHistoryManager;
    if (historyMgr?.runs?.length > 0) {
      // Runs are sorted by date DESC; find the first completed one
      const completedRun = historyMgr.runs.find(r => r.status === 'completed');
      if (completedRun) return String(completedRun.id);
    }

    // Fall back to selectedRunId on the history manager (for cases where
    // runs array is empty but a selection exists)
    if (historyMgr?.getSelectedRunId) {
      const id = historyMgr.getSelectedRunId();
      if (id) return String(id);
    }

    // Fall back to prManager.selectedRunId
    if (mgr.selectedRunId) return String(mgr.selectedRunId);
    return null;
  }

  /**
   * Remove the analysis context card and mark it as explicitly removed.
   * When removed, the backend will skip including analysis suggestions in the session.
   * @param {HTMLElement} cardEl - The analysis context card element
   */
  _removeAnalysisContextCard(cardEl) {
    this._analysisContextRemoved = true;
    cardEl.remove();

    // If no pending context, no messages, and no other context cards, restore empty state
    const tab = this._getActiveTab();
    if (tab && tab.pendingContext.length === 0 && tab.messages.length === 0 &&
        !tab.messagesEl?.querySelector('.chat-panel__context-card')) {
      this._clearMessages();
    }
  }

  /**
   * Add a compact context card for a user or external comment to the messages area.
   * When `ctx.source === 'external'`, adds external-comment-context classes
   * (and `source-<externalSource>`) so per-source theming variables apply,
   * renders the author label (linked to externalUrl when present), and shows
   * an "outdated" badge when `ctx.isOutdated`.
   * @param {Object} ctx - Comment context {commentId, body, file, line_start, line_end, isFileLevel, source, externalSource, externalUrl, isOutdated, author}
   */
  _addCommentContextCard(ctx, { removable = false } = {}) {
    const card = document.createElement('div');
    const isExternal = ctx.source === 'external';
    const classes = ['chat-panel__context-card'];
    if (isExternal) {
      classes.push('external-comment-context');
      if (ctx.externalSource) classes.push(`source-${ctx.externalSource}`);
      if (ctx.isOutdated) classes.push('is-outdated');
    }
    card.className = classes.join(' ');

    const sourceLabel = isExternal
      ? this._formatExternalSourceLabel(ctx.externalSource)
      : null;
    const label = isExternal
      ? (ctx.isFileLevel ? `${sourceLabel} file comment` : `${sourceLabel} comment`)
      : (ctx.isFileLevel ? 'file comment' : 'comment');
    const bodyPreview = ctx.body ? (ctx.body.length > 60 ? ctx.body.substring(0, 60) + '...' : ctx.body) : 'Comment';
    const fileInfo = ctx.file
      ? `${ctx.file}${ctx.line_start ? ':' + ctx.line_start : ''}`
      : '';

    // Author rendering — linked to externalUrl only when the URL passes
    // the scheme allowlist. Mirrors the external-comment-manager so
    // `javascript:` / `data:` URLs from a malicious upstream can't smuggle
    // a live `<a href>` into the DOM.
    let authorHTML = '';
    if (isExternal && ctx.author) {
      const escapedAuthor = this._escapeHtml(ctx.author);
      if (ctx.externalUrl && this._isSafeUrl(ctx.externalUrl)) {
        const escapedUrl = window.escapeHtmlAttribute
          ? window.escapeHtmlAttribute(ctx.externalUrl)
          : this._escapeHtml(ctx.externalUrl);
        authorHTML = `<a class="chat-panel__context-author" href="${escapedUrl}" target="_blank" rel="noopener noreferrer">${escapedAuthor}</a>`;
      } else {
        authorHTML = `<span class="chat-panel__context-author">${escapedAuthor}</span>`;
      }
    }

    const outdatedHTML = isExternal && ctx.isOutdated
      ? '<span class="chat-panel__context-badge chat-panel__context-badge--outdated">outdated</span>'
      : '';

    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
      </svg>
      <span class="chat-panel__context-label">${this._escapeHtml(label)}</span>
      ${authorHTML}
      ${outdatedHTML}
      <span class="chat-panel__context-title">${this._renderInlineMarkdown(bodyPreview)}</span>
      ${fileInfo ? `<span class="chat-panel__context-file">${this._escapeHtml(fileInfo)}</span>` : ''}
    `;

    // Store tooltip data for rich hover preview
    if (ctx.body) card.dataset.tooltipBody = ctx.body;

    if (removable) this._makeCardRemovable(card);

    this.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom({ force: true }));
  }

  /**
   * Add a compact context card for an external comment thread to the messages area.
   * Renders the thread header (source + file:line) and a list of comments,
   * each with author (linked to externalUrl when present), timestamp, body
   * (rendered as markdown), and an "outdated" badge when applicable.
   * @param {Object} ctx - Thread context data persisted by _sendThreadContextMessage.
   * @param {Object} [options] - Options
   * @param {boolean} [options.removable=false] - Whether the card should have a remove button
   */
  _addThreadContextCard(ctx, { removable = false } = {}) {
    const card = document.createElement('div');
    const externalSource = ctx.externalSource || null;
    // No --thread modifier: thread cards now use the same compact single-line
    // layout as line/file cards. The full thread content is exposed via the
    // card's title attribute (hover tooltip).
    const classes = ['chat-panel__context-card', 'external-comment-context'];
    if (externalSource) classes.push(`source-${externalSource}`);
    card.className = classes.join(' ');

    const sourceLabel = this._formatExternalSourceLabel(externalSource);
    const fileLabel = ctx.file || 'unknown file';
    let anchor = fileLabel;
    if (ctx.line_start) {
      anchor += `:${ctx.line_start}`;
      if (ctx.line_end && ctx.line_end !== ctx.line_start) {
        anchor += `-${ctx.line_end}`;
      }
    }
    const comments = Array.isArray(ctx.comments) ? ctx.comments : [];

    // Snippet from the first comment for the visible title slot. Stripped of
    // markdown syntax so the line reads cleanly when truncated by ellipsis.
    const firstBody = comments[0]?.body || '';
    const stripped = this._stripMarkdownForSnippet(firstBody);
    const snippet = stripped.length > 80 ? stripped.substring(0, 80) + '…' : stripped;

    // Full thread content for the hover tooltip — plain text, one comment per
    // block so the native title attribute (which respects newlines on most
    // platforms) gives the reviewer the full conversation on hover.
    const tooltip = comments.map((c, i) => {
      const author = c.author || 'unknown';
      const ts = c.externalCreatedAt ? ` · ${c.externalCreatedAt}` : '';
      const out = c.isOutdated ? ' (outdated)' : '';
      const body = (c.body || '(no body)').trim();
      return `${i + 1}. ${author}${ts}${out}\n${body}`;
    }).join('\n\n');

    card.setAttribute('title', tooltip);

    const countText = `${comments.length} comment${comments.length === 1 ? '' : 's'}`;

    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Z"/>
      </svg>
      <span class="chat-panel__context-label"><strong>${this._escapeHtml(sourceLabel.toUpperCase())} THREAD</strong></span>
      <span class="chat-panel__context-title">${snippet ? this._escapeHtml(snippet) : '<em>(empty)</em>'}</span>
      <span class="chat-panel__context-file">${this._escapeHtml(anchor)}</span>
      <span class="chat-panel__context-count">${countText}</span>
    `;

    if (removable) this._makeCardRemovable(card);

    this.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom({ force: true }));
  }

  /**
   * Strip a small set of common markdown syntax so a snippet reads cleanly
   * when truncated. Not a full parser — just enough to drop heading/list
   * markers, inline code backticks, and bold/italic emphasis.
   * @private
   */
  _stripMarkdownForSnippet(text) {
    if (!text) return '';
    return String(text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Add a compact context card for a line reference (optionally with body text).
   * @param {Object} ctx - Line context {file, line_start, line_end, body}
   */
  _addLineContextCard(ctx, { removable = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';

    const lineLabel = !ctx.line_start
      ? (ctx.file || 'File').split('/').pop()
      : (ctx.line_end && ctx.line_end !== ctx.line_start ? `Lines ${ctx.line_start}-${ctx.line_end}` : `Line ${ctx.line_start}`);
    const fileInfo = ctx.file
      ? `${ctx.file}${ctx.line_start ? ':' + ctx.line_start : ''}`
      : '';

    // When body text is provided (e.g. unsaved comment text), show it as the title
    const titleText = ctx.body
      ? (ctx.body.length > 60 ? ctx.body.substring(0, 60) + '...' : ctx.body)
      : lineLabel;

    const label = !ctx.line_start ? 'FILE' : (ctx.line_end && ctx.line_end !== ctx.line_start ? 'LINES' : 'LINE');

    // Code icon (octicon code-square)
    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"/>
      </svg>
      <span class="chat-panel__context-label"><strong>${label}</strong></span>
      <span class="chat-panel__context-title">${this._escapeHtml(titleText)}</span>
      ${fileInfo ? `<span class="chat-panel__context-file">${this._escapeHtml(fileInfo)}</span>` : ''}
    `;

    // Store tooltip data for rich hover preview when body text is present
    if (ctx.body) card.dataset.tooltipBody = ctx.body;

    if (removable) this._makeCardRemovable(card);

    this.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom());
  }

  /**
   * Add a compact context card to the messages area.
   * Visually indicates which suggestion the user is asking about,
   * without taking up space as a full message bubble.
   * @param {Object} ctx - Suggestion context {title, type, file, line_start, line_end, body}
   */
  _addContextCard(ctx, { removable = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';

    const typeLabel = ctx.type || 'suggestion';
    const fileInfo = ctx.file ? `${ctx.file}${ctx.line_start ? ':' + ctx.line_start : ''}` : '';

    card.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
      </svg>
      <span class="chat-panel__context-label">${this._renderInlineMarkdown(typeLabel)}</span>
      <span class="chat-panel__context-title">${this._renderInlineMarkdown(ctx.title || 'Untitled')}</span>
      ${fileInfo ? `<span class="chat-panel__context-file">${this._escapeHtml(fileInfo)}</span>` : ''}
    `;

    // Store tooltip data for rich hover preview
    if (ctx.body) card.dataset.tooltipBody = ctx.body;
    if (ctx.type) card.dataset.tooltipType = ctx.type;
    if (ctx.title) card.dataset.tooltipTitle = ctx.title;

    if (removable) this._makeCardRemovable(card);

    this.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom({ force: true }));
  }

  /**
   * Restore remove buttons and data-context-index on all pending context cards.
   * Called after a failed send to unlock cards that were locked prematurely.
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  _restoreRemovableCards(targetTab) {
    const tab = targetTab || this._getActiveTab();
    const messagesEl = tab?.messagesEl;
    if (!messagesEl) return;
    // Restore analysis context card if it was locked
    const analysisCard = messagesEl.querySelector('.chat-panel__context-card[data-analysis]');
    if (analysisCard && !analysisCard.querySelector('.chat-panel__context-remove')) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chat-panel__context-remove';
      removeBtn.title = 'Remove context';
      removeBtn.innerHTML = '\u00d7';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeAnalysisContextCard(analysisCard);
      });
      analysisCard.appendChild(removeBtn);
    }

    const cards = messagesEl.querySelectorAll('.chat-panel__context-card:not([data-analysis])');
    let idx = 0;
    cards.forEach((card) => {
      // Only restore cards that don't already have a remove button
      if (!card.querySelector('.chat-panel__context-remove')) {
        card.dataset.contextIndex = idx;
        const removeBtn = document.createElement('button');
        removeBtn.className = 'chat-panel__context-remove';
        removeBtn.title = 'Remove context';
        removeBtn.innerHTML = '\u00d7';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._removeContextCard(card);
        });
        card.appendChild(removeBtn);
      } else {
        card.dataset.contextIndex = idx;
      }
      idx++;
    });
  }

  /**
   * Remove a pending context card from the UI and data arrays.
   * Re-indexes remaining cards so data-context-index stays in sync.
   * @param {HTMLElement} cardEl - The context card element to remove
   */
  _removeContextCard(cardEl) {
    const tab = this._getActiveTab();
    const idx = parseInt(cardEl.dataset.contextIndex, 10);
    if (tab && !isNaN(idx) && idx >= 0 && idx < tab.pendingContext.length) {
      tab.pendingContext.splice(idx, 1);
      tab.pendingContextData.splice(idx, 1);
    }
    // Hide context tooltip – mouseleave won't fire on a removed element
    clearTimeout(this._ctxTooltipTimer);
    if (this._ctxTooltipEl) this._ctxTooltipEl.style.display = 'none';

    cardEl.remove();

    // Re-index remaining removable context cards
    const messagesEl = tab?.messagesEl;
    if (messagesEl) {
      const remainingCards = messagesEl.querySelectorAll('.chat-panel__context-card[data-context-index]');
      remainingCards.forEach((card, i) => {
        card.dataset.contextIndex = i;
      });
    }

    // If no pending context, no messages, and no other context cards, restore empty state
    if (tab && tab.pendingContext.length === 0 && tab.messages.length === 0 &&
        !tab.messagesEl?.querySelector('.chat-panel__context-card')) {
      this._clearMessages();
    }
  }

  /**
   * Show analysis context card if the session response includes context metadata.
   * Removes the empty state first so the card appears as the first element.
   * Accepts an explicit `tab` so the card lands in the originating tab even if
   * the user switched focus while the session POST was in flight.
   * @param {Object|null} sessionData - Response data from createSession
   *   ({ id, status, context? }) — pass null when called before a session is
   *   created (no-op in that case).
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  _showAnalysisContextIfPresent(sessionData, targetTab) {
    if (!sessionData || !sessionData.context || !(sessionData.context.suggestionCount > 0)) return;
    const tab = targetTab || this._getActiveTab();
    if (!tab || !tab.messagesEl) return;

    const existingCard = tab.messagesEl.querySelector('.chat-panel__context-card[data-analysis]');
    this._renderInTab(tab, () => {
      if (existingCard) {
        // Upgrade a bare-bones card (no metadata) with richer data from the backend.
        // Update IN-PLACE to preserve the card's DOM position (avoids jumping below user message).
        const hasRicherContext = !existingCard.dataset.hasMetadata &&
          (sessionData.context.provider || sessionData.context.model || sessionData.context.summary);
        if (!hasRicherContext) return;
        this._updateAnalysisCardContent(existingCard, sessionData.context);
      } else {
        const emptyState = tab.messagesEl.querySelector('.chat-panel__empty');
        if (emptyState) emptyState.remove();
        this._addAnalysisContextCard(sessionData.context);
      }
    });

    // Persist richer analysis context to DB (includes provider, model, summary, etc.)
    const contextData = { type: 'analysis', ...sessionData.context };
    if (tab.sessionId != null) {
      this._persistAnalysisContext(contextData, tab.sessionId);
    }

    // Track which run's context is loaded so _ensureAnalysisContext can skip if already present
    tab.sessionAnalysisRunId = sessionData.context.aiRunId || 'session';
  }

  /**
   * Build the inner HTML string for an analysis context card.
   * Shared by _addAnalysisContextCard (new card) and _updateAnalysisCardContent (in-place upgrade).
   * @param {Object} context - Context metadata { suggestionCount, provider, model, summary, configType }
   * @returns {string} HTML string for the card's content (SVG icon + label + title span)
   */
  _buildAnalysisCardInnerHTML(context) {
    const count = context.suggestionCount;
    const title = count === 1 ? '1 suggestion loaded' : `${count} suggestions loaded`;

    // Build metadata details string (model/provider info)
    const metaParts = [];
    if (context.provider) metaParts.push(this._escapeHtml(context.provider));
    if (context.model) metaParts.push(this._escapeHtml(context.model));
    const metaStr = metaParts.length > 0 ? ` (${metaParts.join(' / ')})` : '';

    // Build tooltip with provider, model, config, and summary (no title, no completedAt here since it's formatted for display)
    const tooltipParts = [];
    if (context.provider || context.model) {
      tooltipParts.push(`Provider: ${context.provider || 'unknown'}, Model: ${context.model || 'unknown'}`);
    }
    if (context.configType) tooltipParts.push(`Config: ${context.configType}`);
    if (context.completedAt) {
      const completedDate = window.parseTimestamp(context.completedAt);
      tooltipParts.push(`Completed: ${completedDate.toLocaleString()}`);
    }
    if (context.summary) tooltipParts.push(`Summary: ${context.summary}`);
    const tooltip = tooltipParts.join('\n');

    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12">
        <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
      </svg>
      <span class="chat-panel__context-label">analysis run</span>
      <span class="chat-panel__context-title" title="${window.escapeHtmlAttribute(tooltip)}">${this._escapeHtml(title)}${metaStr}</span>
    `;
  }

  /**
   * Update an existing analysis context card's content and dataset in-place.
   * Preserves the card's DOM position (avoids remove+recreate which causes ordering bugs).
   * @param {HTMLElement} card - The existing analysis context card element
   * @param {Object} context - Richer context metadata from the backend
   */
  _updateAnalysisCardContent(card, context) {
    // Preserve existing remove button (if card is removable) before replacing innerHTML
    const removeBtn = card.querySelector('.chat-panel__context-remove');

    // Rebuild card innerHTML with richer metadata
    card.innerHTML = this._buildAnalysisCardInnerHTML(context);

    // Re-append the remove button if it existed
    if (removeBtn) {
      card.appendChild(removeBtn);
    }

    // Update dataset attributes
    if (context.aiRunId) {
      card.dataset.analysisRunId = context.aiRunId;
    }
    if (context.provider || context.model || context.summary) {
      card.dataset.hasMetadata = 'true';
    }
  }

  /**
   * Add a compact analysis-run context card to the messages area.
   * Used for manually-added analysis run cards that participate in the pending
   * context arrays (data-context-index path).  Unlike _addAnalysisContextCard
   * (auto-added, data-analysis="true"), these cards use _removeContextCard.
   * @param {Object} ctxData - Context data { type, aiRunId, provider, model, summary, suggestionCount, configType }
   * @param {Object} [opts] - Options
   * @param {boolean} [opts.removable=false] - Whether the card should have a remove button
   */
  _addAnalysisRunContextCard(ctxData, { removable = false } = {}, targetTab) {
    const tab = targetTab || this._getActiveTab();
    if (!tab?.messagesEl) return;
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';
    card.dataset.contextIndex = tab.pendingContext.length - 1;
    card.dataset.analysisRunId = ctxData.aiRunId;
    card.innerHTML = this._buildAnalysisCardInnerHTML(ctxData);

    // _makeCardRemovable reads `tab.pendingContextData.length` via the active
    // tab getter, so re-route the active marker temporarily.
    if (removable) {
      this._renderInTab(tab, () => this._makeCardRemovable(card));
    }

    tab.messagesEl.appendChild(card);
    requestAnimationFrame(() => this.scrollToBottom({ force: true }));
  }

  /**
   * Add a compact analysis context card to the messages area.
   * Visually indicates that the agent has analysis suggestions loaded as context.
   * Displays run metadata (model, provider, summary) when available.
   * @param {Object} context - Context metadata { suggestionCount, aiRunId, provider, model, summary, completedAt, configType, parentRunId }
   */
  _addAnalysisContextCard(context, { removable = false, prepend = false } = {}) {
    const card = document.createElement('div');
    card.className = 'chat-panel__context-card';
    card.dataset.analysis = 'true';
    if (context.aiRunId) {
      card.dataset.analysisRunId = context.aiRunId;
    }
    if (context.provider || context.model || context.summary) {
      card.dataset.hasMetadata = 'true';
    }

    card.innerHTML = this._buildAnalysisCardInnerHTML(context);

    if (removable) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chat-panel__context-remove';
      removeBtn.title = 'Remove context';
      removeBtn.innerHTML = '\u00d7';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeAnalysisContextCard(card);
      });
      card.appendChild(removeBtn);
    }

    if (prepend) {
      const firstChild = this.messagesEl.firstChild;
      if (firstChild) {
        this.messagesEl.insertBefore(card, firstChild);
      } else {
        this.messagesEl.appendChild(card);
      }
    } else {
      this.messagesEl.appendChild(card);
    }
    requestAnimationFrame(() => this.scrollToBottom({ force: true }));
  }

  /**
   * Persist an analysis context card to the backend as a 'context' message.
   * Called immediately when an analysis context card is added, so it appears
   * in the conversation history on reload.
   *
   * Tab-aware callers pass an explicit sessionId so the persist write isn't
   * routed to the active tab's session when focus has shifted between the
   * card being added and the network call landing.
   *
   * @param {Object} contextData - Analysis context metadata (type, suggestionCount, etc.)
   * @param {number} [explicitSessionId] - Defaults to this.currentSessionId.
   */
  async _persistAnalysisContext(contextData, explicitSessionId) {
    const sessionId = explicitSessionId != null ? explicitSessionId : this.currentSessionId;
    if (!sessionId) return;
    try {
      const response = await fetch(`/api/chat/session/${sessionId}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextData })
      });
      if (!response.ok) {
        console.warn('[ChatPanel] Failed to persist analysis context:', response.status);
      }
    } catch (err) {
      console.warn('[ChatPanel] Failed to persist analysis context:', err);
    }
  }

  /**
   * Ensure the review-scoped WebSocket subscription is established. Per-tab
   * chat subscriptions are managed independently via _subscribeTab() as tabs
   * are created.
   */
  _ensureSubscriptions() {
    window.wsClient.connect();

    if (this.reviewId && !this._reviewUnsub) {
      this._reviewUnsub = window.wsClient.subscribe('review:' + this.reviewId, (msg) => {
        if (msg.type?.startsWith('review:')) {
          document.dispatchEvent(new CustomEvent(msg.type, {
            detail: { ...msg }
          }));
        }
      });
    }

    // Resubscribe any open tabs that may have lost their handles (e.g. after
    // late-binding a reviewId).
    for (const tab of this.tabs) {
      if (tab.sessionId != null && !tab.wsUnsub) {
        this._subscribeTab(tab);
      }
    }

    if (!this._onReconnect) {
      this._onReconnect = () => { this._recoverAfterReconnect(); };
      window.addEventListener('wsReconnected', this._onReconnect);
    }
  }

  /**
   * Recover streaming state for every open tab after a WebSocket reconnect.
   * Each tab independently re-fetches its latest assistant message if it was
   * mid-stream when the connection dropped.
   */
  async _recoverAfterReconnect() {
    await Promise.all(this.tabs.map((tab) => this._recoverTabAfterReconnect(tab)));
  }

  async _recoverTabAfterReconnect(tab) {
    if (!tab?.isStreaming || tab.sessionId == null) return;
    const capturedSessionId = tab.sessionId;
    try {
      const response = await fetch(`/api/chat/session/${tab.sessionId}/messages`);
      if (!this.tabs.includes(tab) || tab.sessionId !== capturedSessionId) return;
      if (!response.ok) return;
      const result = await response.json();
      if (!this.tabs.includes(tab) || tab.sessionId !== capturedSessionId) return;
      const messages = result.data?.messages || [];
      let lastAssistant = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'message' && messages[i].role === 'assistant') {
          lastAssistant = messages[i];
          break;
        }
      }
      if (lastAssistant?.content) {
        tab.streamingContent = lastAssistant.content;
        this._finalizeTabStream(tab, lastAssistant.id);
        tab.streamingContent = '';
        if (this.isOpen && this._getActiveTab() === tab) {
          this._finalizeStreaming(tab);
        } else {
          tab.isStreaming = false;
          this._updateTabStatus(tab, 'idle');
        }
      }
    } catch (err) {
      console.warn('[ChatPanel] Failed to recover stream after reconnect:', err);
    }
  }

  /**
   * Handle a WebSocket event for a specific tab. Foreground tabs render
   * directly to the DOM; background tabs accumulate state silently so it
   * is visible when the user clicks back.
   * @param {ChatTab} tab
   * @param {Object} data - Parsed WS message
   */
  _handleChatMessageForTab(tab, data) {
    try {
      if (data.sessionId !== tab.sessionId) {
        console.warn(`[ChatPanel] sessionId mismatch on tab ${tab.sessionId}: got ${data.sessionId}`);
        return;
      }

      if (data.type !== 'delta') {
        console.debug('[ChatPanel] WS event:', data.type, 'tab:', tab.sessionId);
      }

      const isActive = this.isOpen && this._getActiveTab() === tab;

      // Background tab (or panel closed): drive the per-tab DOM via tab-aware
      // helpers so a tab switch reveals the same content the user would have
      // seen had it been in the foreground all along.
      if (!isActive) {
        switch (data.type) {
          case 'delta':
            if (!tab.streamingMsgEl) this._addStreamingPlaceholder(tab);
            tab.streamingContent += data.text;
            this.updateStreamingMessage(tab.streamingContent, tab);
            this._markStreaming(tab);
            break;
          case 'status':
            if (data.status === 'working') this._markStreaming(tab);
            break;
          case 'complete':
            this._finalizeTabStream(tab, data.messageId);
            tab.streamingContent = '';
            tab.isStreaming = false;
            tab.errorMessage = null;
            this._updateTabStatus(tab, 'idle');
            break;
          case 'error':
            // Render the error inline so the user sees what happened when
            // they switch back to this tab.
            this._showError(data.message || 'An error occurred', tab);
            this._finalizeTabStream(tab, null);
            tab.streamingContent = '';
            tab.isStreaming = false;
            break;
        }
        return;
      }

      // Foreground path — drive the DOM directly
      switch (data.type) {
        case 'delta':
          this._hideThinkingIndicator(tab);
          tab.streamingContent += data.text;
          this.updateStreamingMessage(tab.streamingContent, tab);
          break;
        case 'tool_use':
          this._showToolUse(data.toolName, data.status, data.toolInput, tab);
          break;
        case 'status':
          this._handleAgentStatus(data.status, tab);
          break;
        case 'complete':
          tab.errorMessage = null;
          this.finalizeStreamingMessage(data.messageId, tab);
          break;
        case 'error':
          tab.errorMessage = data.message || 'An error occurred';
          this._updateTabStatus(tab, 'error');
          this._showError(tab.errorMessage, tab);
          this._finalizeStreaming(tab);
          break;
      }
    } catch (e) {
      console.error('[ChatPanel] WS parse error:', e);
    }
  }

  /**
   * Close the review-scope subscription and every tab's chat subscription.
   */
  _closeSubscriptions() {
    for (const tab of this.tabs) {
      if (tab.wsUnsub) { try { tab.wsUnsub(); } catch { /* noop */ } tab.wsUnsub = null; }
    }
    if (this._reviewUnsub) { this._reviewUnsub(); this._reviewUnsub = null; }
    if (this._onReconnect) {
      window.removeEventListener('wsReconnected', this._onReconnect);
      this._onReconnect = null;
    }
  }

  /**
   * Add a message to the display.
   * @param {string} role - 'user' or 'assistant'
   * @param {string} content - Message text
   * @param {number} [id] - Optional message ID
   * @param {ChatTab} [targetTab] - Explicit tab; defaults to active tab
   * @returns {HTMLElement} The message element that was appended
   */
  addMessage(role, content, id, targetTab) {
    const tab = targetTab || this._getActiveTab();
    if (!tab || !tab.messagesEl) return null;

    const msg = { role, content, id };
    tab.messages.push(msg);

    const msgEl = document.createElement('div');
    msgEl.className = `chat-panel__message chat-panel__message--${role}`;
    if (id) msgEl.dataset.messageId = id;

    const bubble = document.createElement('div');
    bubble.className = 'chat-panel__bubble';

    if (role === 'assistant') {
      bubble.innerHTML = this.renderMarkdown(content);
      this._linkifyFileReferences(bubble);
      bubble.appendChild(this._createCopyButton(content));
    } else {
      bubble.textContent = content;
    }

    msgEl.appendChild(bubble);
    tab.messagesEl.appendChild(msgEl);

    // Update the tab title from the first user message if the user hasn't
    // explicitly named it. Only do this when no prior user message exists.
    if (role === 'user' && !tab.titleFromUser) {
      const preview = this._truncate(content, 28);
      if (preview) {
        tab.titleFromUser = true;
        this._setTabTitle(tab, preview);
      }
    }

    if (this._getActiveTab() === tab) this.scrollToBottom({ force: true });
    return msgEl;
  }

  /**
   * Create a copy-to-clipboard button for an assistant message bubble.
   * @param {string} rawContent - Raw markdown to copy
   * @returns {HTMLButtonElement}
   */
  _createCopyButton(rawContent) {
    const btn = document.createElement('button');
    btn.className = 'chat-panel__copy-btn';
    btn.title = 'Copy message';
    const clipboardIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
    </svg>`;
    const checkIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
    </svg>`;
    btn.innerHTML = clipboardIcon;

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(rawContent);
        btn.innerHTML = checkIcon;
        btn.classList.add('chat-panel__copy-btn--success');
        setTimeout(() => {
          btn.innerHTML = clipboardIcon;
          btn.classList.remove('chat-panel__copy-btn--success');
        }, 2000);
      } catch (err) {
        console.error('[ChatPanel] Copy failed:', err);
        btn.title = 'Copy failed';
        setTimeout(() => { btn.title = 'Copy message'; }, 2000);
      }
    });

    return btn;
  }

  /**
   * Add a streaming placeholder for the assistant's response on a tab.
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  _addStreamingPlaceholder(targetTab) {
    const tab = targetTab || this._getActiveTab();
    if (!tab || !tab.messagesEl) return;
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-panel__message chat-panel__message--assistant chat-panel__message--streaming';

    const bubble = document.createElement('div');
    bubble.className = 'chat-panel__bubble';
    bubble.innerHTML = getChatSpinnerHTML();

    msgEl.appendChild(bubble);
    tab.messagesEl.appendChild(msgEl);
    tab.streamingMsgEl = msgEl;
    if (this._getActiveTab() === tab) this.scrollToBottom({ force: true });
  }

  /**
   * Update the streaming message on a tab.
   * @param {string} text - Full accumulated text so far
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  updateStreamingMessage(text, targetTab) {
    const tab = targetTab || this._getActiveTab();
    const streamingMsg = tab?.streamingMsgEl;
    if (!streamingMsg) return;

    const transient = streamingMsg.querySelector('.chat-panel__tool-badge--transient');
    if (transient) transient.remove();

    const bubble = streamingMsg.querySelector('.chat-panel__bubble');
    if (bubble) {
      bubble.innerHTML = this.renderMarkdown(text) + '<span class="chat-panel__cursor"></span>';
      this._linkifyFileReferences(bubble);
    }
    if (this._getActiveTab() === tab) this.scrollToBottom();
  }

  /**
   * Finalize the streaming message on a tab. Idempotent — a second call when
   * streamingMsgEl is already null is a no-op.
   * @param {number} messageId - Database message ID
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  finalizeStreamingMessage(messageId, targetTab) {
    const tab = targetTab || this._getActiveTab();
    if (!tab) return;
    this._finalizeTabStream(tab, messageId);
    this._finalizeStreaming(tab);
  }

  /**
   * Tab-aware DOM finalization helper. Writes the final streamed content into
   * `tab.streamingMsgEl`, strips streaming/cursor classes, pushes the message
   * into `tab.messages`, and nulls `tab.streamingMsgEl`. Safe to call twice.
   * @param {ChatTab} tab
   * @param {number} [messageId]
   */
  _finalizeTabStream(tab, messageId) {
    if (!tab) return;
    const streamingMsg = tab.streamingMsgEl;
    if (streamingMsg) {
      streamingMsg.classList.remove('chat-panel__message--streaming');
      if (messageId) streamingMsg.dataset.messageId = messageId;

      const cursor = streamingMsg.querySelector('.chat-panel__cursor');
      if (cursor) cursor.remove();
      const thinking = streamingMsg.querySelector('.chat-panel__thinking');
      if (thinking) thinking.remove();

      const transientBadge = streamingMsg.querySelector('.chat-panel__tool-badge--transient');
      if (transientBadge) transientBadge.remove();

      const spinners = streamingMsg.querySelectorAll('.chat-panel__tool-spinner');
      spinners.forEach(s => s.remove());

      const bubble = streamingMsg.querySelector('.chat-panel__bubble');
      if (bubble) {
        if (tab.streamingContent) {
          bubble.innerHTML = this.renderMarkdown(tab.streamingContent);
          this._linkifyFileReferences(bubble);
          bubble.appendChild(this._createCopyButton(tab.streamingContent));
        } else {
          bubble.innerHTML = '<em class="chat-panel__empty-response">No response generated.</em>';
        }
      }
    }

    if (tab.streamingContent) {
      tab.messages.push({ role: 'assistant', content: tab.streamingContent, id: messageId });
    }
    tab.streamingMsgEl = null;
  }

  /**
   * Abort the current agent turn on the originating tab. Captures the tab
   * at entry so a focus change between the user clicking Stop and the abort
   * round-trip resolving can't finalize the wrong tab's stream.
   */
  async _stopAgent() {
    const tab = this._getActiveTab();
    if (!tab || !tab.isStreaming || tab.sessionId == null) return;
    try {
      await fetch(`/api/chat/session/${tab.sessionId}/abort`, { method: 'POST' });
    } catch (error) {
      console.error('[ChatPanel] Error aborting:', error);
    }
    if (!this.tabs.includes(tab)) return;
    // Finalize the streaming message with whatever content we have so far.
    this.finalizeStreamingMessage(null, tab);
  }

  /**
   * Clean up streaming state on a tab. UI controls are only touched when the
   * tab is currently active.
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  _finalizeStreaming(targetTab) {
    const tab = targetTab || this._getActiveTab();
    if (tab) {
      tab.isStreaming = false;
      tab.streamingContent = '';
      tab.streamingMsgEl = null;
      this._updateTabStatus(tab, tab.errorMessage ? 'error' : 'idle');
    }
    if (!tab || this._getActiveTab() === tab) {
      this.sendBtn.style.display = '';
      this.stopBtn.style.display = 'none';
      this.sendBtn.disabled = !this.inputEl?.value?.trim();
      this._updateActionButtons();
      this.inputEl?.focus();
    }
  }

  /**
   * Show a tool use indicator in a tab's streaming message.
   * @param {string} toolName - Name of the tool being used
   * @param {string} status - 'start' or 'end'
   * @param {Object} [toolInput] - Tool input/arguments (optional)
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  _showToolUse(toolName, status, toolInput, targetTab) {
    if (!toolName) return;
    const tab = targetTab || this._getActiveTab();
    const streamingMsg = tab?.streamingMsgEl;
    if (!streamingMsg) return;

    const isTask = toolName.toLowerCase() === 'task' || toolName.toLowerCase() === 'agent';

    if (status === 'start') {
      this._hideThinkingIndicator();
      const argSummary = this._summarizeToolInput(toolName, toolInput);

      const badgeHTML = `
        <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
          <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
        </svg>
        <span>${this._escapeHtml(toolName)}</span>${argSummary ? `<span class="chat-panel__tool-args" title="${window.escapeHtmlAttribute(argSummary)}">${this._escapeHtml(argSummary)}</span>` : ''}
        <span class="chat-panel__tool-spinner"></span>
      `;

      if (isTask) {
        // Task tools get persistent badges (meaningful delegated work)
        const badge = document.createElement('div');
        badge.className = 'chat-panel__tool-badge';
        badge.dataset.tool = toolName;
        badge.innerHTML = badgeHTML;
        const bubble = streamingMsg.querySelector('.chat-panel__bubble');
        streamingMsg.insertBefore(badge, bubble);
      } else {
        // Non-Task tools reuse a single transient badge
        let badge = streamingMsg.querySelector('.chat-panel__tool-badge--transient');
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'chat-panel__tool-badge chat-panel__tool-badge--transient';
          const bubble = streamingMsg.querySelector('.chat-panel__bubble');
          streamingMsg.insertBefore(badge, bubble);
        }
        badge.dataset.tool = toolName;
        badge.innerHTML = badgeHTML;
      }
    } else {
      if (isTask) {
        // Remove spinner from completed Task badge
        const badges = streamingMsg.querySelectorAll('.chat-panel__tool-badge[data-tool="Task"]:not(.chat-panel__tool-badge--transient), .chat-panel__tool-badge[data-tool="Agent"]:not(.chat-panel__tool-badge--transient)');
        badges.forEach(b => {
          const spinner = b.querySelector('.chat-panel__tool-spinner');
          if (spinner) spinner.remove();
        });
      } else {
        // Remove spinner from transient badge (badge stays until text arrives or next tool starts)
        const transient = streamingMsg.querySelector('.chat-panel__tool-badge--transient');
        if (transient) {
          const spinner = transient.querySelector('.chat-panel__tool-spinner');
          if (spinner) spinner.remove();
        }
      }
      this._showThinkingIndicator(tab);
    }
  }

  /**
   * Extract a compact summary string from tool input for display.
   * @param {string} toolName - Name of the tool
   * @param {Object} [input] - Tool input/arguments
   * @returns {string} Compact summary or empty string
   */
  _summarizeToolInput(toolName, input) {
    if (!input || typeof input !== 'object') return '';

    const name = toolName.toLowerCase();
    switch (name) {
      case 'bash': {
        let cmd = input.command || '';
        // Strip "cd <path> && " prefix — the actual command is more interesting
        cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, '');
        return cmd;
      }
      case 'read':
        return input.file_path || input.path || '';
      case 'grep':
        return input.pattern || '';
      case 'glob':
        return input.pattern || '';
      case 'find':
      case 'ls':
        return input.path || '';
      case 'write':
      case 'edit':
        return input.file_path || input.path || '';
      default: {
        // For unknown tools, show the first string-valued argument
        const vals = Object.values(input);
        for (const v of vals) {
          if (typeof v === 'string' && v.length > 0) return v;
        }
        return '';
      }
    }
  }

  /**
   * Handle agent status events from the backend.
   * @param {string} status - 'working' or 'turn_complete'
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  _handleAgentStatus(status, targetTab) {
    const tab = targetTab || this._getActiveTab();
    if (status === 'working') {
      this._showThinkingIndicator(tab);
      this._markStreaming(tab);
    }
    // 'turn_complete' is informational; the agent may start another turn
  }

  /**
   * Mark a tab as streaming if it is not already. Used by foreground and
   * background status arms to set the per-tab flag + status dot in one place.
   * Short-circuits if already streaming — preserves errorMessage from being
   * cleared mid-stream.
   * @param {ChatTab} tab
   */
  _markStreaming(tab) {
    if (!tab || tab.isStreaming) return;
    tab.isStreaming = true;
    this._updateTabStatus(tab, 'streaming');
  }

  /**
   * Show the pulsing thinking indicator on a tab's streaming message.
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  _showThinkingIndicator(targetTab) {
    const tab = targetTab || this._getActiveTab();
    const streamingMsg = tab?.streamingMsgEl;
    if (!streamingMsg) return;

    // Don't add duplicate
    if (streamingMsg.querySelector('.chat-panel__thinking')) return;

    // Don't add if the bubble still has its initial spinner (no content yet).
    const bubble = streamingMsg.querySelector('.chat-panel__bubble');
    if (bubble && (bubble.querySelector('.chat-panel__typing-indicator') || bubble.querySelector('.chat-panel__loop-spinner'))) return;

    const cursor = bubble?.querySelector('.chat-panel__cursor');
    if (cursor) cursor.remove();

    const indicator = document.createElement('div');
    indicator.className = 'chat-panel__thinking';
    indicator.innerHTML = getChatSpinnerHTML();
    streamingMsg.appendChild(indicator);
    if (this._getActiveTab() === tab) this.scrollToBottom();
  }

  /**
   * Hide the thinking indicator on a tab's streaming message.
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  _hideThinkingIndicator(targetTab) {
    const tab = targetTab || this._getActiveTab();
    const streamingMsg = tab?.streamingMsgEl;
    if (!streamingMsg) return;
    const thinking = streamingMsg.querySelector('.chat-panel__thinking');
    if (thinking) thinking.remove();
  }

  /**
   * Show an error message in a tab.
   * @param {string} message - Error text
   * @param {ChatTab} [targetTab] - Defaults to active tab
   */
  _showError(message, targetTab) {
    const tab = targetTab || this._getActiveTab();
    if (tab) {
      tab.errorMessage = message;
      this._updateTabStatus(tab, 'error');
    }
    const messagesEl = tab?.messagesEl;
    if (!messagesEl) return;
    const errorEl = document.createElement('div');
    errorEl.className = 'chat-panel__message chat-panel__message--error';
    errorEl.innerHTML = `
      <div class="chat-panel__error-bubble">
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
          <path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/>
        </svg>
        ${this._escapeHtml(message)}
      </div>
    `;
    messagesEl.appendChild(errorEl);
    if (this._getActiveTab() === tab) this.scrollToBottom({ force: true });
  }

  /**
   * Show an auto-dismissing toast notification overlaid at the border between
   * the header and messages area.  Appended to the outer .chat-panel container
   * (which has position:relative) so it stays visible regardless of scroll
   * position in the messages area.
   * @param {string} message - Text to display
   */
  _showToast(message) {
    // Remove any existing toast
    const existing = this.panel?.querySelector('.chat-panel__toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'chat-panel__toast';
    toast.textContent = message;

    // Append to the outer chat-panel container so the toast is positioned
    // relative to it (not inside the scrollable messages area).
    if (this.panel) {
      this.panel.appendChild(toast);
    }

    // Auto-dismiss after 2.5 seconds
    setTimeout(() => {
      toast.classList.add('chat-panel__toast--dismissing');
      toast.addEventListener('animationend', () => toast.remove());
    }, 2500);
  }

  /**
   * Post-process a container element to convert [[file:...]] tokens into
   * clickable links that scroll to the file in the diff.
   *
   * Supported formats:
   *   [[file:path/to/file.ext]]           -> file only
   *   [[file:path/to/file.ext:42]]        -> file + line
   *   [[file:path/to/file.ext:42-78]]     -> file + line range
   *
   * Tokens inside <pre> blocks are left untouched.
   *
   * @param {HTMLElement} container - Element whose text nodes to scan
   */
  _linkifyFileReferences(container) {
    if (!container || typeof document.createTreeWalker !== 'function') return;

    const FILE_TOKEN = /\[\[file:([^\]]+?)(?::(\d+)(?:-(\d+))?)?\]\]/g;

    // Collect text nodes that contain tokens (avoid mutating during traversal)
    // NodeFilter.SHOW_TEXT === 4; use literal for environments without NodeFilter global
    const SHOW_TEXT = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
    const walker = document.createTreeWalker(container, SHOW_TEXT);
    const candidates = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      // Skip anything inside a <pre> (code block)
      if (node.parentElement?.closest('pre')) continue;
      FILE_TOKEN.lastIndex = 0;
      if (FILE_TOKEN.test(node.textContent)) {
        candidates.push(node);
      }
    }

    for (const node of candidates) {
      const fragment = document.createDocumentFragment();
      const text = node.textContent;
      let lastIndex = 0;

      FILE_TOKEN.lastIndex = 0;
      let match;
      while ((match = FILE_TOKEN.exec(text)) !== null) {
        // Add any text before this match
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const filePath = match[1];
        const lineStart = match[2] || null;
        const lineEnd = match[3] || null;

        // Build the clickable link
        const link = document.createElement('a');
        link.className = 'chat-file-link';
        link.dataset.file = filePath;
        if (lineStart) link.dataset.lineStart = lineStart;
        if (lineEnd) link.dataset.lineEnd = lineEnd;
        link.title = 'View in diff';

        // File icon SVG
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 16 16');
        icon.setAttribute('fill', 'currentColor');
        icon.setAttribute('width', '12');
        icon.setAttribute('height', '12');
        icon.classList.add('chat-file-link__icon');
        const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathEl.setAttribute('d', 'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z');
        icon.appendChild(pathEl);

        // Display text: show the file reference naturally
        let displayText = filePath;
        if (lineStart && lineEnd) {
          displayText += `:${lineStart}-${lineEnd}`;
        } else if (lineStart) {
          displayText += `:${lineStart}`;
        }

        link.appendChild(icon);
        link.appendChild(document.createTextNode(' ' + displayText));

        fragment.appendChild(link);
        lastIndex = match.index + match[0].length;
      }

      // Add any remaining text after the last match
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      node.parentNode.replaceChild(fragment, node);
    }
  }

  /**
   * Handle click on a chat file link. Scrolls to the referenced file and line
   * in the diff view.
   * @param {HTMLElement} linkEl - The clicked .chat-file-link element
   */
  async _handleFileLinkClick(linkEl) {
    const file = linkEl.dataset.file;
    const lineStart = linkEl.dataset.lineStart ? parseInt(linkEl.dataset.lineStart, 10) : null;
    const lineEnd = linkEl.dataset.lineEnd ? parseInt(linkEl.dataset.lineEnd, 10) : null;

    // Check if file wrapper exists in DOM
    const wrapper = document.querySelector(`[data-file-name="${CSS.escape(file)}"]`);

    if (wrapper) {
      // File is already rendered — scroll to it
      const contextEl = wrapper.closest('.context-file');
      if (contextEl) {
        // Context file — find the right chunk by line number or use first chunk
        let contextFileId = contextEl.dataset?.contextId; // legacy: on wrapper itself
        let lineFoundInChunk = !!contextFileId; // legacy mode assumes line is present
        if (!contextFileId && lineStart) {
          // Merged wrapper: find chunk tbody containing this line
          const chunks = [...contextEl.querySelectorAll('tbody.context-chunk[data-context-id]')];
          for (const chunk of chunks) {
            const row = chunk.querySelector(`tr[data-line-number="${lineStart}"]`);
            if (row) {
              contextFileId = chunk.dataset.contextId;
              lineFoundInChunk = true;
              break;
            }
          }
        }

        if (lineFoundInChunk || !lineStart) {
          if (!contextFileId) {
            const firstChunk = contextEl.querySelector('tbody.context-chunk[data-context-id]');
            if (firstChunk) contextFileId = firstChunk.dataset.contextId;
          }
          if (window.prManager?.scrollToContextFile) {
            window.prManager.scrollToContextFile(file, lineStart, contextFileId);
          }
          return;
        }
        // Line not found in any existing chunk — fall through to add new range
      } else {
        // Diff file
        if (lineStart) {
          await this._scrollToLine(file, lineStart, lineEnd);
        } else if (window.prManager?.scrollToFile) {
          window.prManager.scrollToFile(file);
        }
        return;
      }
    }

    // File not in DOM — try to add as context file
    if (!window.prManager?.ensureContextFile) return;

    linkEl.classList.add('chat-file-link--loading');
    try {
      const result = await window.prManager.ensureContextFile(file, lineStart, lineEnd);

      if (!result) {
        this._showToast('Could not load file');
        return;
      }

      if (result.type === 'diff') {
        if (lineStart) {
          await this._scrollToLine(file, lineStart, lineEnd);
        } else if (window.prManager?.scrollToFile) {
          window.prManager.scrollToFile(file);
        }
      } else if (result.type === 'context') {
        // Brief delay for DOM to settle after loadContextFiles
        await new Promise(resolve => setTimeout(resolve, 100));
        if (window.prManager.scrollToContextFile) {
          window.prManager.scrollToContextFile(file, lineStart, result.contextFile?.id);
        }
      }
    } catch (err) {
      console.error('[ChatPanel] Error handling file link click:', err);
      this._showToast('Could not load file');
    } finally {
      linkEl.classList.remove('chat-file-link--loading');
    }
  }

  /**
   * Scroll to a specific line within a file wrapper, applying a bold
   * left-border + background highlight that fades over ~3.5s.
   * Supports line ranges: if lineEnd is provided, all rows from
   * lineStart to lineEnd are highlighted. If the line is in a collapsed
   * diff chunk, expands the chunk first via ensureLinesVisible().
   * @param {string} file - File path
   * @param {number} lineStart - Target line number (start of range)
   * @param {number|null} [lineEnd] - End of target line range (used for expansion)
   * @param {HTMLElement} [fileWrapper] - Pre-resolved file wrapper element
   */
  async _scrollToLine(file, lineStart, lineEnd, fileWrapper) {
    if (!fileWrapper) {
      const escaped = CSS.escape(file);
      fileWrapper = document.querySelector(`[data-file-name="${escaped}"]`) ||
        document.querySelector(`[data-file-name$="/${escaped}"]`);
    }
    if (!fileWrapper) return;

    // Collect all target rows (single line or range)
    const end = lineEnd || lineStart;
    let targetRows = this._findLineRows(fileWrapper, lineStart, end);

    // If not found, try expanding the collapsed diff context
    if (targetRows.length === 0 && window.prManager?.ensureLinesVisible) {
      await window.prManager.ensureLinesVisible([
        { file, line_start: lineStart, line_end: end, side: 'RIGHT' }
      ]);
      targetRows = this._findLineRows(fileWrapper, lineStart, end);
    }
    if (targetRows.length === 0) return;

    const primaryRow = targetRows[0];

    // Check if the primary target row is already visible in the viewport
    const rect = primaryRow.getBoundingClientRect();
    const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;

    if (!isVisible) {
      primaryRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Apply the highlight to all target rows
    for (const row of targetRows) {
      // Remove any existing highlight first (in case of rapid re-clicks)
      row.classList.remove('chat-line-highlight');
      // Force reflow so re-adding the class restarts the animation
      void row.offsetWidth;
      row.classList.add('chat-line-highlight');
      row.addEventListener('animationend', () => {
        row.classList.remove('chat-line-highlight');
      }, { once: true });
    }
  }

  /**
   * Find all table rows matching a line range within a file wrapper.
   * @param {HTMLElement} fileWrapper - The file wrapper element
   * @param {number} lineStart - Start line number
   * @param {number} lineEnd - End line number (inclusive)
   * @returns {HTMLElement[]} Matching rows
   */
  _findLineRows(fileWrapper, lineStart, lineEnd) {
    const rows = [];
    const lineNums = fileWrapper.querySelectorAll('.line-num2');
    for (const ln of lineNums) {
      const num = parseInt(ln.textContent.trim(), 10);
      if (!isNaN(num) && num >= lineStart && num <= lineEnd) {
        const row = ln.closest('tr');
        if (row) rows.push(row);
      }
    }
    return rows;
  }

  /**
   * Render markdown text to HTML
   * @param {string} text - Markdown text
   * @returns {string} HTML string
   */
  renderMarkdown(text) {
    if (!text) return '';
    // Use the global renderMarkdown if available (from markdown.js utility)
    if (window.renderMarkdown) {
      return window.renderMarkdown(text);
    }
    // Basic fallback: escape and convert newlines
    return this._escapeHtml(text).replace(/\n/g, '<br>');
  }

  /**
   * Render markdown to inline HTML (strips outer <p> wrapper).
   * Useful for context card labels/titles where block-level wrapping is unwanted.
   * @param {string} text - Markdown text
   * @returns {string} Inline HTML string
   */
  _renderInlineMarkdown(text) {
    if (!text) return '';
    const html = this.renderMarkdown(text);
    return html.replace(/^<p>([\s\S]*?)<\/p>\s*$/, '$1');
  }

  /**
   * Escape HTML special characters
   * @param {string} text - Raw text
   * @returns {string} Escaped text
   */
  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Allow only http/https/mailto URLs in href attributes. Used to gate
   * server-supplied URLs (external comment permalinks, profile URLs) so a
   * malicious upstream cannot smuggle `javascript:` or `data:` schemes
   * into our DOM.
   * @param {string} url
   * @returns {boolean}
   */
  _isSafeUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) return true;
    try {
      const base = (typeof window !== 'undefined' && window.location) ? window.location.href : 'http://localhost/';
      const u = new URL(trimmed, base);
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
    } catch {
      return false;
    }
  }

  /**
   * Auto-scroll messages to bottom.
   * When force is true (user-initiated actions), always scrolls.
   * When force is false (streaming content), only scrolls if already near the bottom.
   * @param {{ force?: boolean }} options
   */
  scrollToBottom({ force = false } = {}) {
    if (!this.messagesEl) return;
    if (!force && this._userScrolledAway) {
      this._showNewContentPill();
      return;            // instant bail, no threshold fight
    }
    const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
    const nearBottom = scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_THRESHOLD;
    if (force || nearBottom) {
      this.messagesEl.scrollTop = scrollHeight;
      this._userScrolledAway = false;
      this._hideNewContentPill();
    } else {
      this._userScrolledAway = true;
      this._showNewContentPill();
    }
  }

  /**
   * Show the "new content" pill indicator at the bottom of the messages area.
   */
  _showNewContentPill() {
    if (this.newContentPill) {
      this.newContentPill.style.display = '';
    }
  }

  /**
   * Hide the "new content" pill indicator.
   */
  _hideNewContentPill() {
    if (this.newContentPill) {
      this.newContentPill.style.display = 'none';
    }
  }

  /**
   * Update visibility and disabled state of action buttons based on context and streaming state.
   */
  _updateActionButtons() {
    // Check if shortcuts are disabled via config
    if (document.documentElement.getAttribute('data-chat-shortcuts') === 'disabled') {
      this.actionBar.style.display = 'none';
      return;
    }

    const hasSuggestion = this._contextSource === 'suggestion' && this._contextItemId;
    const hasComment = this._contextSource === 'user' && this._contextItemId;
    const hasLine = this._contextSource === 'line';

    // Show the bar only if at least one button is relevant
    const showBar = hasSuggestion || hasComment || hasLine;
    this.actionBar.style.display = showBar ? '' : 'none';
    this.adoptBtn.style.display = hasSuggestion ? '' : 'none';
    this.dismissSuggestionBtn.style.display = hasSuggestion ? '' : 'none';
    this.updateBtn.style.display = hasComment ? '' : 'none';
    this.dismissCommentBtn.style.display = hasComment ? '' : 'none';
    this.createCommentBtn.style.display = hasLine ? '' : 'none';
    this.createCommentBtn.disabled = this.isStreaming;

    // Disable while streaming
    this.adoptBtn.disabled = this.isStreaming;
    this.updateBtn.disabled = this.isStreaming;
    this.dismissSuggestionBtn.disabled = this.isStreaming;
    this.dismissCommentBtn.disabled = this.isStreaming;
  }

  /**
   * Handle click on "Adopt with AI edits" button.
   * Sends a message asking the agent to refine and adopt the suggestion.
   */
  _handleAdoptClick() {
    if (this.isStreaming || !this._contextItemId) return;
    const tab = this._getActiveTab();
    if (!tab) return;
    tab.pendingActionContext = { type: 'adopt', itemId: tab.contextItemId };
    this.inputEl.value = 'Based on our conversation, please refine and adopt this AI suggestion.';
    this.sendMessage();
  }

  /**
   * Handle click on "Update comment" button.
   * Sends a message asking the agent to update the user's comment.
   */
  _handleUpdateClick() {
    if (this.isStreaming || !this._contextItemId) return;
    const tab = this._getActiveTab();
    if (!tab) return;
    tab.pendingActionContext = { type: 'update', itemId: tab.contextItemId };
    this.inputEl.value = 'Based on our conversation, please update my comment.';
    this.sendMessage();
  }

  /**
   * Handle click on "Dismiss suggestion" button.
   * Sends a message asking the agent to dismiss the AI suggestion.
   */
  _handleDismissSuggestionClick() {
    if (this.isStreaming || !this._contextItemId) return;
    const tab = this._getActiveTab();
    if (!tab) return;
    tab.pendingActionContext = { type: 'dismiss-suggestion', itemId: tab.contextItemId };
    this.inputEl.value = 'Please dismiss this AI suggestion.';
    this.sendMessage();
  }

  /**
   * Handle click on "Dismiss comment" button.
   * Sends a message asking the agent to dismiss the user comment.
   */
  _handleDismissCommentClick() {
    if (this.isStreaming || !this._contextItemId) return;
    const tab = this._getActiveTab();
    if (!tab) return;
    tab.pendingActionContext = { type: 'dismiss-comment', itemId: tab.contextItemId };
    this.inputEl.value = 'Please dismiss this comment.';
    this.sendMessage();
  }

  /**
   * Handle click on action bar dismiss button.
   * Hides the action bar for this conversation by clearing context source.
   */
  _handleActionBarDismiss() {
    this._contextSource = null;
    this._contextItemId = null;
    this._contextLineMeta = null;
    this._updateActionButtons();
  }

  /**
   * Handle click on "Create comment" button.
   * Sends a message asking the agent to create a review comment for the referenced lines.
   */
  _handleCreateCommentClick() {
    if (this.isStreaming) return;
    const tab = this._getActiveTab();
    if (!tab) return;
    tab.pendingActionContext = {
      type: 'create-comment',
      file: tab.contextLineMeta?.file,
      line_start: tab.contextLineMeta?.line_start,
      line_end: tab.contextLineMeta?.line_end,
    };
    this.inputEl.value = 'Based on our conversation, please create a review comment for this code.';
    this.sendMessage();
  }

  /**
   * Initialize the shared context tooltip with event delegation on the messages area.
   * Uses mouseenter/mouseleave with a short delay to avoid flickering.
   */
  _initContextTooltip() {
    this._ctxTooltipEl = document.createElement('div');
    this._ctxTooltipEl.className = 'chat-panel__ctx-tooltip';
    this._ctxTooltipEl.style.display = 'none';
    document.body.appendChild(this._ctxTooltipEl);
    this._ctxTooltipTimer = null;

    // Delegate hover events from the persistent stack element so the tooltip
    // works for every per-tab messagesEl (which are created lazily by
    // _createTabMessagesEl as tabs are opened/restored). Reading
    // `this.messagesEl` here would always be null at construction time —
    // there's no active tab yet — so the listeners would never bind.
    const host = this.messagesStackEl;
    if (!host) return;

    this._onCtxCardEnter = (e) => {
      const card = e.target.closest('.chat-panel__context-card[data-tooltip-body]');
      if (!card) return;
      clearTimeout(this._ctxTooltipTimer);
      this._ctxTooltipTimer = setTimeout(() => this._showContextTooltip(card), 200);
    };

    this._onCtxCardLeave = (e) => {
      const card = e.target.closest('.chat-panel__context-card[data-tooltip-body]');
      if (!card) return;
      clearTimeout(this._ctxTooltipTimer);
      this._ctxTooltipEl.style.display = 'none';
    };

    host.addEventListener('mouseenter', this._onCtxCardEnter, true);
    host.addEventListener('mouseleave', this._onCtxCardLeave, true);
  }

  /**
   * Show the context tooltip positioned relative to a context card element.
   * @param {HTMLElement} card - The context card to show tooltip for
   */
  _showContextTooltip(card) {
    const body = card.dataset.tooltipBody;
    if (!body) return;

    const type = card.dataset.tooltipType;
    const title = card.dataset.tooltipTitle;

    let headerHTML = '';
    if (type || title) {
      headerHTML = `<div class="chat-panel__ctx-tooltip-header">${type ? `<span class="chat-panel__ctx-tooltip-type">${this._renderInlineMarkdown(type)}</span>` : ''}${title ? `<span class="chat-panel__ctx-tooltip-title">${this._renderInlineMarkdown(title)}</span>` : ''}</div>`;
    }

    this._ctxTooltipEl.innerHTML = `${headerHTML}<div class="chat-panel__ctx-tooltip-body">${this.renderMarkdown(body)}</div>`;

    const rect = card.getBoundingClientRect();
    const tooltipHeight = 300; // max-height
    const spaceBelow = window.innerHeight - rect.bottom;

    this._ctxTooltipEl.style.display = '';
    this._ctxTooltipEl.style.left = `${rect.left}px`;

    if (spaceBelow >= tooltipHeight || spaceBelow >= rect.top) {
      // Show below
      this._ctxTooltipEl.style.top = `${rect.bottom + 4}px`;
      this._ctxTooltipEl.style.bottom = '';
    } else {
      // Flip above
      this._ctxTooltipEl.style.top = '';
      this._ctxTooltipEl.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    }
  }

  /**
   * Clean up on page unload
   */
  destroy() {
    document.removeEventListener('keydown', this._onKeydown);
    window.removeEventListener('chat-state-changed', this._onChatStateChanged);
    this._closeSubscriptions();
    this.tabs = [];
    this.activeTabKey = null;

    // Clean up context tooltip
    clearTimeout(this._ctxTooltipTimer);
    if (this._ctxTooltipEl && this._ctxTooltipEl.parentNode) {
      this._ctxTooltipEl.parentNode.removeChild(this._ctxTooltipEl);
    }
    this._ctxTooltipEl = null;

    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

/** Resize configuration for the chat panel, exposed as a static for cross-module use. */
ChatPanel.RESIZE_CONFIG = { min: 300, default: 400, cssVar: '--chat-panel-width', storageKey: 'chat-panel-width' };

// Make ChatPanel available globally
window.ChatPanel = ChatPanel;

// Export for CommonJS testing environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatPanel, NEAR_BOTTOM_THRESHOLD };
}
