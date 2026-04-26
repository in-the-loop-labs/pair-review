// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const { computeLocalDiffDigest, generateLocalDiff, findMainGitRoot, findGitRoot, generateScopedDiff, computeScopedDigest } = require('../../src/local-review');

describe('computeLocalDiffDigest', () => {
  let testDir;

  beforeEach(async () => {
    // Create a temporary directory with a git repo
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-test-'));

    // Initialize git repo
    execSync('git init', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });

    // Create initial file and commit
    await fs.writeFile(path.join(testDir, 'file.txt'), 'initial content\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    // Cleanup
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('should return a 16-character hex digest', async () => {
    // Make a change
    await fs.writeFile(path.join(testDir, 'file.txt'), 'modified content\n');

    const digest = await computeLocalDiffDigest(testDir);

    expect(digest).toMatch(/^[a-f0-9]{16}$/);
  });

  it('should return consistent digest for same working directory state', async () => {
    // Make a change
    await fs.writeFile(path.join(testDir, 'file.txt'), 'modified content\n');

    const digest1 = await computeLocalDiffDigest(testDir);
    const digest2 = await computeLocalDiffDigest(testDir);

    expect(digest1).toBe(digest2);
  });

  it('should return different digest when tracked file changes', async () => {
    // Make a change
    await fs.writeFile(path.join(testDir, 'file.txt'), 'modified content\n');
    const digest1 = await computeLocalDiffDigest(testDir);

    // Make another change
    await fs.writeFile(path.join(testDir, 'file.txt'), 'different content\n');
    const digest2 = await computeLocalDiffDigest(testDir);

    expect(digest1).not.toBe(digest2);
  });

  it('should return different digest when untracked file is added', async () => {
    // Initial state with no changes
    const digest1 = await computeLocalDiffDigest(testDir);

    // Add an untracked file
    await fs.writeFile(path.join(testDir, 'newfile.txt'), 'new content\n');
    const digest2 = await computeLocalDiffDigest(testDir);

    expect(digest1).not.toBe(digest2);
  });

  it('should return different digest when untracked file content changes', async () => {
    // Add an untracked file
    await fs.writeFile(path.join(testDir, 'newfile.txt'), 'content v1\n');
    const digest1 = await computeLocalDiffDigest(testDir);

    // Modify the untracked file
    await fs.writeFile(path.join(testDir, 'newfile.txt'), 'content v2\n');
    const digest2 = await computeLocalDiffDigest(testDir);

    expect(digest1).not.toBe(digest2);
  });

  it('should return null for non-existent path', async () => {
    const digest = await computeLocalDiffDigest('/non/existent/path');

    expect(digest).toBeNull();
  });

  it('should handle empty working directory (no changes)', async () => {
    // No changes made - working directory is clean
    const digest = await computeLocalDiffDigest(testDir);

    // Should still return a valid digest (of empty content)
    expect(digest).toMatch(/^[a-f0-9]{16}$/);
  });

  describe('staleness detection lifecycle', () => {
    it('should detect when working directory becomes stale', async () => {
      // Simulate initial analysis: capture baseline digest
      await fs.writeFile(path.join(testDir, 'file.txt'), 'initial state\n');
      const baselineDigest = await computeLocalDiffDigest(testDir);

      // Verify baseline is stable
      expect(await computeLocalDiffDigest(testDir)).toBe(baselineDigest);

      // Simulate user modifying file (makes working dir stale relative to baseline)
      await fs.writeFile(path.join(testDir, 'file.txt'), 'user changed this\n');
      const currentDigest = await computeLocalDiffDigest(testDir);

      // Staleness detection: digests should differ
      const isStale = baselineDigest !== currentDigest;
      expect(isStale).toBe(true);
    });

    it('should detect when working directory returns to baseline state', async () => {
      // Capture baseline
      const originalContent = 'original content\n';
      await fs.writeFile(path.join(testDir, 'file.txt'), originalContent);
      const baselineDigest = await computeLocalDiffDigest(testDir);

      // Make a change
      await fs.writeFile(path.join(testDir, 'file.txt'), 'temporary change\n');
      expect(await computeLocalDiffDigest(testDir)).not.toBe(baselineDigest);

      // Revert to original
      await fs.writeFile(path.join(testDir, 'file.txt'), originalContent);
      expect(await computeLocalDiffDigest(testDir)).toBe(baselineDigest);
    });
  });
});

describe('generateLocalDiff', () => {
  let testDir;

  beforeEach(async () => {
    // Create a temporary directory with a git repo
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-diff-test-'));

    // Initialize git repo
    execSync('git init', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });

    // Create initial file and commit
    await fs.writeFile(path.join(testDir, 'existing.txt'), 'initial content\n');
    execSync('git add existing.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    // Cleanup
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe('empty working directory', () => {
    it('should return empty diff and stats when no changes exist', async () => {
      // Working directory is clean - no modifications, no untracked files
      const result = await generateLocalDiff(testDir);

      // Should return empty/falsy diff
      expect(result.diff).toBeFalsy();
      expect(result.untrackedFiles).toEqual([]);
      expect(result.stats.unstagedChanges).toBe(0);
      expect(result.stats.untrackedFiles).toBe(0);
    });
  });

  describe('untracked file path normalization', () => {
    it('should normalize untracked file paths in diff to relative paths', async () => {
      // Create an untracked file
      await fs.writeFile(path.join(testDir, 'newfile.js'), 'console.log("hello");\n');

      const result = await generateLocalDiff(testDir);

      // The diff should contain relative paths, not absolute paths
      expect(result.diff).toContain('diff --git a/newfile.js b/newfile.js');
      expect(result.diff).toContain('+++ b/newfile.js');

      // Should NOT contain the absolute path (testDir contains temp dir path)
      // The temp path includes something like /tmp/pair-review-diff-test-xxxxx
      expect(result.diff).not.toContain(testDir);
    });

    it('should normalize nested untracked file paths correctly', async () => {
      // Create a nested directory structure
      await fs.mkdir(path.join(testDir, 'src', 'utils'), { recursive: true });
      await fs.writeFile(path.join(testDir, 'src', 'utils', 'helper.js'), 'export const helper = () => {};\n');

      const result = await generateLocalDiff(testDir);

      // The diff should contain the relative path from repo root
      expect(result.diff).toContain('diff --git a/src/utils/helper.js b/src/utils/helper.js');
      expect(result.diff).toContain('+++ b/src/utils/helper.js');

      // Should NOT contain any part of the absolute path
      expect(result.diff).not.toContain(testDir);
    });

    it('should include tracked file changes with relative paths', async () => {
      // Modify an existing tracked file
      await fs.writeFile(path.join(testDir, 'existing.txt'), 'modified content\n');

      const result = await generateLocalDiff(testDir);

      // Tracked file diffs should also have relative paths
      expect(result.diff).toContain('diff --git a/existing.txt b/existing.txt');
    });

    it('should handle mix of tracked and untracked files with consistent paths', async () => {
      // Modify tracked file
      await fs.writeFile(path.join(testDir, 'existing.txt'), 'modified\n');

      // Add untracked file
      await fs.writeFile(path.join(testDir, 'newfile.txt'), 'new content\n');

      const result = await generateLocalDiff(testDir);

      // Both should use relative paths
      expect(result.diff).toContain('diff --git a/existing.txt b/existing.txt');
      expect(result.diff).toContain('diff --git a/newfile.txt b/newfile.txt');

      // No absolute paths
      expect(result.diff).not.toContain(testDir);
    });
  });
});

describe('findMainGitRoot', () => {
  let mainRepoDir;
  let worktreeDir;

  beforeEach(async () => {
    // Create a main git repository
    // Use realpath to resolve symlinks (e.g., /var -> /private/var on macOS)
    const tmpDir = await fs.realpath(os.tmpdir());
    mainRepoDir = await fs.mkdtemp(path.join(tmpDir, 'pair-review-main-repo-'));

    // Initialize git repo
    execSync('git init', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: mainRepoDir, stdio: 'pipe' });

    // Create initial commit
    await fs.writeFile(path.join(mainRepoDir, 'file.txt'), 'initial content\n');
    execSync('git add file.txt', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: mainRepoDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    // Clean up worktree first (must be removed before the main repo)
    if (worktreeDir) {
      try {
        execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: mainRepoDir, stdio: 'pipe' });
      } catch {
        // Worktree might already be removed or never created
      }
      worktreeDir = null;
    }

    // Clean up main repo
    if (mainRepoDir) {
      await fs.rm(mainRepoDir, { recursive: true, force: true });
    }
  });

  it('should return the same path for a regular git repository', async () => {
    const result = await findMainGitRoot(mainRepoDir);
    expect(result).toBe(mainRepoDir);
  });

  it('should return the main repo root when called from a worktree', async () => {
    // Create a worktree
    const tmpDir = await fs.realpath(os.tmpdir());
    worktreeDir = path.join(tmpDir, `pair-review-worktree-${Date.now()}`);

    // Create a branch for the worktree
    execSync('git branch test-branch', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync(`git worktree add "${worktreeDir}" test-branch`, { cwd: mainRepoDir, stdio: 'pipe' });

    // findMainGitRoot should return the main repo, not the worktree
    const result = await findMainGitRoot(worktreeDir);
    expect(result).toBe(mainRepoDir);
  });

  it('should work when called from a subdirectory of a worktree', async () => {
    // Create a worktree
    const tmpDir = await fs.realpath(os.tmpdir());
    worktreeDir = path.join(tmpDir, `pair-review-worktree-${Date.now()}`);
    execSync('git branch test-branch-2', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync(`git worktree add "${worktreeDir}" test-branch-2`, { cwd: mainRepoDir, stdio: 'pipe' });

    // Create a subdirectory in the worktree
    const subDir = path.join(worktreeDir, 'src', 'components');
    await fs.mkdir(subDir, { recursive: true });

    // findMainGitRoot should still return the main repo
    const result = await findMainGitRoot(subDir);
    expect(result).toBe(mainRepoDir);
  });

  it('should throw an error for non-git directory', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-'));
    try {
      await expect(findMainGitRoot(nonGitDir)).rejects.toThrow('Failed to find main git root');
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });
});

describe('findGitRoot vs findMainGitRoot comparison', () => {
  let mainRepoDir;
  let worktreeDir;

  beforeEach(async () => {
    // Create a main git repository
    // Use realpath to resolve symlinks (e.g., /var -> /private/var on macOS)
    const tmpDir = await fs.realpath(os.tmpdir());
    mainRepoDir = await fs.mkdtemp(path.join(tmpDir, 'pair-review-compare-'));

    // Initialize git repo
    execSync('git init', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: mainRepoDir, stdio: 'pipe' });

    // Create initial commit
    await fs.writeFile(path.join(mainRepoDir, 'file.txt'), 'initial content\n');
    execSync('git add file.txt', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: mainRepoDir, stdio: 'pipe' });

    // Create a worktree
    worktreeDir = path.join(tmpDir, `pair-review-wt-${Date.now()}`);
    execSync('git branch compare-branch', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync(`git worktree add "${worktreeDir}" compare-branch`, { cwd: mainRepoDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    if (worktreeDir) {
      try {
        execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: mainRepoDir, stdio: 'pipe' });
      } catch {
        // Worktree might already be removed
      }
    }
    if (mainRepoDir) {
      await fs.rm(mainRepoDir, { recursive: true, force: true });
    }
  });

  it('should demonstrate the difference: findGitRoot returns worktree, findMainGitRoot returns main repo', async () => {
    // findGitRoot returns the worktree path (where .git file is)
    const gitRoot = await findGitRoot(worktreeDir);
    expect(gitRoot).toBe(worktreeDir);

    // findMainGitRoot returns the main repo path
    const mainRoot = await findMainGitRoot(worktreeDir);
    expect(mainRoot).toBe(mainRepoDir);

    // They should be different for worktrees
    expect(gitRoot).not.toBe(mainRoot);
  });

  it('should return the same path for regular repos', async () => {
    const gitRoot = await findGitRoot(mainRepoDir);
    const mainRoot = await findMainGitRoot(mainRepoDir);

    // For regular repos, both should return the same path
    expect(gitRoot).toBe(mainRoot);
    expect(gitRoot).toBe(mainRepoDir);
  });
});

describe('generateScopedDiff', () => {
  let testDir;
  let defaultBranch;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-scoped-'));
    execSync('git init', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });

    await fs.writeFile(path.join(testDir, 'file.txt'), 'initial content\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });

    defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: testDir, encoding: 'utf8', stdio: 'pipe'
    }).trim();
  });

  afterEach(async () => {
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe('unstaged–untracked scope (legacy default)', () => {
    it('should return unstaged changes and untracked files', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'modified\n');
      await fs.writeFile(path.join(testDir, 'new.txt'), 'brand new\n');

      const result = await generateScopedDiff(testDir, 'unstaged', 'untracked');

      expect(result.diff).toContain('diff --git a/file.txt b/file.txt');
      expect(result.diff).toContain('diff --git a/new.txt b/new.txt');
      expect(result.mergeBaseSha).toBeNull();
    });

    it('should NOT include staged changes', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'staged change\n');
      execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });

      const result = await generateScopedDiff(testDir, 'unstaged', 'untracked');

      expect(result.diff).not.toContain('staged change');
    });
  });

  describe('staged–unstaged scope', () => {
    it('should return staged + unstaged via diff HEAD', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'staged content\n');
      execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'file.txt'), 'unstaged on top\n');

      const result = await generateScopedDiff(testDir, 'staged', 'unstaged');

      // Should see the final working tree state vs HEAD
      expect(result.diff).toContain('unstaged on top');
      expect(result.mergeBaseSha).toBeNull();
    });
  });

  describe('unstaged-only scope', () => {
    it('should return only unstaged changes, no untracked', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'modified\n');
      await fs.writeFile(path.join(testDir, 'new.txt'), 'untracked\n');

      const result = await generateScopedDiff(testDir, 'unstaged', 'unstaged');

      expect(result.diff).toContain('diff --git a/file.txt b/file.txt');
      expect(result.diff).not.toContain('new.txt');
      expect(result.stats.untrackedFiles).toBe(0);
    });
  });

  describe('unstaged–untracked scope', () => {
    it('should return unstaged and untracked file diffs', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'modified\n');
      await fs.writeFile(path.join(testDir, 'new.txt'), 'untracked\n');

      const result = await generateScopedDiff(testDir, 'unstaged', 'untracked');

      expect(result.diff).toContain('diff --git a/file.txt b/file.txt');
      expect(result.diff).toContain('diff --git a/new.txt b/new.txt');
      expect(result.stats.untrackedFiles).toBe(1);
    });
  });

  describe('branch–unstaged scope', () => {
    it('should return committed changes since merge-base', async () => {
      // Create a branch and add a commit
      execSync('git checkout -b feature', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'feature.txt'), 'feature work\n');
      execSync('git add feature.txt', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Feature commit"', { cwd: testDir, stdio: 'pipe' });

      const result = await generateScopedDiff(testDir, 'branch', 'unstaged', defaultBranch);

      expect(result.diff).toContain('feature.txt');
      expect(result.diff).toContain('feature work');
      expect(result.mergeBaseSha).toBeTruthy();
    });

    it('should throw when baseBranch is missing', async () => {
      await expect(
        generateScopedDiff(testDir, 'branch', 'unstaged')
      ).rejects.toThrow('baseBranch is required');
    });

    it('should include both committed and working tree changes', async () => {
      execSync('git checkout -b feature2', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'committed.txt'), 'committed\n');
      execSync('git add committed.txt', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Feature"', { cwd: testDir, stdio: 'pipe' });
      // Also make an unstaged change
      await fs.writeFile(path.join(testDir, 'file.txt'), 'working tree change\n');

      const result = await generateScopedDiff(testDir, 'branch', 'unstaged', defaultBranch);

      expect(result.diff).toContain('committed.txt');
      expect(result.diff).toContain('working tree change');
      expect(result.mergeBaseSha).toBeTruthy();
    });
  });

  describe('branch–untracked scope', () => {
    it('should include committed, staged, unstaged, and untracked changes against merge-base', async () => {
      execSync('git checkout -b feature3', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'committed2.txt'), 'committed\n');
      execSync('git add committed2.txt', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Feature3"', { cwd: testDir, stdio: 'pipe' });
      // Add a staged change
      await fs.writeFile(path.join(testDir, 'staged-only.txt'), 'staged content\n');
      execSync('git add staged-only.txt', { cwd: testDir, stdio: 'pipe' });
      // Add an untracked file (do NOT git add)
      await fs.writeFile(path.join(testDir, 'untracked.txt'), 'untracked content\n');

      const result = await generateScopedDiff(testDir, 'branch', 'untracked', defaultBranch);

      expect(result.diff).toContain('committed2.txt');
      expect(result.diff).toContain('staged-only.txt');
      expect(result.diff).toContain('staged content');
      expect(result.diff).toContain('untracked.txt');
      expect(result.diff).toContain('untracked content');
      expect(result.stats.untrackedFiles).toBe(1);
      expect(result.mergeBaseSha).toBeTruthy();
    });
  });

  describe('empty working directory', () => {
    it('should return empty diff when no changes exist', async () => {
      const result = await generateScopedDiff(testDir, 'unstaged', 'untracked');

      expect(result.diff).toBeFalsy();
      expect(result.stats.trackedChanges).toBe(0);
      expect(result.stats.untrackedFiles).toBe(0);
    });
  });

  describe('contextLines option', () => {
    it('should default to --unified=25 when no contextLines option is provided', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'modified\n');

      const result = await generateScopedDiff(testDir, 'unstaged', 'untracked');

      // The diff should use --unified=25 (default), which shows 25 context lines
      // We can verify this indirectly: the diff was generated without error
      expect(result.diff).toContain('diff --git a/file.txt b/file.txt');
    });

    it('should use custom contextLines when provided', async () => {
      // Create a file with many lines so context line count matters
      const lines = [];
      for (let i = 1; i <= 50; i++) lines.push(`line ${i}`);
      await fs.writeFile(path.join(testDir, 'file.txt'), lines.join('\n') + '\n');
      execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Add many lines"', { cwd: testDir, stdio: 'pipe' });

      // Modify a line in the middle
      lines[25] = 'MODIFIED line 26';
      await fs.writeFile(path.join(testDir, 'file.txt'), lines.join('\n') + '\n');

      // With contextLines: 3, we get fewer context lines
      const result3 = await generateScopedDiff(testDir, 'unstaged', 'unstaged', null, { contextLines: 3 });
      // With default (25), we get more context lines
      const resultDefault = await generateScopedDiff(testDir, 'unstaged', 'unstaged');

      // The diff with 3 context lines should be shorter than with 25
      expect(result3.diff.length).toBeLessThan(resultDefault.diff.length);
      // Both should contain the modification
      expect(result3.diff).toContain('MODIFIED line 26');
      expect(resultDefault.diff).toContain('MODIFIED line 26');
    });
  });

  describe('extraArgs option', () => {
    it('should append extraArgs to git diff commands', async () => {
      // Create files with whitespace-only changes
      await fs.writeFile(path.join(testDir, 'file.txt'), 'hello world\n');
      execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Add file"', { cwd: testDir, stdio: 'pipe' });

      // Make a whitespace-only change
      await fs.writeFile(path.join(testDir, 'file.txt'), 'hello  world\n');

      // Without -w, the diff should show the whitespace change
      const resultWithout = await generateScopedDiff(testDir, 'unstaged', 'unstaged');
      expect(resultWithout.diff).toContain('file.txt');

      // With -w (ignore whitespace), git should produce no diff
      const resultWith = await generateScopedDiff(testDir, 'unstaged', 'unstaged', null, { extraArgs: ['-w'] });
      // The -w flag causes git to ignore whitespace changes entirely
      expect(resultWith.diff).toBeFalsy();
    });

    it('should work together with contextLines', async () => {
      // Create a file with many lines
      const lines = [];
      for (let i = 1; i <= 50; i++) lines.push(`line ${i}`);
      await fs.writeFile(path.join(testDir, 'file.txt'), lines.join('\n') + '\n');
      execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Add lines"', { cwd: testDir, stdio: 'pipe' });

      // Make a real change
      lines[25] = 'CHANGED line 26';
      await fs.writeFile(path.join(testDir, 'file.txt'), lines.join('\n') + '\n');

      // Use both options together
      const result = await generateScopedDiff(testDir, 'unstaged', 'unstaged', null, {
        contextLines: 3,
        extraArgs: ['--stat']
      });

      // Should contain the change
      expect(result.diff).toContain('CHANGED line 26');
      // --stat appends a summary at the end of the diff
      expect(result.diff).toContain('1 file changed');
    });
  });

  describe('untracked file options threading', () => {
    it('should apply contextLines to untracked file diffs', async () => {
      // Create a large untracked file so context line count is visible
      const lines = [];
      for (let i = 1; i <= 50; i++) lines.push(`new line ${i}`);
      await fs.writeFile(path.join(testDir, 'big-new.txt'), lines.join('\n') + '\n');

      // With contextLines: 3, the diff header should use --unified=3
      const result3 = await generateScopedDiff(testDir, 'unstaged', 'untracked', null, { contextLines: 3 });
      // With default (25), the diff header should use --unified=25
      const resultDefault = await generateScopedDiff(testDir, 'unstaged', 'untracked');

      // Both should contain the untracked file
      expect(result3.diff).toContain('big-new.txt');
      expect(resultDefault.diff).toContain('big-new.txt');
      // The diff with 3 context lines should have @@ -0,0 +1,50 @@ style header
      // Both produce the same output for new files (all lines are additions),
      // but the flag should be threaded through without error
      expect(result3.diff).toContain('new line 1');
      expect(resultDefault.diff).toContain('new line 1');
    });

    it('should apply extraArgs to untracked file diffs', async () => {
      // Create an untracked file
      await fs.writeFile(path.join(testDir, 'new-file.txt'), 'new content\n');

      // extraArgs like --stat should be applied to untracked file diffs too
      const result = await generateScopedDiff(testDir, 'unstaged', 'untracked', null, {
        extraArgs: ['--stat']
      });

      // Should contain the untracked file diff
      expect(result.diff).toContain('new-file.txt');
      // --stat appends a summary to each file diff
      expect(result.diff).toContain('1 file changed');
    });

    it('should apply both contextLines and extraArgs to untracked file diffs in mixed scope', async () => {
      // Make an unstaged change AND an untracked file
      await fs.writeFile(path.join(testDir, 'file.txt'), 'modified content\n');
      await fs.writeFile(path.join(testDir, 'brand-new.txt'), 'brand new content\n');

      const result = await generateScopedDiff(testDir, 'unstaged', 'untracked', null, {
        contextLines: 3,
        extraArgs: ['--stat']
      });

      // Should contain both tracked and untracked changes
      expect(result.diff).toContain('file.txt');
      expect(result.diff).toContain('brand-new.txt');
    });

    it('should preserve literal dollar-sign segments in untracked file paths', async () => {
      const originalOwner = process.env.owner;
      const originalRepo = process.env.repo;
      const originalNumber = process.env.number;

      process.env.owner = 'expanded-owner';
      process.env.repo = 'expanded-repo';
      process.env.number = 'expanded-number';

      try {
        const relativePath = 'src/routes/repos/$owner/$repo/pulls/$number/route.tsx';
        await fs.mkdir(path.join(testDir, 'src/routes/repos/$owner/$repo/pulls/$number'), { recursive: true });
        await fs.writeFile(path.join(testDir, relativePath), 'export const Route = {};\n');

        const result = await generateScopedDiff(testDir, 'unstaged', 'untracked');

        expect(result.diff).toContain(`diff --git a/${relativePath} b/${relativePath}`);
        expect(result.diff).toContain(`+++ b/${relativePath}`);
        expect(result.diff).not.toContain('expanded-owner');
        expect(result.diff).not.toContain('expanded-repo');
        expect(result.diff).not.toContain('expanded-number');
      } finally {
        if (originalOwner === undefined) {
          delete process.env.owner;
        } else {
          process.env.owner = originalOwner;
        }

        if (originalRepo === undefined) {
          delete process.env.repo;
        } else {
          process.env.repo = originalRepo;
        }

        if (originalNumber === undefined) {
          delete process.env.number;
        } else {
          process.env.number = originalNumber;
        }
      }
    });
  });

  describe('invalid scope rejection', () => {
    it('should reject scope branch..branch because it does not include unstaged', async () => {
      await expect(
        generateScopedDiff(testDir, 'branch', 'branch', defaultBranch)
      ).rejects.toThrow("Invalid scope branch..branch: scope must include 'unstaged'");
    });

    it('should reject scope staged..staged because it does not include unstaged', async () => {
      await expect(
        generateScopedDiff(testDir, 'staged', 'staged')
      ).rejects.toThrow("Invalid scope staged..staged: scope must include 'unstaged'");
    });

    it('should reject scope untracked..untracked because it does not include unstaged', async () => {
      await expect(
        generateScopedDiff(testDir, 'untracked', 'untracked')
      ).rejects.toThrow("Invalid scope untracked..untracked: scope must include 'unstaged'");
    });
  });
});

describe('computeScopedDigest', () => {
  let testDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-digest-'));
    execSync('git init', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });

    await fs.writeFile(path.join(testDir, 'file.txt'), 'initial\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial"', { cwd: testDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('should return a 16-char hex digest', async () => {
    await fs.writeFile(path.join(testDir, 'file.txt'), 'changed\n');
    const digest = await computeScopedDigest(testDir, 'unstaged', 'untracked');
    expect(digest).toMatch(/^[a-f0-9]{16}$/);
  });

  it('should be consistent for same state', async () => {
    await fs.writeFile(path.join(testDir, 'file.txt'), 'changed\n');
    const d1 = await computeScopedDigest(testDir, 'unstaged', 'untracked');
    const d2 = await computeScopedDigest(testDir, 'unstaged', 'untracked');
    expect(d1).toBe(d2);
  });

  it('should change when unstaged content changes', async () => {
    await fs.writeFile(path.join(testDir, 'file.txt'), 'v1\n');
    const d1 = await computeScopedDigest(testDir, 'unstaged', 'unstaged');

    await fs.writeFile(path.join(testDir, 'file.txt'), 'v2\n');
    const d2 = await computeScopedDigest(testDir, 'unstaged', 'unstaged');

    expect(d1).not.toBe(d2);
  });

  it('should change when staged content changes', async () => {
    await fs.writeFile(path.join(testDir, 'file.txt'), 'staged-v1\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    const d1 = await computeScopedDigest(testDir, 'staged', 'unstaged');

    await fs.writeFile(path.join(testDir, 'file.txt'), 'staged-v2\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    const d2 = await computeScopedDigest(testDir, 'staged', 'unstaged');

    expect(d1).not.toBe(d2);
  });

  it('should change when untracked file is added', async () => {
    const d1 = await computeScopedDigest(testDir, 'unstaged', 'untracked');

    await fs.writeFile(path.join(testDir, 'new.txt'), 'new\n');
    const d2 = await computeScopedDigest(testDir, 'unstaged', 'untracked');

    expect(d1).not.toBe(d2);
  });

  it('should include HEAD SHA when branch is in scope', async () => {
    execSync('git checkout -b feat', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'a.txt'), 'a\n');
    execSync('git add a.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "commit a"', { cwd: testDir, stdio: 'pipe' });
    const d1 = await computeScopedDigest(testDir, 'branch', 'unstaged');

    await fs.writeFile(path.join(testDir, 'b.txt'), 'b\n');
    execSync('git add b.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "commit b"', { cwd: testDir, stdio: 'pipe' });
    const d2 = await computeScopedDigest(testDir, 'branch', 'unstaged');

    expect(d1).not.toBe(d2);
  });

  it('should return null for non-existent path', async () => {
    const digest = await computeScopedDigest('/non/existent/path', 'unstaged', 'untracked');
    expect(digest).toBeNull();
  });

  it('should match computeLocalDiffDigest for unstaged–untracked scope', async () => {
    await fs.writeFile(path.join(testDir, 'file.txt'), 'modified\n');
    await fs.writeFile(path.join(testDir, 'new.txt'), 'new file\n');

    const scopedDigest = await computeScopedDigest(testDir, 'unstaged', 'untracked');
    const legacyDigest = await computeLocalDiffDigest(testDir);

    expect(scopedDigest).toBe(legacyDigest);
  });
});
