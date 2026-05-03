// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';

const { generateTourForReview } = require('../../src/ai/tour-generator.js');
const { kickOffSummaryJob } = require('../../src/ai/summary-generator.js');
const { BackgroundQueue } = require('../../src/ai/background-queue.js');
const { HunkSummaryRepository, TourRepository } = require('../../src/database.js');

const REVIEW_ID = 555;

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
  { id: 'main-model', tier: 'balanced' }
];

function waitForQueueIdle(queue) {
  return new Promise((resolve) => {
    const tick = () => {
      if (queue.active === 0 && queue.queue.length === 0) {
        resolve();
      } else {
        setImmediate(tick);
      }
    };
    tick();
  });
}

describe('integration: generateTourForReview persistence', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
    seedTestReview(db, { id: REVIEW_ID, prNumber: 1, repository: 'owner/repo' });
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('persists tour row with diff_hash, stops, provider, model and broadcasts ready', async () => {
    const broadcastEvents = [];
    const broadcastReviewEvent = vi.fn((id, payload) => {
      broadcastEvents.push({ id, payload });
    });

    const stops = [
      { file_path: 'a.js', side: 'RIGHT', line_start: 2, line_end: 2, title: 't1', description: 'd1' },
      { file_path: 'b.js', side: 'RIGHT', line_start: 2, line_end: 2, title: 't2', description: 'd2' },
      { file_path: 'c.js', side: 'RIGHT', line_start: 2, line_end: 2, title: 't3', description: 'd3' }
    ];

    const provider = {
      execute: vi.fn(async () => ({ stops })),
      constructor: FakeProviderClass
    };

    const result = await generateTourForReview({
      db,
      config: { tours_enabled: true, summaries_enabled: true },
      reviewId: REVIEW_ID,
      diffText: SIMPLE_DIFF,
      worktreePath: '/tmp/wt',
      reviewContext: { prTitle: 'Big change', prDescription: 'Adds three things' },
      _deps: {
        createProvider: vi.fn(() => provider),
        resolveNonExecutableProviderId: vi.fn(() => 'fake'),
        getTourProvider: vi.fn(() => 'fake'),
        getTourModel: vi.fn(() => 'fast-model'),
        broadcastReviewEvent
      }
    });

    expect(result).toEqual({ generated: true, stops: 3 });

    const tourRepo = new TourRepository(db);
    const persisted = await tourRepo.get(REVIEW_ID);
    expect(persisted).toBeDefined();
    expect(persisted.provider).toBe('fake');
    expect(persisted.model).toBe('fast-model');
    expect(typeof persisted.diff_hash).toBe('string');
    expect(persisted.diff_hash.length).toBeGreaterThan(0);

    const persistedStops = JSON.parse(persisted.stops);
    expect(persistedStops).toHaveLength(3);
    expect(persistedStops.map((s) => s.file_path).sort()).toEqual(['a.js', 'b.js', 'c.js']);

    const tourReadyEvents = broadcastEvents.filter(
      (e) => e.payload && e.payload.type === 'review:tour_ready'
    );
    expect(tourReadyEvents).toHaveLength(1);
    expect(tourReadyEvents[0].id).toBe(REVIEW_ID);
  });
});

describe('integration: summary -> tour chained generation', () => {
  let db;
  let queue;

  beforeEach(() => {
    db = createTestDatabase();
    seedTestReview(db, { id: REVIEW_ID, prNumber: 1, repository: 'owner/repo' });
    queue = new BackgroundQueue({ _deps: { broadcast: vi.fn() } });
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('chains tour generation after summaries; both rows persist', async () => {
    let callIdx = 0;
    const fake = {
      execute: vi.fn(async () => {
        callIdx++;
        // First three calls: summary batches (one per file).
        if (callIdx <= 3) {
          return { summaries: [{ index: 1, summary: `summary-${callIdx}` }] };
        }
        // Fourth call: tour. Reference real changed lines on each file.
        return {
          stops: [
            { file_path: 'a.js', side: 'RIGHT', line_start: 2, line_end: 2, title: 't1', description: 'd1' },
            { file_path: 'b.js', side: 'RIGHT', line_start: 2, line_end: 2, title: 't2', description: 'd2' },
            { file_path: 'c.js', side: 'RIGHT', line_start: 2, line_end: 2, title: 't3', description: 'd3' }
          ]
        };
      }),
      constructor: FakeProviderClass
    };

    const broadcastReviewEvent = vi.fn();

    const sharedDeps = {
      backgroundQueue: queue,
      createProvider: vi.fn(() => fake),
      resolveNonExecutableProviderId: vi.fn(() => 'fake'),
      getSummaryProvider: vi.fn(() => 'fake'),
      getSummaryModel: vi.fn(() => 'fast-model'),
      getTourProvider: vi.fn(() => 'fake'),
      getTourModel: vi.fn(() => 'fast-model'),
      broadcastReviewEvent,
      getGeneratedFilePatterns: vi.fn(async () => ({ isGenerated: () => false }))
    };

    const summaryPromise = kickOffSummaryJob({
      db,
      config: {
        summaries_enabled: true,
        tours_enabled: true,
        summaries_max_files: 50,
        summaries_max_lines_added: 3000
      },
      reviewId: REVIEW_ID,
      diffText: SIMPLE_DIFF,
      worktreePath: '/tmp/wt',
      reviewContext: { prTitle: 'Big change', prDescription: 'Adds three things' },
      _deps: sharedDeps
    });

    expect(summaryPromise).toBeInstanceOf(Promise);
    const summaryResult = await summaryPromise;
    expect(summaryResult.filesProcessed).toBe(3);
    expect(summaryResult.hunksPersisted).toBe(3);

    await waitForQueueIdle(queue);

    const summaryRepo = new HunkSummaryRepository(db);
    const summaries = await summaryRepo.getByReview(REVIEW_ID);
    expect(summaries.filter((r) => r.summary_text)).toHaveLength(3);

    const tourRepo = new TourRepository(db);
    const tour = await tourRepo.get(REVIEW_ID);
    expect(tour).toBeDefined();
    expect(tour.provider).toBe('fake');
    expect(tour.model).toBe('fast-model');
    expect(typeof tour.diff_hash).toBe('string');

    const tourReadyCalls = broadcastReviewEvent.mock.calls.filter(
      ([, payload]) => payload && payload.type === 'review:tour_ready'
    );
    expect(tourReadyCalls.length).toBeGreaterThanOrEqual(1);

    // 3 summary calls + 1 tour call
    expect(fake.execute).toHaveBeenCalledTimes(4);
  });

  it('skips both summary and tour when summaries_max_lines_added cap is hit', async () => {
    // Build a diff that adds 10 lines.
    const oversizedBody = Array.from({ length: 10 }, (_, i) => `+added-${i + 1}`).join('\n') + '\n';
    const oversizedDiff = `diff --git a/big.js b/big.js
--- a/big.js
+++ b/big.js
@@ -1,1 +1,11 @@
 base
${oversizedBody}`;

    const fake = {
      execute: vi.fn(),
      constructor: FakeProviderClass
    };

    const broadcastReviewEvent = vi.fn();

    const sharedDeps = {
      backgroundQueue: queue,
      createProvider: vi.fn(() => fake),
      resolveNonExecutableProviderId: vi.fn(() => 'fake'),
      getSummaryProvider: vi.fn(() => 'fake'),
      getSummaryModel: vi.fn(() => 'fast-model'),
      getTourProvider: vi.fn(() => 'fake'),
      getTourModel: vi.fn(() => 'fast-model'),
      broadcastReviewEvent,
      getGeneratedFilePatterns: vi.fn(async () => ({ isGenerated: () => false }))
    };

    const summaryResult = await kickOffSummaryJob({
      db,
      config: {
        summaries_enabled: true,
        tours_enabled: true,
        summaries_max_files: 50,
        summaries_max_lines_added: 5
      },
      reviewId: REVIEW_ID,
      diffText: oversizedDiff,
      worktreePath: '/tmp/wt',
      _deps: sharedDeps
    });

    expect(summaryResult).toMatchObject({ oversized: true });

    await waitForQueueIdle(queue);

    // Provider was never invoked — neither for summaries nor for the tour.
    expect(fake.execute).not.toHaveBeenCalled();

    const summaryRepo = new HunkSummaryRepository(db);
    expect(await summaryRepo.getByReview(REVIEW_ID)).toHaveLength(0);

    const tourRepo = new TourRepository(db);
    expect(await tourRepo.get(REVIEW_ID)).toBeUndefined();
  });
});
