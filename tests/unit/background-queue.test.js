// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from 'vitest';
const { BackgroundQueue, isAbortError } = require('../../src/ai/background-queue.js');

function makeQueue(overrides = {}) {
  const broadcast = overrides.broadcast || vi.fn();
  const concurrency = overrides.concurrency ?? 2;
  const queue = new BackgroundQueue({ concurrency, _deps: { broadcast } });
  return { queue, broadcast };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('BackgroundQueue', () => {
  it('resolves with the job result on success', async () => {
    const { queue } = makeQueue();
    const result = await queue.enqueue(1, 'summaries', () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('propagates failures from rejected jobs', async () => {
    const { queue } = makeQueue();
    const err = new Error('boom');
    await expect(queue.enqueue(1, 'summaries', () => Promise.reject(err))).rejects.toBe(err);
  });

  it('catches synchronous throws from the thunk', async () => {
    const { queue } = makeQueue();
    const err = new Error('sync boom');
    await expect(
      queue.enqueue(1, 'summaries', () => {
        throw err;
      })
    ).rejects.toBe(err);
  });

  it('dedups concurrent enqueues with the same key', async () => {
    const { queue } = makeQueue();
    const fn1 = vi.fn(() => Promise.resolve('first'));
    const fn2 = vi.fn(() => Promise.resolve('second'));
    const p1 = queue.enqueue(1, 'summaries', fn1);
    const p2 = queue.enqueue(1, 'summaries', fn2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('first');
    expect(r2).toBe('first');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).not.toHaveBeenCalled();
  });

  it('runs same jobType for different reviewIds independently', async () => {
    const { queue } = makeQueue();
    const fn1 = vi.fn(() => Promise.resolve('a'));
    const fn2 = vi.fn(() => Promise.resolve('b'));
    const [r1, r2] = await Promise.all([
      queue.enqueue(1, 'summaries', fn1),
      queue.enqueue(2, 'summaries', fn2),
    ]);
    expect(r1).toBe('a');
    expect(r2).toBe('b');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('runs same reviewId with different jobTypes independently', async () => {
    const { queue } = makeQueue();
    const fn1 = vi.fn(() => Promise.resolve('a'));
    const fn2 = vi.fn(() => Promise.resolve('b'));
    const [r1, r2] = await Promise.all([
      queue.enqueue(1, 'summaries', fn1),
      queue.enqueue(1, 'tour', fn2),
    ]);
    expect(r1).toBe('a');
    expect(r2).toBe('b');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('frees the dedup key after completion so the same key can re-run', async () => {
    const { queue } = makeQueue();
    const fn1 = vi.fn(() => Promise.resolve('first'));
    const fn2 = vi.fn(() => Promise.resolve('second'));
    const r1 = await queue.enqueue(1, 'summaries', fn1);
    const r2 = await queue.enqueue(1, 'summaries', fn2);
    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('caps concurrent execution at the configured concurrency', async () => {
    const { queue } = makeQueue({ concurrency: 2 });
    let running = 0;
    let maxRunning = 0;
    const deferreds = [deferred(), deferred(), deferred(), deferred()];
    const promises = deferreds.map((d, i) =>
      queue.enqueue(i + 1, 'summaries', async () => {
        running++;
        if (running > maxRunning) maxRunning = running;
        try {
          return await d.promise;
        } finally {
          running--;
        }
      })
    );

    await flushMicrotasks();
    expect(running).toBe(2);

    deferreds[0].resolve('a');
    await flushMicrotasks();
    expect(running).toBe(2);

    deferreds[1].resolve('b');
    await flushMicrotasks();
    expect(running).toBe(2);

    deferreds[2].resolve('c');
    await flushMicrotasks();
    expect(running).toBe(1);

    deferreds[3].resolve('d');
    const results = await Promise.all(promises);
    expect(results).toEqual(['a', 'b', 'c', 'd']);
    expect(maxRunning).toBe(2);
  });

  it('broadcasts a success event with ok=true', async () => {
    const { queue, broadcast } = makeQueue();
    await queue.enqueue(42, 'summaries', () => Promise.resolve('ok'));
    expect(broadcast).toHaveBeenCalledWith(42, {
      type: 'review:background_job_finished',
      jobType: 'summaries',
      ok: true,
      hasActiveForType: false,
      cancelled: false,
    });
  });

  it('broadcasts a failure event with ok=false', async () => {
    const { queue, broadcast } = makeQueue();
    await expect(
      queue.enqueue(42, 'summaries', () => Promise.reject(new Error('nope')))
    ).rejects.toThrow('nope');
    expect(broadcast).toHaveBeenCalledWith(42, {
      type: 'review:background_job_finished',
      jobType: 'summaries',
      ok: false,
      hasActiveForType: false,
      cancelled: false,
    });
  });

  it('broadcast hasActiveForType reflects sibling jobs of same type-prefix still in flight', async () => {
    // When the queue holds multiple `summaries:${digest}` jobs for the same
    // review (refresh, scope change, whitespace toggle), one finishing
    // should NOT clear the toolbar pulse — the listener uses
    // `hasActiveForType` to know a sibling is still running.
    const { queue, broadcast } = makeQueue({ concurrency: 2 });
    const finishFirst = deferred();
    const finishSecond = deferred();

    const p1 = queue.enqueue(42, 'summaries:digest-a', () => finishFirst.promise);
    const p2 = queue.enqueue(42, 'summaries:digest-b', () => finishSecond.promise);

    // Resolve first while second is still in flight; broadcast for the
    // first must report another summaries job still active.
    finishFirst.resolve('a');
    await p1;
    expect(broadcast).toHaveBeenCalledWith(42, {
      type: 'review:background_job_finished',
      jobType: 'summaries:digest-a',
      ok: true,
      hasActiveForType: true,
      cancelled: false,
    });

    // Now resolve the second; broadcast must report the type cleared.
    finishSecond.resolve('b');
    await p2;
    expect(broadcast).toHaveBeenLastCalledWith(42, {
      type: 'review:background_job_finished',
      jobType: 'summaries:digest-b',
      ok: true,
      hasActiveForType: false,
      cancelled: false,
    });
  });

  describe('hasActiveForReview', () => {
    it('returns true while a same-prefix job is in flight', async () => {
      const { queue } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(7, 'summaries:abc123', () => job.promise);
      // The job is sitting in the queue → key is in `inFlight`.
      expect(queue.hasActiveForReview(7, 'summaries')).toBe(true);
      job.resolve('done');
      await promise;
    });

    it('returns false once the job completes', async () => {
      const { queue } = makeQueue();
      await queue.enqueue(7, 'summaries:abc123', () => Promise.resolve('ok'));
      expect(queue.hasActiveForReview(7, 'summaries')).toBe(false);
    });

    it('matches the bare jobType (no digest suffix)', async () => {
      const { queue } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(7, 'summaries', () => job.promise);
      expect(queue.hasActiveForReview(7, 'summaries')).toBe(true);
      job.resolve('ok');
      await promise;
    });

    it('does not match a different review id', async () => {
      const { queue } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(7, 'summaries:abc123', () => job.promise);
      expect(queue.hasActiveForReview(8, 'summaries')).toBe(false);
      job.resolve('ok');
      await promise;
    });

    it('does not match a different jobType prefix', async () => {
      const { queue } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(7, 'tour', () => job.promise);
      expect(queue.hasActiveForReview(7, 'summaries')).toBe(false);
      job.resolve('ok');
      await promise;
    });

    it('returns false for an empty prefix (defensive)', () => {
      const { queue } = makeQueue();
      expect(queue.hasActiveForReview(7, '')).toBe(false);
      expect(queue.hasActiveForReview(7, undefined)).toBe(false);
    });
  });

  describe('findActiveJobType', () => {
    it('returns the bare jobType when an exact-match job is in flight', async () => {
      const { queue } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(7, 'tour', () => job.promise);
      expect(queue.findActiveJobType(7, 'tour')).toBe('tour');
      job.resolve('ok');
      await promise;
    });

    it('returns the composite jobType when a prefix-match job is in flight', async () => {
      const { queue } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(7, 'summaries:abc123', () => job.promise);
      expect(queue.findActiveJobType(7, 'summaries')).toBe('summaries:abc123');
      job.resolve('ok');
      await promise;
    });

    it('returns null when no matching job is in flight', () => {
      const { queue } = makeQueue();
      expect(queue.findActiveJobType(7, 'summaries')).toBeNull();
    });

    it('returns null for a different reviewId', async () => {
      const { queue } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(7, 'summaries:abc123', () => job.promise);
      expect(queue.findActiveJobType(8, 'summaries')).toBeNull();
      job.resolve('ok');
      await promise;
    });

    it('returns null for an empty prefix (defensive)', () => {
      const { queue } = makeQueue();
      expect(queue.findActiveJobType(7, '')).toBeNull();
      expect(queue.findActiveJobType(7, undefined)).toBeNull();
      expect(queue.findActiveJobType(7, null)).toBeNull();
    });

    it('works with numeric reviewIds (string concatenation hazard)', async () => {
      // The reviewId 42 produces key `42:summaries:abc123`; slicing must use
      // String(reviewId).length so the returned jobType is `summaries:abc123`,
      // not `:summaries:abc123` (off-by-one) or `summaries:abc12` (wrong slice).
      const { queue } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(42, 'summaries:abc123', () => job.promise);
      expect(queue.findActiveJobType(42, 'summaries')).toBe('summaries:abc123');
      job.resolve('ok');
      await promise;
    });

    it('works with multi-digit numeric reviewIds', async () => {
      // Three-digit reviewId — must still slice correctly.
      const { queue } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(123, 'tour', () => job.promise);
      expect(queue.findActiveJobType(123, 'tour')).toBe('tour');
      job.resolve('ok');
      await promise;
    });
  });

  it('does not crash the queue when broadcast throws', async () => {
    const broadcast = vi.fn(() => {
      throw new Error('broadcast exploded');
    });
    const { queue } = makeQueue({ broadcast });
    const r1 = await queue.enqueue(1, 'summaries', () => Promise.resolve('first'));
    const r2 = await queue.enqueue(2, 'summaries', () => Promise.resolve('second'));
    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  describe('cancellation', () => {
    it('passes an AbortSignal to the worker thunk', async () => {
      const { queue } = makeQueue();
      let observed = null;
      await queue.enqueue(1, 'tour', (signal) => {
        observed = signal;
        return Promise.resolve('ok');
      });
      expect(observed).toBeInstanceOf(AbortSignal);
      expect(observed.aborted).toBe(false);
    });

    it('cancel(reviewId, jobKey) aborts the signal for an exact match', async () => {
      const { queue } = makeQueue();
      const job = deferred();
      let workerSignal;
      const promise = queue.enqueue(1, 'tour', (signal) => {
        workerSignal = signal;
        return job.promise;
      });
      await flushMicrotasks();
      const { cancelled } = queue.cancel(1, 'tour');
      expect(cancelled).toBe(1);
      expect(workerSignal.aborted).toBe(true);
      job.resolve('done-but-cancelled');
      await promise; // worker resolved after abort; queue still settles cleanly
    });

    it('cancel by bare prefix aborts ALL matching composite-key jobs', async () => {
      const { queue } = makeQueue({ concurrency: 2 });
      const a = deferred();
      const b = deferred();
      const signals = [];
      const p1 = queue.enqueue(7, 'summaries:digest-a', (s) => {
        signals.push(s);
        return a.promise;
      });
      const p2 = queue.enqueue(7, 'summaries:digest-b', (s) => {
        signals.push(s);
        return b.promise;
      });
      await flushMicrotasks();
      const { cancelled } = queue.cancel(7, 'summaries');
      expect(cancelled).toBe(2);
      expect(signals.every((s) => s.aborted)).toBe(true);
      a.resolve('a'); b.resolve('b');
      await Promise.all([p1, p2]);
    });

    it('cancel returns 0 when no matching job is in flight', () => {
      const { queue } = makeQueue();
      expect(queue.cancel(42, 'tour')).toEqual({ cancelled: 0 });
    });

    it('cancel ignores empty / nullish jobKey', () => {
      const { queue } = makeQueue();
      expect(queue.cancel(1, '')).toEqual({ cancelled: 0 });
      expect(queue.cancel(1, null)).toEqual({ cancelled: 0 });
      expect(queue.cancel(1, undefined)).toEqual({ cancelled: 0 });
    });

    it('does not cancel jobs for a different reviewId', async () => {
      const { queue } = makeQueue();
      const j = deferred();
      let workerSignal;
      const promise = queue.enqueue(1, 'tour', (s) => {
        workerSignal = s;
        return j.promise;
      });
      await flushMicrotasks();
      expect(queue.cancel(2, 'tour')).toEqual({ cancelled: 0 });
      expect(workerSignal.aborted).toBe(false);
      j.resolve('ok');
      await promise;
    });

    it('broadcasts cancelled:true when the worker rejects with an AbortError', async () => {
      const { queue, broadcast } = makeQueue();
      const job = deferred();
      const promise = queue.enqueue(42, 'tour', () => job.promise);
      await flushMicrotasks();
      queue.cancel(42, 'tour');
      // Simulate the provider noticing the abort and rejecting with an
      // AbortError — same shape the real claude-provider emits.
      const err = new Error('cancelled');
      err.name = 'AbortError';
      job.reject(err);
      await expect(promise).rejects.toBe(err);
      expect(broadcast).toHaveBeenCalledWith(42, expect.objectContaining({
        jobType: 'tour',
        ok: false,
        cancelled: true,
      }));
    });

    it('frees the controller after the job settles so the same key can re-run', async () => {
      const { queue } = makeQueue();
      const j1 = deferred();
      const p1 = queue.enqueue(1, 'tour', () => j1.promise);
      await flushMicrotasks();
      queue.cancel(1, 'tour');
      j1.resolve('first');
      await p1;
      // After the first job settled, cancel() should match nothing.
      expect(queue.cancel(1, 'tour')).toEqual({ cancelled: 0 });
      // And a fresh enqueue should run normally.
      let workerSignal;
      const r2 = await queue.enqueue(1, 'tour', (s) => {
        workerSignal = s;
        return Promise.resolve('second');
      });
      expect(r2).toBe('second');
      expect(workerSignal.aborted).toBe(false);
    });

    // Regression for the stale-dedup bug: a cancel followed by an immediate
    // re-enqueue of the same key used to return the about-to-reject promise
    // because cancel() didn't remove the key from `inFlight`. The user
    // would click Cancel → Generate and silently inherit the cancellation.
    it('cancel + immediate re-enqueue starts a fresh job (no stale dedup)', async () => {
      const { queue } = makeQueue();
      const j1 = deferred();
      let firstSignal;
      const fn1 = vi.fn((signal) => {
        firstSignal = signal;
        return j1.promise;
      });
      const p1 = queue.enqueue(1, 'tour', fn1);
      await flushMicrotasks();

      // Cancel — controller aborts, key should be evicted immediately.
      queue.cancel(1, 'tour');
      expect(firstSignal.aborted).toBe(true);

      // Re-enqueue BEFORE the first worker has settled. The new call must
      // start a fresh job, not reuse p1.
      let secondSignal;
      const fn2 = vi.fn((signal) => {
        secondSignal = signal;
        return Promise.resolve('fresh');
      });
      const p2 = queue.enqueue(1, 'tour', fn2);
      expect(p2).not.toBe(p1);

      // Now let the first worker reject (it noticed the abort).
      j1.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      await expect(p1).rejects.toMatchObject({ name: 'AbortError' });

      // Second job runs to completion with its own un-aborted signal.
      await expect(p2).resolves.toBe('fresh');
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(secondSignal).toBeDefined();
      expect(secondSignal.aborted).toBe(false);
    });

    // Regression for the ownership bug in _settle: after cancel() evicts a
    // running job and a replacement is enqueued under the same key, the
    // original worker's eventual rejection must NOT wipe the replacement's
    // bookkeeping. Symptoms of the old behavior: hasActiveForReview returns
    // false, cancel() no-ops, and a follow-up enqueue spins a duplicate.
    it('settle of a cancelled worker does not clobber a re-enqueued replacement', async () => {
      const { queue } = makeQueue();
      const j1 = deferred();
      const j2 = deferred();
      let firstSignal;
      let secondSignal;

      const p1 = queue.enqueue(1, 'tour', (signal) => {
        firstSignal = signal;
        return j1.promise;
      });
      await flushMicrotasks();

      // Cancel the first job — controller aborts, key evicted from maps.
      queue.cancel(1, 'tour');
      expect(firstSignal.aborted).toBe(true);

      // Re-enqueue BEFORE the first worker rejects. New controller/promise
      // get installed under the same key.
      const p2 = queue.enqueue(1, 'tour', (signal) => {
        secondSignal = signal;
        return j2.promise;
      });
      await flushMicrotasks();
      expect(secondSignal).toBeDefined();
      expect(secondSignal.aborted).toBe(false);
      expect(queue.hasActiveForReview(1, 'tour')).toBe(true);

      // First worker finally notices the abort and rejects. _settle for the
      // dead descriptor must NOT touch the replacement's map entries.
      j1.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      await expect(p1).rejects.toMatchObject({ name: 'AbortError' });

      // Replacement still tracked: visible to hasActiveForReview, cancel
      // actually aborts it, dedup still works.
      expect(queue.hasActiveForReview(1, 'tour')).toBe(true);
      const dedup = queue.enqueue(1, 'tour', () => Promise.resolve('should-dedup'));
      expect(dedup).toBe(p2);
      const { cancelled } = queue.cancel(1, 'tour');
      expect(cancelled).toBe(1);
      expect(secondSignal.aborted).toBe(true);

      j2.reject(Object.assign(new Error('cancelled-2'), { name: 'AbortError' }));
      await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    });

    // Regression for the queued-descriptor bug: cancelling while a job
    // was still queued (concurrency saturated) used to leave the
    // descriptor in `this.queue`. `_drain()` would then hand the worker
    // an already-aborted signal and `hasActiveForReview` would keep
    // reporting true.
    it('cancel splices queued descriptors and rejects them with AbortError', async () => {
      const { queue } = makeQueue({ concurrency: 1 });
      const blockerDone = deferred();
      const blocker = queue.enqueue(99, 'other', () => blockerDone.promise);
      await flushMicrotasks();

      // This second enqueue is queued behind the blocker (concurrency=1).
      const queuedFn = vi.fn(() => Promise.resolve('never'));
      const queuedPromise = queue.enqueue(7, 'tour', queuedFn);
      // It IS reported active for the review while queued.
      expect(queue.hasActiveForReview(7, 'tour')).toBe(true);

      // Cancel before the blocker releases — the descriptor is still in
      // this.queue, not running.
      const { cancelled } = queue.cancel(7, 'tour');
      expect(cancelled).toBe(1);

      // Queued descriptor's promise rejects with AbortError synchronously
      // (well, after microtask flush — the reject is scheduled).
      await expect(queuedPromise).rejects.toMatchObject({ name: 'AbortError' });

      // Key is gone from active tracking.
      expect(queue.hasActiveForReview(7, 'tour')).toBe(false);

      // The queued fn must NEVER be invoked — _drain shouldn't pick it up.
      blockerDone.resolve('blocker-done');
      await blocker;
      await flushMicrotasks();
      expect(queuedFn).not.toHaveBeenCalled();
    });
  });

  describe('isAbortError', () => {
    it('matches DOMException with name AbortError', () => {
      const err = new Error('x');
      err.name = 'AbortError';
      expect(isAbortError(err)).toBe(true);
    });
    it('matches errors with code ABORT_ERR', () => {
      const err = new Error('x');
      err.code = 'ABORT_ERR';
      expect(isAbortError(err)).toBe(true);
    });
    it('matches errors with isCancellation flag', () => {
      const err = new Error('x');
      err.isCancellation = true;
      expect(isAbortError(err)).toBe(true);
    });
    it('returns false for regular errors / nullish', () => {
      expect(isAbortError(null)).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
      expect(isAbortError(new Error('boom'))).toBe(false);
      expect(isAbortError('cancelled')).toBe(false);
    });
  });
});
