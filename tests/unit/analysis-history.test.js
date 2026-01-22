// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for AnalysisHistoryManager
 *
 * Tests the show/hide functionality, configurable containerPrefix,
 * and base64 encoding/decoding for clipboard content.
 *
 * This file imports and tests the ACTUAL production AnalysisHistoryManager class,
 * mocking only external dependencies (DOM, fetch, clipboard).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Helper to create mock DOM elements with realistic behavior
function createMockElement(overrides = {}) {
  const classSet = new Set();
  return {
    style: { display: '' },
    classList: {
      add: vi.fn((cls) => classSet.add(cls)),
      remove: vi.fn((cls) => classSet.delete(cls)),
      toggle: vi.fn((cls, force) => {
        if (force === undefined) {
          if (classSet.has(cls)) {
            classSet.delete(cls);
          } else {
            classSet.add(cls);
          }
        } else if (force) {
          classSet.add(cls);
        } else {
          classSet.delete(cls);
        }
      }),
      contains: vi.fn((cls) => classSet.has(cls))
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
  elements[`${prefix}-preview`] = createMockElement(); // previewPanel

  // Mock createElement to return an element that works for escapeHtml
  const mockCreateElement = vi.fn(() => {
    const el = {
      textContent: '',
      innerHTML: ''
    };
    // Make innerHTML reflect textContent (escaped) for escapeHtml
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._innerHTML || ''; },
      set(v) { this._innerHTML = v; }
    });
    Object.defineProperty(el, 'textContent', {
      get() { return this._textContent || ''; },
      set(v) {
        this._textContent = v;
        // Simulate browser's HTML escaping
        this._innerHTML = v
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }
    });
    return el;
  });

  return {
    getElementById: vi.fn((id) => elements[id] || null),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createElement: mockCreateElement,
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
  let mockClipboard;
  let mockFetch;

  beforeEach(async () => {
    // Save original globals
    originalGlobals = {
      document: global.document,
      window: global.window,
      btoa: global.btoa,
      atob: global.atob,
      fetch: global.fetch
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

    // Mock fetch
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Mock clipboard - use vi.stubGlobal for Node.js 20+ where navigator is read-only
    mockClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined)
    };
    vi.stubGlobal('navigator', { clipboard: mockClipboard });

    // Reset modules so we get a fresh import
    vi.resetModules();

    // Now import the actual production module
    // The module assigns to window.AnalysisHistoryManager
    await import('../../public/js/modules/analysis-history.js');

    // Get the class from the window object where the module attaches it
    AnalysisHistoryManager = global.window.AnalysisHistoryManager;
  });

  afterEach(() => {
    // Restore original globals
    global.document = originalGlobals.document;
    global.window = originalGlobals.window;
    global.btoa = originalGlobals.btoa;
    global.atob = originalGlobals.atob;
    global.fetch = originalGlobals.fetch;
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
      expect(mockDocument.getElementById).toHaveBeenCalledWith(`${customPrefix}-preview`);
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
    // Test the encoding function used in updatePreviewPanel
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

      manager.destroy();

      expect(manager.runs).toEqual([]);
      expect(manager.selectedRunId).toBeNull();
      expect(manager.selectedRun).toBeNull();
      expect(manager.isDropdownOpen).toBe(false);
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
      // Format: <timestamp> · <provider> · <model> (provider is lowercase)
      expect(manager.historyLabel.textContent).toMatch(/2 hours ago · claude · claude-opus-4/);
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

      // Provider is lowercase per formatProviderName()
      expect(manager.historyLabel.textContent).toMatch(/3 hours ago · gemini · gemini-pro/);
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

      // Provider defaults to 'unknown' (lowercase), model to 'Unknown' (capitalized)
      expect(manager.historyLabel.textContent).toMatch(/1 hour ago · unknown · Unknown/);
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
      manager.selectedRunId = 1;

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

  describe('updatePreviewPanel() tier display', () => {
    it('should include tier when model has a known tier', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up runs with a known model
      manager.runs = [{
        id: 'run-123',
        model: 'sonnet',
        provider: 'claude',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: '2024-01-15T10:01:00Z',
        total_suggestions: 5
      }];

      manager.updatePreviewPanel('run-123');

      // Check that the HTML includes the tier (lowercase per code review feedback)
      const previewPanel = mockDocument._elements['analysis-context-preview'];
      expect(previewPanel.innerHTML).toContain('balanced');
    });

    it('should include fast tier for fast models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      manager.runs = [{
        id: 'run-123',
        model: 'haiku',
        provider: 'claude',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: '2024-01-15T10:01:00Z',
        total_suggestions: 3
      }];

      manager.updatePreviewPanel('run-123');

      const previewPanel = mockDocument._elements['analysis-context-preview'];
      expect(previewPanel.innerHTML).toContain('fast');
    });

    it('should include thorough tier for thorough models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      manager.runs = [{
        id: 'run-123',
        model: 'opus',
        provider: 'claude',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: '2024-01-15T10:01:00Z',
        total_suggestions: 8
      }];

      manager.updatePreviewPanel('run-123');

      const previewPanel = mockDocument._elements['analysis-context-preview'];
      expect(previewPanel.innerHTML).toContain('thorough');
    });

    it('should show unknown tier for unknown models', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      manager.runs = [{
        id: 'run-123',
        model: 'unknown-model',
        provider: 'custom',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: '2024-01-15T10:01:00Z',
        total_suggestions: 2
      }];

      manager.updatePreviewPanel('run-123');

      const previewPanel = mockDocument._elements['analysis-context-preview'];
      // Should show unknown for the tier (lowercase per code review feedback)
      expect(previewPanel.innerHTML).toContain('unknown');
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

  describe('refresh()', () => {
    it('should switch to the new run when switchToNew=true', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up existing state with an old run selected
      manager.runs = [{ id: 'old-run', model: 'sonnet', provider: 'claude' }];
      manager.selectedRunId = 'old-run';
      manager.selectedRun = manager.runs[0];

      // Mock fetch to return both old and new runs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          runs: [
            { id: 'new-run', model: 'opus', provider: 'claude' },
            { id: 'old-run', model: 'sonnet', provider: 'claude' }
          ]
        })
      });

      await manager.refresh({ switchToNew: true });

      // Should switch to the new run
      expect(manager.selectedRunId).toBe('new-run');
      expect(manager.selectedRun.model).toBe('opus');
      expect(manager.newRunId).toBeNull();
    });

    it('should preserve user selection and show indicator when switchToNew=false', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up existing state with an old run selected
      manager.runs = [{ id: 'old-run', model: 'sonnet', provider: 'claude' }];
      manager.selectedRunId = 'old-run';
      manager.selectedRun = manager.runs[0];

      // Mock fetch to return both old and new runs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          runs: [
            { id: 'new-run', model: 'opus', provider: 'claude' },
            { id: 'old-run', model: 'sonnet', provider: 'claude' }
          ]
        })
      });

      await manager.refresh({ switchToNew: false });

      // Should preserve the old selection
      expect(manager.selectedRunId).toBe('old-run');
      expect(manager.selectedRun.model).toBe('sonnet');
      // Should mark the new run
      expect(manager.newRunId).toBe('new-run');
      // Should show the indicator
      expect(manager.historyBtn.classList.add).toHaveBeenCalledWith('has-new-run');
    });

    it('should switch to new run even with switchToNew=false if no previous selection', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // No previous selection
      manager.runs = [];
      manager.selectedRunId = null;
      manager.selectedRun = null;

      // Mock fetch to return a new run
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          runs: [
            { id: 'new-run', model: 'opus', provider: 'claude' }
          ]
        })
      });

      await manager.refresh({ switchToNew: false });

      // Should switch to the new run since there was no previous selection
      expect(manager.selectedRunId).toBe('new-run');
      expect(manager.selectedRun.model).toBe('opus');
      expect(manager.newRunId).toBeNull();
    });

    it('should return previous runs on fetch error', async () => {
      // Suppress expected console warning
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up existing state
      const oldRuns = [{ id: 'old-run', model: 'sonnet', provider: 'claude' }];
      manager.runs = oldRuns;
      manager.selectedRunId = 'old-run';

      // Mock fetch to return an error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500
      });

      const result = await manager.refresh({ switchToNew: true });

      // Should return the previous runs and didSwitch=false
      expect(result).toEqual({ runs: oldRuns, didSwitch: false });
    });

    it('should return didSwitch=true when switching to a new run', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up existing state with an old run selected
      manager.runs = [{ id: 'old-run', model: 'sonnet', provider: 'claude' }];
      manager.selectedRunId = 'old-run';
      manager.selectedRun = manager.runs[0];

      // Mock fetch to return both old and new runs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          runs: [
            { id: 'new-run', model: 'opus', provider: 'claude' },
            { id: 'old-run', model: 'sonnet', provider: 'claude' }
          ]
        })
      });

      const result = await manager.refresh({ switchToNew: true });

      // Should return didSwitch=true
      expect(result.didSwitch).toBe(true);
      expect(result.runs).toHaveLength(2);
    });

    it('should return didSwitch=false when preserving user selection', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up existing state with an old run selected
      manager.runs = [{ id: 'old-run', model: 'sonnet', provider: 'claude' }];
      manager.selectedRunId = 'old-run';
      manager.selectedRun = manager.runs[0];

      // Mock fetch to return both old and new runs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          runs: [
            { id: 'new-run', model: 'opus', provider: 'claude' },
            { id: 'old-run', model: 'sonnet', provider: 'claude' }
          ]
        })
      });

      const result = await manager.refresh({ switchToNew: false });

      // Should return didSwitch=false since user selection was preserved
      expect(result.didSwitch).toBe(false);
      expect(result.runs).toHaveLength(2);
    });

    it('should return didSwitch=true for first-ever run even with switchToNew=false', async () => {
      // This is the key bug fix test: first-ever analysis run should switch
      // and return didSwitch=true regardless of the switchToNew parameter
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // No previous selection (first-ever run scenario)
      manager.runs = [];
      manager.selectedRunId = null;
      manager.selectedRun = null;

      // Mock fetch to return a new run
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          runs: [
            { id: 'first-run', model: 'opus', provider: 'claude' }
          ]
        })
      });

      const result = await manager.refresh({ switchToNew: false });

      // Even though switchToNew=false, should switch because there's no previous selection
      // This ensures the ProgressModal will call loadAISuggestions() for first-ever runs
      expect(result.didSwitch).toBe(true);
      expect(manager.selectedRunId).toBe('first-run');
      expect(manager.selectedRun.model).toBe('opus');
    });

    it('should return didSwitch=false when runs list is empty after fetch', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up existing state
      manager.runs = [{ id: 'old-run', model: 'sonnet', provider: 'claude' }];
      manager.selectedRunId = 'old-run';

      // Mock fetch to return empty runs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runs: [] })
      });

      const result = await manager.refresh({ switchToNew: true });

      // Should return didSwitch=false since there's nothing to switch to
      expect(result.didSwitch).toBe(false);
      expect(result.runs).toEqual([]);
    });
  });

  describe('clearNewRunIndicator()', () => {
    it('should be called when user selects the new run', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up state with a new run indicator
      manager.runs = [
        { id: 'new-run', model: 'opus', provider: 'claude' },
        { id: 'old-run', model: 'sonnet', provider: 'claude' }
      ];
      manager.newRunId = 'new-run';
      manager.selectedRunId = 'old-run';
      manager.selectedRun = manager.runs[1];

      // Select the new run
      await manager.selectRun('new-run', false);

      // Should clear the indicator
      expect(manager.newRunId).toBeNull();
      expect(manager.historyBtn.classList.remove).toHaveBeenCalledWith('has-new-run');
    });

    it('should not clear indicator when selecting a different run', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });
      manager.init();

      // Set up state with a new run indicator
      manager.runs = [
        { id: 'new-run', model: 'opus', provider: 'claude' },
        { id: 'middle-run', model: 'haiku', provider: 'claude' },
        { id: 'old-run', model: 'sonnet', provider: 'claude' }
      ];
      manager.newRunId = 'new-run';
      manager.selectedRunId = 'old-run';
      manager.selectedRun = manager.runs[2];

      // Select the middle run (not the new one)
      await manager.selectRun('middle-run', false);

      // Should NOT clear the indicator
      expect(manager.newRunId).toBe('new-run');
    });
  });

  describe('hasNewRun() and getNewRunId()', () => {
    it('hasNewRun() should return true when newRunId is set', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      manager.newRunId = 'some-run-id';

      expect(manager.hasNewRun()).toBe(true);
    });

    it('hasNewRun() should return false when newRunId is null', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      manager.newRunId = null;

      expect(manager.hasNewRun()).toBe(false);
    });

    it('getNewRunId() should return the newRunId value', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      manager.newRunId = 'test-run-123';

      expect(manager.getNewRunId()).toBe('test-run-123');
    });

    it('getNewRunId() should return null when no new run', () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 1,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      manager.newRunId = null;

      expect(manager.getNewRunId()).toBeNull();
    });
  });

  describe('fetchRuns()', () => {
    it('should return empty runs when reviewId is not set', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: null,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      const result = await manager.fetchRuns();

      expect(result).toEqual({ runs: [], error: null });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fetch runs from the API', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 123,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      const mockRuns = [{ id: 1, model: 'opus' }, { id: 2, model: 'sonnet' }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runs: mockRuns })
      });

      const result = await manager.fetchRuns();

      expect(mockFetch).toHaveBeenCalledWith('/api/analysis-runs/123');
      expect(result).toEqual({ runs: mockRuns, error: null });
    });

    it('should handle HTTP errors', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 123,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      const result = await manager.fetchRuns();

      expect(result).toEqual({ runs: [], error: 'HTTP 404' });
    });

    it('should handle network errors', async () => {
      const manager = new AnalysisHistoryManager({
        reviewId: 123,
        mode: 'pr',
        onSelectionChange: vi.fn()
      });

      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      const result = await manager.fetchRuns();

      expect(result).toEqual({ runs: [], error: 'Network failure' });
    });
  });
});
