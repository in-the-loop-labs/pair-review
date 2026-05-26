// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared frontend helpers for cancelling in-flight background jobs
 * (tour and summaries). Both flows share the same dialog -> POST ->
 * reset-button-state shape, so the per-artifact wrappers stay thin.
 *
 * Backend contract (see src/routes/reviews.js handleJobCancel):
 *   POST /api/reviews/:reviewId/jobs/:jobKey/cancel
 *   200 -> { cancelled: true, count: N }
 *   404 -> { cancelled: false }   (nothing in flight)
 *   400 -> invalid jobKey
 *
 * Local-mode parity: the local route at
 *   POST /api/local/:reviewId/jobs/:jobKey/cancel
 * is a thin wrapper. Both modes share the `reviews` table, so we can
 * use ONE endpoint here. Local mode is detected via document.body.dataset
 * to keep this module independent of PRManager internals.
 */

(function () {
  'use strict';

  /**
   * POST the cancel request for a single (reviewId, jobKey) pair.
   * Returns a Promise resolving to the parsed JSON response.
   *
   * @param {number|string} reviewId
   * @param {string} jobKey - bare prefix (`tour` | `summaries`) or full
   *   suffix (`summaries:<digest>`); the backend treats bare prefixes as
   *   "cancel all matching".
   * @returns {Promise<{ok: boolean, status: number, body: any}>}
   */
  async function postCancel(reviewId, jobKey) {
    if (!reviewId) {
      return { ok: false, status: 0, body: { error: 'missing reviewId' } };
    }
    // Both modes share the /api/reviews/... endpoint thanks to the
    // shared reviews table. No need to branch on local-vs-PR mode here.
    const url = `/api/reviews/${reviewId}/jobs/${encodeURIComponent(jobKey)}/cancel`;
    try {
      const resp = await fetch(url, { method: 'POST' });
      let body = null;
      try {
        body = await resp.json();
      } catch {
        body = null;
      }
      return { ok: resp.ok, status: resp.status, body };
    } catch (err) {
      // Network or unexpected fetch error — log and surface as failure.
      // We deliberately do not toast here so callers can decide the UX.
      // eslint-disable-next-line no-console
      console.warn(`[cancel-background-job] POST ${url} failed:`, err);
      return { ok: false, status: 0, body: { error: err && err.message } };
    }
  }

  /**
   * Open the shared ConfirmDialog with cancel-job copy, then on confirm
   * POST the cancel and invoke the caller's `onCancelled` callback so it
   * can sync UI state (button class toggles, in-memory `_generating`
   * flags, etc.).
   *
   * The caller's `onCancelled` runs only when the backend confirms the
   * cancel reached a terminal state: 200 (cancelled) or 404 (already gone).
   * For any other HTTP status (400 validation, 500 server error, etc.) or
   * a network failure, we toast an error and leave the active state intact
   * so the pulse stays visible and the user can retry the cancel click.
   *
   * @param {Object} opts
   * @param {number|string} opts.reviewId
   * @param {string} opts.jobKey  - `tour` or `summaries`
   * @param {string} opts.title   - Dialog title (e.g. "Tour is still generating")
   * @param {string} opts.message - Dialog body
   * @param {string} opts.confirmText - Confirm button label (e.g. "Cancel Tour")
   * @param {Function} opts.onCancelled - Called after a confirmed cancel.
   * @returns {Promise<void>}
   */
  async function showCancelJobDialog(opts) {
    const { reviewId, jobKey, title, message, confirmText, onCancelled } = opts || {};
    const dialog = typeof window !== 'undefined' ? window.confirmDialog : null;
    if (!dialog || typeof dialog.show !== 'function') {
      // ConfirmDialog hasn't initialized yet — bail silently. The button
      // still works on its second click (after DOMContentLoaded fires).
      return;
    }
    const result = await dialog.show({
      title: title || 'Generation in progress',
      message: message || 'Cancel this job?',
      confirmText: confirmText || 'Cancel',
      confirmClass: 'btn-danger',
      cancelText: 'OK',
    });
    if (result !== 'confirm') return;

    const { status, body } = await postCancel(reviewId, jobKey);
    // ONLY 200 (cancelled) and 404 (already gone) are UI-clearing outcomes.
    // Anything else (400, 500, 503, network failure with status=0) means
    // the job may still be running — keep the pulse, toast an error, and
    // let the user re-click to retry.
    if (status !== 200 && status !== 404) {
      // eslint-disable-next-line no-console
      console.error(
        `[cancel-background-job] cancel failed for ${jobKey} (status ${status}):`,
        body
      );
      if (typeof window !== 'undefined' && window.toast?.error) {
        const detail = body && body.error ? `: ${body.error}` : '';
        const msg = status === 0
          ? 'Failed to cancel — check connection'
          : `Failed to cancel (HTTP ${status})${detail}`;
        window.toast.error(msg);
      }
      return;
    }
    // 200 or 404 — terminal. Reset UI state.
    if (typeof onCancelled === 'function') {
      try {
        onCancelled({ cancelled: status === 200 && body && body.cancelled, status });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[cancel-background-job] onCancelled handler threw:', err);
      }
    }
  }

  // ---- Per-artifact wrappers (thin convenience layer) --------------------

  /**
   * Open the "Cancel Tour" confirm dialog.
   * @param {Object} opts
   * @param {number|string} opts.reviewId
   * @param {Function} opts.onCancelled
   * @returns {Promise<void>}
   */
  function showCancelTourDialog(opts) {
    return showCancelJobDialog({
      reviewId: opts.reviewId,
      jobKey: 'tour',
      title: 'Tour is still being generated',
      message:
        'A guided tour is still being generated for this review. ' +
        'Cancelling will stop the upstream AI call.',
      confirmText: 'Cancel Tour',
      onCancelled: opts.onCancelled,
    });
  }

  /**
   * Open the "Cancel Summaries" confirm dialog.
   * @param {Object} opts
   * @param {number|string} opts.reviewId
   * @param {Function} opts.onCancelled
   * @returns {Promise<void>}
   */
  function showCancelSummariesDialog(opts) {
    return showCancelJobDialog({
      reviewId: opts.reviewId,
      jobKey: 'summaries',
      title: 'Summaries are still being generated',
      message:
        'Hunk summaries are still being generated for this review. ' +
        'Cancelling will stop the upstream AI call. Summaries already ' +
        'persisted will remain.',
      confirmText: 'Cancel Summaries',
      onCancelled: opts.onCancelled,
    });
  }

  const api = {
    postCancel,
    showCancelJobDialog,
    showCancelTourDialog,
    showCancelSummariesDialog,
  };

  if (typeof window !== 'undefined') {
    window.CancelBackgroundJob = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
