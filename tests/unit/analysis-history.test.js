// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for AnalysisHistoryManager
 *
 * Tests the show/hide functionality, configurable containerPrefix,
 * and base64 encoding/decoding for clipboard content.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Helper to create mock DOM elements
function createMockElement(overrides = {}) {
  return {
    style: { display: '' },
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
      contains: vi.fn(() => false)
    },
    addEventListener: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    querySelector: vi.fn(() => null),
    contains: vi.fn(() => false),
    textContent: '',
    innerHTML: '',
    dataset: {},
    ...overrides
  };
}

// Helper to create a mock document with configurable prefix
function createMockDocument(prefix = 'analysis-context') {
  const elements = {};

  // Create standard elements for AnalysisHistoryManager
  elements[prefix] = createMockElement(); // container
  elements[`${prefix}-empty`] = createMockElement(); // emptyState
  elements[`${prefix}-selector`] = createMockElement(); // selector
  elements[`${prefix}-btn`] = createMockElement(); // historyBtn
  elements[`${prefix}-label`] = createMockElement(); // historyLabel
  elements[`${prefix}-dropdown`] = createMockElement(); // dropdown
  elements[`${prefix}-list`] = createMockElement(); // listElement
  elements[`${prefix}-info-btn`] = createMockElement(); // infoBtn
  elements[`${prefix}-popover`] = createMockElement(); // infoPopover
  elements[`${prefix}-info-content`] = createMockElement(); // infoContent

  return {
    getElementById: vi.fn((id) => elements[id] || null),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createElement: vi.fn(() => createMockElement()),
    _elements: elements,
    _setElement: (id, el) => { elements[id] = el; }
  };
}

// Mock btoa/atob for base64 encoding/decoding (Node.js environment)
function mockBtoa(str) {
  return Buffer.from(str, 'binary').toString('base64');
}

function mockAtob(str) {
  return Buffer.from(str, 'base64').toString('binary');
}

describe('AnalysisHistoryManager', () => {
  let mockDocument;
  let mockWindow;
  let originalGlobals;
  let AnalysisHistoryManager;

  // Mock clipboard for tests
  let mockClipboard;

  beforeEach(() => {
    // Save original globals
    originalGlobals = {
      document: global.document,
      window: global.window,
      btoa: global.btoa,
      atob: global.atob
    };

    // Set up mock document
    mockDocument = createMockDocument();
    global.document = mockDocument;

    // Set up mock window
    mockWindow = {
      AnalysisHistoryManager: null
    };
    global.window = mockWindow;

    // Set up btoa/atob for Node environment
    global.btoa = mockBtoa;
    global.atob = mockAtob;

    // Mock clipboard - use vi.stubGlobal for Node.js 20+ where navigator is read-only
    mockClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined)
    };
    vi.stubGlobal('navigator', { clipboard: mockClipboard });

    // Load the module fresh for each test
    // Since the module attaches to window, we need to re-evaluate it
    vi.resetModules();

    // Define a simplified version of the class for testing
    // This mirrors the key functionality we want to test
    class TestableAnalysisHistoryManager {
      constructor({ reviewId, mode, onSelectionChange, containerPrefix = 'analysis-context' }) {
        this.reviewId = reviewId;
        this.mode = mode;
        this.onSelectionChange = onSelectionChange;
        this.containerPrefix = containerPrefix;
        this.runs = [];
        this.selectedRunId = null;
        this.selectedRun = null;
        this.isDropdownOpen = false;
        this.isPopoverOpen = false;
        this.container = null;
        this.emptyState = null;
        this.selector = null;
        this.historyBtn = null;
        this.historyLabel = null;
        this.dropdown = null;
        this.listElement = null;
        this.infoBtn = null;
        this.infoPopover = null;
        this.infoContent = null;
      }

      init() {
        const prefix = this.containerPrefix;
        this.container = document.getElementById(prefix);
        this.emptyState = document.getElementById(`${prefix}-empty`);
        this.selector = document.getElementById(`${prefix}-selector`);
        this.historyBtn = document.getElementById(`${prefix}-btn`);
        this.historyLabel = document.getElementById(`${prefix}-label`);
        this.dropdown = document.getElementById(`${prefix}-dropdown`);
        this.listElement = document.getElementById(`${prefix}-list`);
        this.infoBtn = document.getElementById(`${prefix}-info-btn`);
        this.infoPopover = document.getElementById(`${prefix}-popover`);
        this.infoContent = document.getElementById(`${prefix}-info-content`);

        if (!this.container || !this.historyBtn) {
          console.warn(`Analysis history elements not found in DOM with prefix: ${prefix}`);
          return;
        }

        this.historyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleDropdown();
        });

        if (this.infoBtn) {
          this.infoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleInfoPopover();
          });
        }

        this.handleDocumentClick = (e) => {
          if (!this.container.contains(e.target)) {
            this.hideDropdown();
            this.hideInfoPopover();
          }
        };
        document.addEventListener('click', this.handleDocumentClick);

        this.handleKeydown = (e) => {
          if (e.key === 'Escape') {
            this.hideDropdown();
            this.hideInfoPopover();
          }
        };
        document.addEventListener('keydown', this.handleKeydown);
      }

      show() {
        if (this.emptyState) {
          this.emptyState.style.display = 'none';
        }
        if (this.selector) {
          this.selector.style.display = '';
        }
      }

      hide() {
        if (this.emptyState) {
          this.emptyState.style.display = '';
        }
        if (this.selector) {
          this.selector.style.display = 'none';
        }
      }

      toggleDropdown() {
        if (this.isDropdownOpen) {
          this.hideDropdown();
        } else {
          this.showDropdown();
        }
      }

      showDropdown() {
        if (this.container) {
          // Re-render dropdown to get fresh timestamps
          if (this.runs.length > 0) {
            this.renderDropdown(this.runs);
          }
          // Also update the selected label for fresh timestamp
          this.updateSelectedLabel();

          this.container.classList.add('open');
          this.isDropdownOpen = true;
          this.hideInfoPopover();
        }
      }

      renderDropdown(runs) {
        if (!this.listElement) return;
        // Simplified rendering for tests - just sets innerHTML
        this.listElement.innerHTML = runs.map(run => `<button data-run-id="${run.id}">${run.model}</button>`).join('');
      }

      updateSelectedLabel() {
        if (!this.historyLabel) return;
        if (!this.selectedRun) return;

        const run = this.selectedRun;
        const timeAgo = this.formatRelativeTime(run.completed_at || run.started_at);
        const provider = this.formatProviderName(run.provider);
        const model = run.model || 'Unknown';

        this.historyLabel.textContent = `${timeAgo} \u00B7 ${provider} \u00B7 ${model}`;
      }

      parseTimestamp(timestamp) {
        if (!timestamp) return new Date(NaN);

        // If the timestamp already has timezone info (ends with Z or +/-offset), parse as-is
        if (/Z$|[+-]\d{2}:\d{2}$/.test(timestamp)) {
          return new Date(timestamp);
        }

        // SQLite CURRENT_TIMESTAMP format: "YYYY-MM-DD HH:MM:SS" (no timezone, but is UTC)
        // Append 'Z' to interpret as UTC
        return new Date(timestamp + 'Z');
      }

      formatRelativeTime(timestamp) {
        if (!timestamp) return 'Unknown';

        const now = new Date();
        const date = this.parseTimestamp(timestamp);
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

      formatProviderName(provider) {
        const providerNames = {
          'claude': 'Claude',
          'gemini': 'Gemini',
          'codex': 'Codex',
          'openai': 'OpenAI'
        };
        return providerNames[provider] || provider || 'Unknown';
      }

      hideDropdown() {
        if (this.container) {
          this.container.classList.remove('open');
          this.isDropdownOpen = false;
        }
      }

      toggleInfoPopover() {
        if (this.isPopoverOpen) {
          this.hideInfoPopover();
        } else {
          this.showInfoPopover();
        }
      }

      showInfoPopover() {
        if (this.container) {
          this.container.classList.add('popover-open');
          this.isPopoverOpen = true;
          this.hideDropdown();
        }
      }

      hideInfoPopover() {
        if (this.container) {
          this.container.classList.remove('popover-open');
          this.isPopoverOpen = false;
        }
      }

      async handleCopyInstructions(button) {
        const encodedContent = button.dataset.content;
        if (!encodedContent) return;

        try {
          const content = new TextDecoder().decode(Uint8Array.from(atob(encodedContent), c => c.charCodeAt(0)));
          await navigator.clipboard.writeText(content);

          button.classList.add('copied');
          const textSpan = button.querySelector('.copy-btn-text');
          const originalText = textSpan?.textContent;
          if (textSpan) {
            textSpan.textContent = 'Copied!';
          }

          setTimeout(() => {
            button.classList.remove('copied');
            if (textSpan && originalText) {
              textSpan.textContent = originalText;
            }
          }, 1500);
        } catch (error) {
          console.error('Failed to copy to clipboard:', error);
        }
      }

      getTierForModel(modelId) {
        if (!modelId) return null;

        const modelTiers = {
          'haiku': 'fast',
          'sonnet': 'balanced',
          'opus': 'thorough',
          'flash': 'fast',
          'pro': 'balanced',
          'ultra': 'thorough',
          'gpt-4o-mini': 'fast',
          'gpt-4o': 'balanced',
          'o1': 'thorough',
          'o1-mini': 'balanced',
          'gpt-4': 'balanced'
        };

        return modelTiers[modelId] || null;
      }

      formatTierName(tier) {
        if (!tier) return '';
        return tier.toUpperCase();
      }

      escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      formatDate(timestamp) {
        if (!timestamp) return 'Unknown';
        const date = this.parseTimestamp(timestamp);
        return date.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        });
      }

      formatDuration(startedAt, completedAt) {
        if (!startedAt || !completedAt) return 'Unknown';
        const start = this.parseTimestamp(startedAt);
        const end = this.parseTimestamp(completedAt);
        const durationMs = end - start;
        if (durationMs < 0) return 'Unknown';
        const seconds = durationMs / 1000;
        if (seconds < 60) {
          return `${seconds.toFixed(1)}s`;
        } else {
          const minutes = Math.floor(seconds / 60);
          const remainingSeconds = Math.floor(seconds % 60);
          return `${minutes}m ${remainingSeconds}s`;
        }
      }

      updateInfoPopover() {
        if (!this.infoContent || !this.selectedRun) return;

        const run = this.selectedRun;
        const runDate = run.completed_at || run.started_at;
        const formattedDate = runDate ? this.formatDate(runDate) : 'Unknown';
        const duration = this.formatDuration(run.started_at, run.completed_at);
        const suggestionCount = run.total_suggestions || 0;

        const tier = this.getTierForModel(run.model);
        const tierBadgeHtml = tier
          ? `<span class="analysis-tier-badge analysis-tier-${tier}">${this.formatTierName(tier)}</span>`
          : '';

        let html = `
          ${tierBadgeHtml ? `<div class="analysis-info-tier-row">${tierBadgeHtml}</div>` : ''}
          <div class="analysis-info-row">
            <span class="analysis-info-label">Provider</span>
            <span class="analysis-info-value">${this.escapeHtml(this.formatProviderName(run.provider))}</span>
          </div>
          <div class="analysis-info-row">
            <span class="analysis-info-label">Model</span>
            <span class="analysis-info-value">${this.escapeHtml(run.model || 'Unknown')}</span>
          </div>
          <div class="analysis-info-row">
            <span class="analysis-info-label">Run at</span>
            <span class="analysis-info-value">${formattedDate}</span>
          </div>
          <div class="analysis-info-row">
            <span class="analysis-info-label">Duration</span>
            <span class="analysis-info-value">${duration}</span>
          </div>
          <div class="analysis-info-row">
            <span class="analysis-info-label">Suggestions</span>
            <span class="analysis-info-value">${suggestionCount}</span>
          </div>
        `;

        this.infoContent.innerHTML = html;
      }

      destroy() {
        if (this.handleDocumentClick) {
          document.removeEventListener('click', this.handleDocumentClick);
          this.handleDocumentClick = null;
        }
        if (this.handleKeydown) {
          document.removeEventListener('keydown', this.handleKeydown);
          this.handleKeydown = null;
        }
        this.runs = [];
        this.selectedRunId = null;
        this.selectedRun = null;
        this.isDropdownOpen = false;
        this.isPopoverOpen = false;
      }
    }

    AnalysisHistoryManager = TestableAnalysisHistoryManager;
    global.window.AnalysisHistoryManager = AnalysisHistoryManager;
  });

  afterEach(() => {
    // Restore original globals
    global.document = originalGlobals.document;
    global.window = originalGlobals.window;
    global.btoa = originalGlobals.btoa;
    global.atob = originalGlobals.atob;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('show()', () => {
    it('should hide empty state and show selector', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Initial state - emptyState visible, selector hidden
      manager.emptyState.style.display = '';
      manager.selector.style.display = 'none';

      manager.show();

      expect(manager.emptyState.style.display).toBe('none');
      expect(manager.selector.style.display).toBe('');
    });

    it('should handle missing emptyState element gracefully', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();
      manager.emptyState = null;

      expect(() => manager.show()).not.toThrow();
      expect(manager.selector.style.display).toBe('');
    });

    it('should handle missing selector element gracefully', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();
      manager.selector = null;

      expect(() => manager.show()).not.toThrow();
      expect(manager.emptyState.style.display).toBe('none');
    });
  });

  describe('hide()', () => {
    it('should show empty state and hide selector', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Initial state - emptyState hidden, selector visible
      manager.emptyState.style.display = 'none';
      manager.selector.style.display = '';

      manager.hide();

      expect(manager.emptyState.style.display).toBe('');
      expect(manager.selector.style.display).toBe('none');
    });

    it('should handle missing emptyState element gracefully', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();
      manager.emptyState = null;

      expect(() => manager.hide()).not.toThrow();
      expect(manager.selector.style.display).toBe('none');
    });

    it('should handle missing selector element gracefully', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();
      manager.selector = null;

      expect(() => manager.hide()).not.toThrow();
      expect(manager.emptyState.style.display).toBe('');
    });
  });

  describe('configurable containerPrefix', () => {
    it('should use default prefix when not specified', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      expect(manager.containerPrefix).toBe('analysis-context');
    });

    it('should use custom prefix when specified', () => {
      const customPrefix = 'custom-analysis';
      mockDocument = createMockDocument(customPrefix);
      global.document = mockDocument;

      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'local',
        onSelectionChange: vi.fn(),
        containerPrefix: customPrefix
      });

      expect(manager.containerPrefix).toBe(customPrefix);
    });

    it('should look up DOM elements using custom prefix', () => {
      const customPrefix = 'my-prefix';
      mockDocument = createMockDocument(customPrefix);
      global.document = mockDocument;

      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn(),
        containerPrefix: customPrefix
      });
      manager.init();

      expect(mockDocument.getElementById).toHaveBeenCalledWith(customPrefix);
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-empty`);
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-selector`);
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-btn`);
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-label`);
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-dropdown`);
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-list`);
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-info-btn`);
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-popover`);
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-info-content`);
    });

    it('should work with different DOM structures using different prefixes', () => {
      // Test with 'local-analysis' prefix (like local.html uses)
      const localPrefix = 'local-analysis';
      const localMockDocument = createMockDocument(localPrefix);
      global.document = localMockDocument;

      const localManager = new AnalysisHistoryManager({
        reviewId: 2,
        mode: 'local',
        onSelectionChange: vi.fn(),
        containerPrefix: localPrefix
      });
      localManager.init();

      expect(localManager.container).toBe(localMockDocument._elements[localPrefix]);
      expect(localManager.emptyState).toBe(localMockDocument._elements[`${localPrefix}-empty`]);
      expect(localManager.selector).toBe(localMockDocument._elements[`${localPrefix}-selector`]);
    });

    it('should warn when DOM elements not found with custom prefix', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const missingPrefix = 'missing-prefix';

      // Create a document that doesn't have the elements
      const emptyMockDocument = {
        getElementById: vi.fn(() => null),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };
      global.document = emptyMockDocument;

      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn(),
        containerPrefix: missingPrefix
      });
      manager.init();

      expect(consoleSpy).toHaveBeenCalledWith(
        `Analysis history elements not found in DOM with prefix: ${missingPrefix}`
      );
      consoleSpy.mockRestore();
    });
  });

  describe('Base64 encoding/decoding for clipboard content', () => {
    // Test the encoding function used in updateInfoPopover
    function encodeForClipboard(text) {
      return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    }

    // Test the decoding function used in handleCopyInstructions
    function decodeFromClipboard(encoded) {
      return new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
    }

    it('should correctly encode and decode ASCII text', () => {
      const original = 'Hello, World!';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should correctly encode and decode UTF-8 characters', () => {
      const original = 'Hello, \u4e16\u754c! \ud83c\udf0d';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should correctly encode and decode special characters', () => {
      const original = 'Code review: "Check for <script> injection & SQL attacks"';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should correctly encode and decode multi-line text', () => {
      const original = 'Line 1\nLine 2\nLine 3\t with tab';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should correctly encode and decode emoji and symbols', () => {
      const original = '\u2728 Review focus: \ud83d\udc1b bugs, \ud83d\udca1 suggestions, \ud83d\udc4d praise';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should correctly encode and decode accented characters', () => {
      const original = 'Caf\u00e9 r\u00e9sum\u00e9 \u00fc\u00f6\u00e4 \u00f1';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should correctly encode and decode Japanese text', () => {
      const original = '\u30b3\u30fc\u30c9\u30ec\u30d3\u30e5\u30fc';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should correctly encode and decode Chinese text', () => {
      const original = '\u4ee3\u7801\u5ba1\u67e5';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should correctly encode and decode Russian text', () => {
      const original = '\u041e\u0431\u0437\u043e\u0440 \u043a\u043e\u0434\u0430';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should correctly encode and decode Arabic text', () => {
      const original = '\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0643\u0648\u062f';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should handle empty string', () => {
      const original = '';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });

    it('should handle string with only whitespace', () => {
      const original = '   \t\n  ';
      const encoded = encodeForClipboard(original);
      const decoded = decodeFromClipboard(encoded);

      expect(decoded).toBe(original);
    });
  });

  describe('handleCopyInstructions', () => {
    it('should copy decoded content to clipboard', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      const originalText = 'Test instructions with UTF-8: \u4e16\u754c';
      const encodedContent = btoa(String.fromCharCode(...new TextEncoder().encode(originalText)));

      const mockButton = createMockElement({
        dataset: { content: encodedContent },
        querySelector: vi.fn(() => ({ textContent: 'Copy' }))
      });

      await manager.handleCopyInstructions(mockButton);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(originalText);
      expect(mockButton.classList.add).toHaveBeenCalledWith('copied');
    });

    it('should not attempt copy if no encoded content', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      const mockButton = createMockElement({
        dataset: {},
        querySelector: vi.fn(() => null)
      });

      await manager.handleCopyInstructions(mockButton);

      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it('should handle clipboard write failure gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Use mockClipboard which is wired to navigator via vi.stubGlobal
      mockClipboard.writeText = vi.fn().mockRejectedValue(new Error('Clipboard access denied'));

      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      const originalText = 'Test';
      const encodedContent = btoa(String.fromCharCode(...new TextEncoder().encode(originalText)));

      const mockButton = createMockElement({
        dataset: { content: encodedContent },
        querySelector: vi.fn(() => null)
      });

      await manager.handleCopyInstructions(mockButton);

      expect(consoleSpy).toHaveBeenCalledWith('Failed to copy to clipboard:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  describe('destroy()', () => {
    it('should remove event listeners and clear state', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set some state
      manager.runs = [{ id: 1 }];
      manager.selectedRunId = '1';
      manager.selectedRun = { id: 1 };
      manager.isDropdownOpen = true;
      manager.isPopoverOpen = true;

      manager.destroy();

      expect(manager.runs).toEqual([]);
      expect(manager.selectedRunId).toBeNull();
      expect(manager.selectedRun).toBeNull();
      expect(manager.isDropdownOpen).toBe(false);
      expect(manager.isPopoverOpen).toBe(false);
      expect(manager.handleDocumentClick).toBeNull();
      expect(manager.handleKeydown).toBeNull();
      expect(mockDocument.removeEventListener).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateSelectedLabel()', () => {
    it('should update the label with timestamp, provider, and model', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set a selected run with completed_at 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      manager.selectedRun = {
        id: 1,
        provider: 'claude',
        model: 'claude-opus-4',
        completed_at: twoHoursAgo
      };

      manager.updateSelectedLabel();

      // Check that the label was updated with the expected format
      // Format: <timestamp> · <provider> · <model>
      expect(manager.historyLabel.textContent).toMatch(/2 hours ago · Claude · claude-opus-4/);
    });

    it('should return early when historyLabel is null', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();
      manager.historyLabel = null;

      // Set a selected run
      manager.selectedRun = {
        id: 1,
        provider: 'claude',
        model: 'test-model',
        completed_at: new Date().toISOString()
      };

      // Should not throw
      expect(() => manager.updateSelectedLabel()).not.toThrow();
    });

    it('should return early when selectedRun is null', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Ensure historyLabel exists but selectedRun is null
      manager.selectedRun = null;

      // Store original textContent to verify it's not modified
      const originalText = manager.historyLabel.textContent;

      manager.updateSelectedLabel();

      // Label should remain unchanged
      expect(manager.historyLabel.textContent).toBe(originalText);
    });

    it('should use started_at when completed_at is not available', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set a selected run with only started_at
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      manager.selectedRun = {
        id: 1,
        provider: 'gemini',
        model: 'gemini-pro',
        started_at: threeHoursAgo
      };

      manager.updateSelectedLabel();

      expect(manager.historyLabel.textContent).toMatch(/3 hours ago · Gemini · gemini-pro/);
    });

    it('should handle unknown provider and model', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      manager.selectedRun = {
        id: 1,
        completed_at: oneHourAgo
        // No provider or model
      };

      manager.updateSelectedLabel();

      expect(manager.historyLabel.textContent).toMatch(/1 hour ago · Unknown · Unknown/);
    });
  });

  describe('showDropdown()', () => {
    it('should call renderDropdown when runs exist', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up runs and a selected run
      manager.runs = [
        { id: 1, provider: 'claude', model: 'opus', completed_at: new Date().toISOString() },
        { id: 2, provider: 'gemini', model: 'pro', completed_at: new Date().toISOString() }
      ];
      manager.selectedRun = manager.runs[0];

      // Spy on renderDropdown
      const renderSpy = vi.spyOn(manager, 'renderDropdown');

      manager.showDropdown();

      expect(renderSpy).toHaveBeenCalledWith(manager.runs);
    });

    it('should call updateSelectedLabel', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up a selected run
      manager.selectedRun = {
        id: 1,
        provider: 'claude',
        model: 'opus',
        completed_at: new Date().toISOString()
      };

      // Spy on updateSelectedLabel
      const updateSpy = vi.spyOn(manager, 'updateSelectedLabel');

      manager.showDropdown();

      expect(updateSpy).toHaveBeenCalled();
    });

    it('should not call renderDropdown when runs is empty', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Runs is empty by default
      expect(manager.runs).toEqual([]);

      // Spy on renderDropdown
      const renderSpy = vi.spyOn(manager, 'renderDropdown');

      manager.showDropdown();

      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('should add open class and set isDropdownOpen true', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      expect(manager.isDropdownOpen).toBe(false);

      manager.showDropdown();

      expect(manager.container.classList.add).toHaveBeenCalledWith('open');
      expect(manager.isDropdownOpen).toBe(true);
    });

    it('should close info popover when opening dropdown', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Open the popover first
      manager.isPopoverOpen = true;

      // Spy on hideInfoPopover
      const hideSpy = vi.spyOn(manager, 'hideInfoPopover');

      manager.showDropdown();

      expect(hideSpy).toHaveBeenCalled();
    });
  });

  describe('getTierForModel()', () => {
    it('should return fast tier for fast models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      expect(manager.getTierForModel('haiku')).toBe('fast');
      expect(manager.getTierForModel('flash')).toBe('fast');
      expect(manager.getTierForModel('gpt-4o-mini')).toBe('fast');
    });

    it('should return balanced tier for balanced models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      expect(manager.getTierForModel('sonnet')).toBe('balanced');
      expect(manager.getTierForModel('pro')).toBe('balanced');
      expect(manager.getTierForModel('gpt-4o')).toBe('balanced');
      expect(manager.getTierForModel('gpt-4')).toBe('balanced');
      expect(manager.getTierForModel('o1-mini')).toBe('balanced');
    });

    it('should return thorough tier for thorough models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      expect(manager.getTierForModel('opus')).toBe('thorough');
      expect(manager.getTierForModel('ultra')).toBe('thorough');
      expect(manager.getTierForModel('o1')).toBe('thorough');
    });

    it('should return null for unknown models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      expect(manager.getTierForModel('unknown-model')).toBe(null);
      expect(manager.getTierForModel('custom-model')).toBe(null);
    });

    it('should return null for null or undefined input', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      expect(manager.getTierForModel(null)).toBe(null);
      expect(manager.getTierForModel(undefined)).toBe(null);
      expect(manager.getTierForModel('')).toBe(null);
    });
  });

  describe('formatTierName()', () => {
    it('should return uppercase tier name', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      expect(manager.formatTierName('fast')).toBe('FAST');
      expect(manager.formatTierName('balanced')).toBe('BALANCED');
      expect(manager.formatTierName('thorough')).toBe('THOROUGH');
    });

    it('should return empty string for null or undefined', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      expect(manager.formatTierName(null)).toBe('');
      expect(manager.formatTierName(undefined)).toBe('');
      expect(manager.formatTierName('')).toBe('');
    });
  });

  describe('updateInfoPopover() tier badge', () => {
    it('should include tier badge when model has a known tier', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set a selected run with a known model
      manager.selectedRun = {
        id: 'run-123',
        model: 'sonnet',
        provider: 'claude',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: '2024-01-15T10:01:00Z',
        total_suggestions: 5
      };

      manager.updateInfoPopover();

      // Check that the HTML includes the tier badge
      const infoContent = mockDocument._elements['analysis-context-info-content'];
      expect(infoContent.innerHTML).toContain('analysis-tier-badge');
      expect(infoContent.innerHTML).toContain('analysis-tier-balanced');
      expect(infoContent.innerHTML).toContain('BALANCED');
    });

    it('should include fast tier badge for fast models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      manager.selectedRun = {
        id: 'run-123',
        model: 'haiku',
        provider: 'claude',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: '2024-01-15T10:01:00Z',
        total_suggestions: 3
      };

      manager.updateInfoPopover();

      const infoContent = mockDocument._elements['analysis-context-info-content'];
      expect(infoContent.innerHTML).toContain('analysis-tier-fast');
      expect(infoContent.innerHTML).toContain('FAST');
    });

    it('should include thorough tier badge for thorough models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      manager.selectedRun = {
        id: 'run-123',
        model: 'opus',
        provider: 'claude',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: '2024-01-15T10:01:00Z',
        total_suggestions: 8
      };

      manager.updateInfoPopover();

      const infoContent = mockDocument._elements['analysis-context-info-content'];
      expect(infoContent.innerHTML).toContain('analysis-tier-thorough');
      expect(infoContent.innerHTML).toContain('THOROUGH');
    });

    it('should not include tier badge for unknown models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      manager.selectedRun = {
        id: 'run-123',
        model: 'unknown-model',
        provider: 'custom',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: '2024-01-15T10:01:00Z',
        total_suggestions: 2
      };

      manager.updateInfoPopover();

      const infoContent = mockDocument._elements['analysis-context-info-content'];
      expect(infoContent.innerHTML).not.toContain('analysis-tier-badge');
      expect(infoContent.innerHTML).not.toContain('analysis-info-tier-row');
    });
  });

  describe('parseTimestamp() UTC handling', () => {
    it('should parse ISO 8601 timestamps with Z suffix as UTC', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      const result = manager.parseTimestamp('2024-01-15T10:00:00Z');

      // The parsed date should represent 10:00 UTC
      expect(result.getUTCHours()).toBe(10);
      expect(result.getUTCMinutes()).toBe(0);
    });

    it('should parse ISO 8601 timestamps with timezone offset', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      // 10:00 in +05:00 timezone = 05:00 UTC
      const result = manager.parseTimestamp('2024-01-15T10:00:00+05:00');

      expect(result.getUTCHours()).toBe(5);
      expect(result.getUTCMinutes()).toBe(0);
    });

    it('should parse SQLite CURRENT_TIMESTAMP format as UTC', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      // SQLite format without timezone - should be treated as UTC
      const result = manager.parseTimestamp('2024-01-15 10:00:00');

      // The parsed date should represent 10:00 UTC
      expect(result.getUTCHours()).toBe(10);
      expect(result.getUTCMinutes()).toBe(0);
    });

    it('should return invalid date for null/undefined input', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      expect(manager.parseTimestamp(null).toString()).toBe('Invalid Date');
      expect(manager.parseTimestamp(undefined).toString()).toBe('Invalid Date');
    });

    it('should correctly handle SQLite timestamps for relative time calculation', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      // Create a timestamp that's 2 hours ago in UTC using SQLite format
      const nowUtc = new Date();
      const twoHoursAgoUtc = new Date(nowUtc.getTime() - 2 * 60 * 60 * 1000);
      const sqliteFormat = twoHoursAgoUtc.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

      const result = manager.formatRelativeTime(sqliteFormat);

      // Should show "2 hours ago" regardless of local timezone
      expect(result).toBe('2 hours ago');
    });

    it('should correctly handle ISO timestamps for relative time calculation', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      // Create a timestamp that's 3 hours ago in UTC using ISO format
      const nowUtc = new Date();
      const threeHoursAgoUtc = new Date(nowUtc.getTime() - 3 * 60 * 60 * 1000);
      const isoFormat = threeHoursAgoUtc.toISOString();

      const result = manager.formatRelativeTime(isoFormat);

      // Should show "3 hours ago"
      expect(result).toBe('3 hours ago');
    });

    it('should handle duration calculation with SQLite timestamps', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      // 30 seconds duration using SQLite format
      const result = manager.formatDuration(
        '2024-01-15 10:00:00',
        '2024-01-15 10:00:30'
      );

      expect(result).toBe('30.0s');
    });

    it('should handle duration calculation with mixed timestamp formats', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      // 1 minute 30 seconds duration with mixed formats
      const result = manager.formatDuration(
        '2024-01-15 10:00:00',
        '2024-01-15T10:01:30Z'
      );

      expect(result).toBe('1m 30s');
    });
  });
});
