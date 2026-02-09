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
});
