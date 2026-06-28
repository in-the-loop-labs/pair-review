// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for buildHeadlessJson() in src/main.js.
 *
 * buildHeadlessJson assembles the machine-readable headless document from a
 * completed analysis_run plus its CONSOLIDATED final suggestions (the
 * orchestrated layer the app shows by default: source='ai', ai_level IS NULL,
 * non-raw, status active/adopted). These tests seed a temp DB directly and
 * assert the exact JSON shape:
 *   - only consolidated finals for the run appear in `suggestions`
 *   - per-level rows, raw rows, dismissed finals, and other runs' rows are excluded
 *   - `count` matches `suggestions.length`
 *   - `run.level_outcomes` / `run.levels_config` are JSON-parsed objects
 *   - per-suggestion `reasoning` is JSON-parsed
 *   - `mode` passes through unchanged ('pr' and 'local')
 *   - the (potentially large) `diff` column is NOT included
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';

const { buildHeadlessJson, buildHeadlessErrorJson } = require('../../src/main.js');

const RUN_ID = 'run-under-test';
const OTHER_RUN_ID = 'some-other-run';

/** Seed a completed analysis_run row with JSON-string level fields + a diff. */
function seedRun(db, { id, reviewId, configType = 'single', overrides = {} }) {
  const cols = {
    id,
    review_id: reviewId,
    provider: 'claude',
    model: 'opus',
    tier: 'balanced',
    config_type: configType,
    status: 'completed',
    summary: 'Found a few things.',
    total_suggestions: 2,
    files_analyzed: 2,
    head_sha: 'deadbeef',
    global_instructions: null,
    repo_instructions: null,
    request_instructions: 'be terse',
    // Seeded as JSON strings — buildHeadlessJson must PARSE these to objects.
    levels_config: JSON.stringify({ 1: true, 2: true, 3: false }),
    level_outcomes: JSON.stringify({ 1: { status: 'ok' }, 2: { status: 'ok' } }),
    // diff must NOT surface in the output document.
    diff: 'diff --git a/secret.js b/secret.js\n+leak',
    ...overrides
  };
  db.prepare(`
    INSERT INTO analysis_runs
      (id, review_id, provider, model, tier, config_type, status, summary,
       total_suggestions, files_analyzed, head_sha,
       global_instructions, repo_instructions, request_instructions,
       levels_config, level_outcomes, diff)
    VALUES
      (@id, @review_id, @provider, @model, @tier, @config_type, @status, @summary,
       @total_suggestions, @files_analyzed, @head_sha,
       @global_instructions, @repo_instructions, @request_instructions,
       @levels_config, @level_outcomes, @diff)
  `).run(cols);
}

/** Insert a comment row, defaulting to a consolidated AI final for RUN_ID. */
function seedComment(db, reviewId, overrides = {}) {
  const cols = {
    review_id: reviewId,
    source: 'ai',
    ai_run_id: RUN_ID,
    ai_level: null,        // consolidated final
    ai_confidence: 0.9,
    file: 'src/index.js',
    line_start: 10,
    line_end: 12,
    type: 'bug',
    title: 'Null check missing',
    body: 'This could throw.',
    reasoning: null,
    status: 'active',
    is_file_level: 0,
    is_raw: 0,
    severity: 'high',
    ...overrides
  };
  db.prepare(`
    INSERT INTO comments
      (review_id, source, ai_run_id, ai_level, ai_confidence, file,
       line_start, line_end, type, title, body, reasoning, status,
       is_file_level, is_raw, severity)
    VALUES
      (@review_id, @source, @ai_run_id, @ai_level, @ai_confidence, @file,
       @line_start, @line_end, @type, @title, @body, @reasoning, @status,
       @is_file_level, @is_raw, @severity)
  `).run(cols);
}

describe('buildHeadlessJson', () => {
  let db;
  let reviewId;
  let otherReviewId;

  beforeEach(() => {
    db = createTestDatabase();
    reviewId = seedTestReview(db, { prNumber: 1, repository: 'owner/repo' });
    otherReviewId = seedTestReview(db, { prNumber: 2, repository: 'owner/repo' });

    seedRun(db, { id: RUN_ID, reviewId });
    seedRun(db, { id: OTHER_RUN_ID, reviewId: otherReviewId });

    // Two consolidated finals for RUN_ID — these are the ONLY rows that should
    // appear in the JSON suggestions.
    seedComment(db, reviewId, {
      file: 'src/a.js', line_start: 5, line_end: 5,
      reasoning: JSON.stringify({ summary: 'reason a', confidence: 'high' })
    });
    seedComment(db, reviewId, {
      file: 'src/b.js', line_start: 20, line_end: 24, type: 'improvement',
      title: 'Simplify', reasoning: null
    });

    // Noise that MUST be excluded by getFinalSuggestionsByRunId:
    // (1) a per-level row (ai_level = 1)
    seedComment(db, reviewId, { file: 'src/c.js', ai_level: 1, title: 'per-level' });
    // (2) a raw row (is_raw = 1)
    seedComment(db, reviewId, { file: 'src/d.js', is_raw: 1, title: 'raw voice' });
    // (3) a dismissed consolidated final
    seedComment(db, reviewId, { file: 'src/e.js', status: 'dismissed', title: 'dismissed' });
    // (4) a consolidated final belonging to a DIFFERENT run
    seedComment(db, otherReviewId, { ai_run_id: OTHER_RUN_ID, file: 'src/f.js', title: 'other run' });
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  it('marks the success envelope with ok: true', async () => {
    const doc = await buildHeadlessJson(db, RUN_ID, 'pr');
    expect(doc.ok).toBe(true);
  });

  it('returns ONLY the consolidated finals for the run, with a matching count', async () => {
    const doc = await buildHeadlessJson(db, RUN_ID, 'pr');

    expect(doc.count).toBe(2);
    expect(doc.suggestions).toHaveLength(2);

    const titles = doc.suggestions.map(s => s.title).sort();
    expect(titles).toEqual(['Null check missing', 'Simplify']);

    // None of the excluded categories leak in.
    const files = doc.suggestions.map(s => s.file);
    expect(files).not.toContain('src/c.js'); // per-level
    expect(files).not.toContain('src/d.js'); // raw
    expect(files).not.toContain('src/e.js'); // dismissed
    expect(files).not.toContain('src/f.js'); // other run

    // Ordering is ORDER BY file, line_start.
    expect(doc.suggestions.map(s => s.file)).toEqual(['src/a.js', 'src/b.js']);
  });

  it('parses run.level_outcomes and run.levels_config to objects', async () => {
    const doc = await buildHeadlessJson(db, RUN_ID, 'pr');

    expect(doc.run).toBeTruthy();
    expect(doc.run.id).toBe(RUN_ID);
    expect(doc.run.levels_config).toEqual({ 1: true, 2: true, 3: false });
    expect(doc.run.level_outcomes).toEqual({ 1: { status: 'ok' }, 2: { status: 'ok' } });
    // They are real objects, not the raw JSON strings.
    expect(typeof doc.run.levels_config).toBe('object');
    expect(typeof doc.run.level_outcomes).toBe('object');
  });

  it('parses per-suggestion reasoning to an object (and leaves null as null)', async () => {
    const doc = await buildHeadlessJson(db, RUN_ID, 'pr');

    const withReasoning = doc.suggestions.find(s => s.file === 'src/a.js');
    expect(withReasoning.reasoning).toEqual({ summary: 'reason a', confidence: 'high' });

    const withoutReasoning = doc.suggestions.find(s => s.file === 'src/b.js');
    expect(withoutReasoning.reasoning).toBeNull();
  });

  it('passes mode through unchanged for pr mode', async () => {
    const doc = await buildHeadlessJson(db, RUN_ID, 'pr');
    expect(doc.mode).toBe('pr');
  });

  it('passes mode through unchanged for local mode', async () => {
    const doc = await buildHeadlessJson(db, RUN_ID, 'local');
    expect(doc.mode).toBe('local');
  });

  it('does NOT include the diff column anywhere in the document', async () => {
    const doc = await buildHeadlessJson(db, RUN_ID, 'pr');

    expect(doc.run).not.toHaveProperty('diff');
    // Belt-and-suspenders: the seeded diff text must not appear anywhere.
    expect(JSON.stringify(doc)).not.toContain('diff --git');
  });

  it('preserves the rich suggestion columns consumed downstream', async () => {
    const doc = await buildHeadlessJson(db, RUN_ID, 'pr');
    const s = doc.suggestions.find(x => x.file === 'src/a.js');

    // Column parity with getFinalSuggestionsByRunId's SELECT list.
    expect(s).toMatchObject({
      ai_run_id: RUN_ID,
      ai_level: null,
      file: 'src/a.js',
      line_start: 5,
      line_end: 5,
      type: 'bug',
      title: 'Null check missing',
      body: 'This could throw.',
      status: 'active',
      is_file_level: 0,
      severity: 'high'
    });
    expect(s).toHaveProperty('ai_confidence');
    expect(s).toHaveProperty('created_at');
  });

  it('returns an empty suggestions array and count 0 for a run with no finals', async () => {
    // A fresh run with no comments at all.
    const emptyRunId = 'empty-run';
    seedRun(db, { id: emptyRunId, reviewId, overrides: { total_suggestions: 0, files_analyzed: 0 } });

    const doc = await buildHeadlessJson(db, emptyRunId, 'local');
    expect(doc.suggestions).toEqual([]);
    expect(doc.count).toBe(0);
    expect(doc.run.id).toBe(emptyRunId);
  });

  it('returns run=null for an unknown run id (no throw)', async () => {
    const doc = await buildHeadlessJson(db, 'no-such-run', 'pr');
    expect(doc.run).toBeNull();
    expect(doc.suggestions).toEqual([]);
    expect(doc.count).toBe(0);
    expect(doc.mode).toBe('pr');
  });
});

describe('buildHeadlessErrorJson', () => {
  it('builds the failure envelope with ok:false, mode, and the error message', () => {
    const doc = buildHeadlessErrorJson({ mode: 'local', error: new Error('boom') });
    expect(doc).toEqual({ ok: false, mode: 'local', error: { message: 'boom' } });
  });

  it('passes the mode through unchanged', () => {
    const doc = buildHeadlessErrorJson({ mode: 'pr', error: new Error('nope') });
    expect(doc.mode).toBe('pr');
  });

  it('falls back to String(error) when there is no message', () => {
    const doc = buildHeadlessErrorJson({ mode: 'pr', error: 'plain string failure' });
    expect(doc.ok).toBe(false);
    expect(doc.error.message).toBe('plain string failure');
  });
});
