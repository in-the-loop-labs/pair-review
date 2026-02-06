// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for comment/suggestion reload after diff refresh.
 *
 * Bug: After refreshPR() (PR mode) or refreshDiff() (Local mode), the diff
 * container DOM is cleared by renderDiff(), but loadUserComments() and
 * loadAISuggestions() were not called to re-populate. This left
 * clearAllUserComments() counting 0 DOM elements and bailing with
 * "No comments to clear".
 *
 * Fix: Both refreshPR() and refreshDiff() now call loadUserComments()
 * and loadAISuggestions() after re-rendering the diff.
 */

// Import the actual PRManager class from production code
const { PRManager } = require('../../public/js/pr.js');

const mockFetch = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();

  global.fetch = mockFetch;

  global.window = {
    aiPanel: {
      showDismissedComments: false,
      setFileOrder: vi.fn(),
      setComments: vi.fn(),
      setAnalysisState: vi.fn(),
      setSummaryData: vi.fn()
    },
    FileOrderUtils: {
      sortFilesByPath: vi.fn((files) => files),
      createFileOrderMap: vi.fn(() => new Map())
    },
    scrollTo: vi.fn()
  };

  global.document = {
    getElementById: vi.fn(() => null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => [])
  };

  global.alert = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a minimal PRManager for testing refresh behavior.
 */
function createTestPRManager() {
  const prManager = Object.create(PRManager.prototype);

  prManager.currentPR = {
    owner: 'test-owner',
    repo: 'test-repo',
    number: 42,
    id: 1
  };

  prManager.expandedFolders = new Set();
  prManager.generatedFiles = new Map();
  prManager.canonicalFileOrder = new Map();

  // Mock the methods we need to verify are called
  prManager.loadUserComments = vi.fn().mockResolvedValue(undefined);
  prManager.loadAISuggestions = vi.fn().mockResolvedValue(undefined);
  prManager.loadAndDisplayFiles = vi.fn().mockResolvedValue(undefined);
  prManager.renderPRHeader = vi.fn();
  prManager.showError = vi.fn();

  return prManager;
}

describe('PR mode: refreshPR() reloads comments after diff refresh', () => {
  it('should call loadUserComments after loadAndDisplayFiles', async () => {
    const prManager = createTestPRManager();

    // Track call order
    const callOrder = [];
    prManager.loadAndDisplayFiles.mockImplementation(async () => {
      callOrder.push('loadAndDisplayFiles');
    });
    prManager.loadUserComments.mockImplementation(async () => {
      callOrder.push('loadUserComments');
    });
    prManager.loadAISuggestions.mockImplementation(async () => {
      callOrder.push('loadAISuggestions');
    });

    // Mock successful refresh API response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: prManager.currentPR
      })
    });

    // Mock setTimeout for scroll restore
    vi.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());

    await prManager.refreshPR();

    // Verify loadUserComments was called
    expect(prManager.loadUserComments).toHaveBeenCalledTimes(1);
    // Verify loadAISuggestions was called
    expect(prManager.loadAISuggestions).toHaveBeenCalledTimes(1);

    // Verify order: loadAndDisplayFiles -> loadUserComments -> loadAISuggestions
    expect(callOrder).toEqual([
      'loadAndDisplayFiles',
      'loadUserComments',
      'loadAISuggestions'
    ]);
  });

  it('should pass includeDismissed flag from aiPanel to loadUserComments', async () => {
    const prManager = createTestPRManager();

    window.aiPanel.showDismissedComments = true;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: prManager.currentPR
      })
    });

    vi.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());

    await prManager.refreshPR();

    expect(prManager.loadUserComments).toHaveBeenCalledWith(true);
  });

  it('should default includeDismissed to false when aiPanel is not available', async () => {
    const prManager = createTestPRManager();

    window.aiPanel = null;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: prManager.currentPR
      })
    });

    vi.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());

    await prManager.refreshPR();

    expect(prManager.loadUserComments).toHaveBeenCalledWith(false);
  });

  it('should not call loadUserComments when refresh API fails', async () => {
    const prManager = createTestPRManager();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: 'Refresh failed' })
    });

    await prManager.refreshPR();

    expect(prManager.loadUserComments).not.toHaveBeenCalled();
    expect(prManager.loadAISuggestions).not.toHaveBeenCalled();
  });

  it('should not call loadUserComments when no PR is loaded', async () => {
    const prManager = createTestPRManager();
    prManager.currentPR = null;

    await prManager.refreshPR();

    expect(prManager.loadUserComments).not.toHaveBeenCalled();
    expect(prManager.loadAISuggestions).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should preserve selectedRunId when calling loadAISuggestions on refresh', async () => {
    const prManager = createTestPRManager();
    prManager.selectedRunId = 'run-42';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: prManager.currentPR
      })
    });

    vi.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());

    await prManager.refreshPR();

    expect(prManager.loadAISuggestions).toHaveBeenCalledWith(null, 'run-42');
  });
});

describe('Local mode: refreshDiff() reloads comments after diff refresh', () => {
  /**
   * We cannot import LocalManager directly since it depends on browser globals
   * at module load time. Instead, we test the key behavior by simulating
   * what refreshDiff() does: after loadLocalDiff(), it should call
   * loadUserComments() and loadAISuggestions() on the prManager.
   *
   * The actual integration is verified by checking that the source code
   * contains the correct calls after loadLocalDiff().
   */

  it('should verify local.js refreshDiff calls loadUserComments and loadAISuggestions after loadLocalDiff', async () => {
    // Read the source to confirm the fix is present
    const fs = require('fs');
    const path = require('path');
    const localSource = fs.readFileSync(
      path.join(__dirname, '../../public/js/local.js'),
      'utf-8'
    );

    // Find the refreshDiff method body using regex.
    // The lookahead `\n  (?:async\s)?\w+\s*\(` assumes methods are indented with
    // 2 spaces (the project's standard indentation for class-like method bodies).
    const refreshDiffMatch = localSource.match(
      /async refreshDiff\(\)\s*\{[\s\S]*?(?=\n  (?:async\s)?\w+\s*\()/
    );
    expect(refreshDiffMatch).toBeTruthy();
    const refreshDiffBody = refreshDiffMatch[0];

    // Verify loadLocalDiff is called
    expect(refreshDiffBody).toContain('await this.loadLocalDiff()');

    // Verify loadUserComments is called AFTER loadLocalDiff
    const loadDiffIdx = refreshDiffBody.indexOf('await this.loadLocalDiff()');
    const loadCommentsIdx = refreshDiffBody.indexOf('await manager.loadUserComments(');
    const loadSuggestionsIdx = refreshDiffBody.indexOf('await manager.loadAISuggestions(null, manager.selectedRunId)');

    expect(loadCommentsIdx).toBeGreaterThan(loadDiffIdx);
    expect(loadSuggestionsIdx).toBeGreaterThan(loadDiffIdx);
    expect(loadSuggestionsIdx).toBeGreaterThan(loadCommentsIdx);
  });

  it('should verify local.js refreshDiff passes includeDismissed from aiPanel', async () => {
    const fs = require('fs');
    const path = require('path');
    const localSource = fs.readFileSync(
      path.join(__dirname, '../../public/js/local.js'),
      'utf-8'
    );

    // Find the refreshDiff method body using regex.
    // The lookahead `\n  (?:async\s)?\w+\s*\(` assumes methods are indented with
    // 2 spaces (the project's standard indentation for class-like method bodies).
    const refreshDiffMatch = localSource.match(
      /async refreshDiff\(\)\s*\{[\s\S]*?(?=\n  (?:async\s)?\w+\s*\()/
    );
    const refreshDiffBody = refreshDiffMatch[0];

    // Verify the dismissed filter flag is derived from aiPanel
    expect(refreshDiffBody).toContain('window.aiPanel?.showDismissedComments');
    expect(refreshDiffBody).toContain('await manager.loadUserComments(includeDismissed)');
  });
});

describe('PR mode: refreshPR() call ordering matches loadPR()', () => {
  it('should reload comments similarly to how loadPR does on initial load', async () => {
    // This test ensures refreshPR() follows the same pattern as loadPR()
    // for re-populating comments after rendering the diff.
    const fs = require('fs');
    const path = require('path');
    const prSource = fs.readFileSync(
      path.join(__dirname, '../../public/js/pr.js'),
      'utf-8'
    );

    // In loadPR: loadAndDisplayFiles -> loadUserComments -> loadAISuggestions
    // In refreshPR: loadAndDisplayFiles -> loadUserComments -> loadAISuggestions
    // Both should follow the same pattern.

    // Find refreshPR method
    const refreshPRMatch = prSource.match(
      /async refreshPR\(\)\s*\{[\s\S]*?(?=\n  (?:async\s)?\w+\s*\(|\n\})/
    );
    expect(refreshPRMatch).toBeTruthy();
    const refreshPRBody = refreshPRMatch[0];

    // Verify the reload calls exist in refreshPR
    const displayIdx = refreshPRBody.indexOf('loadAndDisplayFiles');
    const commentsIdx = refreshPRBody.indexOf('loadUserComments');
    const suggestionsIdx = refreshPRBody.indexOf('loadAISuggestions');

    expect(displayIdx).toBeGreaterThan(-1);
    expect(commentsIdx).toBeGreaterThan(-1);
    expect(suggestionsIdx).toBeGreaterThan(-1);

    // Verify order
    expect(commentsIdx).toBeGreaterThan(displayIdx);
    expect(suggestionsIdx).toBeGreaterThan(commentsIdx);
  });
});

describe('PR mode: refreshPR() handles reload errors gracefully', () => {
  it('should propagate loadUserComments error to the catch block', async () => {
    const prManager = createTestPRManager();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: prManager.currentPR
      })
    });

    vi.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());

    prManager.loadUserComments.mockRejectedValueOnce(new Error('Failed to load comments'));

    await prManager.refreshPR();

    // The error should be caught and displayed
    expect(prManager.showError).toHaveBeenCalledWith('Failed to load comments');
  });

  it('should propagate loadAISuggestions error to the catch block', async () => {
    const prManager = createTestPRManager();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: prManager.currentPR
      })
    });

    vi.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());

    prManager.loadAISuggestions.mockRejectedValueOnce(new Error('Failed to load suggestions'));

    await prManager.refreshPR();

    // The error should be caught and displayed
    expect(prManager.showError).toHaveBeenCalledWith('Failed to load suggestions');
  });
});
