// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared modal-detection helpers.
 *
 * Used by KeyboardShortcuts and PRManager so keyboard handlers consistently
 * defer to whatever modal/dialog is currently open. Single source of truth
 * for both the selector list and the visibility check — keeping them in
 * sync across consumers was the original motivation for extracting this.
 *
 * The help overlay (`#keyboard-shortcuts-help`) is intentionally excluded
 * from the selectors so the shortcuts overlay itself doesn't suppress
 * Escape handling for its own close button.
 */

/**
 * Selectors that identify "a modal is open". Anything matched here will be
 * treated as a blocker for unrelated keyboard shortcuts.
 * @type {string[]}
 */
const MODAL_SELECTORS = [
  '.modal-overlay:not(#keyboard-shortcuts-help)',
  '.review-modal-overlay',
  '.preview-modal-overlay',
  '.confirm-dialog-overlay',
  '.analysis-config-overlay',
  '.ai-summary-modal-overlay',
  '[role="dialog"]:not(#keyboard-shortcuts-help)'
];

/**
 * Return true when `element` is visually present — i.e. not hidden via
 * `display`, `visibility`, or zero opacity. Mirrors the legacy
 * KeyboardShortcuts.isElementVisible behavior so existing call sites keep
 * the same semantics.
 *
 * @param {Element|null|undefined} element
 * @returns {boolean}
 */
function isElementVisible(element) {
  if (!element) return false;
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return true;
  }
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  return true;
}

/**
 * Return true when at least one of the registered modal selectors matches
 * a visible element in the document.
 *
 * Excludes the keyboard-shortcuts help overlay so it doesn't block its own
 * close behavior.
 *
 * @returns {boolean}
 */
function isModalOpen() {
  if (typeof document === 'undefined') return false;
  for (const selector of MODAL_SELECTORS) {
    const el = document.querySelector(selector);
    if (el && isElementVisible(el)) {
      return true;
    }
  }
  return false;
}

if (typeof window !== 'undefined') {
  window.ModalDetection = { isModalOpen, isElementVisible, MODAL_SELECTORS };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isModalOpen, isElementVisible, MODAL_SELECTORS };
}
