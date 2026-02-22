// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock window object
global.window = { Icons: { icon: () => '<svg></svg>', DEFS: {} } };

// Minimal DOM mocks for Node environment
const createMockElement = (tag = 'div', options = {}) => {
  let _textContent = '';
  return {
    tagName: tag.toUpperCase(),
    style: { display: '' },
    className: '',
    id: options.id || '',
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn()
    },
    innerHTML: '',
    get textContent() { return _textContent; },
    set textContent(val) {
      _textContent = val;
      // Simulate escapeHtml behavior - innerHTML gets escaped version
      this.innerHTML = val
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    appendChild: vi.fn(),
    remove: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ top: 0, left: 0, width: 100, height: 20 })),
    closest: vi.fn((selector) => {
      if (options.dataAction && selector === '[data-action]') {
        return { dataset: { action: options.dataAction } };
      }
      return null;
    }),
    isContentEditable: false,
    contentEditable: 'false'
  };
};

let documentListeners = {};
let createdElements = [];
let headAppendedChildren = [];

global.document = {
  body: {
    innerHTML: '',
    appendChild: vi.fn((el) => createdElements.push(el)),
    removeChild: vi.fn()
  },
  head: {
    appendChild: vi.fn((el) => headAppendedChildren.push(el))
  },
  createElement: vi.fn((tag) => createMockElement(tag)),
  getElementById: vi.fn((id) => {
    if (id === 'keyboard-shortcuts-help') {
      return null; // No existing element
    }
    if (id === 'keyboard-shortcuts-styles') {
      // Return existing style element to prevent re-injection
      return headAppendedChildren.find(el => el.id === 'keyboard-shortcuts-styles');
    }
    return null;
  }),
  querySelector: vi.fn((selector) => {
    // Check for modal visibility
    if (selector.includes('modal-overlay')) {
      return null; // No modal open by default
    }
    return null;
  }),
  addEventListener: vi.fn((event, handler) => {
    if (!documentListeners[event]) {
      documentListeners[event] = [];
    }
    documentListeners[event].push(handler);
  }),
  removeEventListener: vi.fn()
};

global.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0));
global.setTimeout = vi.fn((cb, delay) => {
  cb();
  return 1;
});
global.clearTimeout = vi.fn();

// Mock window.getComputedStyle
global.window.getComputedStyle = vi.fn(() => ({
  display: 'flex',
  visibility: 'visible',
  opacity: '1'
}));

// Import the KeyboardShortcuts module
require('../../public/js/components/KeyboardShortcuts.js');

const { KeyboardShortcuts } = global.window;

describe('KeyboardShortcuts', () => {
  let shortcuts;
  let mockCallbacks;

  beforeEach(() => {
    // Reset state
    documentListeners = {};
    createdElements = [];

    mockCallbacks = {
      onCopyComments: vi.fn(),
      onClearComments: vi.fn(),
      onNextSuggestion: vi.fn(),
      onPrevSuggestion: vi.fn()
    };

    shortcuts = new KeyboardShortcuts(mockCallbacks);
  });

  afterEach(() => {
    if (shortcuts) {
      shortcuts.destroy();
      shortcuts = null;
    }
  });

  describe('constructor', () => {
    it('should initialize with default shortcuts', () => {
      expect(shortcuts.shortcuts.size).toBeGreaterThan(0);
      expect(shortcuts.shortcuts.has('?')).toBe(true);
      expect(shortcuts.shortcuts.has('c c')).toBe(true);
      expect(shortcuts.shortcuts.has('c x')).toBe(true);
      expect(shortcuts.shortcuts.has('j')).toBe(true);
      expect(shortcuts.shortcuts.has('k')).toBe(true);
    });

    it('should initialize with empty pending keys', () => {
      expect(shortcuts.pendingKeys).toEqual([]);
    });

    it('should initialize with help overlay hidden', () => {
      expect(shortcuts.isHelpVisible).toBe(false);
    });

    it('should set chord timeout to 500ms', () => {
      expect(shortcuts.chordTimeoutMs).toBe(500);
    });

    it('should store options', () => {
      expect(shortcuts.options).toBe(mockCallbacks);
    });
  });

  describe('registerShortcut', () => {
    it('should register a new shortcut', () => {
      const callback = vi.fn();
      shortcuts.registerShortcut(['g', 'i'], 'Go to issues', callback);

      expect(shortcuts.shortcuts.has('g i')).toBe(true);
      const shortcut = shortcuts.shortcuts.get('g i');
      expect(shortcut.keys).toEqual(['g', 'i']);
      expect(shortcut.description).toBe('Go to issues');
      expect(shortcut.callback).toBe(callback);
    });

    it('should warn and not register if keys is not an array', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      shortcuts.registerShortcut('?', 'Invalid', vi.fn());

      expect(warnSpy).toHaveBeenCalledWith('KeyboardShortcuts: keys must be a non-empty array');
      warnSpy.mockRestore();
    });

    it('should warn and not register if keys is empty', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      shortcuts.registerShortcut([], 'Invalid', vi.fn());

      expect(warnSpy).toHaveBeenCalledWith('KeyboardShortcuts: keys must be a non-empty array');
      warnSpy.mockRestore();
    });

    it('should allow overwriting existing shortcut', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      shortcuts.registerShortcut(['x'], 'First', callback1);
      shortcuts.registerShortcut(['x'], 'Second', callback2);

      const shortcut = shortcuts.shortcuts.get('x');
      expect(shortcut.description).toBe('Second');
      expect(shortcut.callback).toBe(callback2);
    });
  });

  describe('unregisterShortcut', () => {
    it('should remove a registered shortcut', () => {
      shortcuts.registerShortcut(['x', 'y'], 'Test', vi.fn());
      expect(shortcuts.shortcuts.has('x y')).toBe(true);

      shortcuts.unregisterShortcut(['x', 'y']);
      expect(shortcuts.shortcuts.has('x y')).toBe(false);
    });

    it('should not throw when unregistering non-existent shortcut', () => {
      expect(() => shortcuts.unregisterShortcut(['z', 'z', 'z'])).not.toThrow();
    });
  });

  describe('isInInputField', () => {
    it('should return true for INPUT element', () => {
      const input = createMockElement('input');
      expect(shortcuts.isInInputField(input)).toBe(true);
    });

    it('should return true for TEXTAREA element', () => {
      const textarea = createMockElement('textarea');
      expect(shortcuts.isInInputField(textarea)).toBe(true);
    });

    it('should return true for SELECT element', () => {
      const select = createMockElement('select');
      expect(shortcuts.isInInputField(select)).toBe(true);
    });

    it('should return true for contenteditable element', () => {
      const div = createMockElement('div');
      div.isContentEditable = true;
      expect(shortcuts.isInInputField(div)).toBe(true);
    });

    it('should return true for contentEditable="true" attribute', () => {
      const div = createMockElement('div');
      div.contentEditable = 'true';
      expect(shortcuts.isInInputField(div)).toBe(true);
    });

    it('should return false for regular div', () => {
      const div = createMockElement('div');
      expect(shortcuts.isInInputField(div)).toBe(false);
    });

    it('should return false for null', () => {
      expect(shortcuts.isInInputField(null)).toBe(false);
    });
  });

  describe('isElementVisible', () => {
    it('should return false for null element', () => {
      expect(shortcuts.isElementVisible(null)).toBe(false);
    });

    it('should return false for display:none element', () => {
      const element = createMockElement('div');
      global.window.getComputedStyle = vi.fn(() => ({ display: 'none', visibility: 'visible', opacity: '1' }));
      expect(shortcuts.isElementVisible(element)).toBe(false);
    });

    it('should return false for visibility:hidden element', () => {
      const element = createMockElement('div');
      global.window.getComputedStyle = vi.fn(() => ({ display: 'flex', visibility: 'hidden', opacity: '1' }));
      expect(shortcuts.isElementVisible(element)).toBe(false);
    });

    it('should return false for opacity:0 element', () => {
      const element = createMockElement('div');
      global.window.getComputedStyle = vi.fn(() => ({ display: 'flex', visibility: 'visible', opacity: '0' }));
      expect(shortcuts.isElementVisible(element)).toBe(false);
    });

    it('should return true for visible element', () => {
      const element = createMockElement('div');
      global.window.getComputedStyle = vi.fn(() => ({ display: 'flex', visibility: 'visible', opacity: '1' }));
      expect(shortcuts.isElementVisible(element)).toBe(true);
    });
  });

  describe('chord detection', () => {
    it('should match single-key shortcuts immediately', () => {
      // Simulate pressing '?'
      shortcuts.pendingKeys = ['?'];
      const matched = shortcuts.tryMatchShortcut();

      expect(matched).toBe(true);
    });

    it('should match two-key chords', () => {
      // Simulate 'c' then 'c'
      shortcuts.pendingKeys = ['c', 'c'];
      const matched = shortcuts.tryMatchShortcut();

      expect(matched).toBe(true);
    });

    it('should detect potential match for chord prefix', () => {
      // After pressing 'c', there are potential matches like 'c c' and 'c x'
      shortcuts.pendingKeys = ['c'];
      const hasPotential = shortcuts.hasPotentialMatch();

      expect(hasPotential).toBe(true);
    });

    it('should not detect potential match for non-prefix', () => {
      shortcuts.pendingKeys = ['z'];
      const hasPotential = shortcuts.hasPotentialMatch();

      expect(hasPotential).toBe(false);
    });
  });

  describe('resetChord', () => {
    it('should clear pending keys', () => {
      shortcuts.pendingKeys = ['c', 'x'];
      shortcuts.resetChord();

      expect(shortcuts.pendingKeys).toEqual([]);
    });

    it('should clear chord timeout', () => {
      shortcuts.chordTimeout = 123;
      shortcuts.resetChord();

      expect(global.clearTimeout).toHaveBeenCalledWith(123);
      expect(shortcuts.chordTimeout).toBe(null);
    });
  });

  describe('callback invocation', () => {
    it('should invoke onCopyComments for c c chord', () => {
      const shortcut = shortcuts.shortcuts.get('c c');
      shortcut.callback();

      expect(mockCallbacks.onCopyComments).toHaveBeenCalled();
    });

    it('should invoke onClearComments for c x chord', () => {
      const shortcut = shortcuts.shortcuts.get('c x');
      shortcut.callback();

      expect(mockCallbacks.onClearComments).toHaveBeenCalled();
    });

    it('should invoke onNextSuggestion for j shortcut', () => {
      const shortcut = shortcuts.shortcuts.get('j');
      shortcut.callback();

      expect(mockCallbacks.onNextSuggestion).toHaveBeenCalled();
    });

    it('should invoke onPrevSuggestion for k shortcut', () => {
      const shortcut = shortcuts.shortcuts.get('k');
      shortcut.callback();

      expect(mockCallbacks.onPrevSuggestion).toHaveBeenCalled();
    });

    it('should not throw if callback is undefined', () => {
      const noCallbacks = new KeyboardShortcuts({});
      const shortcut = noCallbacks.shortcuts.get('c c');

      expect(() => shortcut.callback()).not.toThrow();
      noCallbacks.destroy();
    });
  });

  describe('help overlay', () => {
    it('should show help overlay', () => {
      shortcuts.helpOverlay = createMockElement('div');
      shortcuts.helpOverlay.querySelector = vi.fn(() => createMockElement('div'));

      shortcuts.showHelp();

      expect(shortcuts.helpOverlay.style.display).toBe('flex');
      expect(shortcuts.isHelpVisible).toBe(true);
    });

    it('should not show help if already visible', () => {
      shortcuts.helpOverlay = createMockElement('div');
      shortcuts.isHelpVisible = true;
      shortcuts.helpOverlay.style.display = 'flex';

      const originalDisplay = shortcuts.helpOverlay.style.display;
      shortcuts.showHelp();

      expect(shortcuts.helpOverlay.style.display).toBe(originalDisplay);
    });

    it('should hide help overlay', () => {
      shortcuts.helpOverlay = createMockElement('div');
      shortcuts.helpOverlay.style.display = 'flex';
      shortcuts.isHelpVisible = true;

      shortcuts.hideHelp();

      // After setTimeout (mocked to run immediately)
      expect(shortcuts.helpOverlay.style.display).toBe('none');
      expect(shortcuts.isHelpVisible).toBe(false);
    });

    it('should not hide help if not visible', () => {
      shortcuts.helpOverlay = createMockElement('div');
      shortcuts.isHelpVisible = false;

      // This should be a no-op
      shortcuts.hideHelp();

      expect(shortcuts.isHelpVisible).toBe(false);
    });

    it('should toggle help overlay', () => {
      shortcuts.helpOverlay = createMockElement('div');
      shortcuts.helpOverlay.querySelector = vi.fn(() => createMockElement('div'));
      shortcuts.isHelpVisible = false;

      shortcuts.toggleHelp();
      expect(shortcuts.isHelpVisible).toBe(true);

      shortcuts.toggleHelp();
      expect(shortcuts.isHelpVisible).toBe(false);
    });
  });

  describe('formatKey', () => {
    it('should format special keys', () => {
      expect(shortcuts.formatKey('Escape')).toBe('Esc');
      expect(shortcuts.formatKey('ArrowUp')).toBe('\u2191');
      expect(shortcuts.formatKey('ArrowDown')).toBe('\u2193');
      expect(shortcuts.formatKey('Enter')).toBe('\u21B5');
      expect(shortcuts.formatKey(' ')).toBe('Space');
    });

    it('should uppercase regular keys', () => {
      expect(shortcuts.formatKey('a')).toBe('A');
      expect(shortcuts.formatKey('c')).toBe('C');
      expect(shortcuts.formatKey('j')).toBe('J');
    });

    it('should preserve ? key', () => {
      expect(shortcuts.formatKey('?')).toBe('?');
    });
  });

  describe('escapeHtml', () => {
    it('should escape HTML special characters', () => {
      // The escapeHtml method uses DOM to escape - our mock simulates this behavior
      expect(shortcuts.escapeHtml('<script>')).toBe('&lt;script&gt;');
      expect(shortcuts.escapeHtml('a & b')).toBe('a &amp; b');
      expect(shortcuts.escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    });

    it('should handle plain text unchanged', () => {
      expect(shortcuts.escapeHtml('Hello World')).toBe('Hello World');
    });
  });

  describe('renderShortcutsList', () => {
    it('should group shortcuts by category', () => {
      const html = shortcuts.renderShortcutsList();

      // Should contain group titles
      expect(html).toContain('Navigation');
      expect(html).toContain('Comments');
      expect(html).toContain('General');
    });

    it('should generate proper structure for shortcut items', () => {
      const html = shortcuts.renderShortcutsList();

      // Should contain proper structure
      expect(html).toContain('keyboard-shortcuts-group');
      expect(html).toContain('keyboard-shortcuts-group-title');
      expect(html).toContain('keyboard-shortcut-item');
      expect(html).toContain('keyboard-shortcut-key');
      expect(html).toContain('keyboard-shortcut-description');
    });

    it('should include "then" separator for multi-key shortcuts', () => {
      const html = shortcuts.renderShortcutsList();

      // Multi-key shortcuts like 'c c' should have "then" separator
      expect(html).toContain('keyboard-shortcut-then');
    });
  });

  describe('destroy', () => {
    it('should reset chord state', () => {
      shortcuts.pendingKeys = ['c'];
      shortcuts.chordTimeout = 123;

      shortcuts.destroy();

      expect(shortcuts.pendingKeys).toEqual([]);
      expect(shortcuts.chordTimeout).toBe(null);
    });

    it('should remove help overlay', () => {
      const mockOverlay = createMockElement('div');
      shortcuts.helpOverlay = mockOverlay;

      shortcuts.destroy();

      expect(mockOverlay.remove).toHaveBeenCalled();
      expect(shortcuts.helpOverlay).toBe(null);
    });

    it('should clear shortcuts map', () => {
      expect(shortcuts.shortcuts.size).toBeGreaterThan(0);

      shortcuts.destroy();

      expect(shortcuts.shortcuts.size).toBe(0);
    });
  });
});
