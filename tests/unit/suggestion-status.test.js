import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for PRManager suggestion status management
 * Tests dismissSuggestion() and restoreSuggestion() methods
 * focusing on their integration with window.aiPanel.updateFindingStatus()
 *
 * IMPORTANT: These tests import the actual PRManager class from production code
 * to ensure tests verify real behavior, not a reimplementation.
 */

// Import the actual PRManager class from production code
const { PRManager } = require('../../public/js/pr.js');

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

/**
 * Create a minimal PRManager instance for testing.
 * Uses the actual PRManager class, but only initializes the properties
 * needed for the specific methods being tested.
 */
function createTestPRManager() {
  // Create a real PRManager instance
  const prManager = Object.create(PRManager.prototype);

  // Initialize only the properties needed for dismissSuggestion/restoreSuggestion
  prManager.suggestionNavigator = {
    suggestions: [],
    updateSuggestions: vi.fn()
  };

  return prManager;
}

describe('PRManager Suggestion Status', () => {
  describe('dismissSuggestion', () => {
    it('should call window.aiPanel.updateFindingStatus with dismissed status', async () => {
      const prManager = createTestPRManager();
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
      const prManager = createTestPRManager();
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
      const prManager = createTestPRManager();
      const suggestionId = 'test-suggestion-789';

      // Mock failed API response
      mockFetch.mockResolvedValueOnce({ ok: false });

      await prManager.dismissSuggestion(suggestionId);

      // aiPanel.updateFindingStatus should NOT be called on failure
      expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith('Failed to dismiss suggestion');
    });

    it('should handle missing aiPanel gracefully', async () => {
      const prManager = createTestPRManager();
      const suggestionId = 'test-suggestion-abc';

      mockFetch.mockResolvedValueOnce({ ok: true });
      document.querySelector.mockReturnValue(null);

      // Remove aiPanel from window
      window.aiPanel = null;

      // Should not throw
      await expect(prManager.dismissSuggestion(suggestionId)).resolves.not.toThrow();
    });

    it('should not call API or update status for adopted suggestions (hiddenForAdoption)', async () => {
      const prManager = createTestPRManager();
      const suggestionId = 'test-suggestion-adopted';

      // Mock element that is hidden for adoption (was adopted and user comment still exists)
      const mockDiv = {
        classList: {
          add: vi.fn()
        },
        querySelector: vi.fn().mockReturnValue(null)
      };
      const mockButton = {
        title: '',
        querySelector: vi.fn().mockReturnValue({ textContent: '' })
      };
      const mockRow = {
        dataset: { hiddenForAdoption: 'true' },
        querySelector: vi.fn((selector) => {
          if (selector === '.btn-restore') return mockButton;
          return null;
        })
      };
      const mockElement = {
        closest: vi.fn().mockReturnValue(mockRow),
        classList: mockDiv.classList,
        querySelector: vi.fn((selector) => {
          if (selector === '.btn-restore') return mockButton;
          return null;
        })
      };
      document.querySelector.mockReturnValue(mockElement);

      await prManager.dismissSuggestion(suggestionId);

      // API should NOT be called for adopted suggestions
      expect(mockFetch).not.toHaveBeenCalled();
      // aiPanel.updateFindingStatus should NOT be called - status remains 'adopted'
      expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();
      // suggestionNavigator should NOT be updated
      expect(prManager.suggestionNavigator.updateSuggestions).not.toHaveBeenCalled();
      // But the visual collapse should still happen
      expect(mockDiv.classList.add).toHaveBeenCalledWith('collapsed');
    });
  });

  describe('restoreSuggestion', () => {
    it('should call window.aiPanel.updateFindingStatus with active status', async () => {
      const prManager = createTestPRManager();
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
      const prManager = createTestPRManager();
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
      const prManager = createTestPRManager();
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
      const prManager = createTestPRManager();
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
      const prManager = createTestPRManager();
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
      const prManager = createTestPRManager();
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

      const prManager = createTestPRManager();
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

  describe('adopted suggestion workflow', () => {
    it('should preserve adopted status when showing and dismissing adopted suggestion', async () => {
      // Re-setup aiPanel
      global.window = {
        aiPanel: {
          updateFindingStatus: vi.fn()
        }
      };

      const prManager = createTestPRManager();
      const suggestionId = 'test-adopted-workflow';

      // Simulate an adopted suggestion: hiddenForAdoption is 'true'
      // This means there's a user comment linked to this suggestion
      let isCollapsed = true;
      const mockDiv = {
        classList: {
          add: vi.fn(() => { isCollapsed = true; }),
          toggle: vi.fn(() => { isCollapsed = !isCollapsed; }),
          contains: vi.fn(() => isCollapsed)
        }
      };
      const mockButton = {
        title: 'Show suggestion',
        querySelector: vi.fn().mockReturnValue({ textContent: 'Show' })
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
        closest: vi.fn().mockReturnValue(mockRow),
        classList: mockDiv.classList,
        querySelector: vi.fn((selector) => {
          if (selector === '.btn-restore') return mockButton;
          return null;
        })
      };
      document.querySelector.mockReturnValue(mockElement);

      // User clicks "Show" to reveal the adopted suggestion
      await prManager.restoreSuggestion(suggestionId);

      // API should NOT be called (just visual toggle)
      expect(mockFetch).not.toHaveBeenCalled();
      // Status should NOT be updated (remains 'adopted')
      expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();

      // User clicks "Dismiss" on the revealed suggestion
      await prManager.dismissSuggestion(suggestionId);

      // API should still NOT be called (just visual collapse)
      expect(mockFetch).not.toHaveBeenCalled();
      // Status should still NOT be updated (remains 'adopted')
      expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();
      // Visual collapse should happen
      expect(mockDiv.classList.add).toHaveBeenCalledWith('collapsed');
    });

    it('should properly dismiss when hiddenForAdoption is false (adoption deleted)', async () => {
      // Re-setup aiPanel
      global.window = {
        aiPanel: {
          updateFindingStatus: vi.fn()
        }
      };

      const prManager = createTestPRManager();
      const suggestionId = 'test-orphaned-suggestion';

      mockFetch.mockResolvedValue({ ok: true });

      // Simulate a suggestion that was adopted but the user comment was deleted
      // hiddenForAdoption is now 'false' (or not set)
      const mockDiv = {
        classList: {
          add: vi.fn()
        }
      };
      const mockRow = {
        dataset: { hiddenForAdoption: 'false' },
        querySelector: vi.fn().mockReturnValue(null)
      };
      const mockElement = {
        closest: vi.fn().mockReturnValue(mockRow),
        classList: mockDiv.classList,
        querySelector: vi.fn().mockReturnValue(null)
      };
      document.querySelector.mockReturnValue(mockElement);

      await prManager.dismissSuggestion(suggestionId);

      // API SHOULD be called since adoption was deleted
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/ai-suggestion/${suggestionId}/status`,
        expect.objectContaining({
          body: JSON.stringify({ status: 'dismissed' })
        })
      );
      // Status SHOULD be updated to 'dismissed'
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(suggestionId, 'dismissed');
    });
  });

  describe('deleteUserComment', () => {
    let prManager;
    let mockCommentRow;

    beforeEach(() => {
      // Setup window with standard mocks for delete tests
      global.window = {
        aiPanel: {
          updateFindingStatus: vi.fn(),
          removeComment: vi.fn()
        },
        confirmDialog: {
          show: vi.fn().mockResolvedValue('confirm')
        }
      };

      // Create PRManager instance with updateCommentCount mock
      prManager = createTestPRManager();
      prManager.updateCommentCount = vi.fn();

      // Setup mock comment row
      mockCommentRow = { remove: vi.fn() };
      document.querySelector.mockReturnValue(mockCommentRow);
    });

    it('should update AIPanel with active status when deleting comment with parent_id', async () => {
      const commentId = 'test-comment-123';
      const parentSuggestionId = 'test-suggestion-456';

      // Mock successful DELETE response with dismissedSuggestionId
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          dismissedSuggestionId: parentSuggestionId
        })
      });

      await prManager.deleteUserComment(commentId);

      // Verify API was called with DELETE method
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/user-comment/${commentId}`,
        { method: 'DELETE' }
      );

      // Verify AIPanel removeComment was called
      expect(window.aiPanel.removeComment).toHaveBeenCalledWith(commentId);

      // Verify AIPanel updateFindingStatus was called with 'dismissed' status
      // When deleting a comment that adopted a suggestion, the suggestion card
      // is still collapsed/dismissed in the diff view. User can click "Show" to restore.
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(parentSuggestionId, 'dismissed');
    });

    it('should not update AIPanel findingStatus when no parent_id exists', async () => {
      const commentId = 'test-comment-no-parent';

      // Mock successful DELETE response WITHOUT dismissedSuggestionId
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true
          // No dismissedSuggestionId - comment had no parent
        })
      });

      await prManager.deleteUserComment(commentId);

      // AIPanel removeComment should still be called
      expect(window.aiPanel.removeComment).toHaveBeenCalledWith(commentId);

      // But updateFindingStatus should NOT be called since no parent suggestion
      expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();
    });

    it('should handle missing AIPanel gracefully when deleting comment', async () => {
      window.aiPanel = null;

      const commentId = 'test-comment-no-panel';
      const parentSuggestionId = 'test-suggestion-789';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          dismissedSuggestionId: parentSuggestionId
        })
      });

      // Should not throw even without aiPanel
      await expect(prManager.deleteUserComment(commentId)).resolves.not.toThrow();
    });

    it('should not proceed with deletion when user cancels confirmation', async () => {
      window.confirmDialog.show.mockResolvedValue('cancel'); // User cancels

      await prManager.deleteUserComment('test-comment');

      // API should NOT be called
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
