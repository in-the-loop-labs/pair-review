// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for generateDiffForExecutable in executable-analysis.js
 *
 * Note: child_process.exec and fs.promises are captured at module load time
 * via promisify(exec) and require('fs').promises. vi.mock does not intercept
 * CJS requires for Node built-in modules in vitest's forks pool mode, so we
 * use vi.spyOn on the actual module objects and then require the source module.
 * Since execPromise = promisify(exec) is bound at load time, we spy on exec
 * before requiring the module under test.
 */

vi.mock('../../src/utils/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(),
  debug: vi.fn(), streamDebug: vi.fn(), section: vi.fn(),
  log: vi.fn(),
  isStreamDebugEnabled: () => false
}));

vi.mock('../../src/ai/provider', () => ({
  createProvider: vi.fn()
}));
vi.mock('../../src/database', () => ({
  AnalysisRunRepository: vi.fn(() => ({ create: vi.fn().mockResolvedValue({}) })),
  CommentRepository: vi.fn(() => ({ batchInsert: vi.fn() }))
}));
vi.mock('../../src/hooks/hook-runner', () => ({
  fireHooks: vi.fn(),
  hasHooks: vi.fn(() => false)
}));
vi.mock('../../src/hooks/payloads', () => ({
  buildAnalysisStartedPayload: vi.fn(),
  buildAnalysisCompletedPayload: vi.fn(),
  getCachedUser: vi.fn()
}));
vi.mock('../../src/utils/paths', () => ({
  normalizePath: vi.fn(p => p),
  resolveRenamedFile: vi.fn(p => p)
}));
vi.mock('../../src/utils/line-validation', () => ({
  buildFileLineCountMap: vi.fn(),
  validateSuggestionLineNumbers: vi.fn(() => ({ valid: [], converted: [] }))
}));

// For Node built-in modules and CJS requires, vi.mock does not intercept in
// vitest's forks pool mode. Use vi.spyOn on the actual module objects instead.
// These spies must be in place BEFORE requiring the source module, because
// execPromise = promisify(exec) is bound at load time.
const childProcess = require('child_process');
const mockExec = vi.spyOn(childProcess, 'exec');

const fsModule = require('fs');
const mockWriteFile = vi.spyOn(fsModule.promises, 'writeFile');

// Spy on local-review's generateScopedDiff and findMergeBase (also CJS requires in the source)
const localReviewModule = require('../../src/local-review');
const mockGenerateScopedDiff = vi.spyOn(localReviewModule, 'generateScopedDiff');
const mockFindMergeBase = vi.spyOn(localReviewModule, 'findMergeBase');

// Spy on provider and database modules (CJS requires need vi.spyOn, not vi.mock)
const providerModule = require('../../src/ai/provider');
const mockCreateProvider = vi.spyOn(providerModule, 'createProvider');

const databaseModule = require('../../src/database');
const mockAnalysisRunRepoCreate = vi.fn().mockResolvedValue({});
vi.spyOn(databaseModule, 'AnalysisRunRepository').mockImplementation(function () {
  this.create = mockAnalysisRunRepoCreate;
});
vi.spyOn(databaseModule, 'CommentRepository').mockImplementation(function () {
  this.batchInsert = vi.fn();
});

// Import source module after all spies are set up
const { generateDiffForExecutable, getChangedFiles, runExecutableAnalysis } = require('../../src/routes/executable-analysis');

describe('generateDiffForExecutable', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockWriteFile.mockReset();
    mockGenerateScopedDiff.mockReset();
    mockFindMergeBase.mockReset();
    mockWriteFile.mockResolvedValue(undefined);
  });

  // Helper: make mockExec behave like exec with callback(null, { stdout, stderr })
  function mockExecSuccess(stdout) {
    mockExec.mockImplementation((cmd, opts, cb) => {
      // exec(cmd, opts, cb) or exec(cmd, cb)
      const callback = typeof opts === 'function' ? opts : cb;
      process.nextTick(() => callback(null, { stdout, stderr: '' }));
    });
  }

  // ── PR mode ────────────────────────────────────────────────────

  describe('PR mode (baseSha + headSha)', () => {
    it('runs git diff with baseSha...headSha and GIT_DIFF_FLAGS', async () => {
      mockExecSuccess('diff --git a/file.js b/file.js\n');

      await generateDiffForExecutable(
        '/repo',
        { baseSha: 'abc123', headSha: 'def456' },
        [],
        '/tmp/review.diff'
      );

      const cmd = mockExec.mock.calls[0][0];
      expect(cmd).toContain('git diff');
      expect(cmd).toContain('--no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ --no-relative --full-index');
      expect(cmd).toContain('abc123...def456');
    });

    it('appends diffArgs to the git diff command', async () => {
      mockExecSuccess('diff output');

      await generateDiffForExecutable(
        '/repo',
        { baseSha: 'abc', headSha: 'def' },
        ['--ignore-all-space', '-M'],
        '/tmp/review.diff'
      );

      const cmd = mockExec.mock.calls[0][0];
      expect(cmd).toContain('--ignore-all-space -M');
      expect(cmd).toContain('abc...def');
    });

    it('writes diff content to outputPath', async () => {
      const diffContent = 'diff --git a/file.js b/file.js\n+new line\n';
      mockExecSuccess(diffContent);

      await generateDiffForExecutable(
        '/repo',
        { baseSha: 'abc', headSha: 'def' },
        [],
        '/tmp/review.diff'
      );

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/review.diff', diffContent, 'utf-8');
    });

    it('returns the diff content', async () => {
      const diffContent = 'some diff';
      mockExecSuccess(diffContent);

      const result = await generateDiffForExecutable(
        '/repo',
        { baseSha: 'abc', headSha: 'def' },
        [],
        '/tmp/review.diff'
      );

      expect(result).toBe(diffContent);
    });
  });

  // ── Local mode ─────────────────────────────────────────────────

  describe('local mode (scopeStart + scopeEnd)', () => {
    it('calls generateScopedDiff with contextLines: 3 and extraArgs from diffArgs', async () => {
      mockGenerateScopedDiff.mockResolvedValue({ diff: 'scoped diff output' });

      await generateDiffForExecutable(
        '/repo',
        { scopeStart: 'unstaged', scopeEnd: 'untracked', baseBranch: 'main' },
        ['--patience'],
        '/tmp/review.diff'
      );

      expect(mockGenerateScopedDiff).toHaveBeenCalledWith(
        '/repo',
        'unstaged',
        'untracked',
        'main',
        { contextLines: 3, extraArgs: ['--patience'] }
      );
    });

    it('uses null baseBranch when not provided in context', async () => {
      mockGenerateScopedDiff.mockResolvedValue({ diff: 'diff' });

      await generateDiffForExecutable(
        '/repo',
        { scopeStart: 'staged', scopeEnd: 'unstaged' },
        [],
        '/tmp/review.diff'
      );

      expect(mockGenerateScopedDiff).toHaveBeenCalledWith(
        '/repo',
        'staged',
        'unstaged',
        null,
        { contextLines: 3, extraArgs: [] }
      );
    });

    it('writes the scoped diff result to outputPath', async () => {
      mockGenerateScopedDiff.mockResolvedValue({ diff: 'scoped diff content' });

      await generateDiffForExecutable(
        '/repo',
        { scopeStart: 'unstaged', scopeEnd: 'untracked' },
        [],
        '/tmp/review.diff'
      );

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/review.diff', 'scoped diff content', 'utf-8');
    });
  });

  // ── Fallback mode ──────────────────────────────────────────────

  describe('fallback mode (no baseSha/headSha, no scopeStart/scopeEnd)', () => {
    it('runs plain git diff with GIT_DIFF_FLAGS', async () => {
      mockExecSuccess('fallback diff');

      await generateDiffForExecutable(
        '/repo',
        {},
        [],
        '/tmp/review.diff'
      );

      const cmd = mockExec.mock.calls[0][0];
      expect(cmd).toBe('git diff --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ --no-relative --full-index');
    });

    it('appends diffArgs to fallback git diff', async () => {
      mockExecSuccess('diff');

      await generateDiffForExecutable(
        '/repo',
        {},
        ['-w', '--stat'],
        '/tmp/review.diff'
      );

      const cmd = mockExec.mock.calls[0][0];
      expect(cmd).toContain('-w --stat');
      // Should NOT contain baseSha...headSha
      expect(cmd).not.toContain('...');
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('writes empty string when diff is empty (PR mode)', async () => {
      mockExecSuccess('');

      await generateDiffForExecutable(
        '/repo',
        { baseSha: 'abc', headSha: 'def' },
        [],
        '/tmp/review.diff'
      );

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/review.diff', '', 'utf-8');
    });

    it('writes empty string when diff is undefined (fallback mode)', async () => {
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        process.nextTick(() => callback(null, { stdout: undefined, stderr: '' }));
      });

      await generateDiffForExecutable(
        '/repo',
        {},
        [],
        '/tmp/review.diff'
      );

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/review.diff', '', 'utf-8');
    });

    it('writes empty string when scoped diff is empty (local mode)', async () => {
      mockGenerateScopedDiff.mockResolvedValue({ diff: '' });

      await generateDiffForExecutable(
        '/repo',
        { scopeStart: 'unstaged', scopeEnd: 'untracked' },
        [],
        '/tmp/review.diff'
      );

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/review.diff', '', 'utf-8');
    });
  });
});

describe('getChangedFiles', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockFindMergeBase.mockReset();
  });

  // Helper: make mockExec behave like exec with callback(null, { stdout, stderr })
  function mockExecForCalls(callMap) {
    mockExec.mockImplementation((cmd, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      for (const [pattern, stdout] of Object.entries(callMap)) {
        if (cmd.includes(pattern)) {
          process.nextTick(() => callback(null, { stdout, stderr: '' }));
          return;
        }
      }
      process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
    });
  }

  // ── PR mode ────────────────────────────────────────────────────

  describe('PR mode (baseSha + headSha)', () => {
    it('runs git diff --name-only with baseSha...headSha', async () => {
      mockExecForCalls({ '...': 'file1.js\nfile2.js\n' });

      const files = await getChangedFiles('/repo', { baseSha: 'abc', headSha: 'def' });

      expect(files).toEqual(['file1.js', 'file2.js']);
      const cmd = mockExec.mock.calls[0][0];
      expect(cmd).toContain('abc...def');
      expect(cmd).toContain('--name-only');
    });
  });

  // ── Local mode: scope-aware ────────────────────────────────────

  describe('local mode with scope', () => {
    it('includes branch files when scope includes branch', async () => {
      mockFindMergeBase.mockResolvedValue('merge-base-sha');
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd.includes('merge-base-sha..HEAD')) {
          process.nextTick(() => callback(null, { stdout: 'branch-file.js\n', stderr: '' }));
        } else if (cmd.includes('--name-only') && !cmd.includes('--cached') && !cmd.includes('..')) {
          process.nextTick(() => callback(null, { stdout: 'unstaged-file.js\n', stderr: '' }));
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
      });

      const files = await getChangedFiles('/repo', {
        scopeStart: 'branch', scopeEnd: 'unstaged', baseBranch: 'main'
      });

      expect(files).toContain('branch-file.js');
      expect(files).toContain('unstaged-file.js');
      expect(mockFindMergeBase).toHaveBeenCalledWith('/repo', 'main');
    });

    it('includes staged files when scope includes staged', async () => {
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd.includes('--cached')) {
          process.nextTick(() => callback(null, { stdout: 'staged.js\n', stderr: '' }));
        } else if (cmd.includes('--name-only') && !cmd.includes('--cached') && !cmd.includes('..')) {
          process.nextTick(() => callback(null, { stdout: 'unstaged.js\n', stderr: '' }));
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
      });

      const files = await getChangedFiles('/repo', {
        scopeStart: 'staged', scopeEnd: 'unstaged'
      });

      expect(files).toContain('staged.js');
      expect(files).toContain('unstaged.js');
    });

    it('includes unstaged files when scope includes unstaged', async () => {
      // mockExec must match unstaged diff (no --cached, no merge-base)
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd.includes('--name-only') && !cmd.includes('--cached') && !cmd.includes('..')) {
          process.nextTick(() => callback(null, { stdout: 'unstaged.js\n', stderr: '' }));
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
      });

      const files = await getChangedFiles('/repo', {
        scopeStart: 'unstaged', scopeEnd: 'unstaged'
      });

      expect(files).toEqual(['unstaged.js']);
    });

    it('includes untracked files when scope includes untracked', async () => {
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd.includes('ls-files')) {
          process.nextTick(() => callback(null, { stdout: 'untracked.js\n', stderr: '' }));
        } else if (cmd.includes('--name-only') && !cmd.includes('--cached') && !cmd.includes('..')) {
          process.nextTick(() => callback(null, { stdout: 'unstaged.js\n', stderr: '' }));
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
      });

      const files = await getChangedFiles('/repo', {
        scopeStart: 'unstaged', scopeEnd: 'untracked'
      });

      expect(files).toContain('untracked.js');
      expect(files).toContain('unstaged.js');
    });

    it('includes branch + staged + unstaged + untracked for full scope', async () => {
      mockFindMergeBase.mockResolvedValue('mb-sha');
      let callIndex = 0;
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd.includes('mb-sha..HEAD')) {
          process.nextTick(() => callback(null, { stdout: 'branch.js\n', stderr: '' }));
        } else if (cmd.includes('--cached')) {
          process.nextTick(() => callback(null, { stdout: 'staged.js\n', stderr: '' }));
        } else if (cmd.includes('ls-files')) {
          process.nextTick(() => callback(null, { stdout: 'untracked.js\n', stderr: '' }));
        } else if (cmd.includes('--name-only')) {
          process.nextTick(() => callback(null, { stdout: 'unstaged.js\n', stderr: '' }));
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
      });

      const files = await getChangedFiles('/repo', {
        scopeStart: 'branch', scopeEnd: 'untracked', baseBranch: 'main'
      });

      expect(files).toContain('branch.js');
      expect(files).toContain('staged.js');
      expect(files).toContain('unstaged.js');
      expect(files).toContain('untracked.js');
    });

    it('deduplicates files across scope stops', async () => {
      mockExecForCalls({
        '--cached': 'shared.js\n',
        'ls-files': 'shared.js\n'
      });

      // staged–untracked scope: same file in both
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd.includes('--cached')) {
          process.nextTick(() => callback(null, { stdout: 'shared.js\n', stderr: '' }));
        } else if (cmd.includes('ls-files')) {
          process.nextTick(() => callback(null, { stdout: 'shared.js\n', stderr: '' }));
        } else if (cmd.includes('--name-only')) {
          process.nextTick(() => callback(null, { stdout: 'shared.js\n', stderr: '' }));
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
      });

      const files = await getChangedFiles('/repo', {
        scopeStart: 'staged', scopeEnd: 'untracked'
      });

      // Should be deduplicated
      expect(files).toEqual(['shared.js']);
    });

    it('does NOT include untracked files when scope excludes untracked', async () => {
      mockFindMergeBase.mockResolvedValue('mb-sha');
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd.includes('mb-sha..HEAD')) {
          process.nextTick(() => callback(null, { stdout: 'branch.js\n', stderr: '' }));
        } else if (cmd.includes('--cached')) {
          process.nextTick(() => callback(null, { stdout: 'staged.js\n', stderr: '' }));
        } else if (cmd.includes('--name-only') && !cmd.includes('--cached') && !cmd.includes('..')) {
          process.nextTick(() => callback(null, { stdout: 'unstaged.js\n', stderr: '' }));
        } else {
          process.nextTick(() => callback(null, { stdout: 'should-not-appear.js\n', stderr: '' }));
        }
      });

      const files = await getChangedFiles('/repo', {
        scopeStart: 'branch', scopeEnd: 'unstaged', baseBranch: 'main'
      });

      expect(files).toContain('branch.js');
      expect(files).toContain('staged.js');
      expect(files).toContain('unstaged.js');
      expect(files).not.toContain('should-not-appear.js');
      // Should have made 3 exec calls (branch, staged, unstaged) but NOT untracked
      expect(mockExec).toHaveBeenCalledTimes(3);
    });
  });

  // ── Fallback (no scope info) ──────────────────────────────────

  describe('fallback mode (no scope fields)', () => {
    it('includes unstaged + untracked + staged when no scope info', async () => {
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (cmd.includes('--cached')) {
          process.nextTick(() => callback(null, { stdout: 'staged.js\n', stderr: '' }));
        } else if (cmd.includes('ls-files')) {
          process.nextTick(() => callback(null, { stdout: 'untracked.js\n', stderr: '' }));
        } else if (cmd.includes('--name-only')) {
          process.nextTick(() => callback(null, { stdout: 'unstaged.js\n', stderr: '' }));
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
      });

      const files = await getChangedFiles('/repo', {});

      expect(files).toContain('unstaged.js');
      expect(files).toContain('untracked.js');
      expect(files).toContain('staged.js');
    });
  });

  // ── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('returns empty array on error', async () => {
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        process.nextTick(() => callback(new Error('git failed'), null));
      });

      const files = await getChangedFiles('/repo', {});

      expect(files).toEqual([]);
    });

    it('returns empty array when findMergeBase fails for branch scope', async () => {
      mockFindMergeBase.mockRejectedValue(new Error('no merge-base'));

      const files = await getChangedFiles('/repo', {
        scopeStart: 'branch', scopeEnd: 'unstaged', baseBranch: 'main'
      });

      expect(files).toEqual([]);
    });

    it('returns empty array when branch scope has no baseBranch', async () => {
      // When hasBranch is true but baseBranch is null/undefined, the branch
      // command is skipped. Staged and unstaged commands still run but return
      // empty output, resulting in an empty list.
      mockExec.mockImplementation((cmd, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
      });

      const files = await getChangedFiles('/repo', {
        scopeStart: 'branch', scopeEnd: 'unstaged', baseBranch: null
      });

      expect(files).toEqual([]);
      // findMergeBase should NOT be called since baseBranch is null
      expect(mockFindMergeBase).not.toHaveBeenCalled();
    });
  });
});

describe('runExecutableAnalysis', () => {
  it('should pass providerOverrides to createProvider', async () => {
    // Set up createProvider to return a minimal provider that will reject
    // (we only care about the createProvider call args, not the full execution)
    const mockProvider = {
      resolvedModel: 'test-model',
      model: 'test-model',
      contextArgs: {},
      execute: vi.fn().mockRejectedValue(new Error('test abort'))
    };
    mockCreateProvider.mockReturnValue(mockProvider);

    const testOverrides = { load_skills: false };

    const mockReq = {
      app: {
        get: vi.fn((key) => {
          if (key === 'db') return {};
          if (key === 'config') return {};
          return null;
        })
      }
    };
    const mockRes = { json: vi.fn() };

    const params = {
      reviewId: 1,
      review: { id: 1 },
      selectedProvider: 'test-exec',
      selectedModel: 'test-model',
      repoInstructions: null,
      requestInstructions: null,
      runId: 'run-1',
      analysisId: 'analysis-1',
      repository: 'owner/repo',
      reviewType: 'pr',
      headSha: 'abc123',
      extraInitialStatus: {},
      providerOverrides: testOverrides
    };

    const shared = {
      activeAnalyses: new Map(),
      reviewToAnalysisId: new Map(),
      broadcastProgress: vi.fn(),
      broadcastReviewEvent: vi.fn(),
      registerProcessForCancellation: vi.fn()
    };

    const callbacks = {
      buildContext: vi.fn(() => ({ cwd: '/tmp/test' })),
      buildHookPayload: vi.fn(() => ({})),
      onSuccess: vi.fn(),
      logLabel: 'Test'
    };

    await runExecutableAnalysis(mockReq, mockRes, params, shared, callbacks);

    // The async IIFE runs after res.json(), so wait a tick for createProvider to be called
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockCreateProvider).toHaveBeenCalledWith('test-exec', 'test-model', testOverrides);
  });
});
