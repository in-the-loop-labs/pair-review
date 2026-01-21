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
      // Note: deleteUserComment no longer uses confirmDialog (soft-delete without confirmation)
      global.window = {
        aiPanel: {
          updateFindingStatus: vi.fn(),
          removeComment: vi.fn()
        },
        toast: {
          showSuccess: vi.fn(),
          showError: vi.fn()
        }
      };

      // Create PRManager instance with updateCommentCount mock
      prManager = createTestPRManager();
      prManager.updateCommentCount = vi.fn();
      prManager.fileCommentManager = null;

      // Setup mock comment row - return value for first querySelector (line-level),
      // null for second (file-level)
      mockCommentRow = { remove: vi.fn() };
      document.querySelector
        .mockReturnValueOnce(mockCommentRow)  // First call: line-level comment row
        .mockReturnValueOnce(null);            // Second call: file-level comment card (not found)
    });

    it('should update AIPanel with dismissed status when deleting comment with parent_id', async () => {
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

      // Verify toast success message
      expect(window.toast.showSuccess).toHaveBeenCalledWith('Comment dismissed');
    });

    it('should not update AIPanel findingStatus when no parent_id exists', async () => {
      const commentId = 'test-comment-no-parent';

      // Reset querySelector mock for this test
      document.querySelector
        .mockReturnValueOnce(mockCommentRow)  // First call: line-level comment row
        .mockReturnValueOnce(null);            // Second call: file-level comment card (not found)

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

      // Toast success should still be shown
      expect(window.toast.showSuccess).toHaveBeenCalledWith('Comment dismissed');
    });

    it('should handle missing AIPanel gracefully when deleting comment', async () => {
      // Clear aiPanel but keep toast
      const toastMock = window.toast;
      window.aiPanel = null;
      window.toast = toastMock;

      // Reset querySelector mock for this test
      document.querySelector
        .mockReturnValueOnce(mockCommentRow)  // First call: line-level comment row
        .mockReturnValueOnce(null);            // Second call: file-level comment card (not found)

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

      // Toast should still work
      expect(window.toast.showSuccess).toHaveBeenCalledWith('Comment dismissed');
    });

    it('should show error toast when API call fails', async () => {
      // Reset querySelector mock for this test (not needed but for consistency)
      document.querySelector
        .mockReturnValueOnce(mockCommentRow)
        .mockReturnValueOnce(null);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'Failed to delete' })
      });

      await prManager.deleteUserComment('test-comment');

      // Error toast should be shown
      expect(window.toast.showError).toHaveBeenCalledWith('Failed to dismiss comment');
    });

    it('should always remove comment from diff view but update AI Panel when showDismissedComments is true', async () => {
      // DESIGN DECISION: Dismissed comments are NEVER shown in the diff panel.
      // They only appear in the AI/Review Panel when the "show dismissed" filter is ON.
      const commentId = 'test-comment-show-dismissed';

      // Setup aiPanel with showDismissedComments enabled and necessary methods
      window.aiPanel = {
        showDismissedComments: true,
        updateComment: vi.fn(),
        removeComment: vi.fn(),
        updateFindingStatus: vi.fn()
      };

      // Setup mock comment row
      const mockRowWithChild = {
        remove: vi.fn()
      };

      // Reset document.querySelector mock and set up return values
      document.querySelector.mockReset();
      document.querySelector
        .mockReturnValueOnce(mockRowWithChild)  // line-level comment row
        .mockReturnValueOnce(null);              // file-level comment card (not found)

      // Mock successful DELETE response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ success: true })
      });

      await prManager.deleteUserComment(commentId);

      // Verify document.querySelector was called to find the row
      expect(document.querySelector).toHaveBeenCalledWith(`[data-comment-id="${commentId}"]`);

      // Comment row should ALWAYS be removed from diff view (design decision)
      expect(mockRowWithChild.remove).toHaveBeenCalled();

      // AIPanel should update comment status to 'inactive' (not removed from AI Panel)
      expect(window.aiPanel.updateComment).toHaveBeenCalledWith(commentId, { status: 'inactive' });
      expect(window.aiPanel.removeComment).not.toHaveBeenCalled();

      // Comment count should still be updated
      expect(prManager.updateCommentCount).toHaveBeenCalled();
    });

    it('should remove comment when showDismissedComments is false', async () => {
      const commentId = 'test-comment-hide-dismissed';

      // Setup aiPanel with showDismissedComments disabled (default)
      window.aiPanel = {
        showDismissedComments: false,
        updateComment: vi.fn(),
        removeComment: vi.fn(),
        updateFindingStatus: vi.fn()
      };

      // Setup mock comment row
      document.querySelector
        .mockReturnValueOnce(mockCommentRow)  // line-level comment row
        .mockReturnValueOnce(null);            // file-level comment card (not found)

      // Mock successful DELETE response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ success: true })
      });

      await prManager.deleteUserComment(commentId);

      // Comment row should be removed when showDismissedComments is false
      expect(mockCommentRow.remove).toHaveBeenCalled();

      // AIPanel should remove comment, not update it
      expect(window.aiPanel.removeComment).toHaveBeenCalledWith(commentId);
      expect(window.aiPanel.updateComment).not.toHaveBeenCalled();
    });
  });

  describe('updateCommentCount', () => {
    let prManager;
    let mockSplitButton;

    beforeEach(() => {
      prManager = createTestPRManager();

      // Mock splitButton
      mockSplitButton = {
        updateCommentCount: vi.fn()
      };
      prManager.splitButton = mockSplitButton;

      // Reset document mock for querySelectorAll
      document.querySelectorAll = vi.fn();

      // Mock document.getElementById for reviewButton and clearButton
      document.getElementById = vi.fn().mockReturnValue(null);
    });

    it('should count line-level comments', () => {
      // DESIGN DECISION: Dismissed comments are never in the diff DOM, so we simply count all visible elements.
      // Mock DOM with 2 comment rows (all active, dismissed comments are never in DOM)
      document.querySelectorAll.mockImplementation((selector) => {
        if (selector === '.user-comment-row') {
          return { length: 2 }; // 2 comments
        }
        if (selector === '.file-comment-card.user-comment') {
          return { length: 0 }; // No file-level comments
        }
        return { length: 0 };
      });

      prManager.updateCommentCount();

      expect(mockSplitButton.updateCommentCount).toHaveBeenCalledWith(2);
    });

    it('should count file-level comments', () => {
      // Mock DOM with file-level comments (dismissed comments are never in DOM)
      document.querySelectorAll.mockImplementation((selector) => {
        if (selector === '.user-comment-row') {
          return { length: 0 }; // No line-level comments
        }
        if (selector === '.file-comment-card.user-comment') {
          return { length: 1 }; // 1 file-level comment
        }
        return { length: 0 };
      });

      prManager.updateCommentCount();

      expect(mockSplitButton.updateCommentCount).toHaveBeenCalledWith(1);
    });

    it('should combine line-level and file-level comment counts', () => {
      // Mock DOM with both types: 3 line-level, 2 file-level
      document.querySelectorAll.mockImplementation((selector) => {
        if (selector === '.user-comment-row') {
          return { length: 3 }; // 3 line-level comments
        }
        if (selector === '.file-comment-card.user-comment') {
          return { length: 2 }; // 2 file-level comments
        }
        return { length: 0 };
      });

      prManager.updateCommentCount();

      expect(mockSplitButton.updateCommentCount).toHaveBeenCalledWith(5);
    });

    it('should return 0 when no comments exist', () => {
      // Mock DOM with no comments (dismissed comments are never in DOM anyway)
      document.querySelectorAll.mockImplementation((selector) => {
        if (selector === '.user-comment-row') {
          return { length: 0 }; // No line-level
        }
        if (selector === '.file-comment-card.user-comment') {
          return { length: 0 }; // No file-level
        }
        return { length: 0 };
      });

      prManager.updateCommentCount();

      expect(mockSplitButton.updateCommentCount).toHaveBeenCalledWith(0);
    });

    it('should handle missing splitButton gracefully', () => {
      prManager.splitButton = null;

      document.querySelectorAll.mockImplementation((selector) => {
        if (selector === '.user-comment-row') {
          return { length: 2 };
        }
        if (selector === '.file-comment-card.user-comment') {
          return { length: 1 };
        }
        return { length: 0 };
      });

      // Should not throw
      expect(() => prManager.updateCommentCount()).not.toThrow();
    });
  });

  describe('restoreUserComment', () => {
    let prManager;

    beforeEach(() => {
      // Setup window with standard mocks for restore tests
      global.window = {
        aiPanel: {
          showDismissedComments: true
        },
        toast: {
          showSuccess: vi.fn(),
          showError: vi.fn()
        }
      };

      // Create PRManager instance with loadUserComments mock
      prManager = createTestPRManager();
      prManager.loadUserComments = vi.fn().mockResolvedValue(undefined);
    });

    it('should call correct API endpoint when restoring comment', async () => {
      const commentId = 'test-comment-restore-1';

      // Mock successful PUT response
      mockFetch.mockResolvedValueOnce({
        ok: true
      });

      await prManager.restoreUserComment(commentId);

      // Verify API was called with correct endpoint and method
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/user-comment/${commentId}/restore`,
        { method: 'PUT' }
      );
    });

    it('should show success toast on successful restore', async () => {
      const commentId = 'test-comment-restore-2';

      mockFetch.mockResolvedValueOnce({ ok: true });

      await prManager.restoreUserComment(commentId);

      // Verify toast.showSuccess was called
      expect(window.toast.showSuccess).toHaveBeenCalledWith('Comment restored');
    });

    it('should show error toast when API call fails', async () => {
      const commentId = 'test-comment-restore-3';

      // Mock failed PUT response
      mockFetch.mockResolvedValueOnce({ ok: false });

      await prManager.restoreUserComment(commentId);

      // Verify toast.showError was called
      expect(window.toast.showError).toHaveBeenCalledWith('Failed to restore comment');
      // Verify toast.showSuccess was NOT called
      expect(window.toast.showSuccess).not.toHaveBeenCalled();
    });

    it('should reload comments after successful restore', async () => {
      const commentId = 'test-comment-restore-4';

      mockFetch.mockResolvedValueOnce({ ok: true });

      await prManager.restoreUserComment(commentId);

      // Verify loadUserComments was called with current filter state
      expect(prManager.loadUserComments).toHaveBeenCalledWith(true); // showDismissedComments is true
    });

    it('should pass correct includeDismissed flag when reloading comments', async () => {
      // Test with showDismissedComments = false
      window.aiPanel.showDismissedComments = false;
      const commentId = 'test-comment-restore-5';

      mockFetch.mockResolvedValueOnce({ ok: true });

      await prManager.restoreUserComment(commentId);

      // Verify loadUserComments was called with false
      expect(prManager.loadUserComments).toHaveBeenCalledWith(false);
    });

    it('should not reload comments when API call fails', async () => {
      const commentId = 'test-comment-restore-6';

      mockFetch.mockResolvedValueOnce({ ok: false });

      await prManager.restoreUserComment(commentId);

      // Verify loadUserComments was NOT called on failure
      expect(prManager.loadUserComments).not.toHaveBeenCalled();
    });

    it('should handle missing toast gracefully', async () => {
      window.toast = null;
      const commentId = 'test-comment-restore-7';

      mockFetch.mockResolvedValueOnce({ ok: true });

      // Should not throw even without toast
      await expect(prManager.restoreUserComment(commentId)).resolves.not.toThrow();

      // loadUserComments should still be called
      expect(prManager.loadUserComments).toHaveBeenCalled();
    });

    it('should handle missing aiPanel gracefully for filter state', async () => {
      window.aiPanel = null;
      const commentId = 'test-comment-restore-8';

      mockFetch.mockResolvedValueOnce({ ok: true });

      await prManager.restoreUserComment(commentId);

      // Should default to false when aiPanel is missing
      expect(prManager.loadUserComments).toHaveBeenCalledWith(false);
    });
  });
});
