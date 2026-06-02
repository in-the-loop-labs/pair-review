// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Tests for the shared frontend cancel helper at
 * public/js/modules/cancel-background-job.js. Targets the real production
 * module — no duplicated logic.
 *
 * Verifies:
 *   - showCancelTourDialog / showCancelSummariesDialog open the confirm
 *     dialog with the correct copy.
 *   - On confirm, POSTs to the correct endpoint with the correct jobKey.
 *   - On confirm + 200, invokes onCancelled so the button state resets.
 *   - On confirm + 404, still invokes onCancelled (job already gone).
 *   - On confirm + 400 / 500, toasts and does NOT invoke onCancelled
 *     (the job may still be running upstream; keep the pulse).
 *   - On network failure, surfaces a toast and does NOT invoke onCancelled.
 *   - On dialog cancel (OK), neither POSTs nor invokes onCancelled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const helper = require('../../public/js/modules/cancel-background-job.js');

function makeFakeDialog() {
  return {
    show: vi.fn(),
  };
}

describe('cancel-background-job helper', () => {
  let origFetch;
  let origToast;
  let origConfirm;
  let fetchMock;

  beforeEach(() => {
    origFetch = global.fetch;
    origConfirm = window.confirmDialog;
    origToast = window.toast;
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    window.toast = { error: vi.fn() };
    window.confirmDialog = makeFakeDialog();
  });

  afterEach(() => {
    global.fetch = origFetch;
    window.confirmDialog = origConfirm;
    window.toast = origToast;
  });

  describe('showCancelTourDialog', () => {
    it('opens the confirm dialog with tour-specific copy', async () => {
      window.confirmDialog.show.mockResolvedValue('cancel');
      await helper.showCancelTourDialog({ reviewId: 7, onCancelled: vi.fn() });
      expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
      const opts = window.confirmDialog.show.mock.calls[0][0];
      expect(opts.title).toMatch(/tour/i);
      expect(opts.confirmText).toMatch(/cancel.*tour/i);
      expect(opts.confirmClass).toBe('btn-danger');
    });

    it('POSTs to the tour cancel endpoint on confirm and runs onCancelled', async () => {
      window.confirmDialog.show.mockResolvedValue('confirm');
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ cancelled: true, count: 1 }),
      });
      const onCancelled = vi.fn();
      await helper.showCancelTourDialog({ reviewId: 42, onCancelled });
      expect(fetchMock).toHaveBeenCalledWith('/api/reviews/42/jobs/tour/cancel', { method: 'POST' });
      expect(onCancelled).toHaveBeenCalledTimes(1);
      expect(onCancelled).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }));
    });

    it('does NOT POST when the user dismisses the dialog (OK)', async () => {
      window.confirmDialog.show.mockResolvedValue('cancel');
      const onCancelled = vi.fn();
      await helper.showCancelTourDialog({ reviewId: 42, onCancelled });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onCancelled).not.toHaveBeenCalled();
    });
  });

  describe('showCancelSummariesDialog', () => {
    it('POSTs to the summaries endpoint and runs onCancelled', async () => {
      window.confirmDialog.show.mockResolvedValue('confirm');
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ cancelled: true, count: 2 }),
      });
      const onCancelled = vi.fn();
      await helper.showCancelSummariesDialog({ reviewId: 13, onCancelled });
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/reviews/13/jobs/summaries/cancel',
        { method: 'POST' }
      );
      expect(onCancelled).toHaveBeenCalledTimes(1);
    });

    it('runs onCancelled on a 404 (job already done) so the button still resets', async () => {
      window.confirmDialog.show.mockResolvedValue('confirm');
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ cancelled: false }),
      });
      const onCancelled = vi.fn();
      await helper.showCancelSummariesDialog({ reviewId: 13, onCancelled });
      expect(onCancelled).toHaveBeenCalledTimes(1);
    });

    it('toasts and does NOT run onCancelled on network failure', async () => {
      window.confirmDialog.show.mockResolvedValue('confirm');
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const onCancelled = vi.fn();
      await helper.showCancelSummariesDialog({ reviewId: 13, onCancelled });
      expect(window.toast.error).toHaveBeenCalled();
      expect(onCancelled).not.toHaveBeenCalled();
    });

    it('toasts and does NOT run onCancelled on HTTP 400 (validation)', async () => {
      // Regression: previously any non-zero status with !ok still cleared the
      // pulse. A 400 means the job may still be running — keep state intact.
      window.confirmDialog.show.mockResolvedValue('confirm');
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'invalid jobKey' }),
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onCancelled = vi.fn();
      await helper.showCancelSummariesDialog({ reviewId: 13, onCancelled });
      expect(window.toast.error).toHaveBeenCalled();
      // Toast message should surface the HTTP status / error body so the
      // user knows what went wrong, not the generic network copy.
      const toastMsg = window.toast.error.mock.calls[0][0];
      expect(toastMsg).toMatch(/400/);
      expect(onCancelled).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('toasts and does NOT run onCancelled on HTTP 500 (server error)', async () => {
      window.confirmDialog.show.mockResolvedValue('confirm');
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'boom' }),
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onCancelled = vi.fn();
      await helper.showCancelSummariesDialog({ reviewId: 13, onCancelled });
      expect(window.toast.error).toHaveBeenCalled();
      expect(onCancelled).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('postCancel', () => {
    it('uses the unified /api/reviews/.../jobs endpoint regardless of mode', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ cancelled: true }),
      });
      const r = await helper.postCancel(99, 'tour');
      expect(fetchMock).toHaveBeenCalledWith('/api/reviews/99/jobs/tour/cancel', { method: 'POST' });
      expect(r.ok).toBe(true);
    });

    it('URL-encodes jobKey to be safe with composite digests', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ cancelled: true }),
      });
      await helper.postCancel(1, 'summaries:abc:def');
      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe('/api/reviews/1/jobs/summaries%3Aabc%3Adef/cancel');
    });

    it('returns ok:false for a missing reviewId without calling fetch', async () => {
      const r = await helper.postCancel(null, 'tour');
      expect(r.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
