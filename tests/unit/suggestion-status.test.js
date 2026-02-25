// SPDX-License-Identifier: GPL-3.0-or-later
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

  // Initialize currentPR with a review id for unified comment API endpoints
  prManager.currentPR = {
    id: 'test-review-1',
    owner: 'test-owner',
    repo: 'test-repo',
    number: 1
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
        `/api/reviews/test-review-1/suggestions/${suggestionId}/status`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'dismissed' })
        })
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
      const mockButton = {
        title: '',
        querySelector: vi.fn().mockReturnValue({ textContent: '' })
      };
      const mockElement = {
        dataset: { hiddenForAdoption: 'true' },
        classList: {
          add: vi.fn()
        },
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
      expect(mockElement.classList.add).toHaveBeenCalledWith('collapsed');
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
        `/api/reviews/test-review-1/suggestions/${suggestionId}/status`,
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
      // hiddenForAdoption is now on the suggestion div, not the row
      const mockButton = {
        title: '',
        querySelector: vi.fn().mockReturnValue({ textContent: '' })
      };
      const mockElement = {
        dataset: { hiddenForAdoption: 'true' },
        classList: {
          toggle: vi.fn(),
          contains: vi.fn().mockReturnValue(true)
        },
        querySelector: vi.fn((selector) => {
          if (selector === '.btn-restore') return mockButton;
          return null;
        })
      };
      document.querySelector.mockReturnValue(mockElement);

      await prManager.restoreSuggestion(suggestionId);

      // API should NOT be called for hidden-for-adoption suggestions
      expect(mockFetch).not.toHaveBeenCalled();
      // aiPanel.updateFindingStatus should NOT be called either
      expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();
      // The classList.toggle should be called on suggestionDiv (mockElement), not some other element
      expect(mockElement.classList.toggle).toHaveBeenCalledWith('collapsed');
    });

    it('should correctly restore the second suggestion when two suggestions are on the same line (regression test for pair_review-nzu7)', async () => {
      // This test verifies the fix for the bug where restoring the second dismissed
      // suggestion on the same line would incorrectly toggle the first suggestion.
      // The bug was caused by using suggestionRow.querySelector('.ai-suggestion') which
      // always returned the first suggestion div, rather than using the suggestionDiv
      // that was correctly found by ID.
      const prManager = createTestPRManager();

      // Create two mock suggestion divs that share the same parent row
      const mockButton1 = {
        title: '',
        querySelector: vi.fn().mockReturnValue({ textContent: '' })
      };
      const mockButton2 = {
        title: '',
        querySelector: vi.fn().mockReturnValue({ textContent: '' })
      };

      const mockSuggestionDiv1 = {
        dataset: { hiddenForAdoption: 'true' },
        classList: {
          toggle: vi.fn(),
          contains: vi.fn().mockReturnValue(true)
        },
        querySelector: vi.fn((selector) => {
          if (selector === '.btn-restore') return mockButton1;
          return null;
        })
      };

      const mockSuggestionDiv2 = {
        dataset: { hiddenForAdoption: 'true' },
        classList: {
          toggle: vi.fn(),
          contains: vi.fn().mockReturnValue(true)
        },
        querySelector: vi.fn((selector) => {
          if (selector === '.btn-restore') return mockButton2;
          return null;
        })
      };

      // Test restoring the SECOND suggestion (ID: 2)
      // The document.querySelector should find the correct suggestion by ID
      document.querySelector.mockImplementation((selector) => {
        if (selector === '[data-suggestion-id="1"]') return mockSuggestionDiv1;
        if (selector === '[data-suggestion-id="2"]') return mockSuggestionDiv2;
        return null;
      });

      // Restore the second suggestion
      await prManager.restoreSuggestion('2');

      // The SECOND suggestion's classList.toggle should be called, NOT the first
      expect(mockSuggestionDiv2.classList.toggle).toHaveBeenCalledWith('collapsed');
      expect(mockSuggestionDiv1.classList.toggle).not.toHaveBeenCalled();

      // The button within the SECOND suggestion should be updated, NOT the first
      expect(mockSuggestionDiv2.querySelector).toHaveBeenCalledWith('.btn-restore');
      expect(mockSuggestionDiv1.querySelector).not.toHaveBeenCalledWith('.btn-restore');
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
      const mockElement = {
        dataset: { hiddenForAdoption: 'true' },
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
      const mockElement = {
        dataset: { hiddenForAdoption: 'false' },
        classList: {
          add: vi.fn()
        },
        querySelector: vi.fn().mockReturnValue(null)
      };
      document.querySelector.mockReturnValue(mockElement);

      await prManager.dismissSuggestion(suggestionId);

      // API SHOULD be called since adoption was deleted
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/reviews/test-review-1/suggestions/${suggestionId}/status`,
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
        `/api/reviews/test-review-1/comments/${commentId}`,
        expect.objectContaining({ method: 'DELETE' })
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
      document.querySelector.mockReset();
      document.querySelector
        .mockReturnValueOnce(mockCommentRow)  // First call: line-level comment row
        .mockReturnValueOnce(null)            // Second call: file-level comment card (not found)
        .mockReturnValueOnce(null);           // Third call: suggestion div (not found, aiPanel is null anyway)

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

    it('should clear hiddenForAdoption when dismissing an adopted comment\'s parent suggestion', async () => {
      const commentId = 'test-comment-adopted';
      const parentSuggestionId = 'test-suggestion-adopted-parent';

      // Mock successful DELETE response with dismissedSuggestionId
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          dismissedSuggestionId: parentSuggestionId
        })
      });

      // Build a suggestion div with hiddenForAdoption set
      const mockSuggestionDiv = {
        dataset: { hiddenForAdoption: 'true', suggestionId: parentSuggestionId }
      };

      // Reset querySelector mock to handle all 3 calls:
      // 1) line-level comment row, 2) file-level comment card, 3) suggestion div
      document.querySelector.mockReset();
      document.querySelector
        .mockReturnValueOnce(mockCommentRow)       // [data-comment-id="..."]
        .mockReturnValueOnce(null)                  // .file-comment-card[data-comment-id="..."]
        .mockReturnValueOnce(mockSuggestionDiv);    // [data-suggestion-id="..."]

      await prManager.deleteUserComment(commentId);

      // Verify hiddenForAdoption was cleared from the suggestion div
      expect(mockSuggestionDiv.dataset.hiddenForAdoption).toBeUndefined();

      // Verify AIPanel updateFindingStatus was also called
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(parentSuggestionId, 'dismissed');
    });

    it('should support full adopt → dismiss → restore cycle', async () => {
      // This test verifies the complete lifecycle:
      // 1. Suggestion is adopted (hiddenForAdoption = 'true')
      // 2. User deletes the comment → hiddenForAdoption should be cleared
      // 3. User restores the suggestion → should call API (not toggle-only shortcut)

      const commentId = 'test-comment-cycle';
      const suggestionId = 'test-suggestion-cycle';

      // --- Step 1: Setup adopted suggestion state ---
      const mockSuggestionDiv = {
        dataset: { hiddenForAdoption: 'true', suggestionId },
        classList: {
          add: vi.fn(),
          remove: vi.fn(),
          toggle: vi.fn(),
          contains: vi.fn().mockReturnValue(false)
        },
        closest: vi.fn().mockReturnValue(null),
        querySelector: vi.fn().mockReturnValue(null)
      };

      // Verify initial state: hiddenForAdoption is set
      expect(mockSuggestionDiv.dataset.hiddenForAdoption).toBe('true');

      // --- Step 2: Delete the comment (dismiss the parent suggestion) ---
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          dismissedSuggestionId: suggestionId
        })
      });

      // querySelector calls: comment row, file-comment card, suggestion div
      document.querySelector.mockReset();
      document.querySelector
        .mockReturnValueOnce(mockCommentRow)       // line-level comment row
        .mockReturnValueOnce(null)                  // file-level comment card
        .mockReturnValueOnce(mockSuggestionDiv);    // suggestion div lookup

      await prManager.deleteUserComment(commentId);

      // After deletion, hiddenForAdoption should be cleared
      expect(mockSuggestionDiv.dataset.hiddenForAdoption).toBeUndefined();
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(suggestionId, 'dismissed');

      // --- Step 3: Restore the suggestion ---
      // Since hiddenForAdoption was cleared, restoreSuggestion should take the API path
      mockFetch.mockResolvedValueOnce({ ok: true });

      // restoreSuggestion calls querySelector once for the suggestion div
      document.querySelector.mockReset();
      document.querySelector.mockReturnValue(mockSuggestionDiv);

      window.aiPanel.updateFindingStatus.mockClear();
      await prManager.restoreSuggestion(suggestionId);

      // API SHOULD have been called (not the toggle-only shortcut)
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/reviews/test-review-1/suggestions/${suggestionId}/status`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'active' })
        })
      );

      // aiPanel.updateFindingStatus should be called with 'active'
      expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(suggestionId, 'active');
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
        `/api/reviews/test-review-1/comments/${commentId}/restore`,
        expect.objectContaining({ method: 'PUT' })
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

  // Regression guard for pair_review-149d: collapseSuggestionForAdoption must only
  // affect the targeted suggestion when multiple suggestions share the same row.
  describe('collapseSuggestionForAdoption', () => {
    let prManager;

    beforeEach(() => {
      prManager = Object.create(PRManager.prototype);
    });

    /**
     * Build a mock suggestion div with the DOM structure
     * collapseSuggestionForAdoption queries:
     *   - classList.add('collapsed')
     *   - querySelector('.collapsed-text') -> { textContent }
     *   - querySelector('.btn-restore') -> { title, querySelector('.btn-text') -> { textContent } }
     *   - dataset.hiddenForAdoption
     */
    function buildSuggestionDiv(id) {
      const collapsedText = { textContent: '' };
      const btnText = { textContent: '' };
      const restoreBtn = { title: '', querySelector: vi.fn(() => btnText) };

      const div = {
        dataset: { suggestionId: id },
        classList: { add: vi.fn() },
        querySelector: vi.fn((selector) => {
          if (selector === '.collapsed-text') return collapsedText;
          if (selector === '.btn-restore') return restoreBtn;
          return null;
        }),
        getAttribute: vi.fn((attr) => attr === 'data-suggestion-id' ? id : null),
        _collapsedText: collapsedText,
        _restoreBtn: restoreBtn,
        _btnText: btnText
      };
      return div;
    }

    /**
     * Build a mock suggestion row that contains one or more suggestion divs.
     * The row's querySelector uses CSS attribute selectors to find the right div.
     */
    function buildRowWithSuggestions(...divs) {
      return {
        querySelector: vi.fn((selector) => {
          // selector looks like: [data-suggestion-id="<id>"]
          const match = selector.match(/data-suggestion-id="([^"]+)"/);
          if (!match) return null;
          return divs.find(d => d.dataset.suggestionId === match[1]) || null;
        })
      };
    }

    it('should collapse the targeted suggestion div', () => {
      const div = buildSuggestionDiv('s1');
      const row = buildRowWithSuggestions(div);

      prManager.collapseSuggestionForAdoption(row, 's1');

      expect(div.classList.add).toHaveBeenCalledWith('collapsed');
      expect(div._collapsedText.textContent).toBe('Suggestion adopted');
      expect(div._restoreBtn.title).toBe('Show suggestion');
      expect(div._btnText.textContent).toBe('Show');
      expect(div.dataset.hiddenForAdoption).toBe('true');
    });

    it('should only collapse the targeted suggestion when two suggestions share the same row', () => {
      const divA = buildSuggestionDiv('s-target');
      const divB = buildSuggestionDiv('s-other');
      const row = buildRowWithSuggestions(divA, divB);

      prManager.collapseSuggestionForAdoption(row, 's-target');

      // Target suggestion should be collapsed
      expect(divA.classList.add).toHaveBeenCalledWith('collapsed');
      expect(divA._collapsedText.textContent).toBe('Suggestion adopted');
      expect(divA.dataset.hiddenForAdoption).toBe('true');

      // Other suggestion on the same row should be completely unaffected
      expect(divB.classList.add).not.toHaveBeenCalled();
      expect(divB._collapsedText.textContent).toBe('');
      expect(divB.dataset.hiddenForAdoption).toBeUndefined();
    });

    it('should be a no-op when suggestionRow is null', () => {
      // Should not throw
      expect(() => prManager.collapseSuggestionForAdoption(null, 's1')).not.toThrow();
    });

    it('should be a no-op when the target div is not found in the row', () => {
      const divA = buildSuggestionDiv('s-other');
      const row = buildRowWithSuggestions(divA);

      // Targeting a non-existent suggestion ID should not affect divA
      prManager.collapseSuggestionForAdoption(row, 's-missing');

      expect(divA.classList.add).not.toHaveBeenCalled();
      expect(divA._collapsedText.textContent).toBe('');
    });
  });
});
