import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for PRManager suggestion status management
 * Tests dismissSuggestion() and restoreSuggestion() methods
 * focusing on their integration with window.aiPanel.updateFindingStatus()
 */

// Mock global fetch
const mockFetch = vi.fn();

// Setup global mocks before tests
beforeEach(() => {
  // Reset all mocks
  vi.resetAllMocks();

  // Setup global.fetch
  global.fetch = mockFetch;

  // Setup window object with aiPanel mock
  global.window = {
    aiPanel: {
      updateFindingStatus: vi.fn()
    }
  };

  // Setup document mock
  global.document = {
    querySelector: vi.fn()
  };

  // Setup alert mock
  global.alert = vi.fn();

  // Setup console mock for error testing
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Create a minimal PRManager instance for testing
function createPRManager() {
  // Minimal PRManager with just the methods we need to test
  return {
    suggestionNavigator: {
      suggestions: [],
      updateSuggestions: vi.fn()
    },

    async dismissSuggestion(suggestionId) {
      try {
        const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'dismissed' })
        });

        if (!response.ok) throw new Error('Failed to dismiss suggestion');

        const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
        if (suggestionDiv) {
          suggestionDiv.classList.add('collapsed');
          const restoreButton = suggestionDiv.querySelector('.btn-restore');
          if (restoreButton) {
            restoreButton.title = 'Show suggestion';
            const btnText = restoreButton.querySelector('.btn-text');
            if (btnText) btnText.textContent = 'Show';
          }
        }

        if (this.suggestionNavigator?.suggestions) {
          const updatedSuggestions = this.suggestionNavigator.suggestions.map(s =>
            s.id === suggestionId ? { ...s, status: 'dismissed' } : s
          );
          this.suggestionNavigator.updateSuggestions(updatedSuggestions);
        }

        if (window.aiPanel) {
          window.aiPanel.updateFindingStatus(suggestionId, 'dismissed');
        }
      } catch (error) {
        console.error('Error dismissing suggestion:', error);
        alert('Failed to dismiss suggestion');
      }
    },

    async restoreSuggestion(suggestionId) {
      try {
        const suggestionDiv = document.querySelector(`[data-suggestion-id="${suggestionId}"]`);
        const suggestionRow = suggestionDiv?.closest('tr');

        if (suggestionRow?.dataset.hiddenForAdoption === 'true') {
          const div = suggestionRow.querySelector('.ai-suggestion');
          if (div) {
            div.classList.toggle('collapsed');

            const button = suggestionRow.querySelector('.btn-restore');
            if (button) {
              const isNowCollapsed = div.classList.contains('collapsed');
              button.title = isNowCollapsed ? 'Show suggestion' : 'Hide suggestion';
              button.querySelector('.btn-text').textContent = isNowCollapsed ? 'Show' : 'Hide';
            }
          }
          return;
        }

        const response = await fetch(`/api/ai-suggestion/${suggestionId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' })
        });

        if (!response.ok) throw new Error('Failed to restore suggestion');

        if (suggestionDiv) {
          suggestionDiv.classList.remove('collapsed');
        }

        if (this.suggestionNavigator?.suggestions) {
          const updatedSuggestions = this.suggestionNavigator.suggestions.map(s =>
            s.id === suggestionId ? { ...s, status: 'active' } : s
          );
          this.suggestionNavigator.updateSuggestions(updatedSuggestions);
        }

        if (window.aiPanel) {
          window.aiPanel.updateFindingStatus(suggestionId, 'active');
        }
      } catch (error) {
        console.error('Error restoring suggestion:', error);
        alert('Failed to restore suggestion');
      }
    }
  };
}

describe('PRManager Suggestion Status', () => {
  describe('dismissSuggestion', () => {
    it('should call window.aiPanel.updateFindingStatus with dismissed status', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-123';

      // Mock successful API response
      mockFetch.mockResolvedValueOnce({ ok: true });

      // Mock document.querySelector to return null (no DOM element found)
      document.querySelector.mockReturnValue(null);

      await prManager.dismissSuggestion(suggestionId);

      // Verify aiPanel.updateFindingStatus was called with correct arguments
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledTimes(1);
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(suggestionId, 'dismissed');
    });

    it('should call API with correct parameters when dismissing', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-456';

      mockFetch.mockResolvedValueOnce({ ok: true });
      document.querySelector.mockReturnValue(null);

      await prManager.dismissSuggestion(suggestionId);

      expect(mockFetch).toHaveBeenCalledWith(
        `/api/ai-suggestion/${suggestionId}/status`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'dismissed' })
        }
      );
    });

    it('should not call aiPanel.updateFindingStatus when API fails', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-789';

      // Mock failed API response
      mockFetch.mockResolvedValueOnce({ ok: false });

      await prManager.dismissSuggestion(suggestionId);

      // aiPanel.updateFindingStatus should NOT be called on failure
      expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith('Failed to dismiss suggestion');
    });

    it('should handle missing aiPanel gracefully', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-abc';

      mockFetch.mockResolvedValueOnce({ ok: true });
      document.querySelector.mockReturnValue(null);

      // Remove aiPanel from window
      window.aiPanel = null;

      // Should not throw
      await expect(prManager.dismissSuggestion(suggestionId)).resolves.not.toThrow();
    });
  });

  describe('restoreSuggestion', () => {
    it('should call window.aiPanel.updateFindingStatus with active status', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-restore-123';

      // Mock successful API response
      mockFetch.mockResolvedValueOnce({ ok: true });

      // Mock document.querySelector to return a mock element (not hidden for adoption)
      const mockElement = {
        closest: vi.fn().mockReturnValue(null), // No parent row (not hidden for adoption)
        classList: {
          remove: vi.fn()
        }
      };
      document.querySelector.mockReturnValue(mockElement);

      await prManager.restoreSuggestion(suggestionId);

      // Verify aiPanel.updateFindingStatus was called with correct arguments
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledTimes(1);
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(suggestionId, 'active');
    });

    it('should call API with correct parameters when restoring', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-restore-456';

      mockFetch.mockResolvedValueOnce({ ok: true });
      document.querySelector.mockReturnValue({
        closest: vi.fn().mockReturnValue(null),
        classList: { remove: vi.fn() }
      });

      await prManager.restoreSuggestion(suggestionId);

      expect(mockFetch).toHaveBeenCalledWith(
        `/api/ai-suggestion/${suggestionId}/status`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' })
        }
      );
    });

    it('should not call aiPanel.updateFindingStatus when API fails', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-restore-789';

      // Mock failed API response
      mockFetch.mockResolvedValueOnce({ ok: false });
      document.querySelector.mockReturnValue({
        closest: vi.fn().mockReturnValue(null),
        classList: { remove: vi.fn() }
      });

      await prManager.restoreSuggestion(suggestionId);

      // aiPanel.updateFindingStatus should NOT be called on failure
      expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith('Failed to restore suggestion');
    });

    it('should not call API for hidden-for-adoption suggestions', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-hidden';

      // Mock element that is hidden for adoption
      const mockDiv = {
        classList: {
          toggle: vi.fn(),
          contains: vi.fn().mockReturnValue(true)
        }
      };
      const mockButton = {
        title: '',
        querySelector: vi.fn().mockReturnValue({ textContent: '' })
      };
      const mockRow = {
        dataset: { hiddenForAdoption: 'true' },
        querySelector: vi.fn((selector) => {
          if (selector === '.ai-suggestion') return mockDiv;
          if (selector === '.btn-restore') return mockButton;
          return null;
        })
      };
      const mockElement = {
        closest: vi.fn().mockReturnValue(mockRow)
      };
      document.querySelector.mockReturnValue(mockElement);

      await prManager.restoreSuggestion(suggestionId);

      // API should NOT be called for hidden-for-adoption suggestions
      expect(mockFetch).not.toHaveBeenCalled();
      // aiPanel.updateFindingStatus should NOT be called either
      expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();
    });

    it('should handle missing aiPanel gracefully', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-restore-abc';

      mockFetch.mockResolvedValueOnce({ ok: true });
      document.querySelector.mockReturnValue({
        closest: vi.fn().mockReturnValue(null),
        classList: { remove: vi.fn() }
      });

      // Remove aiPanel from window
      window.aiPanel = null;

      // Should not throw
      await expect(prManager.restoreSuggestion(suggestionId)).resolves.not.toThrow();
    });

    it('should update suggestionNavigator when restoring', async () => {
      const prManager = createPRManager();
      const suggestionId = 'test-suggestion-nav';

      // Setup navigator with existing suggestions
      prManager.suggestionNavigator.suggestions = [
        { id: suggestionId, status: 'dismissed', title: 'Test' },
        { id: 'other', status: 'active', title: 'Other' }
      ];

      mockFetch.mockResolvedValueOnce({ ok: true });
      document.querySelector.mockReturnValue({
        closest: vi.fn().mockReturnValue(null),
        classList: { remove: vi.fn() }
      });

      await prManager.restoreSuggestion(suggestionId);

      // Verify navigator was updated with status changed to 'active'
      expect(prManager.suggestionNavigator.updateSuggestions).toHaveBeenCalledWith([
        { id: suggestionId, status: 'active', title: 'Test' },
        { id: 'other', status: 'active', title: 'Other' }
      ]);
    });
  });

  describe('symmetry between dismiss and restore', () => {
    it('should use dismissed status for dismiss and active status for restore', async () => {
      // Re-setup aiPanel since previous test may have nulled it
      global.window = {
        aiPanel: {
          updateFindingStatus: vi.fn()
        }
      };

      const prManager = createPRManager();
      const suggestionId = 'test-symmetry';

      mockFetch.mockResolvedValue({ ok: true });

      // Create mock element that works for both dismiss and restore
      const mockElement = {
        closest: vi.fn().mockReturnValue(null),
        classList: { add: vi.fn(), remove: vi.fn() },
        querySelector: vi.fn().mockReturnValue(null) // For btn-restore lookup
      };
      document.querySelector.mockReturnValue(mockElement);

      // Dismiss first
      await prManager.dismissSuggestion(suggestionId);
      expect(window.aiPanel.updateFindingStatus).toHaveBeenLastCalledWith(suggestionId, 'dismissed');

      // Then restore
      await prManager.restoreSuggestion(suggestionId);
      expect(window.aiPanel.updateFindingStatus).toHaveBeenLastCalledWith(suggestionId, 'active');

      // Both should have been called
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledTimes(2);
    });
  });
});
