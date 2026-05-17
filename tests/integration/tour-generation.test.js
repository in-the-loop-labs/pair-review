// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';

const { generateTourForReview, kickOffTourJob } = require('../../src/ai/tour-generator.js');
const { BackgroundQueue } = require('../../src/ai/background-queue.js');
const { TourRepository } = require('../../src/database.js');

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

describe('integration: kickOffTourJob runs independently of summaries', () => {
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

  it('generates and persists a tour without any summary rows existing', async () => {
    const fake = {
      execute: vi.fn(async () => ({
        stops: [
          { file_path: 'a.js', side: 'RIGHT', line_start: 2, line_end: 2, title: 't1', description: 'd1' },
          { file_path: 'b.js', side: 'RIGHT', line_start: 2, line_end: 2, title: 't2', description: 'd2' },
          { file_path: 'c.js', side: 'RIGHT', line_start: 2, line_end: 2, title: 't3', description: 'd3' }
        ]
      })),
      constructor: FakeProviderClass
    };

    const broadcastReviewEvent = vi.fn();

    const tourPromise = kickOffTourJob({
      db,
      config: { tours_enabled: true },
      reviewId: REVIEW_ID,
      diffText: SIMPLE_DIFF,
      worktreePath: '/tmp/wt',
      reviewContext: { prTitle: 'Big change', prDescription: 'Adds three things' },
      _deps: {
        backgroundQueue: queue,
        createProvider: vi.fn(() => fake),
        resolveNonExecutableProviderId: vi.fn(() => 'fake'),
        getTourProvider: vi.fn(() => 'fake'),
        getTourModel: vi.fn(() => 'fast-model'),
        broadcastReviewEvent
      }
    });

    expect(tourPromise).toBeInstanceOf(Promise);
    await tourPromise;
    await waitForQueueIdle(queue);

    const tourRepo = new TourRepository(db);
    const tour = await tourRepo.get(REVIEW_ID);
    expect(tour).toBeDefined();
    expect(tour.provider).toBe('fake');
    expect(tour.model).toBe('fast-model');
    expect(typeof tour.diff_hash).toBe('string');

    // Provider was called exactly once (tour only — no summaries chained).
    expect(fake.execute).toHaveBeenCalledTimes(1);

    const tourReadyCalls = broadcastReviewEvent.mock.calls.filter(
      ([, payload]) => payload && payload.type === 'review:tour_ready'
    );
    expect(tourReadyCalls.length).toBeGreaterThanOrEqual(1);
  });
});
