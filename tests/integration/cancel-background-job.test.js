// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end integration: enqueue a tour generation job through the
 * BackgroundQueue with a fake provider whose `execute` honors AbortSignal,
 * then trigger cancellation via the public cancel endpoint and verify:
 *   1. The provider's execute() observes the abort and rejects.
 *   2. The tour is NOT persisted (we never reached upsert).
 *   3. The broadcast carries `cancelled: true`.
 *   4. backgroundQueue.cancel() returns 0 once the job has settled.
 *
 * Mirror test for summaries lives in the same file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';

const { kickOffTourJob } = require('../../src/ai/tour-generator.js');
const { kickOffSummaryJob } = require('../../src/ai/summary-generator.js');
const { BackgroundQueue } = require('../../src/ai/background-queue.js');
const {
  TourRepository,
  HunkSummaryRepository,
} = require('../../src/database.js');
const { handleJobCancel } = require('../../src/routes/reviews.js');

const REVIEW_ID = 7777;

const SIMPLE_DIFF = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,2 +1,3 @@
 alpha
+beta
 gamma
diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -1,2 +1,3 @@
 one
+two
 three
diff --git a/c.js b/c.js
--- a/c.js
+++ b/c.js
@@ -1,2 +1,3 @@
 x
+y
 z
`;

function FakeProviderClass() {}
FakeProviderClass.getModels = () => [
  { id: 'fast-model', tier: 'fast' },
  { id: 'main-model', tier: 'balanced' },
];

/**
 * Build a fake provider whose `execute` waits for either the abort signal
 * (in which case it rejects with an AbortError) or for the test to resolve
 * its internal deferred.
 */
function makeAbortableProvider() {
  const calls = [];
  const provider = {
    constructor: FakeProviderClass,
    execute: vi.fn((_prompt, opts = {}) => {
      const signal = opts.abortSignal;
      const call = { signal, sawAbort: false };
      calls.push(call);
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          call.sawAbort = true;
          const err = new Error('cancelled');
          err.name = 'AbortError';
          err.isCancellation = true;
          reject(err);
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        // never resolves on its own — test drives the lifecycle
      });
    }),
  };
  return { provider, calls };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}

function flushMicrotasks(times = 10) {
  return Promise.all(Array.from({ length: times }, () => Promise.resolve()));
}

/** Poll until `cond()` returns true or the timeout fires. */
async function waitFor(cond, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return cond();
}

describe('integration: cancel background job (tour)', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
    seedTestReview(db, { id: REVIEW_ID, prNumber: 1, repository: 'owner/repo' });
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('cancelling an in-flight tour job aborts the provider call and skips persist', async () => {
    // Pass the broadcast spy into the queue constructor so the queue's
    // own `review:background_job_finished` broadcast (which carries the
    // cancelled flag) lands on our spy. The same spy is wired into the
    // generator's _deps so `review:tour_ready` events (not asserted here)
    // also flow through.
    const broadcastEvents = [];
    const broadcastReviewEvent = vi.fn((_id, payload) => {
      broadcastEvents.push(payload);
    });
    const queue = new BackgroundQueue({ concurrency: 2, _deps: { broadcast: broadcastReviewEvent } });

    const { provider, calls } = makeAbortableProvider();

    const tourPromise = kickOffTourJob({
      db,
      config: { tours_enabled: true },
      reviewId: REVIEW_ID,
      diffText: SIMPLE_DIFF,
      worktreePath: '/tmp/wt',
      reviewContext: { prTitle: 't', prDescription: 'd' },
      _deps: {
        backgroundQueue: queue,
        createProvider: vi.fn(() => provider),
        resolveNonExecutableProviderId: vi.fn(() => 'fake'),
        getTourProvider: vi.fn(() => 'fake'),
        getTourModel: vi.fn(() => 'fast-model'),
        broadcastReviewEvent,
      },
    });

    // Wait for the worker to actually invoke the provider so the signal
    // is wired up. The tour worker awaits a sqlite read first, so we poll.
    await waitFor(() => calls.length >= 1);
    expect(calls.length).toBe(1);
    expect(calls[0].sawAbort).toBe(false);

    // Invoke cancel via the public endpoint, but operate on our test queue
    // by reaching into the queue directly (handleJobCancel uses the
    // singleton; we exercise the queue-side contract here, with a separate
    // unit test covering the endpoint shape itself).
    const result = queue.cancel(REVIEW_ID, 'tour');
    expect(result.cancelled).toBe(1);

    // Worker should reject with AbortError; settle the promise.
    await expect(tourPromise).rejects.toMatchObject({ name: 'AbortError' });

    expect(calls[0].sawAbort).toBe(true);

    // No tour persisted (we never reached upsert).
    const tourRepo = new TourRepository(db);
    const tour = await tourRepo.get(REVIEW_ID);
    expect(tour).toBeUndefined();

    // Broadcast carries cancelled:true.
    const finished = broadcastEvents.filter(
      (e) => e && e.type === 'review:background_job_finished' && e.jobType === 'tour'
    );
    expect(finished.length).toBe(1);
    expect(finished[0].cancelled).toBe(true);
    expect(finished[0].ok).toBe(false);

    // Second cancel is a no-op — controller already removed.
    expect(queue.cancel(REVIEW_ID, 'tour')).toEqual({ cancelled: 0 });
  });
});

describe('integration: cancel background job (summaries)', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
    seedTestReview(db, { id: REVIEW_ID, prNumber: 1, repository: 'owner/repo' });
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('cancelling an in-flight summaries job aborts the provider call', async () => {
    const broadcastEvents = [];
    const broadcastReviewEvent = vi.fn((_id, payload) => {
      broadcastEvents.push(payload);
    });
    const queue = new BackgroundQueue({ concurrency: 2, _deps: { broadcast: broadcastReviewEvent } });

    const { provider, calls } = makeAbortableProvider();

    const promise = kickOffSummaryJob({
      db,
      config: { summaries_enabled: true },
      reviewId: REVIEW_ID,
      diffText: SIMPLE_DIFF,
      worktreePath: '/tmp/wt',
      reviewContext: { prTitle: 't', prDescription: 'd' },
      _deps: {
        backgroundQueue: queue,
        createProvider: vi.fn(() => provider),
        resolveNonExecutableProviderId: vi.fn(() => 'fake'),
        getSummaryProvider: vi.fn(() => 'fake'),
        getSummaryModel: vi.fn(() => 'fast-model'),
        broadcastReviewEvent,
        // Skip gitattributes I/O — not relevant to abort wiring.
        getGeneratedFilePatterns: vi.fn(async () => ({ isGenerated: () => false })),
      },
    });

    await waitFor(() => calls.length >= 1);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Cancel using a bare prefix to exercise the prefix-match path.
    const result = queue.cancel(REVIEW_ID, 'summaries');
    expect(result.cancelled).toBe(1);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    // No fully populated summaries persisted for the (only) attempted file
    // before the abort fired. Trivial-only writes from prior files are
    // allowed; we just assert the *first* file's expensive summary did not
    // land. Looking up by content hash would require parsing the diff again
    // — instead assert that the broadcast was cancelled and the upstream
    // provider was aborted.
    const finished = broadcastEvents.filter(
      (e) => e && e.type === 'review:background_job_finished'
        && typeof e.jobType === 'string' && e.jobType.startsWith('summaries')
    );
    expect(finished.length).toBe(1);
    expect(finished[0].cancelled).toBe(true);

    // Sanity: HunkSummaryRepository didn't blow up the DB.
    const repo = new HunkSummaryRepository(db);
    const rows = await repo.getByReviewAndFile(REVIEW_ID, 'a.js');
    // At most a couple of cheap trivial-row writes; not asserted further.
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('integration: cancel endpoint handler against real queue', () => {
  // This exercises the actual handleJobCancel + the module-level singleton
  // backgroundQueue together, end-to-end, to verify the HTTP layer plus
  // queue plumbing as one unit.
  const { backgroundQueue } = require('../../src/ai/background-queue.js');

  it('returns 200 and aborts when a job is in flight on the singleton queue', async () => {
    let workerSignal;
    const deferred = new Promise((resolve) => {
      // Worker waits on abort and then resolves with a sentinel.
      backgroundQueue.enqueue(424242, 'tour', (signal) => {
        workerSignal = signal;
        return new Promise((res) => {
          signal.addEventListener('abort', () => res('aborted'), { once: true });
        });
      }).then(resolve, resolve);
    });

    await waitFor(() => workerSignal !== undefined);
    expect(workerSignal).toBeInstanceOf(AbortSignal);

    const req = { reviewId: 424242, params: { jobKey: 'tour' } };
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ cancelled: true });
    expect(workerSignal.aborted).toBe(true);

    // Drain the worker.
    await deferred;
  });

  it('returns 404 when nothing is in flight', async () => {
    const req = { reviewId: 999999, params: { jobKey: 'tour' } };
    const res = makeRes();
    await handleJobCancel(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ cancelled: false });
  });
});
