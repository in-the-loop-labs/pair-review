import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock localStorage
const createMockLocalStorage = () => {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = value; }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    key: vi.fn((index) => Object.keys(store)[index] ?? null),
    get length() { return Object.keys(store).length; },
    _getStore: () => store,
    _setStore: (newStore) => { store = { ...newStore }; }
  };
};

describe('Storage Cleanup Module', () => {
  let mockLocalStorage;
  let originalConsoleLog;

  beforeEach(() => {
    mockLocalStorage = createMockLocalStorage();
    global.localStorage = mockLocalStorage;
    // Suppress console.log during tests
    originalConsoleLog = console.log;
    console.log = vi.fn();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    vi.clearAllMocks();
  });

  // Import the function inline since it's a browser module
  const cleanupLegacyLocalStorage = () => {
    const legacyKeys = [
      'pair-review-session-state',
      'reviewPanelSegment',
      'pair-review-preferences',
      'pairReviewSidebarCollapsed',
      'pairReviewTheme',
      'settingsReferrer',
    ];

    legacyKeys.forEach(key => {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
      }
    });
  };

  describe('cleanupLegacyLocalStorage', () => {
    it('should remove legacy keys that exist', () => {
      mockLocalStorage._setStore({
        'pair-review-session-state': '{}',
        'reviewPanelSegment': 'comments',
        'pair-review-preferences': '{}',
        'pairReviewSidebarCollapsed': 'false',
        'pairReviewTheme': 'light',
        'settingsReferrer': '{}',
      });

      cleanupLegacyLocalStorage();

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('pair-review-session-state');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('reviewPanelSegment');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('pair-review-preferences');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('pairReviewSidebarCollapsed');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('pairReviewTheme');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('settingsReferrer');
    });

    it('should not call removeItem for keys that do not exist', () => {
      mockLocalStorage._setStore({});

      cleanupLegacyLocalStorage();

      expect(mockLocalStorage.removeItem).not.toHaveBeenCalled();
    });

    it('should leave non-legacy keys untouched', () => {
      mockLocalStorage._setStore({
        'theme': 'dark',
        'file-sidebar-collapsed': 'true',
        'pair-review-model:owner/repo': 'claude-3-opus',
        'reviewPanelSegment_owner/repo#123': 'ai',
        'settingsReferrer:owner/repo': '{"prNumber":123}',
        // Legacy keys to be removed
        'pair-review-session-state': '{}',
        'reviewPanelSegment': 'comments',
      });

      cleanupLegacyLocalStorage();

      // Legacy keys should be removed
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('pair-review-session-state');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('reviewPanelSegment');

      // Non-legacy keys should NOT be removed
      expect(mockLocalStorage.removeItem).not.toHaveBeenCalledWith('theme');
      expect(mockLocalStorage.removeItem).not.toHaveBeenCalledWith('file-sidebar-collapsed');
      expect(mockLocalStorage.removeItem).not.toHaveBeenCalledWith('pair-review-model:owner/repo');
      expect(mockLocalStorage.removeItem).not.toHaveBeenCalledWith('reviewPanelSegment_owner/repo#123');
      expect(mockLocalStorage.removeItem).not.toHaveBeenCalledWith('settingsReferrer:owner/repo');
    });

    it('should only remove legacy keys that actually exist', () => {
      mockLocalStorage._setStore({
        'pair-review-session-state': '{}',
        // Other legacy keys don't exist
      });

      cleanupLegacyLocalStorage();

      expect(mockLocalStorage.removeItem).toHaveBeenCalledTimes(1);
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('pair-review-session-state');
    });

    it('should handle empty localStorage gracefully', () => {
      mockLocalStorage._setStore({});

      expect(() => cleanupLegacyLocalStorage()).not.toThrow();
      expect(mockLocalStorage.removeItem).not.toHaveBeenCalled();
    });
  });
});
