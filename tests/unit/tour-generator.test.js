// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';

const {
  generateTourForReview,
  kickOffTourJob,
  parseHunkHeader,
  buildChangedLineIndex,
  buildScriptCommand,
  validateStop,
  latestRequestedDiffHash,
  resetLatestRequestedDiffHash
} = require('../../src/ai/tour-generator.js');
const {
  TOUR_DESCRIPTION_MAX,
  TOUR_TITLE_MAX
} = require('../../src/ai/prompts/tour.js');
const { TourRepository } = require('../../src/database.js');
const { BackgroundQueue } = require('../../src/ai/background-queue.js');

const REVIEW_ID = 4242;

// ---------- Pure helpers ---------------------------------------------------

describe('parseHunkHeader', () => {
  it('parses a fully-specified header', () => {
    expect(parseHunkHeader('@@ -10,5 +12,7 @@')).toEqual({
      oldStart: 10,
      oldLen: 5,
      newStart: 12,
      newLen: 7
    });
  });

  it('defaults missing length to 1', () => {
    expect(parseHunkHeader('@@ -10 +12 @@')).toEqual({
      oldStart: 10,
      oldLen: 1,
      newStart: 12,
      newLen: 1
    });
  });

  it('returns null for malformed input', () => {
    expect(parseHunkHeader('not a header')).toBeNull();
    expect(parseHunkHeader('')).toBeNull();
    expect(parseHunkHeader(null)).toBeNull();
    expect(parseHunkHeader(undefined)).toBeNull();
  });
});

describe('buildChangedLineIndex', () => {
  it('produces only added line numbers on the right side for additions', () => {
    const hunksByFile = new Map([
      [
        'a.js',
        [
          {
            header: '@@ -10,2 +10,3 @@',
            lines: [' line a', '+line b', '+line c']
          }
        ]
      ]
    ]);
    const idx = buildChangedLineIndex(hunksByFile);
    expect(idx.right.get('a.js')).toEqual(new Set([11, 12]));
    expect(idx.left.get('a.js')).toEqual(new Set());
  });

  it('produces left-side line numbers for deletions, in OLD coordinates', () => {
    const hunksByFile = new Map([
      [
        'a.js',
        [
          {
            header: '@@ -10,3 +10,1 @@',
            lines: [' kept', '-removed-1', '-removed-2']
          }
        ]
      ]
    ]);
    const idx = buildChangedLineIndex(hunksByFile);
    expect(idx.left.get('a.js')).toEqual(new Set([11, 12]));
    expect(idx.right.get('a.js')).toEqual(new Set());
  });

  it('skips no-newline-at-end-of-file markers', () => {
    const hunksByFile = new Map([
      [
        'a.js',
        [
          {
            header: '@@ -1,2 +1,2 @@',
            lines: [' ok', '+added', '\\ No newline at end of file']
          }
        ]
      ]
    ]);
    const idx = buildChangedLineIndex(hunksByFile);
    // The marker should not advance the line counters or pollute the sets.
    expect(idx.right.get('a.js')).toEqual(new Set([2]));
    expect(idx.left.get('a.js')).toEqual(new Set());
  });
});

describe('buildScriptCommand', () => {
  it('returns bare git-diff-lines when no path is provided', () => {
    expect(buildScriptCommand(null)).toBe('git-diff-lines');
    expect(buildScriptCommand(undefined)).toBe('git-diff-lines');
    expect(buildScriptCommand('')).toBe('git-diff-lines');
  });

  it('appends --cwd "<path>" when a path is provided', () => {
    expect(buildScriptCommand('/abs')).toBe('git-diff-lines --cwd "/abs"');
  });
});

// ---------- validateStop ---------------------------------------------------

describe('validateStop', () => {
  let ctx;

  beforeEach(() => {
    ctx = {
      hunksByFile: new Map([['a.js', [{ header: '@@ -10,3 +42,3 @@', lines: [] }]]]),
      changedLines: {
        right: new Map([['a.js', new Set([42, 43, 44])]]),
        left: new Map([['a.js', new Set([20])]])
      },
      worktreePath: '/wt'
    };
  });

  it('returns null when file_path is missing', async () => {
    expect(await validateStop({ title: 'T', description: 'D', line_start: 42, line_end: 43 }, ctx)).toBeNull();
  });

  it('returns null when title is missing', async () => {
    expect(await validateStop({ file_path: 'a.js', description: 'D', line_start: 42, line_end: 43 }, ctx)).toBeNull();
  });

  it('returns null when description is missing', async () => {
    expect(await validateStop({ file_path: 'a.js', title: 'T', line_start: 42, line_end: 43 }, ctx)).toBeNull();
  });

  it('returns null when line_start < 1', async () => {
    expect(await validateStop({ file_path: 'a.js', title: 'T', description: 'D', line_start: 0, line_end: 1 }, ctx)).toBeNull();
  });

  it('returns null when line_end < line_start', async () => {
    expect(await validateStop({ file_path: 'a.js', title: 'T', description: 'D', line_start: 5, line_end: 3 }, ctx)).toBeNull();
  });

  it('normalizes side to uppercase', async () => {
    const out = await validateStop({
      file_path: 'a.js',
      title: 'T',
      description: 'D',
      line_start: 42,
      line_end: 43,
      side: 'right'
    }, ctx);
    expect(out).not.toBeNull();
    expect(out.side).toBe('RIGHT');
  });

  it('accepts a non-context stop on a changed file when range intersects right-side changed lines', async () => {
    const out = await validateStop({
      file_path: 'a.js',
      title: 'T',
      description: 'D',
      line_start: 42,
      line_end: 44
    }, ctx);
    expect(out).not.toBeNull();
    expect(out.side).toBe('RIGHT');
    expect(out.line_start).toBe(42);
    expect(out.line_end).toBe(44);
  });

  it('rejects a non-context stop whose range does not intersect changed lines', async () => {
    expect(await validateStop({
      file_path: 'a.js',
      title: 'T',
      description: 'D',
      line_start: 1,
      line_end: 5
    }, ctx)).toBeNull();
  });

  it('rejects a non-context stop on a file outside the diff', async () => {
    expect(await validateStop({
      file_path: 'unknown.js',
      title: 'T',
      description: 'D',
      line_start: 42,
      line_end: 43
    }, ctx)).toBeNull();
  });

  it('accepts a LEFT-side non-context stop intersecting deleted lines', async () => {
    const out = await validateStop({
      file_path: 'a.js',
      side: 'LEFT',
      title: 'T',
      description: 'D',
      line_start: 20,
      line_end: 20
    }, ctx);
    expect(out).not.toBeNull();
    expect(out.side).toBe('LEFT');
  });

  it('drops every context stop (gap expansion not yet supported in renderer)', async () => {
    // Even when the stop's range falls inside the file and points at the
    // changed file from the diff, is_context:true must be filtered.
    expect(await validateStop({
      file_path: 'a.js',
      is_context: true,
      title: 'T',
      description: 'D',
      line_start: 42,
      line_end: 43
    }, ctx)).toBeNull();

    // External file with is_context: true is also dropped.
    expect(await validateStop({
      file_path: 'ext.js',
      side: 'LEFT',
      is_context: true,
      title: 'T',
      description: 'D',
      line_start: 50,
      line_end: 60
    }, ctx)).toBeNull();
  });

  it('trims and length-caps title and description', async () => {
    const longTitle = '   ' + 'T'.repeat(200) + '   ';
    // Use a length safely above the new 800-char cap so the slice is observable.
    const longDesc = '   ' + 'D'.repeat(TOUR_DESCRIPTION_MAX + 200) + '   ';
    const out = await validateStop({
      file_path: 'a.js',
      title: longTitle,
      description: longDesc,
      line_start: 42,
      line_end: 43
    }, ctx);
    expect(out).not.toBeNull();
    expect(out.title.length).toBeLessThanOrEqual(TOUR_TITLE_MAX);
    expect(out.description.length).toBeLessThanOrEqual(TOUR_DESCRIPTION_MAX);
    // No leading whitespace
    expect(out.title.startsWith(' ')).toBe(false);
    expect(out.description.startsWith(' ')).toBe(false);
  });
});

// ---------- generateTourForReview -----------------------------------------

const SAMPLE_DIFF = `diff --git a/a.js b/a.js
@@ -1,3 +1,4 @@
 line1
 line2
+line3
+line4
`;

function makeProvider(executeImpl) {
  function FakeProvider() {}
  FakeProvider.getModels = () => [{ id: 'fast-model', tier: 'fast' }];
  const instance = { execute: vi.fn(executeImpl), constructor: FakeProvider };
  return { ProviderClass: FakeProvider, instance };
}

function makeDeps({ provider, depsOverride } = {}) {
  const { instance, ProviderClass } = provider || makeProvider(async () => ({
    stops: [
      { file_path: 'a.js', side: 'RIGHT', line_start: 3, line_end: 3, title: 't1', description: 'd1' },
      { file_path: 'a.js', side: 'RIGHT', line_start: 4, line_end: 4, title: 't2', description: 'd2' }
    ]
  }));

  const createProvider = vi.fn(() => instance);
  const broadcastReviewEvent = vi.fn();
  const buildTourPrompt = vi.fn(() => 'TOUR-PROMPT');
  const extractJSON = vi.fn((raw) => {
    try {
      return { success: true, data: JSON.parse(raw) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  const getTourProvider = vi.fn(() => 'fake');
  const getTourModel = vi.fn(() => 'fast-model');
  const resolveNonExecutableProviderId = vi.fn(() => 'fake');
  const parseUnifiedDiffHunks = vi.fn(() => new Map([
    ['a.js', [{ header: '@@ -1,3 +1,4 @@', lines: [' line1', ' line2', '+line3', '+line4'] }]]
  ]));
  const hashDiff = vi.fn(() => 'abc123def456');

  return {
    providerInstance: instance,
    ProviderClass,
    deps: {
      createProvider,
      broadcastReviewEvent,
      buildTourPrompt,
      extractJSON,
      getTourProvider,
      getTourModel,
      resolveNonExecutableProviderId,
      parseUnifiedDiffHunks,
      hashDiff,
      ...(depsOverride || {})
    }
  };
}

describe('generateTourForReview', () => {
  let db;
  let baseParams;

  beforeEach(() => {
    db = createTestDatabase();
    seedTestReview(db, { id: REVIEW_ID, prNumber: 1, repository: 'owner/repo' });
    resetLatestRequestedDiffHash();
    baseParams = {
      db,
      config: { tours_enabled: true, summaries_enabled: true },
      reviewId: REVIEW_ID,
      diffText: SAMPLE_DIFF,
      worktreePath: '/wt',
      reviewContext: { prTitle: 'T', prDescription: 'D' }
    };
  });

  afterEach(() => {
    closeTestDatabase(db);
    resetLatestRequestedDiffHash();
  });

  it("skips with reason: 'no_diff' when diffText is empty/whitespace", async () => {
    const { deps } = makeDeps();
    const result = await generateTourForReview({ ...baseParams, diffText: '   ', _deps: deps });
    expect(result).toEqual({ generated: false, stops: 0, reason: 'no_diff' });
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it("skips with reason: 'empty_diff' when parser returns empty Map", async () => {
    const { deps } = makeDeps();
    deps.parseUnifiedDiffHunks = vi.fn(() => new Map());
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result).toEqual({ generated: false, stops: 0, reason: 'empty_diff' });
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it("skips with reason: 'cached' and broadcasts review:tour_ready when diff_hash already matches", async () => {
    const tourRepo = new TourRepository(db);
    await tourRepo.upsert({
      review_id: REVIEW_ID,
      stops: JSON.stringify([{ cached: true }]),
      diff_hash: 'abc123def456',
      provider: 'cached',
      model: 'cached-m'
    });

    const { deps, providerInstance } = makeDeps();
    const result = await generateTourForReview({ ...baseParams, _deps: deps });

    expect(result).toEqual({ generated: false, stops: 0, reason: 'cached' });
    expect(providerInstance.execute).not.toHaveBeenCalled();
    expect(deps.broadcastReviewEvent).toHaveBeenCalledWith(REVIEW_ID, { type: 'review:tour_ready' });

    // Persisted row untouched
    const after = await tourRepo.get(REVIEW_ID);
    expect(after.provider).toBe('cached');
  });

  it("skips with reason: 'no_provider' when resolveNonExecutableProviderId returns null", async () => {
    const { deps } = makeDeps();
    deps.resolveNonExecutableProviderId = vi.fn(() => null);
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result).toEqual({ generated: false, stops: 0, reason: 'no_provider' });
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it("skips with reason: 'provider_error' when createProvider throws", async () => {
    const { deps } = makeDeps();
    deps.createProvider = vi.fn(() => { throw new Error('no such provider'); });
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result).toEqual({ generated: false, stops: 0, reason: 'provider_error' });
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it("skips with reason: 'provider_throw' when provider.execute throws", async () => {
    const provider = makeProvider(async () => { throw new Error('boom'); });
    const { deps } = makeDeps({ provider });
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result).toEqual({ generated: false, stops: 0, reason: 'provider_throw' });
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it("skips with reason: 'malformed' when extractJSON fails to parse", async () => {
    const provider = makeProvider(async () => ({ raw: 'not-json{', parsed: false }));
    const { deps } = makeDeps({ provider });
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result.reason).toBe('malformed');
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it("skips with reason: 'malformed' when response is missing stops[]", async () => {
    const provider = makeProvider(async () => ({ stops: 'not-an-array' }));
    const { deps } = makeDeps({ provider });
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result.reason).toBe('malformed');
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it("skips with reason: 'not_tour_worthy' when fewer than 2 stops survive validation", async () => {
    const provider = makeProvider(async () => ({
      stops: [
        // valid (1 survivor — below the 2-stop persist gate)
        { file_path: 'a.js', side: 'RIGHT', line_start: 3, line_end: 3, title: 't', description: 'd' },
        // outside diff, not context -> dropped
        { file_path: 'unknown.js', side: 'RIGHT', line_start: 1, line_end: 1, title: 't', description: 'd' },
        // missing description -> dropped
        { file_path: 'a.js', side: 'RIGHT', line_start: 3, line_end: 3, title: 't' }
      ]
    }));
    const { deps } = makeDeps({ provider });
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result.reason).toBe('not_tour_worthy');
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it('happy path: persists tour with correct diff_hash, provider, model and broadcasts ready', async () => {
    const { deps, providerInstance } = makeDeps();
    const result = await generateTourForReview({ ...baseParams, _deps: deps });

    expect(result).toEqual({ generated: true, stops: 2 });
    expect(providerInstance.execute).toHaveBeenCalledTimes(1);

    // Provider called with expected options
    expect(providerInstance.execute.mock.calls[0][1]).toEqual({
      cwd: '/wt',
      logPrefix: '[Tour]'
    });

    const tourRepo = new TourRepository(db);
    const persisted = await tourRepo.get(REVIEW_ID);
    expect(persisted).toBeDefined();
    expect(persisted.diff_hash).toBe('abc123def456');
    expect(persisted.provider).toBe('fake');
    expect(persisted.model).toBe('fast-model');
    const stops = JSON.parse(persisted.stops);
    expect(stops).toHaveLength(2);
    for (const s of stops) {
      expect(s.file_path).toBe('a.js');
      expect(s.side).toBe('RIGHT');
      expect([3, 4]).toContain(s.line_start);
      expect([3, 4]).toContain(s.line_end);
    }

    expect(deps.broadcastReviewEvent).toHaveBeenCalledWith(REVIEW_ID, { type: 'review:tour_ready' });
  });

  it('drops stops outside the diff with is_context:false and persists only valid stops', async () => {
    const provider = makeProvider(async () => ({
      stops: [
        { file_path: 'a.js', side: 'RIGHT', line_start: 3, line_end: 3, title: 't1', description: 'd1' },
        // out-of-diff non-context — must be dropped
        { file_path: 'evil.js', side: 'RIGHT', line_start: 1, line_end: 1, title: 'bad', description: 'bad' },
        { file_path: 'a.js', side: 'RIGHT', line_start: 4, line_end: 4, title: 't2', description: 'd2' }
      ]
    }));
    const { deps } = makeDeps({ provider });
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result.generated).toBe(true);
    expect(result.stops).toBe(2);

    const tourRepo = new TourRepository(db);
    const stops = JSON.parse((await tourRepo.get(REVIEW_ID)).stops);
    expect(stops).toHaveLength(2);
    for (const s of stops) {
      expect(s.file_path).toBe('a.js');
    }
  });

  it('drops stops that overlap an already-accepted stop on the same (file_path, side)', async () => {
    const provider = makeProvider(async () => ({
      stops: [
        // Accepted: covers line 3.
        { file_path: 'a.js', side: 'RIGHT', line_start: 3, line_end: 3, title: 't1', description: 'd1' },
        // Overlaps the previous (3..4 vs 3..3) — must be dropped.
        { file_path: 'a.js', side: 'RIGHT', line_start: 3, line_end: 4, title: 't-dupe', description: 'dupe' },
        // Accepted: covers line 4 (different range from the first).
        { file_path: 'a.js', side: 'RIGHT', line_start: 4, line_end: 4, title: 't2', description: 'd2' }
      ]
    }));
    const { deps } = makeDeps({ provider });
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result.generated).toBe(true);
    expect(result.stops).toBe(2);

    const tourRepo = new TourRepository(db);
    const stops = JSON.parse((await tourRepo.get(REVIEW_ID)).stops);
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => `${s.line_start}-${s.line_end}`).sort()).toEqual(['3-3', '4-4']);
  });

  it('caps stops at TOUR_MAX_STOPS (12) when provider returns more', async () => {
    // 14 distinct, non-overlapping stops on lines 3..16; the cap should
    // truncate to 12.
    const stops = [];
    for (let i = 0; i < 14; i++) {
      const line = 3 + i;
      stops.push({
        file_path: 'a.js',
        side: 'RIGHT',
        line_start: line,
        line_end: line,
        title: `t${i}`,
        description: `d${i}`
      });
    }
    const provider = makeProvider(async () => ({ stops }));
    const { deps } = makeDeps({ provider });
    // Stub parseUnifiedDiffHunks so the validator accepts the wider range.
    deps.parseUnifiedDiffHunks = vi.fn(() => new Map([
      [
        'a.js',
        [
          {
            // 14 added lines starting at line 3.
            header: '@@ -1,2 +1,16 @@',
            lines: [
              ' line1', ' line2',
              ...Array.from({ length: 14 }, (_, i) => `+line${i + 3}`)
            ]
          }
        ]
      ]
    ]));
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result.generated).toBe(true);
    expect(result.stops).toBe(12);

    const tourRepo = new TourRepository(db);
    const persisted = JSON.parse((await tourRepo.get(REVIEW_ID)).stops);
    expect(persisted).toHaveLength(12);
  });

  it('resolves model via getTourModel(config, ProviderClass) and persists it', async () => {
    const { deps, ProviderClass } = makeDeps();
    deps.getTourModel = vi.fn(() => 'custom-tour-model');

    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result.generated).toBe(true);

    expect(deps.getTourModel).toHaveBeenCalled();
    // Called with (config, ProviderClass) once a provider class is known
    const callArgs = deps.getTourModel.mock.calls.find((call) => call[1] === ProviderClass);
    expect(callArgs).toBeDefined();
    expect(callArgs[0]).toBe(baseParams.config);

    const tourRepo = new TourRepository(db);
    const persisted = await tourRepo.get(REVIEW_ID);
    expect(persisted.model).toBe('custom-tour-model');
  });

  it('persists provider matching the resolved providerId', async () => {
    const { deps } = makeDeps();
    deps.resolveNonExecutableProviderId = vi.fn(() => 'resolved-id');
    const result = await generateTourForReview({ ...baseParams, _deps: deps });
    expect(result.generated).toBe(true);

    const tourRepo = new TourRepository(db);
    const persisted = await tourRepo.get(REVIEW_ID);
    expect(persisted.provider).toBe('resolved-id');
  });
});

// ---------- kickOffTourJob ------------------------------------------------

describe('kickOffTourJob', () => {
  it('returns null when tours_enabled !== true', () => {
    const enqueue = vi.fn();
    const result = kickOffTourJob({
      db: {},
      config: { tours_enabled: false },
      reviewId: 1,
      diffText: 'diff',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue, hasActiveForReview: vi.fn() } }
    });
    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('fires regardless of summaries_enabled (tour is decoupled from summaries)', () => {
    const enqueue = vi.fn((_id, _type, fn) => Promise.resolve({ ran: typeof fn === 'function' }));
    const result = kickOffTourJob({
      db: {},
      config: { summaries_enabled: false, tours_enabled: true },
      reviewId: 7,
      diffText: 'diff',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue, hasActiveForReview: vi.fn() } }
    });
    expect(result).toBeInstanceOf(Promise);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('returns null when reviewId is missing', () => {
    const enqueue = vi.fn();
    const result = kickOffTourJob({
      db: {},
      config: { tours_enabled: true },
      reviewId: null,
      diffText: 'diff',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue, hasActiveForReview: vi.fn() } }
    });
    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns null when diffText is missing', () => {
    const enqueue = vi.fn();
    const result = kickOffTourJob({
      db: {},
      config: { tours_enabled: true },
      reviewId: 1,
      diffText: '',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue, hasActiveForReview: vi.fn() } }
    });
    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns null when worktreePath is missing', () => {
    const enqueue = vi.fn();
    const result = kickOffTourJob({
      db: {},
      config: { tours_enabled: true },
      reviewId: 1,
      diffText: 'diff',
      worktreePath: '',
      _deps: { backgroundQueue: { enqueue, hasActiveForReview: vi.fn() } }
    });
    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns enqueue() result and uses (reviewId, "tour", fn) shape', async () => {
    const enqueue = vi.fn((_id, _type, fn) => Promise.resolve({ ran: typeof fn === 'function' }));
    const result = kickOffTourJob({
      db: {},
      config: { tours_enabled: true },
      reviewId: 7,
      diffText: 'diff',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue, hasActiveForReview: vi.fn() } }
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toBe(7);
    expect(enqueue.mock.calls[0][1]).toBe('tour');
    expect(typeof enqueue.mock.calls[0][2]).toBe('function');
    expect(await result).toEqual({ ran: true });
  });
});

// ---------- Staleness / supersede regression -----------------------------

describe('kickOffTourJob staleness handling', () => {
  beforeEach(() => {
    resetLatestRequestedDiffHash();
  });

  afterEach(() => {
    resetLatestRequestedDiffHash();
  });

  it('only the latest diff hash persists when two kickoffs arrive back-to-back', async () => {
    // The queue dedups on (reviewId, 'tour'), so a second kickoff while
    // the first is in flight returns the SAME promise. The fix is to stamp
    // `latestRequestedDiffHash` BEFORE enqueueing in kickOffTourJob and
    // have the in-flight worker observe it before its terminal upsert.
    const queue = new BackgroundQueue({ _deps: { broadcast: vi.fn() } });

    // Defer the in-flight worker: only release it after the second
    // kickoff has stamped its newer hash.
    let releaseFirst;
    const releaseFirstSignal = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const persisted = [];

    // Hash by string equality of the diff text so we can drive two distinct hashes.
    const hashDiff = vi.fn((s) => `H(${s})`);

    let workerCallIdx = 0;
    const fakeGenerate = vi.fn(async ({ reviewId, diffText }) => {
      workerCallIdx++;
      const myHash = hashDiff(diffText);
      // Wait so both kickoffs definitely got their .set() in.
      await releaseFirstSignal;
      // Mimic the in-generator superseded check.
      const latest = latestRequestedDiffHash.get(reviewId);
      if (latest !== undefined && latest !== myHash) {
        return { generated: false, stops: 0, superseded: true, reason: 'superseded' };
      }
      persisted.push({ reviewId, hash: myHash });
      // Same cleanup behavior as the real generator.
      if (latestRequestedDiffHash.get(reviewId) === myHash) {
        latestRequestedDiffHash.delete(reviewId);
      }
      return { generated: true, stops: 2 };
    });

    const baseDeps = {
      backgroundQueue: queue,
      hashDiff,
      generateTourForReview: fakeGenerate
    };

    const reviewId = 9001;
    const config = { tours_enabled: true };

    // Kickoff #1 — older diff. Enqueues the worker (the queue starts it
    // immediately since concurrency >= 1, but the worker awaits releaseFirst).
    const p1 = kickOffTourJob({
      db: {},
      config,
      reviewId,
      diffText: 'diff-OLD',
      worktreePath: '/wt',
      _deps: baseDeps
    });
    expect(p1).toBeInstanceOf(Promise);
    expect(latestRequestedDiffHash.get(reviewId)).toBe('H(diff-OLD)');

    // Kickoff #2 — newer diff. Queue dedups so this returns the SAME promise
    // as p1 — the second worker thunk is dropped. But our staleness map
    // gets stamped with the newer hash BEFORE enqueue checks dedup.
    const p2 = kickOffTourJob({
      db: {},
      config,
      reviewId,
      diffText: 'diff-NEW',
      worktreePath: '/wt',
      _deps: baseDeps
    });
    expect(p2).toBeInstanceOf(Promise);
    expect(latestRequestedDiffHash.get(reviewId)).toBe('H(diff-NEW)');

    // Now release the in-flight worker. It sees the newer stamped hash and
    // skips persistence.
    releaseFirst();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toEqual({ generated: false, stops: 0, superseded: true, reason: 'superseded' });
    expect(r2).toBe(r1); // same promise

    // The first worker bailed; nothing persisted.
    expect(persisted).toHaveLength(0);
    expect(workerCallIdx).toBe(1);

    // The newer hash remains stamped — a follow-up kickoff for the same
    // diff would now run and persist normally.
    expect(latestRequestedDiffHash.get(reviewId)).toBe('H(diff-NEW)');

    // Run a follow-up kickoff for the newer diff to confirm end-state: it
    // persists with the newer hash.
    const p3 = kickOffTourJob({
      db: {},
      config,
      reviewId,
      diffText: 'diff-NEW',
      worktreePath: '/wt',
      _deps: baseDeps
    });
    const r3 = await p3;
    expect(r3).toEqual({ generated: true, stops: 2 });
    expect(persisted).toEqual([{ reviewId, hash: 'H(diff-NEW)' }]);
  });
});
