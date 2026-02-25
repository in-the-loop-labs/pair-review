// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Unit tests for ReviewModal component
 *
 * Tests the updatePendingDraftNotice method, specifically the draft radio label
 * text changing based on pending draft existence.
 *
 * IMPORTANT: These tests import the actual ReviewModal class from production code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Setup minimal DOM globals before importing ReviewModal
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
    reviewModal: null,
    prManager: null,
    aiPanel: null,
    toast: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };

  // Create a localStorage mock
  global.localStorage = {
    _store: {},
    getItem: vi.fn((key) => global.localStorage._store[key] ?? null),
    setItem: vi.fn((key, value) => { global.localStorage._store[key] = value; }),
    removeItem: vi.fn((key) => { delete global.localStorage._store[key]; }),
    clear: vi.fn(() => { global.localStorage._store = {}; })
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.document;
  delete global.window;
  delete global.localStorage;
});

/**
 * Create a mock DOM element with querySelector support.
 * Maintains an innerHTML-based child structure for querySelector to traverse.
 */
function createMockElement(tag) {
  const children = [];
  let innerHTML = '';
  const element = {
    tagName: tag?.toUpperCase(),
    id: '',
    className: '',
    style: {},
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    checked: false,
    title: '',
    href: '',
    _children: children,
    appendChild: vi.fn((child) => {
      children.push(child);
    }),
    remove: vi.fn(),
    querySelector: vi.fn(),
    querySelectorAll: vi.fn().mockReturnValue([]),
    addEventListener: vi.fn(),
    closest: vi.fn(),
    setAttribute: vi.fn(),
    getAttribute: vi.fn(),
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      contains: vi.fn().mockReturnValue(false)
    },
    focus: vi.fn()
  };
  return element;
}

/**
 * Build a ReviewModal instance for testing with mock DOM wired up.
 * Returns the instance and references to key mock elements.
 */
function createTestReviewModal() {
  // Import the actual ReviewModal class
  const { ReviewModal } = require('../../public/js/components/ReviewModal.js');

  // Reset the static listeners flag so constructor can register listeners
  ReviewModal._listenersRegistered = false;

  // Create the mock modal container element
  const modalContainer = createMockElement('div');

  // Create mock elements that updatePendingDraftNotice needs
  const pendingDraftNotice = createMockElement('div');
  pendingDraftNotice.id = 'pending-draft-notice';
  pendingDraftNotice.style = { display: 'none' };

  const pendingDraftCount = createMockElement('strong');
  pendingDraftCount.id = 'pending-draft-count';
  pendingDraftCount.textContent = '0';

  const pendingDraftLink = createMockElement('a');
  pendingDraftLink.id = 'pending-draft-link';
  pendingDraftLink.style = { display: 'inline' };
  pendingDraftLink.href = '';

  // Create a persistent textarea element
  const textarea = createMockElement('textarea');
  textarea.id = 'review-body-modal';
  textarea.value = '';

  // Create assisted-by checkbox and toggle
  const assistedByCheckbox = createMockElement('input');
  assistedByCheckbox.type = 'checkbox';
  assistedByCheckbox.id = 'assisted-by-checkbox';
  assistedByCheckbox.checked = false;

  const assistedByToggle = createMockElement('label');
  assistedByToggle.id = 'assisted-by-toggle';
  assistedByToggle.className = 'assisted-by-toggle';

  // Create the DRAFT radio input and its label
  const draftRadioInput = createMockElement('input');
  draftRadioInput.type = 'radio';
  draftRadioInput.value = 'DRAFT';

  const draftTypeLabel = createMockElement('span');
  draftTypeLabel.className = 'review-type-label';
  draftTypeLabel.textContent = 'Save as Draft';

  const draftTypeOption = createMockElement('label');
  draftTypeOption.className = 'review-type-option';
  draftTypeOption.querySelector = vi.fn().mockImplementation((sel) => {
    if (sel === '.review-type-label') return draftTypeLabel;
    return null;
  });

  draftRadioInput.closest = vi.fn().mockImplementation((sel) => {
    if (sel === '.review-type-option') return draftTypeOption;
    return null;
  });

  // Wire up querySelector on pendingDraftNotice
  pendingDraftNotice.querySelector = vi.fn().mockImplementation((sel) => {
    if (sel === '#pending-draft-count') return pendingDraftCount;
    if (sel === '#pending-draft-link') return pendingDraftLink;
    return null;
  });

  // Wire up querySelector on modalContainer
  modalContainer.querySelector = vi.fn().mockImplementation((sel) => {
    if (sel === '#pending-draft-notice') return pendingDraftNotice;
    if (sel === 'input[name="review-event"][value="DRAFT"]') return draftRadioInput;
    if (sel === '#review-body-modal') return textarea;
    if (sel === '#assisted-by-checkbox') return assistedByCheckbox;
    if (sel === '#assisted-by-toggle') return assistedByToggle;
    if (sel === 'input[name="review-event"]:checked') {
      const radio = createMockElement('input');
      radio.value = 'COMMENT';
      return radio;
    }
    if (sel === '.review-comment-count') return createMockElement('div');
    if (sel === '#review-error-message') return createMockElement('div');
    if (sel === '#large-review-warning') return createMockElement('div');
    if (sel === '#copy-ai-summary-link') return createMockElement('a');
    return null;
  });

  // Prevent the constructor from creating real DOM elements
  document.getElementById = vi.fn().mockReturnValue(null);
  document.createElement = vi.fn().mockReturnValue(modalContainer);

  // Create the ReviewModal instance
  const modal = Object.create(ReviewModal.prototype);
  modal.modal = modalContainer;
  modal.isVisible = false;
  modal.isSubmitting = false;
  modal.assistedByUrl = 'https://github.com/in-the-loop-labs/pair-review';

  return {
    modal,
    modalContainer,
    textarea,
    assistedByCheckbox,
    assistedByToggle,
    pendingDraftNotice,
    pendingDraftCount,
    pendingDraftLink,
    draftRadioInput,
    draftTypeLabel,
    draftTypeOption
  };
}

describe('ReviewModal', () => {
  describe('updatePendingDraftNotice', () => {
    it('should change draft label to "Add to Draft" when pendingDraft exists', () => {
      const { modal, pendingDraftNotice, draftTypeLabel } = createTestReviewModal();

      // Set up pending draft on prManager
      global.window.prManager = {
        currentPR: {
          pendingDraft: {
            github_url: 'https://github.com/owner/repo/pull/1',
            comments_count: 5
          }
        }
      };

      modal.updatePendingDraftNotice();

      // Draft label should change
      expect(draftTypeLabel.textContent).toBe('Add to Draft');

      // Notice should be visible
      expect(pendingDraftNotice.style.display).toBe('flex');
    });

    it('should keep draft label as "Save as Draft" when no pendingDraft exists', () => {
      const { modal, pendingDraftNotice, draftTypeLabel } = createTestReviewModal();

      // No pending draft
      global.window.prManager = {
        currentPR: {
          pendingDraft: null
        }
      };

      modal.updatePendingDraftNotice();

      // Draft label should remain the default
      expect(draftTypeLabel.textContent).toBe('Save as Draft');

      // Notice should be hidden
      expect(pendingDraftNotice.style.display).toBe('none');
    });

    it('should restore draft label to "Save as Draft" when pendingDraft is removed', () => {
      const { modal, draftTypeLabel } = createTestReviewModal();

      // First, set pending draft to change the label
      global.window.prManager = {
        currentPR: {
          pendingDraft: {
            github_url: 'https://github.com/owner/repo/pull/1',
            comments_count: 3
          }
        }
      };
      modal.updatePendingDraftNotice();
      expect(draftTypeLabel.textContent).toBe('Add to Draft');

      // Now remove the pending draft
      global.window.prManager.currentPR.pendingDraft = null;
      modal.updatePendingDraftNotice();

      // Label should revert
      expect(draftTypeLabel.textContent).toBe('Save as Draft');
    });

    it('should update pending draft comment count', () => {
      const { modal, pendingDraftCount } = createTestReviewModal();

      global.window.prManager = {
        currentPR: {
          pendingDraft: {
            github_url: 'https://github.com/owner/repo/pull/1',
            comments_count: 7
          }
        }
      };

      modal.updatePendingDraftNotice();

      expect(pendingDraftCount.textContent).toBe('7');
    });

    it('should hide pending draft link when no github_url', () => {
      const { modal, pendingDraftLink } = createTestReviewModal();

      global.window.prManager = {
        currentPR: {
          pendingDraft: {
            github_url: null,
            comments_count: 2
          }
        }
      };

      modal.updatePendingDraftNotice();

      expect(pendingDraftLink.style.display).toBe('none');
    });

    it('should show pending draft link when github_url exists', () => {
      const { modal, pendingDraftLink } = createTestReviewModal();

      global.window.prManager = {
        currentPR: {
          pendingDraft: {
            github_url: 'https://github.com/owner/repo/pull/1',
            comments_count: 2
          }
        }
      };

      modal.updatePendingDraftNotice();

      expect(pendingDraftLink.style.display).toBe('inline');
      expect(pendingDraftLink.href).toBe('https://github.com/owner/repo/pull/1');
    });

    it('should handle missing prManager gracefully (pending draft)', () => {
      const { modal, pendingDraftNotice, draftTypeLabel } = createTestReviewModal();

      // No prManager at all
      global.window.prManager = null;

      // Should not throw
      expect(() => modal.updatePendingDraftNotice()).not.toThrow();

      // Notice should be hidden (no pendingDraft found)
      expect(pendingDraftNotice.style.display).toBe('none');

      // Label should be the default
      expect(draftTypeLabel.textContent).toBe('Save as Draft');
    });
  });

  describe('Assisted-by Footer Toggle', () => {
    it('should restore checkbox ON from localStorage and append footer', () => {
      global.localStorage._store['pair-review-assisted-by'] = 'true';
      const { modal, assistedByCheckbox, textarea } = createTestReviewModal();

      modal.restoreAssistedByToggle();

      expect(assistedByCheckbox.checked).toBe(true);
      expect(textarea.value).toContain('Review assisted by [pair-review]');
    });

    it('should restore checkbox OFF from localStorage and not append footer', () => {
      global.localStorage._store['pair-review-assisted-by'] = 'false';
      const { modal, assistedByCheckbox, textarea } = createTestReviewModal();

      modal.restoreAssistedByToggle();

      expect(assistedByCheckbox.checked).toBe(false);
      expect(textarea.value).toBe('');
    });

    it('should default to checked when no localStorage key', () => {
      const { modal, assistedByCheckbox, textarea } = createTestReviewModal();

      modal.restoreAssistedByToggle();

      expect(assistedByCheckbox.checked).toBe(true);
      expect(textarea.value).toContain('Review assisted by [pair-review]');
    });

    it('should save true and append footer when toggled ON', () => {
      const { modal, assistedByCheckbox, textarea } = createTestReviewModal();
      assistedByCheckbox.checked = true;

      modal.handleAssistedByToggle();

      expect(global.localStorage.setItem).toHaveBeenCalledWith('pair-review-assisted-by', 'true');
      expect(textarea.value).toContain('Review assisted by [pair-review]');
    });

    it('should save false and remove footer when toggled OFF', () => {
      const { modal, assistedByCheckbox, textarea } = createTestReviewModal();
      // First append footer
      assistedByCheckbox.checked = true;
      modal.handleAssistedByToggle();
      expect(textarea.value).toContain('Review assisted by [pair-review]');

      // Now toggle off
      assistedByCheckbox.checked = false;
      modal.handleAssistedByToggle();

      expect(global.localStorage.setItem).toHaveBeenCalledWith('pair-review-assisted-by', 'false');
      expect(textarea.value).toBe('');
    });

    it('should not duplicate footer on appendAssistedByFooter', () => {
      const { modal, textarea } = createTestReviewModal();

      modal.appendAssistedByFooter();
      const firstValue = textarea.value;
      modal.appendAssistedByFooter();

      expect(textarea.value).toBe(firstValue);
    });

    it('should remove footer from middle of text', () => {
      const { modal, textarea } = createTestReviewModal();
      const footer = modal.getAssistedByFooter();
      textarea.value = 'Before' + footer + 'After';

      modal.removeAssistedByFooter();

      expect(textarea.value).toBe('BeforeAfter');
    });

    it('should be a no-op when removeAssistedByFooter called without footer', () => {
      const { modal, textarea } = createTestReviewModal();
      textarea.value = 'Some review text';

      modal.removeAssistedByFooter();

      expect(textarea.value).toBe('Some review text');
    });

    it('should insert AI summary before footer when present', () => {
      const { modal, textarea } = createTestReviewModal();

      // Add footer
      modal.appendAssistedByFooter();

      // Mock AI panel
      global.window.aiPanel = {
        getSummary: () => 'AI generated summary'
      };
      global.window.toast = { showSuccess: vi.fn(), showWarning: vi.fn() };

      modal.appendAISummary();

      // Summary should come before footer
      const footerIndex = textarea.value.indexOf('---\n_Review assisted by');
      const summaryIndex = textarea.value.indexOf('AI generated summary');
      expect(summaryIndex).toBeLessThan(footerIndex);
      expect(summaryIndex).toBeGreaterThanOrEqual(0);
    });

    it('should use configured URL from assistedByUrl', () => {
      const { modal, textarea } = createTestReviewModal();
      modal.assistedByUrl = 'https://custom.example.com/review';

      modal.appendAssistedByFooter();

      expect(textarea.value).toContain('https://custom.example.com/review');
    });

    it('should disable toggle when Draft is selected', () => {
      const { modal, modalContainer, assistedByToggle } = createTestReviewModal();

      // Mock the checked radio to be DRAFT
      const draftRadio = createMockElement('input');
      draftRadio.value = 'DRAFT';
      modalContainer.querySelector = vi.fn().mockImplementation((sel) => {
        if (sel === '#review-body-modal') return createMockElement('textarea');
        if (sel === 'input[name="review-event"]:checked') return draftRadio;
        if (sel === '#assisted-by-toggle') return assistedByToggle;
        return null;
      });

      modal.updateTextareaState();

      expect(assistedByToggle.classList.add).toHaveBeenCalledWith('disabled');
    });
  });

  describe('Cmd/Ctrl+Enter keyboard shortcut', () => {
    /**
     * Create a ReviewModal via its real constructor with document.addEventListener
     * mocked to capture the keydown handler. Returns the instance and the handler.
     */
    function setupKeydownTest() {
      const { ReviewModal } = require('../../public/js/components/ReviewModal.js');
      ReviewModal._listenersRegistered = false;

      let keydownHandler;
      document.addEventListener = vi.fn().mockImplementation((event, handler) => {
        if (event === 'keydown') keydownHandler = handler;
      });

      const instance = new ReviewModal();
      instance.submitReview = vi.fn();
      instance.hide = vi.fn();
      global.window.reviewModal = instance;

      return { instance, keydownHandler };
    }

    it('should register a keydown listener on document', () => {
      setupKeydownTest();

      const keydownCalls = document.addEventListener.mock.calls.filter(c => c[0] === 'keydown');
      expect(keydownCalls.length).toBeGreaterThan(0);
    });

    it('should call submitReview on Cmd+Enter when modal is visible and not submitting', () => {
      const { instance, keydownHandler } = setupKeydownTest();
      instance.isVisible = true;
      instance.isSubmitting = false;

      const event = {
        metaKey: true,
        ctrlKey: false,
        key: 'Enter',
        preventDefault: vi.fn()
      };
      keydownHandler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(instance.submitReview).toHaveBeenCalled();
    });

    it('should call submitReview on Ctrl+Enter when modal is visible and not submitting', () => {
      const { instance, keydownHandler } = setupKeydownTest();
      instance.isVisible = true;
      instance.isSubmitting = false;

      const event = {
        metaKey: false,
        ctrlKey: true,
        key: 'Enter',
        preventDefault: vi.fn()
      };
      keydownHandler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(instance.submitReview).toHaveBeenCalled();
    });

    it('should NOT call submitReview when modal is not visible', () => {
      const { instance, keydownHandler } = setupKeydownTest();
      instance.isVisible = false;
      instance.isSubmitting = false;

      const event = {
        metaKey: true,
        ctrlKey: false,
        key: 'Enter',
        preventDefault: vi.fn()
      };
      keydownHandler(event);

      expect(instance.submitReview).not.toHaveBeenCalled();
    });

    it('should NOT call submitReview when already submitting', () => {
      const { instance, keydownHandler } = setupKeydownTest();
      instance.isVisible = true;
      instance.isSubmitting = true;

      const event = {
        metaKey: true,
        ctrlKey: false,
        key: 'Enter',
        preventDefault: vi.fn()
      };
      keydownHandler(event);

      expect(instance.submitReview).not.toHaveBeenCalled();
    });

    it('should still close on Escape when modal is visible', () => {
      const { instance, keydownHandler } = setupKeydownTest();
      instance.isVisible = true;
      instance.isSubmitting = false;

      const event = {
        metaKey: false,
        ctrlKey: false,
        key: 'Escape',
        preventDefault: vi.fn()
      };
      keydownHandler(event);

      expect(instance.hide).toHaveBeenCalled();
    });
  });
});
