// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for FileCommentManager._getFileCommentEndpoint()
 *
 * Tests the endpoint generation for file-level comment operations,
 * ensuring the correct reviewId is used in local mode for all operations.
 *
 * This specifically tests the fix for a bug where 'prId' (undefined) was
 * used instead of 'reviewId' for update and delete operations in local mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Setup global.window before importing production code that assigns to it
global.window = global.window || {};

// Import the actual FileCommentManager class from production code
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');

/**
 * Create a minimal FileCommentManager instance for testing.
 * @param {Object} prManagerConfig - Configuration for the mock prManager
 */
function createTestFileCommentManager(prManagerConfig = {}) {
  const fileCommentManager = Object.create(FileCommentManager.prototype);
  fileCommentManager.prManager = {
    currentPR: {
      id: prManagerConfig.reviewId || 'test-review-123',
      reviewType: prManagerConfig.reviewType || 'local',
      head_sha: prManagerConfig.headSha || 'abc123'
    }
  };
  return fileCommentManager;
}

describe('FileCommentManager._getFileCommentEndpoint', () => {
  describe('Local mode endpoints', () => {
    let fileCommentManager;

    beforeEach(() => {
      fileCommentManager = createTestFileCommentManager({
        reviewId: 'local-review-456',
        reviewType: 'local',
        headSha: 'def789'
      });
    });

    it('should use reviewId for create endpoint in local mode', () => {
      const result = fileCommentManager._getFileCommentEndpoint('create', {
        file: 'src/test.js',
        body: 'Test comment'
      });

      expect(result.endpoint).toBe('/api/local/local-review-456/file-comment');
      expect(result.endpoint).not.toContain('undefined');
    });

    it('should use reviewId for update endpoint in local mode', () => {
      const result = fileCommentManager._getFileCommentEndpoint('update', {
        commentId: 'comment-789',
        body: 'Updated comment'
      });

      expect(result.endpoint).toBe('/api/local/local-review-456/file-comment/comment-789');
      expect(result.endpoint).not.toContain('undefined');
    });

    it('should use reviewId for delete endpoint in local mode', () => {
      const result = fileCommentManager._getFileCommentEndpoint('delete', {
        commentId: 'comment-789'
      });

      expect(result.endpoint).toBe('/api/local/local-review-456/file-comment/comment-789');
      expect(result.endpoint).not.toContain('undefined');
    });

    it('should include correct request body for create operation', () => {
      const result = fileCommentManager._getFileCommentEndpoint('create', {
        file: 'src/test.js',
        body: 'Test comment',
        parent_id: 'parent-123',
        type: 'suggestion',
        title: 'Test Title'
      });

      expect(result.requestBody).toEqual({
        file: 'src/test.js',
        body: 'Test comment',
        parent_id: 'parent-123',
        type: 'suggestion',
        title: 'Test Title'
      });
    });

    it('should include correct request body for update operation', () => {
      const result = fileCommentManager._getFileCommentEndpoint('update', {
        commentId: 'comment-789',
        body: 'Updated comment'
      });

      expect(result.requestBody).toEqual({
        body: 'Updated comment'
      });
    });

    it('should have null request body for delete operation', () => {
      const result = fileCommentManager._getFileCommentEndpoint('delete', {
        commentId: 'comment-789'
      });

      expect(result.requestBody).toBeNull();
    });
  });

  describe('PR mode endpoints', () => {
    let fileCommentManager;

    beforeEach(() => {
      fileCommentManager = createTestFileCommentManager({
        reviewId: 'pr-review-123',
        reviewType: 'pr',
        headSha: 'abc123'
      });
    });

    it('should use /api/file-comment for create endpoint in PR mode', () => {
      const result = fileCommentManager._getFileCommentEndpoint('create', {
        file: 'src/test.js',
        body: 'Test comment'
      });

      expect(result.endpoint).toBe('/api/file-comment');
    });

    it('should use /api/user-comment/:id for update endpoint in PR mode', () => {
      const result = fileCommentManager._getFileCommentEndpoint('update', {
        commentId: 'comment-789',
        body: 'Updated comment'
      });

      expect(result.endpoint).toBe('/api/user-comment/comment-789');
    });

    it('should use /api/user-comment/:id for delete endpoint in PR mode', () => {
      const result = fileCommentManager._getFileCommentEndpoint('delete', {
        commentId: 'comment-789'
      });

      expect(result.endpoint).toBe('/api/user-comment/comment-789');
    });

    it('should include review_id and commit_sha in create request body for PR mode', () => {
      const result = fileCommentManager._getFileCommentEndpoint('create', {
        file: 'src/test.js',
        body: 'Test comment',
        parent_id: 'parent-123',
        type: 'suggestion',
        title: 'Test Title'
      });

      expect(result.requestBody).toEqual({
        review_id: 'pr-review-123',
        file: 'src/test.js',
        body: 'Test comment',
        commit_sha: 'abc123',
        parent_id: 'parent-123',
        type: 'suggestion',
        title: 'Test Title'
      });
    });
  });

  describe('Error handling', () => {
    it('should throw for unknown operation', () => {
      const fileCommentManager = createTestFileCommentManager();

      expect(() => {
        fileCommentManager._getFileCommentEndpoint('unknown', {});
      }).toThrow('Unknown operation: unknown');
    });
  });
});

/**
 * Tests for FileCommentManager._getSuggestionStatusEndpoint()
 * Verifies that the helper method returns the correct endpoint URL
 * for both local and PR modes.
 */
describe('FileCommentManager._getSuggestionStatusEndpoint', () => {
  describe('Local mode', () => {
    it('should return local API endpoint when reviewType is local', () => {
      const fileCommentManager = createTestFileCommentManager({
        reviewId: 'local-review-456',
        reviewType: 'local'
      });

      const endpoint = fileCommentManager._getSuggestionStatusEndpoint(123);

      expect(endpoint).toBe('/api/local/local-review-456/ai-suggestion/123/status');
      expect(endpoint).not.toContain('undefined');
    });

    it('should include numeric reviewId correctly', () => {
      const fileCommentManager = createTestFileCommentManager({
        reviewId: 789,
        reviewType: 'local'
      });

      const endpoint = fileCommentManager._getSuggestionStatusEndpoint(456);

      expect(endpoint).toBe('/api/local/789/ai-suggestion/456/status');
    });
  });

  describe('PR mode', () => {
    it('should return PR API endpoint when reviewType is pr', () => {
      const fileCommentManager = createTestFileCommentManager({
        reviewId: 'pr-review-123',
        reviewType: 'pr'
      });

      const endpoint = fileCommentManager._getSuggestionStatusEndpoint(456);

      expect(endpoint).toBe('/api/ai-suggestion/456/status');
    });

    it('should not include reviewId in PR mode endpoint', () => {
      const fileCommentManager = createTestFileCommentManager({
        reviewId: 'pr-review-999',
        reviewType: 'pr'
      });

      const endpoint = fileCommentManager._getSuggestionStatusEndpoint(111);

      expect(endpoint).not.toContain('pr-review-999');
      expect(endpoint).not.toContain('/local/');
    });
  });

  describe('Edge cases', () => {
    it('should default to PR mode when reviewType is undefined', () => {
      // Bypass the test helper's default to test undefined reviewType
      const fileCommentManager = Object.create(FileCommentManager.prototype);
      fileCommentManager.prManager = {
        currentPR: {
          id: 'some-review',
          reviewType: undefined  // Explicitly undefined, not defaulted
        }
      };

      const endpoint = fileCommentManager._getSuggestionStatusEndpoint(123);

      expect(endpoint).toBe('/api/ai-suggestion/123/status');
    });

    it('should handle missing prManager gracefully', () => {
      const fileCommentManager = Object.create(FileCommentManager.prototype);
      fileCommentManager.prManager = null;

      const endpoint = fileCommentManager._getSuggestionStatusEndpoint(123);

      // Should default to PR mode endpoint when prManager is null
      expect(endpoint).toBe('/api/ai-suggestion/123/status');
    });
  });
});

/**
 * Tests for FileCommentManager.restoreAISuggestion()
 * Verifies that restoring a file-level AI suggestion:
 * 1. Calls the API to update suggestion status to 'active'
 * 2. Updates the AIPanel to reflect the active status
 */
describe('FileCommentManager.restoreAISuggestion', () => {
  let mockFetch;

  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Setup window with aiPanel mock
    global.window = {
      aiPanel: {
        updateFindingStatus: vi.fn()
      },
      toast: {
        showError: vi.fn()
      }
    };

    // Mock console.error
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call PR mode API endpoint when reviewType is pr', async () => {
    const fileCommentManager = createTestFileCommentManager({
      reviewId: 'pr-review-123',
      reviewType: 'pr'
    });
    const suggestionId = 123;

    // Mock successful API response
    mockFetch.mockResolvedValueOnce({ ok: true });

    // Create mock zone with suggestion card
    const mockCard = {
      classList: {
        remove: vi.fn()
      }
    };
    const mockZone = {
      querySelector: vi.fn().mockReturnValue(mockCard)
    };

    await fileCommentManager.restoreAISuggestion(mockZone, suggestionId);

    // Verify PR mode endpoint was called
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/ai-suggestion/${suggestionId}/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' })
      }
    );
  });

  it('should call local mode API endpoint when reviewType is local', async () => {
    const fileCommentManager = createTestFileCommentManager({
      reviewId: 'local-review-456',
      reviewType: 'local'
    });
    const suggestionId = 789;

    // Mock successful API response
    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockCard = { classList: { remove: vi.fn() } };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    await fileCommentManager.restoreAISuggestion(mockZone, suggestionId);

    // Verify local mode endpoint was called with reviewId
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/local/local-review-456/ai-suggestion/${suggestionId}/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' })
      }
    );
  });

  it('should update AIPanel with active status after successful API call', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const suggestionId = 456;

    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockCard = { classList: { remove: vi.fn() } };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    await fileCommentManager.restoreAISuggestion(mockZone, suggestionId);

    // Verify AIPanel was notified
    expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledTimes(1);
    expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(suggestionId, 'active');
  });

  it('should remove collapsed class from suggestion card', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const suggestionId = 789;

    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockRemove = vi.fn();
    const mockCard = { classList: { remove: mockRemove } };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    await fileCommentManager.restoreAISuggestion(mockZone, suggestionId);

    // Verify collapsed class was removed
    expect(mockRemove).toHaveBeenCalledWith('collapsed');
  });

  it('should not update AIPanel when API call fails', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const suggestionId = 111;

    // Mock failed API response
    mockFetch.mockResolvedValueOnce({ ok: false });

    const mockCard = { classList: { remove: vi.fn() } };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    await fileCommentManager.restoreAISuggestion(mockZone, suggestionId);

    // AIPanel should NOT be updated on failure
    expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();

    // Toast error should be shown
    expect(window.toast.showError).toHaveBeenCalledWith('Failed to restore suggestion');
  });

  it('should handle missing AIPanel gracefully', async () => {
    window.aiPanel = null;

    const fileCommentManager = createTestFileCommentManager();
    const suggestionId = 222;

    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockCard = { classList: { remove: vi.fn() } };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    // Should not throw even without aiPanel
    await expect(
      fileCommentManager.restoreAISuggestion(mockZone, suggestionId)
    ).resolves.not.toThrow();
  });

  it('should handle missing suggestion card gracefully', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const suggestionId = 333;

    mockFetch.mockResolvedValueOnce({ ok: true });

    // Zone returns null for querySelector (card not found)
    const mockZone = { querySelector: vi.fn().mockReturnValue(null) };

    // Should not throw
    await expect(
      fileCommentManager.restoreAISuggestion(mockZone, suggestionId)
    ).resolves.not.toThrow();

    // API should still be called
    expect(mockFetch).toHaveBeenCalled();

    // AIPanel should still be updated
    expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(suggestionId, 'active');
  });

  it('should query for suggestion card with correct selector', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const suggestionId = 444;

    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockQuerySelector = vi.fn().mockReturnValue({ classList: { remove: vi.fn() } });
    const mockZone = { querySelector: mockQuerySelector };

    await fileCommentManager.restoreAISuggestion(mockZone, suggestionId);

    // Verify querySelector was called with correct selector
    expect(mockQuerySelector).toHaveBeenCalledWith(`[data-suggestion-id="${suggestionId}"]`);
  });

  it('should call updateCommentCount after restoring suggestion', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const suggestionId = 555;

    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockCard = { classList: { remove: vi.fn() } };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    // Spy on updateCommentCount
    fileCommentManager.updateCommentCount = vi.fn();

    await fileCommentManager.restoreAISuggestion(mockZone, suggestionId);

    // Verify updateCommentCount was called with the zone
    expect(fileCommentManager.updateCommentCount).toHaveBeenCalledTimes(1);
    expect(fileCommentManager.updateCommentCount).toHaveBeenCalledWith(mockZone);
  });

  it('should not call updateCommentCount when API call fails', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const suggestionId = 666;

    // Mock failed API response
    mockFetch.mockResolvedValueOnce({ ok: false });

    const mockZone = { querySelector: vi.fn().mockReturnValue({ classList: { remove: vi.fn() } }) };
    fileCommentManager.updateCommentCount = vi.fn();

    await fileCommentManager.restoreAISuggestion(mockZone, suggestionId);

    // updateCommentCount should NOT be called on failure
    expect(fileCommentManager.updateCommentCount).not.toHaveBeenCalled();
  });
});

/**
 * Tests for FileCommentManager.deleteFileComment()
 * Verifies that deleting a file-level comment:
 * 1. Calls the correct API endpoint
 * 2. Updates AIPanel when the comment had a parent suggestion (dismissedSuggestionId)
 */
describe('FileCommentManager.deleteFileComment', () => {
  let mockFetch;
  let mockConfirmDialog;

  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    mockConfirmDialog = {
      show: vi.fn().mockResolvedValue('confirm')
    };

    // Setup window with mocks
    global.window = {
      aiPanel: {
        updateFindingStatus: vi.fn(),
        removeComment: vi.fn()
      },
      confirmDialog: mockConfirmDialog,
      toast: {
        showError: vi.fn()
      }
    };

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call API to delete comment', async () => {
    const fileCommentManager = createTestFileCommentManager({
      reviewId: 'local-review-456',
      reviewType: 'local'
    });
    const commentId = 123;

    // Mock successful API response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ success: true })
    });

    const mockCard = { remove: vi.fn() };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };
    fileCommentManager.updateCommentCount = vi.fn();

    await fileCommentManager.deleteFileComment(mockZone, commentId);

    // Verify API was called
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/local/local-review-456/file-comment/123',
      { method: 'DELETE' }
    );
  });

  it('should update AIPanel with active status when dismissedSuggestionId is returned', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const commentId = 456;
    const parentSuggestionId = 789;

    // Mock successful API response with dismissedSuggestionId
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        dismissedSuggestionId: parentSuggestionId
      })
    });

    const mockCard = { remove: vi.fn() };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };
    fileCommentManager.updateCommentCount = vi.fn();

    await fileCommentManager.deleteFileComment(mockZone, commentId);

    // Verify AIPanel removeComment was called
    expect(window.aiPanel.removeComment).toHaveBeenCalledWith(commentId);

    // Verify AIPanel updateFindingStatus was called with 'dismissed' status
    // (suggestion card is still collapsed in diff view; user can click "Show" to restore to active)
    expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(parentSuggestionId, 'dismissed');
  });

  it('should not update AIPanel findingStatus when no dismissedSuggestionId', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const commentId = 111;

    // Mock successful API response WITHOUT dismissedSuggestionId
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ success: true })
    });

    const mockCard = { remove: vi.fn() };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };
    fileCommentManager.updateCommentCount = vi.fn();

    await fileCommentManager.deleteFileComment(mockZone, commentId);

    // AIPanel removeComment should still be called
    expect(window.aiPanel.removeComment).toHaveBeenCalledWith(commentId);

    // But updateFindingStatus should NOT be called
    expect(window.aiPanel.updateFindingStatus).not.toHaveBeenCalled();
  });

  it('should handle missing AIPanel gracefully', async () => {
    window.aiPanel = null;

    const fileCommentManager = createTestFileCommentManager();
    const commentId = 222;
    const parentSuggestionId = 333;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        dismissedSuggestionId: parentSuggestionId
      })
    });

    const mockCard = { remove: vi.fn() };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };
    fileCommentManager.updateCommentCount = vi.fn();

    // Should not throw even without aiPanel
    await expect(
      fileCommentManager.deleteFileComment(mockZone, commentId)
    ).resolves.not.toThrow();
  });

  it('should not proceed when user cancels confirmation dialog', async () => {
    mockConfirmDialog.show.mockResolvedValue('cancel');

    const fileCommentManager = createTestFileCommentManager();

    await fileCommentManager.deleteFileComment({}, 123);

    // API should NOT be called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should show error toast when API call fails', async () => {
    const fileCommentManager = createTestFileCommentManager();
    const commentId = 444;

    // Mock failed API response
    mockFetch.mockResolvedValueOnce({ ok: false });

    const mockZone = { querySelector: vi.fn().mockReturnValue({ remove: vi.fn() }) };
    fileCommentManager.updateCommentCount = vi.fn();

    await fileCommentManager.deleteFileComment(mockZone, commentId);

    // Toast error should be shown
    expect(window.toast.showError).toHaveBeenCalledWith('Failed to delete comment');

    // AIPanel should NOT be updated on failure
    expect(window.aiPanel.removeComment).not.toHaveBeenCalled();
  });
});

/**
 * Tests for FileCommentManager.adoptAISuggestion()
 * Verifies that adopting a file-level AI suggestion uses mode-aware endpoints.
 */
describe('FileCommentManager.adoptAISuggestion', () => {
  let mockFetch;

  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Setup window with mocks
    global.window = {
      aiPanel: {
        updateFindingStatus: vi.fn(),
        addComment: vi.fn()
      },
      toast: {
        showError: vi.fn()
      }
    };

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call local mode API endpoint for status update when reviewType is local', async () => {
    const fileCommentManager = createTestFileCommentManager({
      reviewId: 'local-review-456',
      reviewType: 'local'
    });

    // Mock all required methods
    fileCommentManager.formatAdoptedComment = vi.fn().mockReturnValue('formatted comment');
    fileCommentManager._getFileCommentEndpoint = vi.fn().mockReturnValue({
      endpoint: '/api/local/local-review-456/file-comment',
      requestBody: { file: 'test.js', body: 'formatted comment' }
    });
    fileCommentManager.displayUserComment = vi.fn();
    fileCommentManager.updateCommentCount = vi.fn();

    const suggestion = {
      id: 123,
      file: 'test.js',
      body: 'Original suggestion',
      type: 'bug'
    };

    // Mock successful API responses
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ commentId: 999 })
      })
      .mockResolvedValueOnce({ ok: true }); // status update

    const mockCard = {
      classList: { add: vi.fn() },
      querySelector: vi.fn().mockReturnValue({ textContent: '' })
    };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    await fileCommentManager.adoptAISuggestion(mockZone, suggestion);

    // Verify status update call uses local mode endpoint
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      '/api/local/local-review-456/ai-suggestion/123/status',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'adopted' })
      }
    );
  });

  it('should call PR mode API endpoint for status update when reviewType is pr', async () => {
    const fileCommentManager = createTestFileCommentManager({
      reviewId: 'pr-review-123',
      reviewType: 'pr',
      headSha: 'abc123'
    });

    fileCommentManager.formatAdoptedComment = vi.fn().mockReturnValue('formatted comment');
    fileCommentManager._getFileCommentEndpoint = vi.fn().mockReturnValue({
      endpoint: '/api/file-comment',
      requestBody: { review_id: 'pr-review-123', file: 'test.js', body: 'formatted comment', commit_sha: 'abc123' }
    });
    fileCommentManager.displayUserComment = vi.fn();
    fileCommentManager.updateCommentCount = vi.fn();

    const suggestion = {
      id: 456,
      file: 'test.js',
      body: 'Original suggestion',
      type: 'suggestion'
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ commentId: 888 })
      })
      .mockResolvedValueOnce({ ok: true });

    const mockCard = {
      classList: { add: vi.fn() },
      querySelector: vi.fn().mockReturnValue({ textContent: '' })
    };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    await fileCommentManager.adoptAISuggestion(mockZone, suggestion);

    // Verify status update call uses PR mode endpoint
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      '/api/ai-suggestion/456/status',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'adopted' })
      }
    );
  });
});

/**
 * Tests for FileCommentManager.dismissAISuggestion()
 * Verifies that dismissing a file-level AI suggestion uses mode-aware endpoints.
 */
describe('FileCommentManager.dismissAISuggestion', () => {
  let mockFetch;

  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    global.window = {
      aiPanel: {
        updateFindingStatus: vi.fn()
      },
      toast: {
        showError: vi.fn()
      }
    };

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call local mode API endpoint when reviewType is local', async () => {
    const fileCommentManager = createTestFileCommentManager({
      reviewId: 'local-review-789',
      reviewType: 'local'
    });
    fileCommentManager.updateCommentCount = vi.fn();

    const suggestionId = 555;

    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockCard = {
      classList: { add: vi.fn() },
      querySelector: vi.fn().mockReturnValue({ textContent: '' })
    };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    await fileCommentManager.dismissAISuggestion(mockZone, suggestionId);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/local/local-review-789/ai-suggestion/555/status',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed' })
      }
    );
  });

  it('should call PR mode API endpoint when reviewType is pr', async () => {
    const fileCommentManager = createTestFileCommentManager({
      reviewId: 'pr-review-456',
      reviewType: 'pr'
    });
    fileCommentManager.updateCommentCount = vi.fn();

    const suggestionId = 777;

    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockCard = {
      classList: { add: vi.fn() },
      querySelector: vi.fn().mockReturnValue({ textContent: '' })
    };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    await fileCommentManager.dismissAISuggestion(mockZone, suggestionId);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/ai-suggestion/777/status',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed' })
      }
    );
  });

  it('should update AIPanel with dismissed status after successful API call', async () => {
    const fileCommentManager = createTestFileCommentManager();
    fileCommentManager.updateCommentCount = vi.fn();

    const suggestionId = 888;

    mockFetch.mockResolvedValueOnce({ ok: true });

    const mockCard = {
      classList: { add: vi.fn() },
      querySelector: vi.fn().mockReturnValue({ textContent: '' })
    };
    const mockZone = { querySelector: vi.fn().mockReturnValue(mockCard) };

    await fileCommentManager.dismissAISuggestion(mockZone, suggestionId);

    expect(window.aiPanel.updateFindingStatus).toHaveBeenCalledWith(suggestionId, 'dismissed');
  });
});
