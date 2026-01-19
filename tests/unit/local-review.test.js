import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const { computeLocalDiffDigest, generateLocalDiff, findMainGitRoot, findGitRoot } = require('../../src/local-review');

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
