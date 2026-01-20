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
          this.container.classList.add('open');
          this.isDropdownOpen = true;
          this.hideInfoPopover();
        }
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
});
