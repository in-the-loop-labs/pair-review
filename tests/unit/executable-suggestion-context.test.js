// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema';

// These CJS dependencies are captured at module load, so install spies first.
const childProcess = require('child_process');
const exec = vi.spyOn(childProcess, 'exec').mockImplementation((command, options, callback) => {
  callback(null, { stdout: 'changed.js\n', stderr: '' });
});
const providers = require('../../src/ai/provider');
const createProvider = vi.spyOn(providers, 'createProvider');
const { runExecutableAnalysis } = require('../../src/routes/executable-analysis');

describe.each(['pr', 'local'])('Executable suggestion context in %s mode', mode => {
  let db, root, reviewId, outputDirs;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'executable-context-'));
    fs.writeFileSync(path.join(root, 'unchanged.js'), 'code\n'.repeat(100));
    db = createTestDatabase();
    if (mode === 'pr') {
      reviewId = seedTestReview(db);
      db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
        VALUES ('worktree', 1, 'test/repo', 'feature', ?, '2026-01-01', '2026-01-01')`).run(root);
    } else {
      reviewId = Number(db.prepare(`INSERT INTO reviews (review_type, local_path, local_head_sha, status, repository)
        VALUES ('local', ?, 'head', 'draft', 'test/repo')`).run(root).lastInsertRowid);
    }
    outputDirs = [];
    createProvider.mockReturnValue({
      model: 'test',
      execute: async (prompt, options) => {
        outputDirs.push(options.executableContext.outputDir);
        return { success: true, data: { suggestions: ['unchanged.js', 'missing.js'].map(file => ({
          file, line_start: 60, line_end: 65, old_or_new: 'OLD',
          type: 'bug', title: 'Cross-file issue', description: 'The caller breaks this behavior.'
        })) } };
      }
    });
  });
  afterEach(async () => {
    try {
      // Wait for the background lifecycle's own cleanup, including on failures.
      await vi.waitFor(() => {
        for (const dir of outputDirs) expect(fs.existsSync(dir)).toBe(false);
      });
    } finally {
      closeTestDatabase(db);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores unchanged findings on RIGHT and seeds their context only once', async () => {
    const shared = {
      activeAnalyses: new Map(), reviewToAnalysisId: new Map(),
      broadcastProgress: vi.fn(), broadcastReviewEvent: vi.fn(), registerProcessForCancellation: vi.fn()
    };
    const onSuccess = vi.fn();
    for (const runId of ['first', 'second']) {
      await runExecutableAnalysis({ app: { get: key => key === 'db' ? db : {} } }, { json: vi.fn() }, {
        reviewId, review: { id: reviewId }, selectedProvider: 'test', selectedModel: 'test',
        runId, analysisId: runId, repository: 'test/repo', reviewType: mode, headSha: 'head'
      }, shared, {
        buildContext: () => ({ cwd: root }), buildHookPayload: () => ({}), onSuccess, logLabel: mode
      });
      await vi.waitFor(() => expect(shared.reviewToAnalysisId.has(reviewId)).toBe(false));
      expect(shared.activeAnalyses.get(runId).status).toBe('completed');
      expect(db.prepare('SELECT * FROM comments WHERE ai_run_id = ?').all(runId)).toMatchObject([
        { file: 'unchanged.js', side: 'RIGHT', line_start: 60, line_end: 65 }
      ]);
      expect(db.prepare('SELECT * FROM context_files').all()).toHaveLength(1);
    }
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('drops an unchanged finding beyond the actual file length without seeding context', async () => {
    createProvider.mockReturnValue({
      model: 'test',
      execute: async (prompt, options) => {
        outputDirs.push(options.executableContext.outputDir);
        return { success: true, data: { suggestions: [{
          file: 'unchanged.js', line_start: 900, line_end: 910, old_or_new: 'OLD',
          type: 'bug', title: 'Invalid range', description: 'Outside the file.'
        }] } };
      }
    });
    const shared = {
      activeAnalyses: new Map(), reviewToAnalysisId: new Map(),
      broadcastProgress: vi.fn(), broadcastReviewEvent: vi.fn(), registerProcessForCancellation: vi.fn()
    };
    await runExecutableAnalysis({ app: { get: key => key === 'db' ? db : {} } }, { json: vi.fn() }, {
      reviewId, review: { id: reviewId }, selectedProvider: 'test', selectedModel: 'test',
      runId: 'invalid', analysisId: 'invalid', repository: 'test/repo', reviewType: mode, headSha: 'head'
    }, shared, {
      buildContext: () => ({ cwd: root }), buildHookPayload: () => ({}), onSuccess: vi.fn(), logLabel: mode
    });
    await vi.waitFor(() => expect(shared.reviewToAnalysisId.has(reviewId)).toBe(false));
    expect(shared.activeAnalyses.get('invalid').status).toBe('completed');
    expect(db.prepare('SELECT file, is_file_level, line_start FROM comments').all())
      .toEqual([{ file: 'unchanged.js', is_file_level: 1, line_start: null }]);
    expect(db.prepare('SELECT file, line_start, line_end FROM context_files').all())
      .toEqual([{ file: 'unchanged.js', line_start: 1, line_end: 50 }]);
  });

  it('stores the result validated in the executable checkout without rereading a different review root', async () => {
    const otherRoot = path.join(root, 'other-checkout');
    fs.mkdirSync(otherRoot);
    fs.writeFileSync(path.join(otherRoot, 'unchanged.js'), 'short\n');
    if (mode === 'pr') db.prepare('UPDATE worktrees SET path = ?').run(otherRoot);
    else db.prepare('UPDATE reviews SET local_path = ? WHERE id = ?').run(otherRoot, reviewId);
    // Line counting opens each file (bounded binary scan) rather than readFile.
    const openFile = vi.spyOn(fs.promises, 'open');
    try {
      const shared = {
        activeAnalyses: new Map(), reviewToAnalysisId: new Map(),
        broadcastProgress: vi.fn(), broadcastReviewEvent: vi.fn(), registerProcessForCancellation: vi.fn()
      };
      await runExecutableAnalysis({ app: { get: key => key === 'db' ? db : {} } }, { json: vi.fn() }, {
        reviewId, review: { id: reviewId }, selectedProvider: 'test', selectedModel: 'test',
        runId: 'prepared', analysisId: 'prepared', repository: 'test/repo', reviewType: mode, headSha: 'head'
      }, shared, {
        buildContext: () => ({ cwd: root }), buildHookPayload: () => ({}), onSuccess: vi.fn(), logLabel: mode
      });
      await vi.waitFor(() => expect(shared.reviewToAnalysisId.has(reviewId)).toBe(false));
      expect(shared.activeAnalyses.get('prepared').status).toBe('completed');
      expect(db.prepare('SELECT * FROM comments').all()).toMatchObject([
        { file: 'unchanged.js', side: 'RIGHT', line_start: 60, line_end: 65 }
      ]);
      expect(openFile.mock.calls.filter(([file]) => file === path.join(root, 'unchanged.js'))).toHaveLength(1);
      expect(openFile.mock.calls.filter(([file]) => file === path.join(otherRoot, 'unchanged.js'))).toHaveLength(0);
    } finally {
      openFile.mockRestore();
    }
  });
});

afterEach(() => {
  exec.mockClear();
  createProvider.mockClear();
});

afterAll(() => vi.restoreAllMocks());
