// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from 'vitest';
const { BackgroundQueue } = require('../../src/ai/background-queue.js');

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
    });

    // Now resolve the second; broadcast must report the type cleared.
    finishSecond.resolve('b');
    await p2;
    expect(broadcast).toHaveBeenLastCalledWith(42, {
      type: 'review:background_job_finished',
      jobType: 'summaries:digest-b',
      ok: true,
      hasActiveForType: false,
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
});
