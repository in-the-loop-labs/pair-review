// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for CouncilProgressModal component
 *
 * Tests the _updateVoiceFromLevelStatus method which handles updating voice
 * states and triggering bulk completion/failure/cancellation based on incoming
 * level status events.
 *
 * IMPORTANT: These tests import the actual CouncilProgressModal class from production code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Setup minimal DOM globals before importing CouncilProgressModal
beforeEach(() => {
  // Reset mocks
  vi.resetAllMocks();

  // Create a minimal document mock
  global.document = {
    readyState: 'complete',
    getElementById: vi.fn().mockReturnValue(null),
    createElement: vi.fn().mockImplementation((tag) => {
      return createMockElement(tag);
    }),
    body: {
      appendChild: vi.fn()
    },
    addEventListener: vi.fn(),
    querySelectorAll: vi.fn().mockReturnValue([])
  };

  // Create a minimal window mock
  global.window = {
    councilProgressModal: null,
    prManager: null,
    localManager: null,
    aiPanel: null,
    statusIndicator: null,
    EventSource: vi.fn().mockImplementation(() => ({
      close: vi.fn(),
      addEventListener: vi.fn()
    }))
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.document;
  delete global.window;
  delete global.EventSource;
});

/**
 * Create a mock DOM element with querySelector support.
 * Maintains an innerHTML-based child structure for querySelector to traverse.
 */
function createMockElement(tag) {
  const children = [];
  const element = {
    tagName: tag?.toUpperCase(),
    id: '',
    className: '',
    style: {},
    innerHTML: '',
    textContent: '',
    disabled: false,
    _children: children,
    appendChild: vi.fn((child) => { children.push(child); }),
    remove: vi.fn(),
    querySelector: vi.fn().mockReturnValue(null),
    querySelectorAll: vi.fn().mockReturnValue([]),
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
    getAttribute: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn() },
    dataset: {}
  };
  return element;
}

/**
 * Build a CouncilProgressModal instance for testing with mock DOM wired up.
 * Returns the instance and references to key mock elements.
 */
function createTestCouncilProgressModal() {
  // Import the actual CouncilProgressModal class
  const CouncilProgressModalModule = require('../../public/js/components/CouncilProgressModal.js');
  const CouncilProgressModal = CouncilProgressModalModule.CouncilProgressModal || CouncilProgressModalModule.default;

  // Create the mock modal container element
  const modalContainer = createMockElement('div');
  modalContainer.id = 'council-progress-modal';

  // Prevent the constructor from creating real DOM elements
  document.getElementById = vi.fn().mockReturnValue(null);
  document.createElement = vi.fn().mockReturnValue(modalContainer);

  // Create the CouncilProgressModal instance (bypassing constructor to avoid DOM setup)
  const modal = Object.create(CouncilProgressModal.prototype);
  modal.modal = modalContainer;
  modal.isVisible = false;
  modal.currentAnalysisId = null;
  modal.eventSource = null;
  modal.statusCheckInterval = null;
  modal.isRunningInBackground = false;
  modal.councilConfig = null;
  modal._voiceStates = {};
  modal._useLocalEndpoint = false;
  modal._localReviewId = null;

  return { modal, modalContainer };
}

describe('CouncilProgressModal', () => {
  describe('_updateVoiceFromLevelStatus', () => {
    it('with voices map: updates each voice from the map', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();

      // Spy on _setVoiceState
      const setVoiceStateSpy = vi.spyOn(modal, '_setVoiceState').mockImplementation(() => {});

      const levelStatus = {
        voices: {
          'L1-claude-sonnet': { status: 'completed' },
          'L1-gemini-pro': { status: 'running' }
        }
      };

      modal._updateVoiceFromLevelStatus(1, levelStatus);

      // Verify _setVoiceState was called for each voice
      expect(setVoiceStateSpy).toHaveBeenCalledTimes(2);
      expect(setVoiceStateSpy).toHaveBeenCalledWith('L1-claude-sonnet', 'completed', { status: 'completed' });
      expect(setVoiceStateSpy).toHaveBeenCalledWith('L1-gemini-pro', 'running', { status: 'running' });
    });

    it('with voices map: returns early, does not call bulk completion', () => {
      const { modal } = createTestCouncilProgressModal();

      // Spy on both _setVoiceState and _completeAllVoicesForLevel
      const setVoiceStateSpy = vi.spyOn(modal, '_setVoiceState').mockImplementation(() => {});
      const completeAllSpy = vi.spyOn(modal, '_completeAllVoicesForLevel').mockImplementation(() => {});

      const levelStatus = {
        voices: {
          'L1-voice-A': { status: 'completed' }
        },
        status: 'completed' // This should be ignored due to early return
      };

      modal._updateVoiceFromLevelStatus(1, levelStatus);

      // Verify _setVoiceState was called
      expect(setVoiceStateSpy).toHaveBeenCalledTimes(1);
      expect(setVoiceStateSpy).toHaveBeenCalledWith('L1-voice-A', 'completed', { status: 'completed' });

      // Verify _completeAllVoicesForLevel was NOT called (early return prevents fallthrough)
      expect(completeAllSpy).not.toHaveBeenCalled();
    });

    it('with single voiceId (no voices map): updates that voice', () => {
      const { modal } = createTestCouncilProgressModal();

      // Spy on _setVoiceState
      const setVoiceStateSpy = vi.spyOn(modal, '_setVoiceState').mockImplementation(() => {});

      const levelStatus = {
        voiceId: 'L2-claude-sonnet',
        status: 'running',
        streamEvent: { text: 'thinking...' }
      };

      modal._updateVoiceFromLevelStatus(2, levelStatus);

      // Verify _setVoiceState was called with correct args
      expect(setVoiceStateSpy).toHaveBeenCalledTimes(1);
      expect(setVoiceStateSpy).toHaveBeenCalledWith(
        'L2-claude-sonnet',
        'running',
        { voiceId: 'L2-claude-sonnet', status: 'running', streamEvent: { text: 'thinking...' } }
      );
    });

    it('without voiceId, status completed: completes all voices for level', () => {
      const { modal } = createTestCouncilProgressModal();

      // Spy on _completeAllVoicesForLevel
      const completeAllSpy = vi.spyOn(modal, '_completeAllVoicesForLevel').mockImplementation(() => {});

      const levelStatus = {
        status: 'completed'
      };

      modal._updateVoiceFromLevelStatus(2, levelStatus);

      // Verify _completeAllVoicesForLevel was called with the level
      expect(completeAllSpy).toHaveBeenCalledTimes(1);
      expect(completeAllSpy).toHaveBeenCalledWith(2);
    });

    it('without voiceId, status failed: fails all voices for level', () => {
      const { modal } = createTestCouncilProgressModal();

      // Spy on _failAllVoicesForLevel
      const failAllSpy = vi.spyOn(modal, '_failAllVoicesForLevel').mockImplementation(() => {});

      const levelStatus = {
        status: 'failed'
      };

      modal._updateVoiceFromLevelStatus(3, levelStatus);

      // Verify _failAllVoicesForLevel was called with the level
      expect(failAllSpy).toHaveBeenCalledTimes(1);
      expect(failAllSpy).toHaveBeenCalledWith(3);
    });

    it('without voiceId, status cancelled: cancels all voices for level', () => {
      const { modal } = createTestCouncilProgressModal();

      // Spy on _cancelAllVoicesForLevel
      const cancelAllSpy = vi.spyOn(modal, '_cancelAllVoicesForLevel').mockImplementation(() => {});

      const levelStatus = {
        status: 'cancelled'
      };

      modal._updateVoiceFromLevelStatus(1, levelStatus);

      // Verify _cancelAllVoicesForLevel was called with the level
      expect(cancelAllSpy).toHaveBeenCalledTimes(1);
      expect(cancelAllSpy).toHaveBeenCalledWith(1);
    });

    it('without voiceId, status skipped: does not call any bulk methods', () => {
      const { modal } = createTestCouncilProgressModal();

      // Spy on all bulk methods
      const completeAllSpy = vi.spyOn(modal, '_completeAllVoicesForLevel').mockImplementation(() => {});
      const failAllSpy = vi.spyOn(modal, '_failAllVoicesForLevel').mockImplementation(() => {});
      const cancelAllSpy = vi.spyOn(modal, '_cancelAllVoicesForLevel').mockImplementation(() => {});
      const setVoiceStateSpy = vi.spyOn(modal, '_setVoiceState').mockImplementation(() => {});

      const levelStatus = {
        status: 'skipped'
      };

      modal._updateVoiceFromLevelStatus(2, levelStatus);

      // Verify none of the bulk methods were called
      expect(completeAllSpy).not.toHaveBeenCalled();
      expect(failAllSpy).not.toHaveBeenCalled();
      expect(cancelAllSpy).not.toHaveBeenCalled();
      expect(setVoiceStateSpy).not.toHaveBeenCalled();
    });

    it('with voices map: handles missing status by defaulting to running', () => {
      const { modal } = createTestCouncilProgressModal();

      // Spy on _setVoiceState
      const setVoiceStateSpy = vi.spyOn(modal, '_setVoiceState').mockImplementation(() => {});

      const levelStatus = {
        voices: {
          'L1-voice-without-status': {} // No status field
        }
      };

      modal._updateVoiceFromLevelStatus(1, levelStatus);

      // Verify _setVoiceState was called with 'running' as default
      expect(setVoiceStateSpy).toHaveBeenCalledTimes(1);
      expect(setVoiceStateSpy).toHaveBeenCalledWith('L1-voice-without-status', 'running', {});
    });

    it('with single voiceId: handles missing status by defaulting to running', () => {
      const { modal } = createTestCouncilProgressModal();

      // Spy on _setVoiceState
      const setVoiceStateSpy = vi.spyOn(modal, '_setVoiceState').mockImplementation(() => {});

      const levelStatus = {
        voiceId: 'L2-voice-no-status'
        // No status field
      };

      modal._updateVoiceFromLevelStatus(2, levelStatus);

      // Verify _setVoiceState was called with 'running' as default
      expect(setVoiceStateSpy).toHaveBeenCalledTimes(1);
      expect(setVoiceStateSpy).toHaveBeenCalledWith(
        'L2-voice-no-status',
        'running',
        { voiceId: 'L2-voice-no-status' }
      );
    });
  });

  describe('_updateSingleModelLevel', () => {
    it('displays stream event text in snippet element when running', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();

      // Build mock DOM: header with icon+status, sibling snippet element
      const snippetEl = { textContent: '', style: { display: 'none' } };
      const iconEl = { className: '', textContent: '', innerHTML: '' };
      const statusEl = { className: '', textContent: '' };
      const levelContainer = {
        querySelector: vi.fn((sel) => {
          if (sel === '.council-level-snippet') return snippetEl;
          return null;
        })
      };
      const headerEl = {
        dataset: {},
        closest: vi.fn(() => levelContainer),
        querySelector: vi.fn((sel) => {
          if (sel === '.council-level-icon') return iconEl;
          if (sel === '.council-level-status') return statusEl;
          return null;
        })
      };

      modalContainer.querySelector = vi.fn((sel) => {
        if (sel === '.council-level-header[data-level="1"]') return headerEl;
        return null;
      });

      modal._updateSingleModelLevel(1, {
        status: 'running',
        streamEvent: { text: 'Analyzing file foo.js...' }
      });

      expect(snippetEl.textContent).toBe('Analyzing file foo.js...');
      expect(snippetEl.style.display).toBe('block');
    });

    it('hides snippet element when state is not running', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();

      const snippetEl = { textContent: 'old text', style: { display: 'block' } };
      const iconEl = { className: '', textContent: '', innerHTML: '' };
      const statusEl = { className: '', textContent: '' };
      const levelContainer = {
        querySelector: vi.fn((sel) => {
          if (sel === '.council-level-snippet') return snippetEl;
          return null;
        })
      };
      const headerEl = {
        dataset: {},
        closest: vi.fn(() => levelContainer),
        querySelector: vi.fn((sel) => {
          if (sel === '.council-level-icon') return iconEl;
          if (sel === '.council-level-status') return statusEl;
          return null;
        })
      };

      modalContainer.querySelector = vi.fn((sel) => {
        if (sel === '.council-level-header[data-level="2"]') return headerEl;
        return null;
      });

      modal._updateSingleModelLevel(2, { status: 'completed' });

      expect(snippetEl.style.display).toBe('none');
    });

    it('does not show snippet when running but no streamEvent text', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();

      const snippetEl = { textContent: '', style: { display: 'none' } };
      const iconEl = { className: '', textContent: '', innerHTML: '' };
      const statusEl = { className: '', textContent: '' };
      const levelContainer = {
        querySelector: vi.fn((sel) => {
          if (sel === '.council-level-snippet') return snippetEl;
          return null;
        })
      };
      const headerEl = {
        dataset: {},
        closest: vi.fn(() => levelContainer),
        querySelector: vi.fn((sel) => {
          if (sel === '.council-level-icon') return iconEl;
          if (sel === '.council-level-status') return statusEl;
          return null;
        })
      };

      modalContainer.querySelector = vi.fn((sel) => {
        if (sel === '.council-level-header[data-level="1"]') return headerEl;
        return null;
      });

      modal._updateSingleModelLevel(1, { status: 'running' });

      // Snippet should remain hidden when there is no stream text
      expect(snippetEl.style.display).toBe('none');
    });

    it('skips update when header has data-skipped=true', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();

      const headerEl = {
        dataset: { skipped: 'true' },
        closest: vi.fn(),
        querySelector: vi.fn()
      };

      modalContainer.querySelector = vi.fn((sel) => {
        if (sel === '.council-level-header[data-level="1"]') return headerEl;
        return null;
      });

      // Should return early without trying to query icon/status
      modal._updateSingleModelLevel(1, { status: 'running' });

      expect(headerEl.querySelector).not.toHaveBeenCalled();
    });
  });

  describe('show() title', () => {
    it('sets title to "Review progress" for single model mode', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();

      const titleEl = { textContent: '' };
      modalContainer.querySelector = vi.fn((sel) => {
        if (sel === '#council-progress-title') return titleEl;
        if (sel === '.council-progress-body') return { innerHTML: '' };
        if (sel === '.council-bg-btn') return { textContent: '', disabled: false };
        if (sel === '.council-cancel-btn') return { textContent: '' };
        return null;
      });

      // Stub monitoring
      vi.spyOn(modal, 'startProgressMonitoring').mockImplementation(() => {});

      modal.show('test-id', null, null, { configType: 'single', enabledLevels: [1, 2, 3] });

      expect(titleEl.textContent).toBe('Review progress');
    });

    it('sets title to "Review progress" with council name for council mode', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();

      const titleEl = { textContent: '' };
      modalContainer.querySelector = vi.fn((sel) => {
        if (sel === '#council-progress-title') return titleEl;
        if (sel === '.council-progress-body') return { innerHTML: '' };
        if (sel === '.council-bg-btn') return { textContent: '', disabled: false };
        if (sel === '.council-cancel-btn') return { textContent: '' };
        return null;
      });

      vi.spyOn(modal, 'startProgressMonitoring').mockImplementation(() => {});

      const config = { levels: { '1': { enabled: true, voices: [] } } };
      modal.show('test-id', config, 'My Council', { configType: 'council' });

      expect(titleEl.textContent).toBe('Review progress \u00b7 My Council');
    });

    it('sets title to "Review progress" for council mode without name', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();

      const titleEl = { textContent: '' };
      modalContainer.querySelector = vi.fn((sel) => {
        if (sel === '#council-progress-title') return titleEl;
        if (sel === '.council-progress-body') return { innerHTML: '' };
        if (sel === '.council-bg-btn') return { textContent: '', disabled: false };
        if (sel === '.council-cancel-btn') return { textContent: '' };
        return null;
      });

      vi.spyOn(modal, 'startProgressMonitoring').mockImplementation(() => {});

      const config = { levels: { '1': { enabled: true, voices: [] } } };
      modal.show('test-id', config, null, { configType: 'advanced' });

      expect(titleEl.textContent).toBe('Review progress');
    });
  });

  describe('_refreshConsolidationHeader', () => {
    /**
     * Helper: create a mock consolidation child element whose statusEl
     * reports the given state via classList.contains (matching _renderState behaviour).
     */
    function mockChild(state) {
      const statusEl = {
        className: `council-voice-status ${state}`,
        textContent: 'Irrelevant Label',
        classList: {
          contains: (cls) => cls === state
        }
      };
      return {
        querySelector: vi.fn((sel) => {
          if (sel === '.council-voice-status') return statusEl;
          return null;
        })
      };
    }

    it('derives "completed" when all children are completed', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      modalContainer.querySelectorAll = vi.fn(() => [mockChild('completed'), mockChild('completed')]);

      const iconEl = {};
      const statusEl = {};
      modal._refreshConsolidationHeader(iconEl, statusEl, 'pending');

      expect(renderSpy).toHaveBeenCalledWith(iconEl, statusEl, 'completed', 'council-level');
    });

    it('derives "running" when any child is running', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      modalContainer.querySelectorAll = vi.fn(() => [mockChild('completed'), mockChild('running')]);

      modal._refreshConsolidationHeader({}, {}, 'pending');

      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'running', 'council-level');
    });

    it('derives "failed" when a child has failed and none are running', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      modalContainer.querySelectorAll = vi.fn(() => [mockChild('completed'), mockChild('failed')]);

      modal._refreshConsolidationHeader({}, {}, 'pending');

      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'failed', 'council-level');
    });

    it('derives "failed" when mixed failed and running (failed takes precedence)', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      modalContainer.querySelectorAll = vi.fn(() => [mockChild('failed'), mockChild('running')]);

      modal._refreshConsolidationHeader({}, {}, 'pending');

      // failed takes unconditional precedence over running, matching backend behaviour
      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'failed', 'council-level');
    });

    it('derives "cancelled" when all children are cancelled', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      modalContainer.querySelectorAll = vi.fn(() => [mockChild('cancelled'), mockChild('cancelled')]);

      modal._refreshConsolidationHeader({}, {}, 'pending');

      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'cancelled', 'council-level');
    });

    it('derives "pending" when all children are pending', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      modalContainer.querySelectorAll = vi.fn(() => [mockChild('pending'), mockChild('pending')]);

      modal._refreshConsolidationHeader({}, {}, 'pending');

      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'pending', 'council-level');
    });

    it('derives "running" when mix of completed and pending (partial progress)', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      modalContainer.querySelectorAll = vi.fn(() => [mockChild('completed'), mockChild('pending')]);

      modal._refreshConsolidationHeader({}, {}, 'pending');

      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'running', 'council-level');
    });

    it('uses fallback state when no children exist', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      modalContainer.querySelectorAll = vi.fn(() => []);

      modal._refreshConsolidationHeader({}, {}, 'running');

      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'running', 'council-level');
    });

    it('returns early when iconEl or statusEl is null', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      modal._refreshConsolidationHeader(null, {}, 'running');
      modal._refreshConsolidationHeader({}, null, 'running');

      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('reads state from CSS classes, not textContent', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      // Child whose textContent says "Complete" but CSS class says "running"
      // This verifies we read the CSS class, not the label text
      const trickChild = {
        querySelector: vi.fn((sel) => {
          if (sel === '.council-voice-status') {
            return {
              className: 'council-voice-status running',
              textContent: 'Complete',   // misleading label
              classList: { contains: (cls) => cls === 'running' }
            };
          }
          return null;
        })
      };

      modalContainer.querySelectorAll = vi.fn(() => [trickChild]);

      modal._refreshConsolidationHeader({}, {}, 'pending');

      // Should derive "running" from the CSS class, NOT "completed" from textContent
      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'running', 'council-level');
    });

    it('treats child with no statusEl as pending', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      const childNoStatus = {
        querySelector: vi.fn(() => null)
      };

      modalContainer.querySelectorAll = vi.fn(() => [childNoStatus, mockChild('completed')]);

      modal._refreshConsolidationHeader({}, {}, 'pending');

      // One pending + one completed => partial progress => "running"
      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'running', 'council-level');
    });

    it('derives "skipped" state from CSS class on children', () => {
      const { modal, modalContainer } = createTestCouncilProgressModal();
      const renderSpy = vi.spyOn(modal, '_renderState').mockImplementation(() => {});

      // Mix of skipped and completed — skipped is not completed/running/failed/cancelled
      // so it falls through to the partial progress branch
      modalContainer.querySelectorAll = vi.fn(() => [mockChild('skipped'), mockChild('completed')]);

      modal._refreshConsolidationHeader({}, {}, 'pending');

      // skipped + completed: not allComplete, not anyRunning, not anyFailed, not allCancelled
      // => falls to else: some !== pending => 'running'
      expect(renderSpy).toHaveBeenCalledWith({}, {}, 'running', 'council-level');
    });
  });
});
