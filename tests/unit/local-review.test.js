// SPDX-License-Identifier: GPL-3.0-or-later
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

  describe('staged scope', () => {
    it('should return only staged changes', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'staged content\n');
      execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
      // Make another unstaged change
      await fs.writeFile(path.join(testDir, 'file.txt'), 'unstaged on top\n');

      const result = await generateScopedDiff(testDir, 'staged', 'staged');

      expect(result.diff).toContain('staged content');
      expect(result.diff).not.toContain('unstaged on top');
      expect(result.mergeBaseSha).toBeNull();
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

  describe('untracked-only scope', () => {
    it('should return only untracked file diffs', async () => {
      await fs.writeFile(path.join(testDir, 'file.txt'), 'modified\n');
      await fs.writeFile(path.join(testDir, 'new.txt'), 'untracked\n');

      const result = await generateScopedDiff(testDir, 'untracked', 'untracked');

      expect(result.diff).not.toContain('file.txt');
      expect(result.diff).toContain('diff --git a/new.txt b/new.txt');
      expect(result.stats.untrackedFiles).toBe(1);
    });
  });

  describe('branch scope', () => {
    it('should return committed changes since merge-base', async () => {
      // Create a branch and add a commit
      execSync('git checkout -b feature', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'feature.txt'), 'feature work\n');
      execSync('git add feature.txt', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Feature commit"', { cwd: testDir, stdio: 'pipe' });

      const result = await generateScopedDiff(testDir, 'branch', 'branch', defaultBranch);

      expect(result.diff).toContain('feature.txt');
      expect(result.diff).toContain('feature work');
      expect(result.mergeBaseSha).toBeTruthy();
    });

    it('should throw when baseBranch is missing', async () => {
      await expect(
        generateScopedDiff(testDir, 'branch', 'branch')
      ).rejects.toThrow('baseBranch is required');
    });
  });

  describe('branch–unstaged scope', () => {
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

  describe('branch–staged scope', () => {
    it('should include both committed and staged-only changes against merge-base', async () => {
      execSync('git checkout -b feature3', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'committed2.txt'), 'committed\n');
      execSync('git add committed2.txt', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Feature3"', { cwd: testDir, stdio: 'pipe' });
      // Add a staged-only change (not committed)
      await fs.writeFile(path.join(testDir, 'staged-only.txt'), 'staged content\n');
      execSync('git add staged-only.txt', { cwd: testDir, stdio: 'pipe' });

      const result = await generateScopedDiff(testDir, 'branch', 'staged', defaultBranch);

      expect(result.diff).toContain('committed2.txt');
      expect(result.diff).toContain('staged-only.txt');
      expect(result.diff).toContain('staged content');
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
    const d1 = await computeScopedDigest(testDir, 'staged', 'staged');

    await fs.writeFile(path.join(testDir, 'file.txt'), 'staged-v2\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    const d2 = await computeScopedDigest(testDir, 'staged', 'staged');

    expect(d1).not.toBe(d2);
  });

  it('should change when untracked file is added', async () => {
    const d1 = await computeScopedDigest(testDir, 'untracked', 'untracked');

    await fs.writeFile(path.join(testDir, 'new.txt'), 'new\n');
    const d2 = await computeScopedDigest(testDir, 'untracked', 'untracked');

    expect(d1).not.toBe(d2);
  });

  it('should include HEAD SHA when branch is in scope', async () => {
    execSync('git checkout -b feat', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'a.txt'), 'a\n');
    execSync('git add a.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "commit a"', { cwd: testDir, stdio: 'pipe' });
    const d1 = await computeScopedDigest(testDir, 'branch', 'branch');

    await fs.writeFile(path.join(testDir, 'b.txt'), 'b\n');
    execSync('git add b.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "commit b"', { cwd: testDir, stdio: 'pipe' });
    const d2 = await computeScopedDigest(testDir, 'branch', 'branch');

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
