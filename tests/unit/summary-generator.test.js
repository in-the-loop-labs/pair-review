// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';

const {
  generateSummariesForReview,
  kickOffSummaryJob
} = require('../../src/ai/summary-generator.js');
const { HunkSummaryRepository } = require('../../src/database.js');

const REVIEW_ID = 42;

function makeDiff(files) {
  let diff = '';
  for (const { path, body } of files) {
    diff += `diff --git a/${path} b/${path}\n`;
    diff += `--- a/${path}\n`;
    diff += `+++ b/${path}\n`;
    diff += body;
    if (!body.endsWith('\n')) diff += '\n';
  }
  return diff;
}

const SIMPLE_HUNK_BODY = `@@ -1,2 +1,3 @@
 alpha
+beta
 gamma
`;

const SECOND_HUNK_BODY = `@@ -1,3 +1,4 @@
 a
+b
 c
 d
`;

/**
 * Wrap the real HunkSummaryRepository in vi.fn() spies so test assertions on
 * call counts/args still work, but persistence is real (matches production).
 */
function makeRealRepo(db) {
  const repo = new HunkSummaryRepository(db);
  return {
    real: repo,
    getByHashes: vi.fn((reviewId, hashes) => repo.getByHashes(reviewId, hashes)),
    upsertMany: vi.fn((rows) => repo.upsertMany(rows)),
    getByReview: vi.fn((reviewId) => repo.getByReview(reviewId)),
    getByReviewAndFile: vi.fn((reviewId, filePath) => repo.getByReviewAndFile(reviewId, filePath)),
    deleteByReview: vi.fn((reviewId) => repo.deleteByReview(reviewId))
  };
}

function makeProvider(executeImpl) {
  function FakeProvider() {}
  FakeProvider.getModels = () => [
    { id: 'fast-model', tier: 'fast' },
    { id: 'main-model', tier: 'balanced' }
  ];
  const instance = { execute: vi.fn(executeImpl), constructor: FakeProvider };
  return { ProviderClass: FakeProvider, instance };
}

function makeDeps({ repo, provider, isGenerated, depsOverride } = {}) {
  function HunkSummaryRepositoryStub() {
    return repo;
  }

  const { ProviderClass, instance: providerInstance } = provider || makeProvider(
    async () => ({ raw: '{"summaries":[]}', parsed: false })
  );
  const createProvider = vi.fn(() => providerInstance);

  const broadcastReviewEvent = vi.fn();
  const getGeneratedFilePatterns = vi.fn(async () => ({
    isGenerated: isGenerated || (() => false)
  }));
  const buildHunkSummaryPrompt = vi.fn(() => 'PROMPT');
  const extractJSON = vi.fn((raw) => {
    try {
      return { success: true, data: JSON.parse(raw) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  const getSummaryProvider = vi.fn(() => 'fake');
  const getSummaryModel = vi.fn(() => 'fast-model');
  const resolveNonExecutableProviderId = vi.fn(() => 'fake');

  return {
    repo,
    providerInstance,
    ProviderClass,
    deps: {
      HunkSummaryRepository: HunkSummaryRepositoryStub,
      createProvider,
      broadcastReviewEvent,
      getGeneratedFilePatterns,
      buildHunkSummaryPrompt,
      extractJSON,
      getSummaryProvider,
      getSummaryModel,
      resolveNonExecutableProviderId,
      ...(depsOverride || {})
    }
  };
}

describe('generateSummariesForReview', () => {
  let db;
  let repo;
  let baseParams;

  beforeEach(() => {
    db = createTestDatabase();
    seedTestReview(db, { id: REVIEW_ID, prNumber: 1, repository: 'owner/repo' });
    repo = makeRealRepo(db);
    baseParams = {
      db: {},
      config: { summaries: { max_files: 50 } },
      reviewId: REVIEW_ID,
      worktreePath: '/tmp/wt',
      reviewContext: {}
    };
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('returns zeros for empty diffText and never calls provider', async () => {
    const { deps, providerInstance } = makeDeps({ repo });
    const result = await generateSummariesForReview({
      ...baseParams,
      diffText: '',
      _deps: deps
    });
    expect(result).toEqual({ filesProcessed: 0, hunksPersisted: 0 });
    expect(providerInstance.execute).not.toHaveBeenCalled();
  });

  it('returns zeros when parsed hunks map is empty', async () => {
    const { deps, providerInstance } = makeDeps({ repo });
    const result = await generateSummariesForReview({
      ...baseParams,
      diffText: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n',
      _deps: deps
    });
    expect(result).toEqual({ filesProcessed: 0, hunksPersisted: 0 });
    expect(providerInstance.execute).not.toHaveBeenCalled();
  });

  it('respects summaries.max_files cap', async () => {
    const { deps, providerInstance } = makeDeps({ repo });
    const diffText = makeDiff([
      { path: 'a.js', body: SIMPLE_HUNK_BODY },
      { path: 'b.js', body: SIMPLE_HUNK_BODY },
      { path: 'c.js', body: SIMPLE_HUNK_BODY }
    ]);
    const result = await generateSummariesForReview({
      ...baseParams,
      config: { summaries: { max_files: 2 } },
      diffText,
      _deps: deps
    });
    expect(result).toEqual({ filesProcessed: 0, hunksPersisted: 0, oversized: true });
    expect(providerInstance.execute).not.toHaveBeenCalled();
  });

  it('respects summaries.max_lines_added cap', async () => {
    const { deps, providerInstance } = makeDeps({ repo });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);
    const result = await generateSummariesForReview({
      ...baseParams,
      config: { summaries: { max_lines_added: 0 } },
      diffText,
      _deps: deps
    });
    expect(result).toEqual({ filesProcessed: 0, hunksPersisted: 0, oversized: true });
    expect(providerInstance.execute).not.toHaveBeenCalled();
  });

  it('returns zeros and never calls provider when no non-executable provider available', async () => {
    const { deps, providerInstance } = makeDeps({ repo });
    deps.resolveNonExecutableProviderId = vi.fn(() => null);
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);
    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });
    expect(result).toEqual({ filesProcessed: 0, hunksPersisted: 0 });
    expect(providerInstance.execute).not.toHaveBeenCalled();
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it('skips provider call when all hunks already persisted but still broadcasts', async () => {
    const { hashHunk } = require('../../src/ai/hunk-hashing');
    const { parseUnifiedDiffHunks } = require('../../src/utils/diff-hunks');
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);
    const hunks = parseUnifiedDiffHunks(diffText).get('a.js');
    const content = [hunks[0].header, ...hunks[0].lines].join('\n');
    const hash = hashHunk('a.js', content);
    await repo.real.upsertMany([
      {
        review_id: REVIEW_ID,
        file_path: 'a.js',
        content_hash: hash,
        summary_text: 'pre-existing',
        trivial_reason: null,
        provider: 'p',
        model: 'm'
      }
    ]);
    const { deps, providerInstance } = makeDeps({ repo });
    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });
    expect(result).toEqual({ filesProcessed: 1, hunksPersisted: 0 });
    expect(providerInstance.execute).not.toHaveBeenCalled();
    expect(deps.broadcastReviewEvent).toHaveBeenCalledTimes(1);
    const [reviewIdArg, payload] = deps.broadcastReviewEvent.mock.calls[0];
    expect(reviewIdArg).toBe(REVIEW_ID);
    expect(payload.type).toBe('review:hunk_summaries_ready');
    expect(payload.filePath).toBe('a.js');
    expect(payload.summaries).toHaveLength(1);
    expect(payload.summaries[0].summary_text).toBe('pre-existing');
  });

  it('skips hunks with existing sentinel rows on reload (does not re-enqueue)', async () => {
    // First pass: provider returns null for the only hunk, persisting a model_skipped sentinel
    const provider = makeProvider(async () => ({
      summaries: [{ index: 1, summary: null }]
    }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);

    const first = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });
    expect(first.hunksPersisted).toBe(1);
    const afterFirst = await repo.real.getByReview(REVIEW_ID);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].trivial_reason).toBe('model_skipped');

    // Second pass: SAME diff, fresh provider that records calls. Must not be invoked.
    const provider2Calls = [];
    const provider2 = makeProvider(async (...args) => {
      provider2Calls.push(args);
      return { summaries: [{ index: 1, summary: 'should not run' }] };
    });
    const { deps: deps2 } = makeDeps({ repo, provider: provider2 });

    const second = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps2
    });
    expect(provider2Calls).toHaveLength(0);
    expect(second.hunksPersisted).toBe(0);

    // Sentinel row remains; nothing got overwritten
    const afterSecond = await repo.real.getByReview(REVIEW_ID);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].trivial_reason).toBe('model_skipped');
  });

  it('mixes trivial + non-trivial hunks with batched LLM call per file', async () => {
    const TRIVIAL_PKG_BODY = `@@ -1,3 +1,3 @@
 {
-  "lodash": "^4.17.20"
+  "lodash": "^4.17.21"
 }
`;
    const NON_TRIVIAL_BODY = SIMPLE_HUNK_BODY + SECOND_HUNK_BODY;

    const provider = makeProvider(async () => ({
      summaries: [
        { index: 1, summary: 'Adds beta line.' },
        { index: 2, summary: 'Adds b after a.' }
      ]
    }));
    const { deps, providerInstance } = makeDeps({ repo, provider });
    const diffText = makeDiff([
      { path: 'package.json', body: TRIVIAL_PKG_BODY },
      { path: 'src/foo.js', body: NON_TRIVIAL_BODY }
    ]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.filesProcessed).toBe(2);
    expect(result.hunksPersisted).toBe(3);
    expect(providerInstance.execute).toHaveBeenCalledTimes(1);

    const allRows = await repo.real.getByReview(REVIEW_ID);
    const trivialRow = allRows.find((r) => r.file_path === 'package.json');
    expect(trivialRow).toBeDefined();
    expect(trivialRow.summary_text).toBeNull();
    expect(trivialRow.trivial_reason).toBe('version_bump');
    expect(trivialRow.provider).toBeNull();

    const nonTrivialRows = allRows.filter((r) => r.file_path === 'src/foo.js');
    expect(nonTrivialRows).toHaveLength(2);
    for (const row of nonTrivialRows) {
      expect(row.provider).toBe('fake');
      expect(row.model).toBe('fast-model');
      expect(row.summary_text).toBeTruthy();
      expect(row.trivial_reason).toBeNull();
    }
  });

  it('uses provider-direct response shape (parsed JSON returned directly)', async () => {
    const provider = makeProvider(async () => ({
      summaries: [{ index: 1, summary: 'parsed-direct' }]
    }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);

    const result = await generateSummariesForReview({ ...baseParams, diffText, _deps: deps });

    expect(deps.extractJSON).not.toHaveBeenCalled();
    expect(result.hunksPersisted).toBe(1);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    expect(allRows.find((r) => r.summary_text === 'parsed-direct')).toBeDefined();
    // Lock in the wiring: worktreePath flows through to the prompt builder as cwd.
    expect(deps.buildHunkSummaryPrompt.mock.calls[0][0].cwd).toBe(baseParams.worktreePath);
  });

  it('falls back to extractJSON when provider returns {raw, parsed:false}', async () => {
    const provider = makeProvider(async () => ({
      raw: '{"summaries":[{"index":1,"summary":"from-extracted"}]}',
      parsed: false
    }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);

    await generateSummariesForReview({ ...baseParams, diffText, _deps: deps });

    expect(deps.extractJSON).toHaveBeenCalledTimes(1);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    expect(allRows.find((r) => r.summary_text === 'from-extracted')).toBeDefined();
  });

  it('skips persistence for envelope-malformed file but processes other files (no sentinel; retries on reload)', async () => {
    let call = 0;
    const provider = makeProvider(async () => {
      call++;
      if (call === 1) {
        return { raw: 'not json at all', parsed: false };
      }
      return { summaries: [{ index: 1, summary: 'good' }] };
    });
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([
      { path: 'a.js', body: SIMPLE_HUNK_BODY },
      { path: 'b.js', body: SIMPLE_HUNK_BODY }
    ]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.filesProcessed).toBe(2);
    // No sentinel for a.js (envelope malformed -> retries on reload), 1 real summary for b.js
    expect(result.hunksPersisted).toBe(1);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    const summaries = allRows.filter((r) => r.summary_text);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].file_path).toBe('b.js');
    // No rows at all for the envelope-malformed file
    expect(allRows.filter((r) => r.file_path === 'a.js')).toEqual([]);
    expect(deps.broadcastReviewEvent).toHaveBeenCalledTimes(2);
  });

  it('continues with other files when provider throws', async () => {
    let call = 0;
    const provider = makeProvider(async () => {
      call++;
      if (call === 1) {
        throw new Error('provider down');
      }
      return { summaries: [{ index: 1, summary: 'recovered' }] };
    });
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([
      { path: 'a.js', body: SIMPLE_HUNK_BODY },
      { path: 'b.js', body: SIMPLE_HUNK_BODY }
    ]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.filesProcessed).toBe(2);
    expect(result.hunksPersisted).toBe(1);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    const summaries = allRows.filter((r) => r.summary_text);
    expect(summaries[0].file_path).toBe('b.js');
  });

  it('broadcasts even when summaries field is not an array (no sentinel; retries on reload)', async () => {
    const provider = makeProvider(async () => ({ summaries: 'oops' }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);

    await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(deps.broadcastReviewEvent).toHaveBeenCalledTimes(1);
    // Envelope malformed -> no rows persisted, hunk eligible for retry
    const allRows = await repo.real.getByReview(REVIEW_ID);
    expect(allRows).toEqual([]);
  });

  it('drops out-of-range indexes and persists valid ones (others become malformed sentinels)', async () => {
    const NON_TRIVIAL_BODY = SIMPLE_HUNK_BODY + SECOND_HUNK_BODY;
    const provider = makeProvider(async () => ({
      summaries: [
        { index: 1, summary: 'one' },
        { index: 5, summary: 'out-of-range' },
        { index: 0, summary: 'also-out' },
        { index: 2 },
        { index: 2, summary: 'two' }
      ]
    }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: NON_TRIVIAL_BODY }]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    // Both slots resolve to valid summaries (the duplicate index 2 with a real
    // string wins over the empty entry).
    expect(result.hunksPersisted).toBe(2);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    const llmRows = allRows.filter((r) => r.summary_text);
    expect(llmRows.map((r) => r.summary_text).sort()).toEqual(['one', 'two']);
  });

  it('stores long summaries verbatim without truncation', async () => {
    const longText = 'A'.repeat(500);
    const provider = makeProvider(async () => ({
      summaries: [{ index: 1, summary: longText }]
    }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);

    await generateSummariesForReview({ ...baseParams, diffText, _deps: deps });

    const allRows = await repo.real.getByReview(REVIEW_ID);
    const row = allRows.find((r) => r.summary_text);
    expect(row.summary_text).toHaveLength(500);
    expect(row.summary_text).toBe(longText);
  });

  it('persists model_skipped sentinel when model returns explicit null summary', async () => {
    const provider = makeProvider(async () => ({
      summaries: [{ index: 1, summary: null }]
    }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.hunksPersisted).toBe(1);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    expect(allRows).toHaveLength(1);
    expect(allRows[0].file_path).toBe('a.js');
    expect(allRows[0].summary_text).toBeNull();
    expect(allRows[0].trivial_reason).toBe('model_skipped');
    expect(allRows[0].provider).toBe('fake');
    expect(allRows[0].model).toBe('fast-model');
  });

  it('persists model_malformed sentinels for every hunk when summaries[] is empty', async () => {
    const NON_TRIVIAL_BODY = SIMPLE_HUNK_BODY + SECOND_HUNK_BODY;
    const provider = makeProvider(async () => ({ summaries: [] }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: NON_TRIVIAL_BODY }]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.hunksPersisted).toBe(2);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    expect(allRows).toHaveLength(2);
    for (const row of allRows) {
      expect(row.summary_text).toBeNull();
      expect(row.trivial_reason).toBe('model_malformed');
      expect(row.provider).toBe('fake');
      expect(row.model).toBe('fast-model');
    }
  });

  it('persists nothing when extractJSON fails on raw response (no sentinel; retries on reload)', async () => {
    const NON_TRIVIAL_BODY = SIMPLE_HUNK_BODY + SECOND_HUNK_BODY;
    const provider = makeProvider(async () => ({ raw: 'not json at all', parsed: false }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: NON_TRIVIAL_BODY }]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.hunksPersisted).toBe(0);
    expect(deps.extractJSON).toHaveBeenCalledTimes(1);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    expect(allRows).toEqual([]);
    // Frontend still gets a broadcast so it doesn't hang waiting for this file.
    expect(deps.broadcastReviewEvent).toHaveBeenCalledTimes(1);
  });

  it('persists nothing when summaries field is not an array (no sentinel; retries on reload)', async () => {
    const provider = makeProvider(async () => ({ summaries: 'oops' }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.hunksPersisted).toBe(0);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    expect(allRows).toEqual([]);
    // Frontend still gets a broadcast so it doesn't hang waiting for this file.
    expect(deps.broadcastReviewEvent).toHaveBeenCalledTimes(1);
  });

  it('mixes real summaries with model_malformed sentinels for missing/wrong-shape entries', async () => {
    const NON_TRIVIAL_BODY = SIMPLE_HUNK_BODY + SECOND_HUNK_BODY;
    const provider = makeProvider(async () => ({
      summaries: [
        { index: 1, summary: 'real summary' }
        // index 2 deliberately missing
      ]
    }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'a.js', body: NON_TRIVIAL_BODY }]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.hunksPersisted).toBe(2);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    expect(allRows).toHaveLength(2);
    const real = allRows.find((r) => r.summary_text === 'real summary');
    expect(real).toBeDefined();
    expect(real.trivial_reason).toBeNull();
    const sentinel = allRows.find((r) => r.summary_text === null);
    expect(sentinel).toBeDefined();
    expect(sentinel.trivial_reason).toBe('model_malformed');
  });

  it('returns zeros and logs when provider creation throws', async () => {
    const { deps, providerInstance } = makeDeps({ repo });
    deps.createProvider = vi.fn(() => {
      throw new Error('no such provider');
    });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result).toEqual({ filesProcessed: 0, hunksPersisted: 0 });
    expect(providerInstance.execute).not.toHaveBeenCalled();
    expect(deps.broadcastReviewEvent).not.toHaveBeenCalled();
  });

  it('treats generated files as trivial without calling LLM', async () => {
    const provider = makeProvider(async () => ({
      summaries: [{ index: 1, summary: 'should-not-be-used' }]
    }));
    const { deps, providerInstance } = makeDeps({
      repo,
      provider,
      isGenerated: (filePath) => filePath === 'gen.js'
    });
    const diffText = makeDiff([
      { path: 'gen.js', body: SIMPLE_HUNK_BODY },
      { path: 'real.js', body: SIMPLE_HUNK_BODY }
    ]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.filesProcessed).toBe(2);
    expect(providerInstance.execute).toHaveBeenCalledTimes(1);
    const allRows = await repo.real.getByReview(REVIEW_ID);
    const genRow = allRows.find((r) => r.file_path === 'gen.js');
    expect(genRow.trivial_reason).toBe('generated');
    expect(genRow.summary_text).toBeNull();
    const realRow = allRows.find((r) => r.file_path === 'real.js');
    expect(realRow.summary_text).toBe('should-not-be-used');
  });

  it('broadcasts envelope containing all summaries for the file', async () => {
    const { hashHunk } = require('../../src/ai/hunk-hashing');
    const { parseUnifiedDiffHunks } = require('../../src/utils/diff-hunks');
    const NON_TRIVIAL_BODY = SIMPLE_HUNK_BODY + SECOND_HUNK_BODY;
    const diffText = makeDiff([{ path: 'a.js', body: NON_TRIVIAL_BODY }]);
    const hunks = parseUnifiedDiffHunks(diffText).get('a.js');
    const hash1 = hashHunk('a.js', [hunks[0].header, ...hunks[0].lines].join('\n'));

    await repo.real.upsertMany([
      {
        review_id: REVIEW_ID,
        file_path: 'a.js',
        content_hash: hash1,
        summary_text: 'pre-existing',
        trivial_reason: null,
        provider: 'p',
        model: 'm'
      }
    ]);

    const provider = makeProvider(async () => ({
      summaries: [{ index: 1, summary: 'new-one' }]
    }));
    const { deps } = makeDeps({ repo, provider });

    await generateSummariesForReview({ ...baseParams, diffText, _deps: deps });

    expect(deps.broadcastReviewEvent).toHaveBeenCalledTimes(1);
    const [reviewIdArg, payload] = deps.broadcastReviewEvent.mock.calls[0];
    expect(reviewIdArg).toBe(REVIEW_ID);
    expect(payload.type).toBe('review:hunk_summaries_ready');
    expect(payload.filePath).toBe('a.js');
    expect(payload.summaries).toHaveLength(2);
    const texts = payload.summaries.map((s) => s.summary_text).sort();
    expect(texts).toEqual(['new-one', 'pre-existing']);
    for (const s of payload.summaries) {
      expect(s).toHaveProperty('file_path');
      expect(s).toHaveProperty('content_hash');
      expect(s).toHaveProperty('summary_text');
      expect(s).toHaveProperty('trivial_reason');
    }
  });

  it('outer-catch broadcasts and counts the file when getByHashes throws', async () => {
    const provider = makeProvider(async () => ({ summaries: [] }));
    const { deps } = makeDeps({ repo, provider });
    repo.getByHashes.mockImplementationOnce(() => {
      throw new Error('hash classification kaboom');
    });
    const diffText = makeDiff([{ path: 'a.js', body: SIMPLE_HUNK_BODY }]);

    const result = await generateSummariesForReview({
      ...baseParams,
      diffText,
      _deps: deps
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.hunksPersisted).toBe(0);
    expect(deps.broadcastReviewEvent).toHaveBeenCalledTimes(1);
    expect(deps.broadcastReviewEvent.mock.calls[0][1].filePath).toBe('a.js');
  });

  it('auto-derives changedFiles from hunksByFile keys when caller omits it', async () => {
    const provider = makeProvider(async () => ({ summaries: [] }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([
      { path: 'src/a.js', body: SIMPLE_HUNK_BODY },
      { path: 'src/b.js', body: SIMPLE_HUNK_BODY }
    ]);

    await generateSummariesForReview({
      ...baseParams,
      reviewContext: undefined,
      diffText,
      _deps: deps
    });

    expect(deps.buildHunkSummaryPrompt).toHaveBeenCalled();
    const firstCallArg = deps.buildHunkSummaryPrompt.mock.calls[0][0];
    expect(firstCallArg.changedFiles).toEqual(['src/a.js', 'src/b.js']);
  });

  it('preserves caller-supplied changedFiles unchanged', async () => {
    const provider = makeProvider(async () => ({ summaries: [] }));
    const { deps } = makeDeps({ repo, provider });
    const diffText = makeDiff([{ path: 'src/a.js', body: SIMPLE_HUNK_BODY }]);
    const callerChangedFiles = ['custom-1.js', 'custom-2.js', 'custom-3.js'];

    await generateSummariesForReview({
      ...baseParams,
      reviewContext: { changedFiles: callerChangedFiles },
      diffText,
      _deps: deps
    });

    const firstCallArg = deps.buildHunkSummaryPrompt.mock.calls[0][0];
    expect(firstCallArg.changedFiles).toEqual(callerChangedFiles);
  });
});

describe('kickOffSummaryJob', () => {
  it('returns null and skips queue when summaries.enabled is false', () => {
    const enqueue = vi.fn();
    const result = kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: false } },
      reviewId: 1,
      diffText: 'diff',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue } }
    });
    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns null and skips queue when reviewId is missing', () => {
    const enqueue = vi.fn();
    const result = kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true } },
      reviewId: null,
      diffText: 'diff',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue } }
    });
    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns null and skips queue when diffText is missing', () => {
    const enqueue = vi.fn();
    const result = kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true } },
      reviewId: 1,
      diffText: '',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue } }
    });
    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns null and skips queue when worktreePath is missing', () => {
    const enqueue = vi.fn();
    const result = kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true } },
      reviewId: 1,
      diffText: 'diff',
      worktreePath: '',
      _deps: { backgroundQueue: { enqueue } }
    });
    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues with reviewId and a digest-keyed type, returning the queue promise', async () => {
    const enqueue = vi.fn((_id, _type, fn) => Promise.resolve({ called: fn }));
    const result = kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true, max_files: 50 } },
      reviewId: 7,
      diffText: 'some-diff-text',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue }, hashDiff: () => 'deadbeef' }
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toBe(7);
    expect(enqueue.mock.calls[0][1]).toBe('summaries:deadbeef');
    expect(typeof enqueue.mock.calls[0][2]).toBe('function');
    const awaited = await result;
    expect(awaited).toEqual({ called: enqueue.mock.calls[0][2] });
  });

  it('different diffText yields different queue keys', () => {
    const enqueue = vi.fn();
    const realCryptoHash = (text) => {
      const crypto = require('crypto');
      return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    };
    kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true } },
      reviewId: 1,
      diffText: 'AAA',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue }, hashDiff: realCryptoHash }
    });
    kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true } },
      reviewId: 1,
      diffText: 'BBB',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue }, hashDiff: realCryptoHash }
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    const key1 = enqueue.mock.calls[0][1];
    const key2 = enqueue.mock.calls[1][1];
    expect(key1).not.toBe(key2);
    expect(key1.startsWith('summaries:')).toBe(true);
    expect(key2.startsWith('summaries:')).toBe(true);
  });

  it('same diffText yields the same queue key (idempotent re-trigger)', () => {
    const enqueue = vi.fn();
    const realCryptoHash = (text) => {
      const crypto = require('crypto');
      return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    };
    kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true } },
      reviewId: 1,
      diffText: 'SAME',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue }, hashDiff: realCryptoHash }
    });
    kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true } },
      reviewId: 1,
      diffText: 'SAME',
      worktreePath: '/wt',
      _deps: { backgroundQueue: { enqueue }, hashDiff: realCryptoHash }
    });
    expect(enqueue.mock.calls[0][1]).toBe(enqueue.mock.calls[1][1]);
  });

  describe('smart-cancel on diff change', () => {
    function makeQueueMock() {
      return {
        enqueue: vi.fn(() => Promise.resolve()),
        findActiveJobType: vi.fn(() => null),
        cancel: vi.fn(() => ({ cancelled: 0 }))
      };
    }

    it('happy path: no in-flight job → enqueue called, cancel NOT called', () => {
      const queue = makeQueueMock();
      kickOffSummaryJob({
        db: {},
        config: { summaries: { enabled: true } },
        reviewId: 1,
        diffText: 'DIFF-A',
        worktreePath: '/wt',
        _deps: { backgroundQueue: queue, hashDiff: () => 'digestA' }
      });
      expect(queue.findActiveJobType).toHaveBeenCalledWith(1, 'summaries');
      expect(queue.cancel).not.toHaveBeenCalled();
      expect(queue.enqueue).toHaveBeenCalledWith(1, 'summaries:digestA', expect.any(Function));
    });

    it('same-digest in flight: cancel NOT called (enqueue dedup handles it)', () => {
      const queue = makeQueueMock();
      // First call enqueues; record the digest.
      kickOffSummaryJob({
        db: {},
        config: { summaries: { enabled: true } },
        reviewId: 1,
        diffText: 'DIFF-A',
        worktreePath: '/wt',
        _deps: { backgroundQueue: queue, hashDiff: () => 'digestA' }
      });
      // Now pretend findActiveJobType reports the same digest is still in flight.
      queue.findActiveJobType.mockReturnValue('summaries:digestA');
      queue.cancel.mockClear();
      queue.enqueue.mockClear();
      kickOffSummaryJob({
        db: {},
        config: { summaries: { enabled: true } },
        reviewId: 1,
        diffText: 'DIFF-A',
        worktreePath: '/wt',
        _deps: { backgroundQueue: queue, hashDiff: () => 'digestA' }
      });
      expect(queue.cancel).not.toHaveBeenCalled();
      // Second enqueue is still invoked — dedup happens inside the queue,
      // not the kickoff. This matches the contract of BackgroundQueue.enqueue.
      expect(queue.enqueue).toHaveBeenCalledWith(1, 'summaries:digestA', expect.any(Function));
    });

    it('different-digest in flight: cancel the stale digest, then enqueue the new one', () => {
      const queue = makeQueueMock();
      // Pretend the previous (stale) digest is still in flight.
      queue.findActiveJobType.mockReturnValue('summaries:digestOLD');
      kickOffSummaryJob({
        db: {},
        config: { summaries: { enabled: true } },
        reviewId: 1,
        diffText: 'DIFF-B',
        worktreePath: '/wt',
        _deps: { backgroundQueue: queue, hashDiff: () => 'digestNEW' }
      });
      expect(queue.cancel).toHaveBeenCalledTimes(1);
      expect(queue.cancel).toHaveBeenCalledWith(1, 'summaries:digestOLD');
      expect(queue.enqueue).toHaveBeenCalledWith(1, 'summaries:digestNEW', expect.any(Function));
    });

    it('cancel happens BEFORE enqueue (call order matters for queue invariants)', () => {
      const queue = makeQueueMock();
      queue.findActiveJobType.mockReturnValue('summaries:digestOLD');
      const order = [];
      queue.cancel.mockImplementation(() => { order.push('cancel'); return { cancelled: 1 }; });
      queue.enqueue.mockImplementation(() => { order.push('enqueue'); return Promise.resolve(); });
      kickOffSummaryJob({
        db: {},
        config: { summaries: { enabled: true } },
        reviewId: 1,
        diffText: 'DIFF-B',
        worktreePath: '/wt',
        _deps: { backgroundQueue: queue, hashDiff: () => 'digestNEW' }
      });
      expect(order).toEqual(['cancel', 'enqueue']);
    });
  });

  it('thunk invokes generateSummariesForReview with provided params', async () => {
    let captured;
    const enqueue = vi.fn((_id, _type, fn) => {
      captured = fn;
      return null;
    });
    function HunkSummaryRepositoryStub() {
      return {
        getByHashes: vi.fn(async () => []),
        getByReview: vi.fn(async () => []),
        getByReviewAndFile: vi.fn(async () => []),
        upsertMany: vi.fn(async () => 0)
      };
    }
    const broadcastReviewEvent = vi.fn();
    const getGeneratedFilePatterns = vi.fn(async () => ({ isGenerated: () => false }));
    const createProvider = vi.fn(() => ({
      execute: vi.fn(async () => ({ summaries: [] })),
      constructor: { getModels: () => [] }
    }));

    await kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true, max_files: 50 } },
      reviewId: 9,
      diffText: '   ',
      worktreePath: '/wt',
      _deps: {
        backgroundQueue: { enqueue },
        HunkSummaryRepository: HunkSummaryRepositoryStub,
        broadcastReviewEvent,
        getGeneratedFilePatterns,
        createProvider,
        getSummaryProvider: () => 'fake',
        getSummaryModel: () => 'fast-model',
        resolveNonExecutableProviderId: () => 'fake',
        buildHunkSummaryPrompt: () => 'PROMPT',
        extractJSON: () => ({ success: false })
      }
    });

    const inner = await captured();
    expect(inner).toEqual({ filesProcessed: 0, hunksPersisted: 0 });
  });
});

describe('auto_generate gate ordering', () => {
  function makeQueueMock() {
    return {
      enqueue: vi.fn(() => Promise.resolve()),
      findActiveJobType: vi.fn(() => null),
      cancel: vi.fn(() => ({ cancelled: 0 }))
    };
  }

  it('auto trigger + auto_generate off → returns null, enqueue NOT called', () => {
    const queue = makeQueueMock();
    const result = kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true, auto_generate: false } },
      reviewId: 1,
      diffText: 'some-diff',
      worktreePath: '/wt',
      // trigger defaults to 'auto'
      _deps: { backgroundQueue: queue, hashDiff: () => 'digest1' }
    });
    expect(result).toBeNull();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('manual trigger + auto_generate off → enqueue IS called', () => {
    const queue = makeQueueMock();
    const result = kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true, auto_generate: false } },
      reviewId: 1,
      diffText: 'some-diff',
      worktreePath: '/wt',
      trigger: 'manual',
      _deps: { backgroundQueue: queue, hashDiff: () => 'digest1' }
    });
    expect(result).not.toBeNull();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('auto trigger + auto_generate true → enqueue IS called', () => {
    const queue = makeQueueMock();
    const result = kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true, auto_generate: true } },
      reviewId: 1,
      diffText: 'some-diff',
      worktreePath: '/wt',
      // trigger defaults to 'auto'
      _deps: { backgroundQueue: queue, hashDiff: () => 'digest1' }
    });
    expect(result).not.toBeNull();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('regression: stale job IS cancelled even when auto_generate off + auto trigger', () => {
    const queue = makeQueueMock();
    // Pretend a stale job with the OLD hash is in flight.
    queue.findActiveJobType.mockReturnValue('summaries:OLDHASH');

    const result = kickOffSummaryJob({
      db: {},
      config: { summaries: { enabled: true, auto_generate: false } },
      reviewId: 1,
      diffText: 'new-diff',
      worktreePath: '/wt',
      // trigger defaults to 'auto'
      _deps: { backgroundQueue: queue, hashDiff: () => 'NEWHASH' }
    });

    // Gate fires AFTER cancel: job is cancelled but nothing is enqueued.
    expect(queue.cancel).toHaveBeenCalledTimes(1);
    expect(queue.cancel).toHaveBeenCalledWith(1, 'summaries:OLDHASH');
    expect(result).toBeNull();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
