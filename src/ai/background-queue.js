// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const { broadcastReviewEvent } = require('../events/review-events');
const logger = require('../utils/logger');
const { makeAbortError } = require('./abort-signal-wiring');

const BACKGROUND_QUEUE_CONCURRENCY = 2;

const defaults = {
  broadcast: broadcastReviewEvent,
};

/**
 * Bounded-concurrency in-process queue with per-key dedup.
 *
 * Jobs are keyed by `${reviewId}:${jobType}`; concurrent enqueues
 * for the same key share a single execution and a single promise.
 *
 * Cancellation: each enqueued job is associated with an `AbortController`.
 * The worker thunk is invoked as `fn(signal)` so it can plumb the signal
 * into downstream provider calls / `fetch` / `child_process.spawn`.
 * Callers cancel via `cancel(reviewId, jobKey)`, which aborts the
 * signal and removes the controller; the worker is expected to react
 * to the abort and settle (typically by rejecting with an AbortError).
 */
class BackgroundQueue {
  /**
   * @param {Object} [options]
   * @param {number} [options.concurrency] - Max concurrent jobs.
   * @param {Object} [options._deps] - Override dependencies (testing).
   * @param {Function} [options._deps.broadcast] - Broadcast hook.
   */
  constructor(options = {}) {
    const { concurrency = BACKGROUND_QUEUE_CONCURRENCY, _deps = {} } = options;
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.inFlight = new Map();
    // Per-key AbortController covers both queued and running jobs so a
    // single lookup can resolve cancellation against either state.
    this.controllers = new Map();
    this._deps = { ...defaults, ..._deps };
  }

  /**
   * Enqueue a job for execution.
   *
   * Dedup contract: if a job for the same `(reviewId, jobType)` key is
   * already queued or running, this returns the existing promise without
   * invoking `fn`. The duplicate `fn` is silently dropped.
   *
   * The thunk is called as `fn(signal)` where `signal` is the `AbortSignal`
   * for this job. Workers that touch the network, spawn processes, or
   * otherwise burn upstream resources should thread the signal through so
   * cancellation actually frees those resources.
   *
   * @param {string|number} reviewId - Review identifier.
   * @param {string} jobType - Job category (e.g. 'summaries', 'tour').
   * @param {Function} fn - Thunk `(signal) => value|Promise<value>`.
   * @returns {Promise} Resolves/rejects with the job result.
   */
  enqueue(reviewId, jobType, fn) {
    const key = `${reviewId}:${jobType}`;
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }
    let resolve;
    let reject;
    const p = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.inFlight.set(key, p);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    this.queue.push({
      key,
      run: fn,
      resolve,
      reject,
      reviewId,
      jobType,
      controller,
      promise: p,
    });
    this._drain();
    return p;
  }

  /**
   * Cancel an in-flight or queued job. Aborts its `AbortSignal` so the
   * worker can tear down upstream resources, then drops the controller.
   *
   * Matching is exact on `(reviewId, jobKey)`. For composite jobTypes
   * like `summaries:${digest}`, callers may also pass a bare prefix
   * (`summaries`) — this cancels ALL matching `summaries:*` jobs for the
   * review. This is what the toolbar "Cancel Summaries" button needs:
   * users don't know about digests, they just want the pulse to stop.
   *
   * @param {string|number} reviewId
   * @param {string} jobKey - bare `jobType` (e.g. `tour`) or full key
   *   suffix (e.g. `summaries:abc123`).
   * @returns {{cancelled: number}} number of jobs aborted.
   */
  cancel(reviewId, jobKey) {
    if (jobKey === undefined || jobKey === null || jobKey === '') {
      return { cancelled: 0 };
    }
    const exact = `${reviewId}:${jobKey}`;
    const prefix = `${exact}:`;
    let cancelled = 0;
    // Snapshot keys before aborting — settling a worker mid-iteration would
    // mutate this.controllers (via _settle).
    const keys = Array.from(this.controllers.keys());
    for (const key of keys) {
      if (key !== exact && !key.startsWith(prefix)) continue;
      const controller = this.controllers.get(key);
      if (!controller) continue;
      try {
        controller.abort();
      } catch (err) {
        logger.warn(`BackgroundQueue controller.abort() failed for ${key}: ${err.message}`);
      }
      // Eagerly evict the cancelled key from the dedup/controller maps and
      // splice any not-yet-started descriptors out of the queue. Without
      // this, a follow-up enqueue() for the same key would hit the dedup
      // guard and inherit the about-to-reject promise, and _drain() could
      // hand the worker an already-aborted signal. _settle()'s deletes are
      // identity-guarded, so when the cancelled worker eventually rejects
      // it won't clobber a replacement job installed under the same key.
      this._evictKey(key);
      cancelled++;
    }
    return { cancelled };
  }

  /**
   * Remove a key from the dedup/controller maps and reject any queued (not
   * yet started) descriptor with an AbortError. Safe to call when the key
   * has already been cleaned up — Map.delete and Array.splice both no-op.
   *
   * @param {string} key - Composite `${reviewId}:${jobType}` key.
   * @private
   */
  _evictKey(key) {
    // Splice queued descriptors and reject their promises so the dedup'd
    // caller (if any) sees a clean cancellation rather than a hung promise.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].key !== key) continue;
      const [descriptor] = this.queue.splice(i, 1);
      try {
        descriptor.reject(makeAbortError('Job cancelled before start'));
      } catch (rejectErr) {
        logger.warn(
          `BackgroundQueue descriptor.reject failed for ${key}: ${rejectErr.message}`
        );
      }
    }
    this.inFlight.delete(key);
    this.controllers.delete(key);
  }

  /** Start as many queued jobs as concurrency allows. */
  _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const descriptor = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(() => descriptor.run(descriptor.controller.signal))
        .then(
          (result) => this._settle(descriptor, null, result),
          (error) => this._settle(descriptor, error, undefined)
        );
    }
  }

  /** Finalize a job: free its key, broadcast, settle, and drain. */
  _settle(descriptor, error, result) {
    // Identity-guarded cleanup: if cancel() evicted this descriptor and a
    // replacement was enqueued under the same key, the maps now point at
    // the new descriptor's controller/promise — unconditional deletes would
    // wipe the replacement's bookkeeping (invisible to hasActiveForReview,
    // immune to cancel, vulnerable to duplicate enqueue).
    if (this.controllers.get(descriptor.key) === descriptor.controller) {
      this.controllers.delete(descriptor.key);
    }
    if (this.inFlight.get(descriptor.key) === descriptor.promise) {
      this.inFlight.delete(descriptor.key);
    }
    this.active--;
    this._onComplete(descriptor.reviewId, descriptor.jobType, error);
    if (error === null) {
      descriptor.resolve(result);
    } else {
      descriptor.reject(error);
    }
    this._drain();
  }

  /**
   * Is there an in-flight or queued job for this review whose jobType
   * starts with the given prefix? Useful for surfacing a "generating"
   * indicator on the frontend (`hasActiveForReview(id, 'summaries')`).
   *
   * Job keys are stored as `${reviewId}:${jobType}`; `summaries` jobs use
   * the form `summaries:${digest}`, so a prefix match on
   * `${reviewId}:summaries` catches every digest variant.
   *
   * @param {string|number} reviewId
   * @param {string} jobTypePrefix
   * @returns {boolean}
   */
  hasActiveForReview(reviewId, jobTypePrefix) {
    if (!jobTypePrefix) return false;
    const prefix = `${reviewId}:${jobTypePrefix}`;
    for (const key of this.inFlight.keys()) {
      if (key === prefix || key.startsWith(prefix + ':')) return true;
    }
    return false;
  }

  /** Broadcast job completion; broadcast failures are logged, not thrown. */
  _onComplete(reviewId, jobType, error) {
    try {
      // Include whether more jobs of the same type-prefix remain queued or
      // in-flight so listeners (e.g. the summaries toolbar pulse) don't
      // clear their "generating" state when a sibling job is still running.
      // For composite types like `summaries:${digest}`, we strip the suffix
      // so the prefix match catches every digest variant.
      const colonIdx = jobType.indexOf(':');
      const prefix = colonIdx >= 0 ? jobType.slice(0, colonIdx) : jobType;
      const hasActiveForType = this.hasActiveForReview(reviewId, prefix);
      this._deps.broadcast(reviewId, {
        type: 'review:background_job_finished',
        jobType,
        ok: error === null,
        hasActiveForType,
        cancelled: isAbortError(error),
      });
    } catch (broadcastError) {
      logger.warn(
        `BackgroundQueue broadcast failed for ${reviewId}:${jobType}: ${broadcastError.message}`
      );
    }
  }
}

/**
 * Recognize errors that originated from `AbortController.abort()`.
 * Node sets `name === 'AbortError'` on the DOMException for AbortSignal,
 * but providers that wrap the abort in a custom Error may instead set
 * `code === 'ABORT_ERR'` or surface `signal.aborted` themselves. Check
 * the common shapes so the broadcast payload is honest about cancels.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  if (!err) return false;
  if (typeof err !== 'object') return false;
  if (err.name === 'AbortError') return true;
  if (err.code === 'ABORT_ERR') return true;
  if (err.isCancellation === true) return true;
  return false;
}

const backgroundQueue = new BackgroundQueue();

module.exports = { BackgroundQueue, backgroundQueue, BACKGROUND_QUEUE_CONCURRENCY, isAbortError };
