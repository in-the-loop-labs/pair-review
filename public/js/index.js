// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Index Page Manager
 *
 * Handles the main index page functionality including:
 * - Theme management (light/dark toggle)
 * - Help modal
 * - PR review start flow
 * - Local review start flow
 * - Recent reviews listing with pagination
 * - Local review sessions listing with pagination and deletion
 * - Tab switching (PR / Local)
 */
(function () {
  'use strict';

  // ─── Theme Management ───────────────────────────────────────────────────────

  function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = savedTheme || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  }

  function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
  }

  // Initialize theme on page load
  initTheme();

  // Set up theme toggle button
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // ─── Help Modal ─────────────────────────────────────────────────────────────

  function openHelpModal() {
    const overlay = document.getElementById('help-modal-overlay');
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeHelpModal() {
    const overlay = document.getElementById('help-modal-overlay');
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
  }

  // Set up help button
  document.getElementById('help-btn').addEventListener('click', openHelpModal);

  // Set up close button
  document.getElementById('help-modal-close').addEventListener('click', closeHelpModal);

  // Close on overlay click (but not modal click)
  document.getElementById('help-modal-overlay').addEventListener('click', function (e) {
    if (e.target === this) {
      closeHelpModal();
    }
  });

  // Close on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      const overlay = document.getElementById('help-modal-overlay');
      if (overlay.classList.contains('visible')) {
        closeHelpModal();
      }
    }
  });

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
    if (!localStorage.getItem('theme')) {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    }
  });

  // ─── Shared Utilities ───────────────────────────────────────────────────────

  /** localStorage key for persisting the active tab */
  const TAB_STORAGE_KEY = 'pair-review-active-tab';

  /**
   * Format a relative time string from a date
   * @param {string} dateString - ISO date string
   * @returns {string} Human-readable relative time
   */
  function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) {
      return 'Just now';
    } else if (diffMins < 60) {
      return diffMins + ' minute' + (diffMins !== 1 ? 's' : '') + ' ago';
    } else if (diffHours < 24) {
      return diffHours + ' hour' + (diffHours !== 1 ? 's' : '') + ' ago';
    } else if (diffDays < 7) {
      return diffDays + ' day' + (diffDays !== 1 ? 's' : '') + ' ago';
    } else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      return weeks + ' week' + (weeks !== 1 ? 's' : '') + ' ago';
    } else {
      const months = Math.floor(diffDays / 30);
      return months + ' month' + (months !== 1 ? 's' : '') + ' ago';
    }
  }

  /**
   * Escape HTML special characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  /**
   * Set loading state for a tab's form
   * @param {string} tab - 'pr' or 'local'
   * @param {boolean} loading - Whether to show loading state
   * @param {string} [text] - Optional loading text
   */
  function setFormLoading(tab, loading, text) {
    const ids = tab === 'pr'
      ? { input: 'pr-url-input', btn: 'start-review-btn', loadingEl: 'start-review-loading-pr', loadingText: 'start-review-loading-text-pr', errorEl: 'start-review-error-pr', btnLabel: 'Start Review' }
      : { input: 'local-path-input', btn: 'start-local-btn', loadingEl: 'start-review-loading-local', loadingText: 'start-review-loading-text-local', errorEl: 'start-review-error-local', btnLabel: 'Review Local' };

    const inputEl = document.getElementById(ids.input);
    const btnEl = document.getElementById(ids.btn);
    const loadingEl = document.getElementById(ids.loadingEl);
    const loadingTextEl = document.getElementById(ids.loadingText);
    const errorEl = document.getElementById(ids.errorEl);

    if (loading) {
      if (inputEl) inputEl.disabled = true;
      if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Starting...'; }
      if (loadingEl) loadingEl.classList.add('visible');
      if (loadingTextEl && text) loadingTextEl.textContent = text;
      if (errorEl) errorEl.classList.remove('visible', 'info');
    } else {
      if (inputEl) inputEl.disabled = false;
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = ids.btnLabel; }
      if (loadingEl) loadingEl.classList.remove('visible');
    }
  }

  /**
   * Show error message for a specific tab's form
   * @param {string} tab - 'pr' or 'local'
   * @param {string} message - Error message to display
   */
  function showError(tab, message) {
    const elId = tab === 'pr' ? 'start-review-error-pr' : 'start-review-error-local';
    const errorEl = document.getElementById(elId);
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove('info');
      errorEl.classList.add('visible');
    }
  }

  /**
   * Show an informational (non-error) message to the user.
   * Uses the same element as showError but with neutral info styling.
   * @param {string} tab - 'pr' or 'local'
   * @param {string} message - Informational message to display
   */
  function showInfo(tab, message) {
    const elId = tab === 'pr' ? 'start-review-error-pr' : 'start-review-error-local';
    const errorEl = document.getElementById(elId);
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.add('visible', 'info');
    }
  }

  // ─── Tab Switching ──────────────────────────────────────────────────────────

  /**
   * Generic tab switching handler
   * Activates the clicked tab and its corresponding pane
   * @param {HTMLElement} tabBar - The tab bar container
   * @param {HTMLElement} clickedBtn - The clicked tab button
   * @param {Function} [onActivate] - Optional callback when a tab is activated
   */
  function switchTab(tabBar, clickedBtn, onActivate) {
    const tabId = clickedBtn.dataset.tab;
    if (!tabId) return;

    // Deactivate all tabs in this bar
    tabBar.querySelectorAll('.tab-btn').forEach(function (btn) { btn.classList.remove('active'); });
    clickedBtn.classList.add('active');

    // Find the parent container that holds the tab panes
    const container = tabBar.closest('.recent-reviews-section');
    if (!container) return;

    // Hide all panes, show the target
    container.querySelectorAll('.tab-pane').forEach(function (pane) { pane.classList.remove('active'); });
    const targetPane = container.querySelector('#' + tabId);
    if (targetPane) {
      targetPane.classList.add('active');
    }

    if (onActivate) onActivate(tabId);
  }

  // ─── Local Reviews ──────────────────────────────────────────────────────────

  /**
   * Render a single local review session table row
   * @param {Object} session - Session data
   * @returns {string} HTML string for the table row
   */
  function renderLocalReviewRow(session) {
    const link = '/local/' + session.id;
    const relativeTime = formatRelativeTime(session.updated_at);
    const pathDisplay = session.local_path || '';
    const sha = session.local_head_sha
      ? session.local_head_sha.substring(0, 7)
      : '';
    const hasName = !!session.name;
    const nameDisplay = hasName ? escapeHtml(session.name) : '<em>Untitled</em>';

    // Build repo settings link if repository looks like owner/repo
    var settingsHtml = '';
    if (session.repository && session.repository.includes('/')) {
      var repoParts = session.repository.split('/');
      var settingsLink = '/repo-settings.html?owner=' + encodeURIComponent(repoParts[0]) + '&repo=' + encodeURIComponent(repoParts[1]);
      settingsHtml =
        '<a href="' + settingsLink + '" class="btn-repo-settings" title="Repository settings">' +
          '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">' +
            '<path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/>' +
          '</svg>' +
        '</a>';
    }

    return '' +
      '<tr data-session-id="' + session.id + '">' +
        '<td class="col-local-name" title="' + escapeHtml(session.name || 'Untitled') + '"><a href="' + link + '">' + nameDisplay + '</a></td>' +
        '<td class="col-local-sha" title="' + escapeHtml(session.local_head_sha || '') + '">' + escapeHtml(sha) + '</td>' +
        '<td class="col-local-path" title="' + escapeHtml(pathDisplay) + '">' + escapeHtml(pathDisplay) + '</td>' +
        '<td class="col-repo">' + escapeHtml(session.repository || '') + '</td>' +
        '<td class="col-time">' + relativeTime + '</td>' +
        '<td class="col-actions">' +
          settingsHtml +
          '<button' +
            ' class="btn-delete-session"' +
            ' data-session-id="' + session.id + '"' +
            ' data-session-path="' + escapeHtml(pathDisplay) + '"' +
            ' title="Delete session"' +
          '>' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">' +
              '<path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19a1.75 1.75 0 001.741-1.575l.66-6.6a.75.75 0 00-1.492-.15l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>' +
            '</svg>' +
          '</button>' +
        '</td>' +
      '</tr>';
  }

  /** Pagination state for the local reviews list */
  const localReviewsPagination = {
    lastTimestamp: null,
    pageSize: 10,
    hasMore: false,
    loaded: false
  };

  /**
   * Fetch and display local review sessions (initial load).
   */
  async function loadLocalReviews() {
    const container = document.getElementById('local-reviews-container');
    if (!container) return;

    // Reset pagination
    localReviewsPagination.lastTimestamp = null;
    localReviewsPagination.hasMore = false;

    try {
      const response = await fetch('/api/local/sessions?limit=' + localReviewsPagination.pageSize);
      if (!response.ok) throw new Error('Failed to fetch local sessions');

      const data = await response.json();

      if (!data.success || !data.sessions || data.sessions.length === 0) {
        container.innerHTML =
          '<div class="recent-reviews-empty">' +
            '<p>No local review sessions yet. Enter a directory path above or run <code>pair-review --local</code> from the CLI.</p>' +
          '</div>';
        container.classList.remove('recent-reviews-loading');
        return;
      }

      // Update pagination
      localReviewsPagination.lastTimestamp = data.sessions[data.sessions.length - 1].updated_at;
      localReviewsPagination.hasMore = !!data.hasMore;

      container.innerHTML =
        '<table class="recent-reviews-table local-table">' +
          '<thead>' +
            '<tr>' +
              '<th>Name</th>' +
              '<th>Head</th>' +
              '<th>Path</th>' +
              '<th>Repo</th>' +
              '<th>Last Updated</th>' +
              '<th></th>' +
            '</tr>' +
          '</thead>' +
          '<tbody id="local-reviews-tbody">' +
            data.sessions.map(renderLocalReviewRow).join('') +
          '</tbody>' +
        '</table>' +
        (data.hasMore
          ? '<div class="show-more-container" id="local-show-more-container">' +
              '<button class="btn-show-more" id="btn-local-show-more" type="button">' +
                '<span class="btn-show-more-text">Show more</span>' +
                '<span class="spinner"></span>' +
              '</button>' +
            '</div>'
          : '');
      container.classList.remove('recent-reviews-loading');
      localReviewsPagination.loaded = true;

    } catch (error) {
      console.error('Error loading local reviews:', error);
      container.innerHTML =
        '<div class="recent-reviews-empty">' +
          '<p>Failed to load local reviews.</p>' +
        '</div>';
      container.classList.remove('recent-reviews-loading');
    }
  }

  /**
   * Load more local review sessions (pagination)
   */
  async function loadMoreLocalReviews() {
    const btn = document.getElementById('btn-local-show-more');
    const tbody = document.getElementById('local-reviews-tbody');
    if (!btn || !tbody) return;

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      const params = new URLSearchParams({ limit: localReviewsPagination.pageSize });
      if (localReviewsPagination.lastTimestamp) params.set('before', localReviewsPagination.lastTimestamp);
      const response = await fetch('/api/local/sessions?' + params);
      if (!response.ok) throw new Error('Failed to fetch more sessions');

      const data = await response.json();
      if (!document.contains(btn)) return;

      if (!data.success || !data.sessions || data.sessions.length === 0) {
        const showMoreContainer = document.getElementById('local-show-more-container');
        if (showMoreContainer) showMoreContainer.remove();
        localReviewsPagination.hasMore = false;
        return;
      }

      tbody.insertAdjacentHTML('beforeend', data.sessions.map(renderLocalReviewRow).join(''));

      localReviewsPagination.lastTimestamp = data.sessions[data.sessions.length - 1].updated_at;
      localReviewsPagination.hasMore = !!data.hasMore;

      if (!data.hasMore) {
        const container = document.getElementById('local-show-more-container');
        if (container) container.remove();
      } else {
        btn.classList.remove('loading');
        btn.disabled = false;
      }

    } catch (error) {
      console.error('Error loading more local reviews:', error);
      btn.classList.remove('loading');
      btn.disabled = false;
      const textEl = btn.querySelector('.btn-show-more-text');
      if (textEl) {
        textEl.textContent = 'Failed to load \u2014 click to retry';
        setTimeout(function () { textEl.textContent = 'Show more'; }, 4000);
      }
    }
  }

  /**
   * Show inline delete confirmation for a local session row
   * @param {HTMLElement} button - The delete button element
   */
  function showDeleteSessionConfirm(button) {
    const sessionId = button.dataset.sessionId;
    const sessionPath = button.dataset.sessionPath || '';
    const row = button.closest('tr');
    if (!row) return;

    // If already showing confirmation, do nothing
    if (row.classList.contains('delete-confirm-row')) return;

    // Remember original HTML so we can restore on cancel.
    // Note: restoring innerHTML is safe because all click handlers use event delegation.
    const originalHTML = row.innerHTML;
    const colCount = row.children.length;

    row.classList.add('delete-confirm-row');
    row.innerHTML =
      '<td colspan="' + colCount + '">' +
        '<div class="delete-confirm-inner">' +
          '<span>Delete session for ' + escapeHtml(sessionPath) + '?</span>' +
          '<button class="btn-confirm-yes" data-session-id="' + sessionId + '">Delete</button>' +
          '<button class="btn-confirm-no">Cancel</button>' +
        '</div>' +
      '</td>';

    // Wire up buttons
    row.querySelector('.btn-confirm-yes').addEventListener('click', async function () {
      try {
        const response = await fetch('/api/local/sessions/' + sessionId, {
          method: 'DELETE'
        });
        if (!response.ok) {
          const respData = await response.json().catch(function () { return {}; });
          throw new Error(respData.error || 'Failed to delete session');
        }
        // Remove the row from DOM
        row.remove();
        // If no more rows, reload to show empty state
        const tbody = document.getElementById('local-reviews-tbody');
        if (tbody && tbody.children.length === 0) {
          await loadLocalReviews();
        }
      } catch (error) {
        console.error('Error deleting local session:', error);
        // Restore row on failure
        row.classList.remove('delete-confirm-row');
        row.innerHTML = originalHTML;
      }
    });

    row.querySelector('.btn-confirm-no').addEventListener('click', function () {
      row.classList.remove('delete-confirm-row');
      row.innerHTML = originalHTML;
    });
  }

  // ─── Local Review Start ─────────────────────────────────────────────────────

  /**
   * Handle start local review form submission.
   * Navigates to the setup page which shows step-by-step progress,
   * matching the flow used when reviews are started from the MCP/CLI.
   * @param {Event} event - Form submit event
   */
  async function handleStartLocal(event) {
    event.preventDefault();

    const input = document.getElementById('local-path-input');
    const pathValue = input.value.trim();

    // Clear previous errors/info messages
    const errorEl = document.getElementById('start-review-error-local');
    if (errorEl) errorEl.classList.remove('visible', 'info');

    if (!pathValue) {
      showError('local', 'Please enter a directory path');
      input.focus();
      return;
    }

    // Navigate to the setup page which shows step-by-step progress
    // The /local?path= route serves setup.html which handles the full setup flow
    window.location.href = '/local?path=' + encodeURIComponent(pathValue);
  }

  // ─── Browse Directory ──────────────────────────────────────────────────────

  /**
   * Handle Browse button click — open native OS directory picker via backend API
   */
  async function handleBrowseLocal() {
    const browseBtn = document.getElementById('browse-local-btn');
    const input = document.getElementById('local-path-input');
    if (!browseBtn || !input) return;

    // Disable button while dialog is open
    browseBtn.disabled = true;
    browseBtn.textContent = 'Browsing...';

    try {
      const response = await fetch('/api/local/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();

      if (!response.ok) {
        showError('local', data.error || 'Failed to open directory picker');
        return;
      }

      if (!data.cancelled && data.path) {
        input.value = data.path;
        input.focus();
      }

    } catch (error) {
      console.error('Error browsing for directory:', error);
      showError('local', 'Failed to open directory picker');
    } finally {
      browseBtn.disabled = false;
      browseBtn.textContent = 'Browse';
    }
  }

  // ─── PR Reviews ─────────────────────────────────────────────────────────────

  /**
   * Render a single recent review table row
   * @param {Object} worktree - Worktree data
   * @returns {string} HTML string for the table row
   */
  function renderRecentReviewRow(worktree) {
    const parts = worktree.repository.split('/');
    const owner = parts[0];
    const repo = parts[1];
    const link = '/pr/' + owner + '/' + repo + '/' + worktree.pr_number;
    const settingsLink = '/repo-settings.html?owner=' + encodeURIComponent(owner) + '&repo=' + encodeURIComponent(repo);
    const relativeTime = formatRelativeTime(worktree.last_accessed_at);

    const authorDisplay = worktree.author
      ? '<a href="https://github.com/' + encodeURIComponent(worktree.author) + '" target="_blank" rel="noopener">' + escapeHtml(worktree.author) + '</a>'
      : '';

    return '' +
      '<tr>' +
        '<td class="col-repo">' + escapeHtml(worktree.repository) + '</td>' +
        '<td class="col-pr"><a href="' + link + '">#' + worktree.pr_number + '</a></td>' +
        '<td class="col-title" title="' + escapeHtml(worktree.pr_title) + '">' + escapeHtml(worktree.pr_title) + '</td>' +
        '<td class="col-author">' + authorDisplay + '</td>' +
        '<td class="col-time">' + relativeTime + '</td>' +
        '<td class="col-actions">' +
          '<a href="' + settingsLink + '" class="btn-repo-settings" title="Repository settings">' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">' +
              '<path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/>' +
            '</svg>' +
          '</a>' +
          '<button' +
            ' class="btn-delete-worktree"' +
            ' data-worktree-id="' + worktree.id + '"' +
            ' data-repository="' + escapeHtml(worktree.repository) + '"' +
            ' data-pr-number="' + worktree.pr_number + '"' +
            ' title="Delete worktree"' +
          '>' +
            '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">' +
              '<path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19a1.75 1.75 0 001.741-1.575l.66-6.6a.75.75 0 00-1.492-.15l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>' +
            '</svg>' +
          '</button>' +
        '</td>' +
      '</tr>';
  }

  /**
   * Show inline delete confirmation for a PR worktree row
   * @param {HTMLElement} button - The delete button element
   */
  function showDeleteWorktreeConfirm(button) {
    const worktreeId = button.dataset.worktreeId;
    const repository = button.dataset.repository;
    const prNumber = button.dataset.prNumber;
    const row = button.closest('tr');
    if (!row) return;

    // If already showing confirmation, do nothing
    if (row.classList.contains('delete-confirm-row')) return;

    // Remember original HTML so we can restore on cancel.
    // Note: restoring innerHTML is safe because all click handlers use event delegation.
    const originalHTML = row.innerHTML;
    const colCount = row.children.length;

    row.classList.add('delete-confirm-row');
    row.innerHTML =
      '<td colspan="' + colCount + '">' +
        '<div class="delete-confirm-inner">' +
          '<span>Delete worktree for ' + escapeHtml(repository) + ' #' + escapeHtml(String(prNumber)) + '?</span>' +
          '<button class="btn-confirm-yes" data-worktree-id="' + worktreeId + '">Delete</button>' +
          '<button class="btn-confirm-no">Cancel</button>' +
        '</div>' +
      '</td>';

    // Wire up buttons
    row.querySelector('.btn-confirm-yes').addEventListener('click', async function () {
      try {
        const response = await fetch('/api/worktrees/' + worktreeId, {
          method: 'DELETE'
        });

        if (!response.ok) {
          const data = await response.json().catch(function () { return {}; });
          throw new Error(data.error || 'Failed to delete worktree');
        }

        // Reload the recent reviews list
        await loadRecentReviews();

      } catch (error) {
        console.error('Error deleting worktree:', error);
        // Restore row on failure
        row.classList.remove('delete-confirm-row');
        row.innerHTML = originalHTML;
      }
    });

    row.querySelector('.btn-confirm-no').addEventListener('click', function () {
      row.classList.remove('delete-confirm-row');
      row.innerHTML = originalHTML;
    });
  }

  /** Pagination state for the recent reviews list */
  const recentReviewsPagination = {
    /** ISO timestamp of the last loaded item (cursor for next fetch) */
    lastTimestamp: null,
    /** Number of worktrees to fetch per page */
    pageSize: 10,
    /** Whether the server has indicated more results exist */
    hasMore: false
  };

  /**
   * Fetch and display recent reviews (initial load).
   * Resets pagination state and renders the full table from scratch.
   */
  async function loadRecentReviews() {
    const container = document.getElementById('recent-reviews-container');
    const section = document.getElementById('recent-reviews-section');
    const usageInfo = document.getElementById('usage-info');

    // Reset pagination state
    recentReviewsPagination.lastTimestamp = null;
    recentReviewsPagination.hasMore = false;

    try {
      const response = await fetch('/api/worktrees/recent?limit=' + recentReviewsPagination.pageSize);

      if (!response.ok) {
        throw new Error('Failed to fetch recent reviews');
      }

      const data = await response.json();

      if (!data.success || !data.worktrees || data.worktrees.length === 0) {
        // Show friendly empty state with usage info
        container.innerHTML =
          '<div class="recent-reviews-empty">' +
            '<p>No PR reviews yet. Paste a PR URL above to get started.</p>' +
          '</div>';
        container.classList.remove('recent-reviews-loading');
        // Show usage info when no reviews exist
        if (usageInfo) usageInfo.classList.remove('loading-hidden');
        return;
      }

      // Update pagination state - track the cursor for the next page
      recentReviewsPagination.lastTimestamp = data.worktrees[data.worktrees.length - 1].last_accessed_at;
      recentReviewsPagination.hasMore = !!data.hasMore;

      // Render the table of recent reviews
      const html =
        '<table class="recent-reviews-table">' +
          '<thead>' +
            '<tr>' +
              '<th>Repository</th>' +
              '<th>PR</th>' +
              '<th>Title</th>' +
              '<th>Author</th>' +
              '<th>Last Opened</th>' +
              '<th>Actions</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody id="recent-reviews-tbody">' +
            data.worktrees.map(renderRecentReviewRow).join('') +
          '</tbody>' +
        '</table>' +
        renderShowMoreButton(data.hasMore);
      container.innerHTML = html;
      container.classList.remove('recent-reviews-loading');

    } catch (error) {
      console.error('Error loading recent reviews:', error);
      // Hide the section on error, show usage info as fallback
      section.style.display = 'none';
      if (usageInfo) usageInfo.classList.remove('loading-hidden');
    }
  }

  /**
   * Render the "Show more" button HTML.
   * @param {boolean} hasMore - Whether more results are available
   * @returns {string} HTML string for the show-more container
   */
  function renderShowMoreButton(hasMore) {
    if (!hasMore) return '';
    return '' +
      '<div class="show-more-container" id="show-more-container">' +
        '<button class="btn-show-more" id="btn-show-more" type="button">' +
          '<span class="btn-show-more-text">Show more</span>' +
          '<span class="spinner"></span>' +
        '</button>' +
      '</div>';
  }

  /**
   * Load the next page of worktrees and append them to the existing table.
   * Called when the "Show more" button is clicked.
   */
  async function loadMoreReviews() {
    const btn = document.getElementById('btn-show-more');
    const tbody = document.getElementById('recent-reviews-tbody');
    if (!btn || !tbody) return;

    // Show loading state on the button
    btn.classList.add('loading');
    btn.disabled = true;

    try {
      const params = new URLSearchParams({ limit: recentReviewsPagination.pageSize });
      if (recentReviewsPagination.lastTimestamp) params.set('before', recentReviewsPagination.lastTimestamp);
      const response = await fetch('/api/worktrees/recent?' + params);

      if (!response.ok) {
        throw new Error('Failed to fetch more reviews');
      }

      const data = await response.json();

      // Guard against stale response if the table was refreshed (e.g. by a delete) while loading
      if (!document.contains(btn)) return;

      if (!data.success || !data.worktrees || data.worktrees.length === 0) {
        // No more results - remove the button
        const showMoreContainer = document.getElementById('show-more-container');
        if (showMoreContainer) showMoreContainer.remove();
        recentReviewsPagination.hasMore = false;
        return;
      }

      // Append new rows to the existing table body
      tbody.insertAdjacentHTML('beforeend', data.worktrees.map(renderRecentReviewRow).join(''));

      // Update pagination state - advance the cursor
      recentReviewsPagination.lastTimestamp = data.worktrees[data.worktrees.length - 1].last_accessed_at;
      recentReviewsPagination.hasMore = !!data.hasMore;

      // Update or remove the "Show more" button
      if (!data.hasMore) {
        const container = document.getElementById('show-more-container');
        if (container) container.remove();
      } else {
        // Reset button state
        btn.classList.remove('loading');
        btn.disabled = false;
      }

    } catch (error) {
      console.error('Error loading more reviews:', error);
      // Reset button state and show error so the user knows what happened
      btn.classList.remove('loading');
      btn.disabled = false;
      const textEl = btn.querySelector('.btn-show-more-text');
      if (textEl) {
        textEl.textContent = 'Failed to load \u2014 click to retry';
        // Restore original text after a brief delay so the user sees the error
        setTimeout(function () { textEl.textContent = 'Show more'; }, 4000);
      }
    }
  }

  // ─── PR Start Flow ──────────────────────────────────────────────────────────

  /**
   * Parse a PR URL using the backend API
   * Supports GitHub and Graphite URLs (with or without protocol)
   * @param {string} url - The PR URL to parse
   * @returns {Promise<Object|null>} { owner, repo, prNumber } or null if invalid
   */
  async function parsePRUrl(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }

    try {
      const response = await fetch('/api/parse-pr-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: url.trim() })
      });

      const data = await response.json();

      if (data.valid) {
        return {
          owner: data.owner,
          repo: data.repo,
          prNumber: data.prNumber
        };
      }

      return null;
    } catch (e) {
      console.error('Error parsing PR URL:', e);
      return null;
    }
  }

  /**
   * Handle start review form submission.
   * Parses the PR URL, then navigates to the PR route which serves the
   * setup page with step-by-step progress for new PRs, or the review page
   * directly for PRs that already exist in the database.
   * @param {Event} event - Form submit event
   */
  async function handleStartReview(event) {
    event.preventDefault();

    const input = document.getElementById('pr-url-input');
    const url = input.value.trim();

    // Clear previous errors
    const errorEl = document.getElementById('start-review-error-pr');
    if (errorEl) errorEl.classList.remove('visible');

    // Validate input
    if (!url) {
      showError('pr', 'Please enter a GitHub PR URL');
      input.focus();
      return;
    }

    // Show loading state while parsing
    setFormLoading('pr', true, 'Validating PR URL...');

    // Parse the URL using the backend API
    const parsed = await parsePRUrl(url);
    if (!parsed) {
      setFormLoading('pr', false);
      showError('pr', 'Invalid PR URL. Please enter a GitHub or Graphite PR URL (e.g., https://github.com/owner/repo/pull/123)');
      input.focus();
      return;
    }

    // Navigate to the PR route which serves setup.html (with step-by-step progress)
    // for new PRs, or pr.html directly for PRs already in the database
    window.location.href = '/pr/' + encodeURIComponent(parsed.owner) + '/' + encodeURIComponent(parsed.repo) + '/' + encodeURIComponent(parsed.prNumber);
  }

  // ─── Config & Command Examples ──────────────────────────────────────────────

  /**
   * Update command examples based on whether running via npx or installed
   * @param {boolean} isNpx - True if running via npx
   */
  function updateCommandExamples(isNpx) {
    const baseCmd = isNpx ? 'npx @in-the-loop-labs/pair-review' : 'pair-review';
    const cmdExamples = document.querySelectorAll('.cmd-example');
    cmdExamples.forEach(function (el) {
      const args = el.dataset.args || '';
      el.textContent = args ? baseCmd + ' ' + args : baseCmd;
    });
  }

  /**
   * Fetch config from server and update UI accordingly
   */
  async function loadConfigAndUpdateUI() {
    try {
      const response = await fetch('/api/config');
      if (response.ok) {
        const config = await response.json();
        updateCommandExamples(config.is_running_via_npx);

        // Set chat feature state based on config and Pi availability
        let chatState = 'disabled';
        if (config.enable_chat) {
          chatState = config.pi_available ? 'available' : 'unavailable';
        }
        document.documentElement.setAttribute('data-chat', chatState);
        window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: chatState } }));
      } else {
        // Fallback: assume installed (shorter command)
        updateCommandExamples(false);
      }
    } catch (error) {
      console.error('Error loading config:', error);
      // Fallback: assume installed (shorter command)
      updateCommandExamples(false);
    }
  }

  // ─── Event Delegation ───────────────────────────────────────────────────────

  // Event delegation for buttons, show-more, tab switching
  document.addEventListener('click', function (event) {
    // Delete worktree (PR mode)
    const deleteBtn = event.target.closest('.btn-delete-worktree');
    if (deleteBtn) {
      event.preventDefault();
      event.stopPropagation();
      showDeleteWorktreeConfirm(deleteBtn);
      return;
    }

    // Delete local session
    const deleteSessionBtn = event.target.closest('.btn-delete-session');
    if (deleteSessionBtn) {
      event.preventDefault();
      event.stopPropagation();
      showDeleteSessionConfirm(deleteSessionBtn);
      return;
    }

    // Show more (PR reviews)
    const showMoreBtn = event.target.closest('#btn-show-more');
    if (showMoreBtn) {
      event.preventDefault();
      loadMoreReviews();
      return;
    }

    // Show more (local reviews)
    const localShowMoreBtn = event.target.closest('#btn-local-show-more');
    if (localShowMoreBtn) {
      event.preventDefault();
      loadMoreLocalReviews();
      return;
    }

    // Unified tab switching
    const unifiedTabBtn = event.target.closest('#unified-tab-bar .tab-btn');
    if (unifiedTabBtn) {
      const tabBar = document.getElementById('unified-tab-bar');
      switchTab(tabBar, unifiedTabBtn, function (tabId) {
        // Persist tab choice
        localStorage.setItem(TAB_STORAGE_KEY, tabId);
        // Lazy-load local reviews on first switch
        if (tabId === 'local-tab' && !localReviewsPagination.loaded) {
          loadLocalReviews();
        }
      });
      return;
    }
  });

  // ─── DOMContentLoaded Initialization ────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    // Load config and update command examples based on npx detection
    loadConfigAndUpdateUI().then(function () {
      // Sync help content to usage-info section AFTER command examples are updated
      const helpContent = document.querySelector('.help-modal-content');
      const usageInfo = document.getElementById('usage-info');
      if (helpContent && usageInfo) {
        usageInfo.innerHTML = '';
        Array.from(helpContent.childNodes).forEach(function (node) {
          usageInfo.appendChild(node.cloneNode(true));
        });
      }
    });

    // Restore saved tab from localStorage (default: 'pr-tab')
    const savedTab = localStorage.getItem(TAB_STORAGE_KEY) || 'pr-tab';
    const tabBar = document.getElementById('unified-tab-bar');
    if (tabBar) {
      const targetBtn = tabBar.querySelector('[data-tab="' + savedTab + '"]');
      if (targetBtn && savedTab !== 'pr-tab') {
        // Switch to saved tab (pr-tab is already active by default in HTML)
        switchTab(tabBar, targetBtn);
      }
    }

    // Always load PR reviews (they show on initial load)
    loadRecentReviews();

    // If local tab is active, load local reviews immediately
    if (savedTab === 'local-tab') {
      loadLocalReviews();
    }

    // Set up start review form handler
    const form = document.getElementById('start-review-form');
    if (form) {
      form.addEventListener('submit', handleStartReview);
    }

    // Set up local review form handler
    const localForm = document.getElementById('start-local-form');
    if (localForm) {
      localForm.addEventListener('submit', handleStartLocal);
    }

    // Set up browse button handler
    const browseBtn = document.getElementById('browse-local-btn');
    if (browseBtn) {
      browseBtn.addEventListener('click', handleBrowseLocal);
    }

    // Note: No explicit Enter keypress handlers are needed here.
    // Both inputs are inside <form> elements, so pressing Enter
    // natively triggers form submission.
  });

  // ─── bfcache Restoration ───────────────────────────────────────────────────

  // When the browser restores this page from bfcache (e.g. user hits the back
  // button after navigating away), any in-progress loading state on the forms
  // will still be visible because the DOM snapshot is preserved as-is.  Reset
  // both forms so the user is not stuck with a disabled input and spinner.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      setFormLoading('pr', false);
      setFormLoading('local', false);
    }
  });

})();
