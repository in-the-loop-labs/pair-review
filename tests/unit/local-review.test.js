// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const { computeLocalDiffDigest, generateLocalDiff, findMainGitRoot, findGitRoot, generateScopedDiff, computeScopedDigest, detectAndBuildBranchInfo, detectPRForBranch, parseRemoteUrl, getRemoteHostname, getRepositoryName, listFilesModifiedVsHead } = require('../../src/local-review');
const baseBranchModule = require('../../src/git/base-branch');

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

// Exercised against REAL repositories on purpose. Every claim this function
// makes is a claim about git's behaviour — which operand covers the index,
// what `-z` emits, how a rename is named — and a mocked execSync would only
// re-assert the assumption under test. This is the single input deciding
// whether a submitted comment keeps its line number (src/routes/local.js,
// `submit-review`), so a silent regression here anchors comments to lines the
// commit on GitHub does not have.
describe('listFilesModifiedVsHead', () => {
  let testDir;

  /** Deterministic repo: fixed identity, no signing, no reliance on user config. */
  const initRepo = (dir) => {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: dir, stdio: 'pipe' });
    execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });
  };

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-dirty-'));
    initRepo(testDir);

    await fs.writeFile(path.join(testDir, 'tracked.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(testDir, 'other.txt'), 'other\n');
    execSync('git add -A', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('returns an empty set for a clean tree', async () => {
    const result = await listFilesModifiedVsHead(testDir);

    expect(result).toBeInstanceOf(Set);
    expect([...result]).toEqual([]);
  });

  it('reports a file whose change is only UNSTAGED', async () => {
    await fs.writeFile(path.join(testDir, 'tracked.txt'), 'one\ntwo changed\n');

    const result = await listFilesModifiedVsHead(testDir);

    expect(result.has('tracked.txt')).toBe(true);
    expect(result.has('other.txt')).toBe(false);
  });

  it('reports a file whose change is only STAGED', async () => {
    // The HEAD operand is what makes this visible: a bare `git diff` compares
    // the index to the working tree and calls a fully staged edit clean, which
    // would hand a shifted line number to GitHub.
    await fs.writeFile(path.join(testDir, 'tracked.txt'), 'one\ntwo staged\n');
    execSync('git add tracked.txt', { cwd: testDir, stdio: 'pipe' });

    const result = await listFilesModifiedVsHead(testDir);

    expect(result.has('tracked.txt')).toBe(true);
  });

  it('reports a file that is staged AND further modified once', async () => {
    await fs.writeFile(path.join(testDir, 'tracked.txt'), 'one\nstaged\n');
    execSync('git add tracked.txt', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'tracked.txt'), 'one\nstaged then more\n');

    const result = await listFilesModifiedVsHead(testDir);

    expect([...result]).toEqual(['tracked.txt']);
  });

  it('excludes untracked files', async () => {
    // Deliberate: an untracked file is in no commit, so it is in no PR diff,
    // and its comments are file-level for that reason rather than this one.
    await fs.writeFile(path.join(testDir, 'brand-new.txt'), 'hello\n');

    const result = await listFilesModifiedVsHead(testDir);

    expect(result.has('brand-new.txt')).toBe(false);
    expect([...result]).toEqual([]);
  });

  it('reports a rename under its POST-IMAGE path only', async () => {
    // Comments are anchored to the path local mode renders, which is the name
    // on disk now. Reporting the pre-image name instead would leave the file
    // the reviewer commented on looking clean.
    execSync('git mv tracked.txt renamed.txt', { cwd: testDir, stdio: 'pipe' });

    const result = await listFilesModifiedVsHead(testDir);

    expect(result.has('renamed.txt')).toBe(true);
    expect(result.has('tracked.txt')).toBe(false);
  });

  it('survives the -z parse for paths containing a space', async () => {
    // Without -z git QUOTES such a path ("with space.txt"), and the quoted
    // form matches no `comment.file`, so the file reads as clean.
    await fs.writeFile(path.join(testDir, 'with space.txt'), 'a\n');
    execSync('git add -A', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Add spaced path"', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'with space.txt'), 'b\n');

    const result = await listFilesModifiedVsHead(testDir);

    expect([...result]).toEqual(['with space.txt']);
  });

  it('returns REPO-ROOT-relative paths even with diff.relative set and a subdirectory repoPath', async () => {
    // Regression guard for the missing GIT_DIFF_FLAGS. `diff.relative` makes
    // git answer with subdirectory-relative names ("f.txt"), which match no
    // repo-root-relative comment path — so every dirty file silently reads as
    // clean and KEEPS its line number. Failing that direction is the one
    // outcome this function must never produce. `local_path` can point below
    // the repo root: src/routes/mcp.js and src/routes/analyses.js store the
    // path they are handed verbatim.
    const subDir = path.join(testDir, 'nested');
    await fs.mkdir(subDir);
    await fs.writeFile(path.join(subDir, 'f.txt'), 'a\n');
    execSync('git add -A', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Add nested file"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config diff.relative true', { cwd: testDir, stdio: 'pipe' });

    await fs.writeFile(path.join(subDir, 'f.txt'), 'b\n');

    const result = await listFilesModifiedVsHead(subDir);

    expect([...result]).toEqual(['nested/f.txt']);
  });

  it('REJECTS rather than resolving empty when the path is not a git repository', async () => {
    // The whole contract: an empty set means "clean", which is what buys a
    // comment its line number. An unanswerable question must throw so the
    // caller degrades every comment to file level.
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-nongit-'));
    try {
      await expect(listFilesModifiedVsHead(nonGitDir)).rejects.toThrow(
        /Failed to list files modified vs HEAD/
      );
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('REJECTS on a repository with no commits (HEAD does not resolve)', async () => {
    const emptyRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-nocommit-'));
    try {
      initRepo(emptyRepo);
      await fs.writeFile(path.join(emptyRepo, 'a.txt'), 'a\n');
      execSync('git add -A', { cwd: emptyRepo, stdio: 'pipe' });

      await expect(listFilesModifiedVsHead(emptyRepo)).rejects.toThrow(
        /Failed to list files modified vs HEAD/
      );
    } finally {
      await fs.rm(emptyRepo, { recursive: true, force: true });
    }
  });
});

describe('findMainGitRoot', () => {
  let mainRepoDir;
  let worktreeDir;
  let worktreeParent;

  beforeEach(async () => {
    // Create a main git repository
    // Use realpath to resolve symlinks (e.g., /var -> /private/var on macOS)
    const tmpDir = await fs.realpath(os.tmpdir());
    mainRepoDir = await fs.mkdtemp(path.join(tmpDir, 'pair-review-main-repo-'));

    // Unique parent for worktree paths. Tests derive worktreeDir INSIDE this
    // mkdtemp'd parent (the worktree target itself must not pre-exist for
    // `git worktree add`) instead of a Date.now()-suffixed path directly in
    // the shared tmp root, which can collide across parallel workers.
    worktreeParent = await fs.mkdtemp(path.join(tmpDir, 'pair-review-worktree-'));

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

    // Clean up the worktree parent directory
    if (worktreeParent) {
      await fs.rm(worktreeParent, { recursive: true, force: true });
      worktreeParent = null;
    }
  });

  it('should return the same path for a regular git repository', async () => {
    const result = await findMainGitRoot(mainRepoDir);
    expect(result).toBe(mainRepoDir);
  });

  it('should return the main repo root when called from a worktree', async () => {
    // Create a worktree inside the per-test mkdtemp'd parent
    worktreeDir = path.join(worktreeParent, 'wt');

    // Create a branch for the worktree
    execSync('git branch test-branch', { cwd: mainRepoDir, stdio: 'pipe' });
    execSync(`git worktree add "${worktreeDir}" test-branch`, { cwd: mainRepoDir, stdio: 'pipe' });

    // findMainGitRoot should return the main repo, not the worktree
    const result = await findMainGitRoot(worktreeDir);
    expect(result).toBe(mainRepoDir);
  });

  it('should work when called from a subdirectory of a worktree', async () => {
    // Create a worktree inside the per-test mkdtemp'd parent
    worktreeDir = path.join(worktreeParent, 'wt');
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
  let worktreeParent;

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

    // Create a worktree inside a unique mkdtemp'd parent — a Date.now()
    // suffix directly in the shared tmp root can collide across workers.
    // (`git worktree add` requires the target itself to not pre-exist.)
    worktreeParent = await fs.mkdtemp(path.join(tmpDir, 'pair-review-wt-'));
    worktreeDir = path.join(worktreeParent, 'wt');
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
    if (worktreeParent) {
      await fs.rm(worktreeParent, { recursive: true, force: true });
      worktreeParent = null;
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

describe('detectAndBuildBranchInfo - PR association persistence', () => {
  let testDir;
  let detectBaseBranchSpy;

  beforeEach(async () => {
    // Real git repo so getBranchCommitCount returns >0 against a real base.
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-pr-assoc-'));
    execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'base.txt'), 'base\n');
    execSync('git add . && git commit -m "base"', { cwd: testDir, stdio: 'pipe' });
    execSync('git checkout -b feature-branch', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'feat.txt'), 'feature\n');
    execSync('git add . && git commit -m "feature commit"', { cwd: testDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    if (detectBaseBranchSpy) {
      detectBaseBranchSpy.mockRestore();
      detectBaseBranchSpy = null;
    }
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('persists pr_number and repository when GitHub returns a PR', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'main',
      source: 'github',
      prNumber: 42
    });

    const calls = [];
    const reviewRepo = {
      associatePR: vi.fn(async (id, { prNumber, repository }) => {
        calls.push({ id, prNumber, repository });
        return true;
      })
    };

    const result = await detectAndBuildBranchInfo(testDir, 'feature-branch', {
      repository: 'owner/repo',
      diff: '',
      untrackedFiles: [],
      githubToken: 'test-token',
      reviewRepo,
      reviewId: 7
    });

    expect(result).toEqual(expect.objectContaining({
      baseBranch: 'main',
      prNumber: 42,
      source: 'github'
    }));
    expect(reviewRepo.associatePR).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({ id: 7, prNumber: 42, repository: 'owner/repo' });
  });

  it('does NOT persist when no PR is found', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'main',
      source: 'default'
      // no prNumber
    });

    const reviewRepo = { associatePR: vi.fn(async () => true) };

    const result = await detectAndBuildBranchInfo(testDir, 'feature-branch', {
      repository: 'owner/repo',
      diff: '',
      untrackedFiles: [],
      githubToken: 'test-token',
      reviewRepo,
      reviewId: 9
    });

    expect(result).toEqual(expect.objectContaining({ baseBranch: 'main', prNumber: null }));
    expect(reviewRepo.associatePR).not.toHaveBeenCalled();
  });

  it('does not crash when GitHub detection throws; leaves persistence untouched', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch')
      .mockRejectedValue(new Error('GitHub API down'));

    const reviewRepo = { associatePR: vi.fn(async () => true) };

    const result = await detectAndBuildBranchInfo(testDir, 'feature-branch', {
      repository: 'owner/repo',
      diff: '',
      untrackedFiles: [],
      githubToken: 'test-token',
      reviewRepo,
      reviewId: 11
    });

    expect(result).toBeNull();
    expect(reviewRepo.associatePR).not.toHaveBeenCalled();
  });

  it('does not persist when reviewRepo / reviewId are not provided', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'main',
      source: 'github',
      prNumber: 99
    });

    const result = await detectAndBuildBranchInfo(testDir, 'feature-branch', {
      repository: 'owner/repo',
      diff: '',
      untrackedFiles: [],
      githubToken: 'test-token'
    });

    expect(result?.prNumber).toBe(99);
    // No throw, no persistence requested — caller opted out.
  });

  it('swallows persistence errors without breaking detection', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'main',
      source: 'github',
      prNumber: 13
    });

    const reviewRepo = {
      associatePR: vi.fn(async () => { throw new Error('db gone'); })
    };

    const result = await detectAndBuildBranchInfo(testDir, 'feature-branch', {
      repository: 'owner/repo',
      diff: '',
      untrackedFiles: [],
      githubToken: 'test-token',
      reviewRepo,
      reviewId: 13
    });

    expect(result?.prNumber).toBe(13);
    expect(reviewRepo.associatePR).toHaveBeenCalledTimes(1);
  });
});

describe('detectPRForBranch - guard-free PR detection', () => {
  let testDir;
  let detectBaseBranchSpy;
  let tryGitHubPRSpy;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-pr-detect-'));
    // Don't bother initialising git — detectPRForBranch shouldn't run any
    // git commands itself; it delegates entirely to base-branch detection.
  });

  afterEach(async () => {
    if (detectBaseBranchSpy) {
      detectBaseBranchSpy.mockRestore();
      detectBaseBranchSpy = null;
    }
    if (tryGitHubPRSpy) {
      tryGitHubPRSpy.mockRestore();
      tryGitHubPRSpy = null;
    }
    if (testDir) await fs.rm(testDir, { recursive: true, force: true });
  });

  it('returns PR number regardless of clean working tree state', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'main',
      source: 'github-pr',
      prNumber: 42
    });

    const reviewRepo = { associatePR: vi.fn(async () => true) };

    const result = await detectPRForBranch(testDir, 'feature-branch', {
      repository: 'owner/repo',
      githubToken: 'tok',
      reviewRepo,
      reviewId: 5
    });

    expect(result).toEqual({ baseBranch: 'main', source: 'github-pr', prNumber: 42 });
    expect(reviewRepo.associatePR).toHaveBeenCalledWith(5, { prNumber: 42, repository: 'owner/repo' });
  });

  it('runs the detection even when caller has untracked files (no guard)', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'main',
      source: 'github-pr',
      prNumber: 99
    });
    const reviewRepo = { associatePR: vi.fn(async () => true) };

    // Note: this helper takes no diff/untrackedFiles options — that's the
    // whole point. detectAndBuildBranchInfo has those guards; this one
    // doesn't, so a dirty tree must not suppress the lookup.
    const result = await detectPRForBranch(testDir, 'feature-branch', {
      repository: 'owner/repo',
      githubToken: 'tok',
      reviewRepo,
      reviewId: 6
    });
    expect(result?.prNumber).toBe(99);
  });

  it('does NOT run when branch is detached (HEAD)', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch');
    const result = await detectPRForBranch(testDir, 'HEAD', { repository: 'owner/repo' });
    expect(result).toBeNull();
    expect(detectBaseBranchSpy).not.toHaveBeenCalled();
  });

  it('enriches Graphite result with a separate GitHub PR lookup when prNumber missing', async () => {
    // Graphite returns base branch but no prNumber — by design.
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'parent-branch',
      source: 'graphite',
      prNumber: null
    });
    tryGitHubPRSpy = vi.spyOn(baseBranchModule, 'tryGitHubPR').mockResolvedValue({
      baseBranch: 'parent-branch',
      source: 'github-pr',
      prNumber: 42
    });
    const reviewRepo = { associatePR: vi.fn(async () => true) };

    const result = await detectPRForBranch(testDir, 'feature-branch', {
      repository: 'owner/repo',
      githubToken: 'tok',
      enableGraphite: true,
      reviewRepo,
      reviewId: 7
    });

    expect(result).toEqual({ baseBranch: 'parent-branch', source: 'graphite', prNumber: 42 });
    expect(tryGitHubPRSpy).toHaveBeenCalledTimes(1);
    expect(reviewRepo.associatePR).toHaveBeenCalledWith(7, { prNumber: 42, repository: 'owner/repo' });
  });

  it('does not call enrichment lookup when prNumber already present', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'main',
      source: 'github-pr',
      prNumber: 5
    });
    tryGitHubPRSpy = vi.spyOn(baseBranchModule, 'tryGitHubPR');

    const result = await detectPRForBranch(testDir, 'feature-branch', {
      repository: 'owner/repo',
      githubToken: 'tok'
    });

    expect(result?.prNumber).toBe(5);
    expect(tryGitHubPRSpy).not.toHaveBeenCalled();
  });

  it('does not enrich when no token is supplied', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'main',
      source: 'graphite',
      prNumber: null
    });
    tryGitHubPRSpy = vi.spyOn(baseBranchModule, 'tryGitHubPR');

    const result = await detectPRForBranch(testDir, 'feature-branch', {
      repository: 'owner/repo'
    });

    expect(result?.prNumber).toBeNull();
    expect(tryGitHubPRSpy).not.toHaveBeenCalled();
  });

  it('swallows persistence errors without breaking detection', async () => {
    detectBaseBranchSpy = vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue({
      baseBranch: 'main',
      source: 'github-pr',
      prNumber: 21
    });
    const reviewRepo = {
      associatePR: vi.fn(async () => { throw new Error('db gone'); })
    };

    const result = await detectPRForBranch(testDir, 'feature-branch', {
      repository: 'owner/repo',
      githubToken: 'tok',
      reviewRepo,
      reviewId: 11
    });

    expect(result?.prNumber).toBe(21);
  });
});

describe('parseRemoteUrl', () => {
  describe('hostname', () => {
    it('parses SCP-style SSH remotes', () => {
      expect(parseRemoteUrl('git@github.com:owner/repo.git').hostname).toBe('github.com');
      expect(parseRemoteUrl('git@github.com:owner/repo').hostname).toBe('github.com');
      expect(parseRemoteUrl('git@git.corp:owner/repo.git').hostname).toBe('git.corp');
      // No user part is still valid SCP syntax.
      expect(parseRemoteUrl('git.corp:owner/repo.git').hostname).toBe('git.corp');
    });

    it('parses HTTPS remotes', () => {
      expect(parseRemoteUrl('https://github.com/owner/repo.git').hostname).toBe('github.com');
      expect(parseRemoteUrl('https://github.com/owner/repo').hostname).toBe('github.com');
      expect(parseRemoteUrl('http://git.corp/owner/repo.git').hostname).toBe('git.corp');
    });

    it('parses ssh:// remotes, including with a user and a port', () => {
      expect(parseRemoteUrl('ssh://github.com/owner/repo.git').hostname).toBe('github.com');
      expect(parseRemoteUrl('ssh://git@github.com/owner/repo.git').hostname).toBe('github.com');
      expect(parseRemoteUrl('ssh://git@git.corp:22/owner/repo.git').hostname).toBe('git.corp');
    });

    it('lowercases the hostname', () => {
      expect(parseRemoteUrl('https://GitHub.COM/owner/repo.git').hostname).toBe('github.com');
      expect(parseRemoteUrl('git@GIT.Corp:owner/repo.git').hostname).toBe('git.corp');
    });

    it('returns null for remotes with no host', () => {
      expect(parseRemoteUrl('not-a-url').hostname).toBe(null);
      expect(parseRemoteUrl('/path/to/repo.git').hostname).toBe(null);
      expect(parseRemoteUrl('file:///path/to/repo.git').hostname).toBe(null);
      expect(parseRemoteUrl('../sibling-repo').hostname).toBe(null);
    });

  });

  describe('repoName (must match the historical getRepositoryName parser exactly)', () => {
    it('parses SCP-style SSH remotes with and without .git', () => {
      expect(parseRemoteUrl('git@github.com:owner/repo.git').repoName).toBe('owner/repo');
      expect(parseRemoteUrl('git@github.com:owner/repo').repoName).toBe('owner/repo');
    });

    it('parses HTTPS remotes with and without .git', () => {
      expect(parseRemoteUrl('https://github.com/owner/repo.git').repoName).toBe('owner/repo');
      expect(parseRemoteUrl('https://github.com/owner/repo').repoName).toBe('owner/repo');
    });

    it('preserves the legacy quirks for user-bearing ssh:// remotes', () => {
      // These outputs are wrong-looking but are exactly what getRepositoryName
      // has always returned: the `://` URL contains both ':' and '@', so the
      // SCP branch wins and splits on the LAST colon. Locked in deliberately —
      // changing it would rename existing local reviews.
      expect(parseRemoteUrl('ssh://git@github.com/owner/repo.git').repoName)
        .toBe('/git@github.com/owner/repo');
      expect(parseRemoteUrl('ssh://git@github.com:22/owner/repo.git').repoName)
        .toBe('22/owner/repo');
    });

    it('returns a bare name when the remote has no owner segment', () => {
      expect(parseRemoteUrl('git@github.com:repo.git').repoName).toBe('repo');
      expect(parseRemoteUrl('not-a-url').repoName).toBe('not-a-url');
    });

    it('returns null when nothing usable remains', () => {
      expect(parseRemoteUrl('https://github.com/').repoName).toBe(null);
      expect(parseRemoteUrl('').repoName).toBe(null);
      expect(parseRemoteUrl('   ').repoName).toBe(null);
      expect(parseRemoteUrl(null).repoName).toBe(null);
    });
  });
});

describe('getRemoteHostname', () => {
  const GIT_REMOTE_COMMAND = 'git config --get remote.origin.url';
  // The implementation moved to utils/host-resolution (local-review re-exports
  // it); the timeout constant comes from there.
  const { GIT_REMOTE_TIMEOUT_MS } = require('../../src/utils/host-resolution');

  it('returns the hostname of remote.origin.url', () => {
    const execSyncMock = vi.fn(() => 'git@git.corp:owner/repo.git\n');

    expect(getRemoteHostname('/some/repo', { execSync: execSyncMock })).toBe('git.corp');
    // The timeout is load-bearing: this runs on the blocking page-load path,
    // and a checkout on a hung network mount would otherwise stall execSync
    // forever.
    expect(execSyncMock).toHaveBeenCalledWith(GIT_REMOTE_COMMAND, {
      cwd: '/some/repo',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_REMOTE_TIMEOUT_MS
    });
    expect(GIT_REMOTE_TIMEOUT_MS).toBe(5000);
  });

  it('returns null (does not throw) when the git call TIMES OUT', () => {
    // execSync signals a timeout by throwing an ETIMEDOUT error, exactly like
    // any other failure — the contract is "null, never throw".
    const timeoutError = Object.assign(new Error('spawnSync git ETIMEDOUT'), {
      code: 'ETIMEDOUT',
      killed: true,
      signal: 'SIGTERM'
    });
    const execSyncMock = vi.fn(() => { throw timeoutError; });

    expect(getRemoteHostname('/hung/mount', { execSync: execSyncMock })).toBe(null);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the remote URL is empty', () => {
    const execSyncMock = vi.fn(() => '\n');
    expect(getRemoteHostname('/some/repo', { execSync: execSyncMock })).toBe(null);
  });

  it('reads a real checkout with a configured origin', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-remote-host-'));
    try {
      execSync('git init', { cwd: repoDir, stdio: 'pipe' });
      execSync('git remote add origin git@git.corp:owner/repo.git', { cwd: repoDir, stdio: 'pipe' });

      expect(getRemoteHostname(repoDir)).toBe('git.corp');
      // getRepositoryName keeps working off the same remote.
      await expect(getRepositoryName(repoDir)).resolves.toBe('owner/repo');
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('returns null for a real checkout with no origin remote (and the name falls back)', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-no-remote-'));
    try {
      execSync('git init', { cwd: repoDir, stdio: 'pipe' });

      expect(getRemoteHostname(repoDir)).toBe(null);
      // Unchanged legacy behaviour: no remote → directory basename.
      await expect(getRepositoryName(repoDir)).resolves.toBe(path.basename(repoDir));
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });
});

/**
 * FINDING 1 (CLI write entry point): the association WRITE side must resolve
 * the host through the SAME function as the metadata READ side.
 *
 * The association row is host-blind — it stores a PR number and an owner/repo,
 * nothing about which host that PR lives on. So on a DUAL repo (`api_host` +
 * `exclusive: false`), a write side that binds the github.com GUESS while the
 * read side binds the host the checkout's remote names associates github.com
 * PR #77 and then reads the alt host's unrelated PR #77 — caching its metadata
 * and letting the external-comments sync anchor a stranger's comments to the
 * reviewer's code.
 *
 * `setupLocalReviewSession` is the CLI seam (CLAUDE.md "CLI vs Web UI entry
 * points"); `POST /api/local/start` is covered in tests/integration/routes.test.js.
 */
describe('setupLocalReviewSession binds the same host the metadata read side resolves', () => {
  const { createTestDatabase, closeTestDatabase } = require('../utils/schema');
  const localReviewModule = require('../../src/local-review');
  const summaryGenerator = require('../../src/ai/summary-generator');
  const tourGenerator = require('../../src/ai/tour-generator');
  const prContext = require('../../src/providers/pr-context');
  const { localReviewDiffs } = require('../../src/routes/shared');

  const ALT_HOST = 'https://alt.example.com/api/v3';
  const REPO = 'owner/repo';
  const repoPath = '/mock/dual-checkout';

  /** DUAL: api_host present, exclusive:false, with an alt-host credential. */
  const dualConfig = () => ({
    port: 7247,
    github_token: 'GH_TOKEN',
    repos: { [REPO]: { api_host: ALT_HOST, exclusive: false, token: 'ALT_TOKEN' } }
  });

  let db;

  beforeEach(() => {
    db = createTestDatabase();
    // resolveHostBinding consults GITHUB_TOKEN for github.com bindings; the
    // developer's real env must not decide the outcome.
    vi.stubEnv('GITHUB_TOKEN', '');
    prContext._hostBindingInternals.clearHostBindingFailureCache();
    prContext._hostBindingInternals.clearRemoteHostnameCache();

    vi.spyOn(localReviewModule, 'getHeadSha').mockResolvedValue('abc123def456');
    vi.spyOn(localReviewModule, 'getRepositoryName').mockResolvedValue(REPO);
    vi.spyOn(localReviewModule, 'getCurrentBranch').mockResolvedValue('feature/x');
    vi.spyOn(localReviewModule, 'findMainGitRoot').mockResolvedValue(repoPath);
    vi.spyOn(localReviewModule, 'generateScopedDiff').mockResolvedValue({
      diff: '', stats: { trackedChanges: 0, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 0 }, mergeBaseSha: null
    });
    vi.spyOn(localReviewModule, 'computeScopedDigest').mockResolvedValue('digest123');
    vi.spyOn(localReviewModule, 'findMergeBase').mockResolvedValue(null);
    vi.spyOn(localReviewModule, 'getFirstCommitSubject').mockResolvedValue(null);
    vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue(null);
    vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockReturnValue(null);
    vi.spyOn(tourGenerator, 'kickOffTourJob').mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    prContext._hostBindingInternals.clearHostBindingFailureCache();
    prContext._hostBindingInternals.clearRemoteHostnameCache();
    localReviewDiffs.clear();
    vi.restoreAllMocks();
    closeTestDatabase(db);
  });

  /** Capture the binding the CLI feeds into branch → PR detection. */
  function captureDetectionBinding() {
    const captured = {};
    vi.spyOn(localReviewModule, 'detectAndBuildBranchInfo').mockImplementation(async (p, branch, options = {}) => {
      captured.hostBinding = options.hostBinding;
      captured.githubToken = options.githubToken;
      return null;
    });
    return captured;
  }

  /** What the READ side (GET /api/local/:id → fetchPRMetadata) would bind. */
  function readSideBinding(config) {
    return prContext.resolveAssociationBinding(
      { prNumber: 77, repository: REPO },
      config,
      { localPath: repoPath }
    );
  }

  it('binds the ALT host on both sides when the checkout remote names it', async () => {
    prContext._hostBindingInternals.setRemoteHostname(repoPath, 'alt.example.com');
    const config = dualConfig();
    const captured = captureDetectionBinding();

    const session = await localReviewModule.setupLocalReviewSession({
      db, config, repoPath, flags: {}, startBackgroundJobs: false
    });
    expect(session.sessionId).toBeDefined();

    // WRITE side: the alt host, from evidence — not the github.com guess.
    expect(captured.hostBinding).toMatchObject({ host: ALT_HOST, apiHost: ALT_HOST, token: 'ALT_TOKEN' });
    expect(captured.hostBinding.hostAmbiguous).toBeUndefined();
    expect(captured.githubToken).toBe('ALT_TOKEN');

    // READ side: the same host. This equality IS the invariant.
    const read = readSideBinding(config);
    expect(read.host).toBe(captured.hostBinding.host);
    expect(read.apiHost).toBe(captured.hostBinding.apiHost);
    expect(read.hostAmbiguous).toBeUndefined();
  });

  it('binds GITHUB.COM on both sides when the checkout remote names github', async () => {
    prContext._hostBindingInternals.setRemoteHostname(repoPath, 'github.com');
    const config = dualConfig();
    const captured = captureDetectionBinding();

    await localReviewModule.setupLocalReviewSession({
      db, config, repoPath, flags: {}, startBackgroundJobs: false
    });

    expect(captured.hostBinding).toMatchObject({ host: null, token: 'GH_TOKEN' });
    expect(captured.hostBinding.hostAmbiguous).toBeUndefined();
    expect(readSideBinding(config).host).toBe(captured.hostBinding.host);
  });

  it('stays AMBIGUOUS on both sides when the remote matches neither host', async () => {
    // The safe pre-existing behaviour: detection still runs on the
    // conservative guess, but the marker travels with it so the read side
    // refuses to persist a guessed host (see fetchPRMetadata).
    prContext._hostBindingInternals.setRemoteHostname(repoPath, 'mirror.internal');
    const config = dualConfig();
    const captured = captureDetectionBinding();

    await localReviewModule.setupLocalReviewSession({
      db, config, repoPath, flags: {}, startBackgroundJobs: false
    });

    expect(captured.hostBinding.hostAmbiguous).toBe(true);
    expect(readSideBinding(config).hostAmbiguous).toBe(true);
  });

  it('resolves the repos[...] key through the identity translation (url_pattern monorepo)', async () => {
    // A raw resolveHostBinding on the IDENTITY misses a url_pattern-keyed
    // entry and silently degrades to github.com + the global token — the
    // second half of the regression this write site had.
    prContext._hostBindingInternals.setRemoteHostname(repoPath, 'alt.example.com');
    const config = {
      port: 7247,
      github_token: 'GH_TOKEN',
      repos: {
        'alt-owner/monorepo': {
          api_host: ALT_HOST,
          exclusive: false,
          token: 'ALT_TOKEN',
          url_pattern: '^https://alt\\.example\\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)$'
        }
      }
    };
    const captured = captureDetectionBinding();

    await localReviewModule.setupLocalReviewSession({
      db, config, repoPath, flags: {}, startBackgroundJobs: false
    });

    expect(captured.hostBinding).toMatchObject({ host: ALT_HOST, token: 'ALT_TOKEN' });
    expect(readSideBinding(config)).toMatchObject({ host: ALT_HOST, token: 'ALT_TOKEN' });
  });
});
