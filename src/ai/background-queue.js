// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const { broadcastReviewEvent } = require('../events/review-events');
const logger = require('../utils/logger');

const BACKGROUND_QUEUE_CONCURRENCY = 2;

const defaults = {
  broadcast: broadcastReviewEvent,
};

/**
 * Bounded-concurrency in-process queue with per-key dedup.
 *
 * Jobs are keyed by `${reviewId}:${jobType}`; concurrent enqueues
 * for the same key share a single execution and a single promise.
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
    this._deps = { ...defaults, ..._deps };
  }

  /**
   * Enqueue a job for execution.
   *
   * Dedup contract: if a job for the same `(reviewId, jobType)` key is
   * already queued or running, this returns the existing promise without
   * invoking `fn`. The duplicate `fn` is silently dropped.
   *
   * @param {string|number} reviewId - Review identifier.
   * @param {string} jobType - Job category (e.g. 'summaries', 'tour').
   * @param {Function} fn - Thunk returning a value or promise.
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
    this.queue.push({ key, run: fn, resolve, reject, reviewId, jobType });
    this._drain();
    return p;
  }

  /** Start as many queued jobs as concurrency allows. */
  _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const descriptor = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(() => descriptor.run())
        .then(
          (result) => this._settle(descriptor, null, result),
          (error) => this._settle(descriptor, error, undefined)
        );
    }
  }

  /** Finalize a job: free its key, broadcast, settle, and drain. */
  _settle(descriptor, error, result) {
    this.inFlight.delete(descriptor.key);
    this.active--;
    this._onComplete(descriptor.reviewId, descriptor.jobType, error);
    if (error === null) {
      descriptor.resolve(result);
    } else {
      descriptor.reject(error);
    }
    this._drain();
  }

  /** Broadcast job completion; broadcast failures are logged, not thrown. */
  _onComplete(reviewId, jobType, error) {
    try {
      this._deps.broadcast(reviewId, {
        type: 'review:background_job_finished',
        jobType,
        ok: error === null,
      });
    } catch (broadcastError) {
      logger.warn(
        `BackgroundQueue broadcast failed for ${reviewId}:${jobType}: ${broadcastError.message}`
      );
    }
  }
}

const backgroundQueue = new BackgroundQueue();

module.exports = { BackgroundQueue, backgroundQueue, BACKGROUND_QUEUE_CONCURRENCY };
