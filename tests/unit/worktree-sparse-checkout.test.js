// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const { GitWorktreeManager } = require('../../src/git/worktree');

describe('GitWorktreeManager constructor and name template', () => {
  it('should use default worktree base directory when not provided', () => {
    const manager = new GitWorktreeManager();
    expect(manager.worktreeBaseDir).toContain('.pair-review/worktrees');
  });

  it('should use custom worktree base directory when provided', () => {
    const manager = new GitWorktreeManager(null, { worktreeBaseDir: '/custom/path' });
    expect(manager.worktreeBaseDir).toBe('/custom/path');
  });

  it('should use default name template when not provided', () => {
    const manager = new GitWorktreeManager();
    expect(manager.nameTemplate).toBe('{id}');
  });

  it('should use custom name template when provided', () => {
    const manager = new GitWorktreeManager(null, { nameTemplate: '{id}/src' });
    expect(manager.nameTemplate).toBe('{id}/src');
  });

  describe('applyNameTemplate', () => {
    it('should replace {id} with the worktree ID', () => {
      const manager = new GitWorktreeManager(null, { nameTemplate: '{id}' });
      const result = manager.applyNameTemplate({ id: 'abc123' });
      expect(result).toBe('abc123');
    });

    it('should replace {pr_number} with the PR number', () => {
      const manager = new GitWorktreeManager(null, { nameTemplate: 'pr-{pr_number}' });
      const result = manager.applyNameTemplate({ id: 'abc123', prNumber: 42 });
      expect(result).toBe('pr-42');
    });

    it('should replace {repo} with the repository name', () => {
      const manager = new GitWorktreeManager(null, { nameTemplate: '{repo}' });
      const result = manager.applyNameTemplate({ id: 'abc123', repo: 'my-repo' });
      expect(result).toBe('my-repo');
    });

    it('should replace {owner} with the repository owner', () => {
      const manager = new GitWorktreeManager(null, { nameTemplate: '{owner}' });
      const result = manager.applyNameTemplate({ id: 'abc123', owner: 'my-org' });
      expect(result).toBe('my-org');
    });

    it('should replace all variables in a complex template', () => {
      const manager = new GitWorktreeManager(null, { nameTemplate: 'pr-{pr_number}/{owner}/{repo}/{id}' });
      const result = manager.applyNameTemplate({ id: 'abc123', prNumber: 42, repo: 'my-repo', owner: 'my-org' });
      expect(result).toBe('pr-42/my-org/my-repo/abc123');
    });

    it('should handle templates with subdirectories', () => {
      const manager = new GitWorktreeManager(null, { nameTemplate: '{id}/src' });
      const result = manager.applyNameTemplate({ id: 'abc123' });
      expect(result).toBe('abc123/src');
    });

    it('should handle multiple occurrences of the same variable', () => {
      const manager = new GitWorktreeManager(null, { nameTemplate: '{id}-{id}' });
      const result = manager.applyNameTemplate({ id: 'abc123' });
      expect(result).toBe('abc123-abc123');
    });

    it('should leave unreplaced variables when context is missing', () => {
      const manager = new GitWorktreeManager(null, { nameTemplate: '{id}-{pr_number}' });
      const result = manager.applyNameTemplate({ id: 'abc123' });
      expect(result).toBe('abc123-{pr_number}');
    });

    it('should replace id with undefined when not in context', () => {
      const manager = new GitWorktreeManager(null, { nameTemplate: '{id}' });
      const result = manager.applyNameTemplate({});
      // id is always replaced (with undefined if not provided), but optional vars are preserved
      expect(result).toBe('undefined');
    });
  });
});

describe('GitWorktreeManager sparse-checkout methods', () => {
  let testDir;
  let worktreeManager;

  beforeEach(async () => {
    // Create a temporary directory with a git repo
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-sparse-test-'));
    worktreeManager = new GitWorktreeManager();

    // Initialize git repo
    execSync('git init', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });

    // Create initial file and commit
    await fs.mkdir(path.join(testDir, 'packages', 'core'), { recursive: true });
    await fs.writeFile(path.join(testDir, 'packages', 'core', 'index.js'), 'export default {};\n');
    await fs.writeFile(path.join(testDir, 'README.md'), '# Test\n');
    execSync('git add .', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    // Cleanup
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe('isSparseCheckoutEnabled', () => {
    it('should return false for a normal repo without sparse-checkout', async () => {
      const isEnabled = await worktreeManager.isSparseCheckoutEnabled(testDir);
      expect(isEnabled).toBe(false);
    });

    it('should return true when sparse-checkout is enabled', async () => {
      // Enable sparse-checkout
      execSync('git config core.sparseCheckout true', { cwd: testDir, stdio: 'pipe' });

      const isEnabled = await worktreeManager.isSparseCheckoutEnabled(testDir);
      expect(isEnabled).toBe(true);
    });

    it('should return false for non-existent path', async () => {
      const isEnabled = await worktreeManager.isSparseCheckoutEnabled('/non/existent/path');
      expect(isEnabled).toBe(false);
    });
  });

  describe('getSparseCheckoutPatterns', () => {
    it('should return empty array for repo without sparse-checkout patterns', async () => {
      const patterns = await worktreeManager.getSparseCheckoutPatterns(testDir);
      expect(patterns).toEqual([]);
    });

    it('should return patterns when sparse-checkout is configured', async () => {
      // Enable sparse-checkout with patterns
      execSync('git sparse-checkout init', { cwd: testDir, stdio: 'pipe' });
      execSync('git sparse-checkout set packages/core', { cwd: testDir, stdio: 'pipe' });

      const patterns = await worktreeManager.getSparseCheckoutPatterns(testDir);
      expect(patterns).toContain('packages/core');
    });

    it('should return multiple patterns', async () => {
      // Create additional directory structure for testing multiple patterns
      await fs.mkdir(path.join(testDir, 'packages', 'utils'), { recursive: true });
      await fs.writeFile(path.join(testDir, 'packages', 'utils', 'index.js'), 'export {};\n');
      execSync('git add .', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Add utils package"', { cwd: testDir, stdio: 'pipe' });

      // Enable sparse-checkout with multiple directory patterns
      execSync('git sparse-checkout init', { cwd: testDir, stdio: 'pipe' });
      execSync('git sparse-checkout set packages/core packages/utils', { cwd: testDir, stdio: 'pipe' });

      const patterns = await worktreeManager.getSparseCheckoutPatterns(testDir);
      expect(patterns.length).toBeGreaterThanOrEqual(2);
      expect(patterns).toContain('packages/core');
      expect(patterns).toContain('packages/utils');
    });

    it('should return empty array for non-existent path', async () => {
      const patterns = await worktreeManager.getSparseCheckoutPatterns('/non/existent/path');
      expect(patterns).toEqual([]);
    });
  });

  describe('ensurePRDirectoriesInSparseCheckout', () => {
    it('should return empty array when sparse-checkout is not enabled', async () => {
      const changedFiles = [{ filename: 'packages/core/index.js' }];

      const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(testDir, changedFiles);
      expect(addedDirs).toEqual([]);
    });

    it('should return empty array when all directories are already covered', async () => {
      // Enable sparse-checkout with the needed patterns
      // Use 'packages' as parent to cover 'packages/core'
      execSync('git sparse-checkout init', { cwd: testDir, stdio: 'pipe' });
      execSync('git sparse-checkout set packages', { cwd: testDir, stdio: 'pipe' });

      const changedFiles = [{ filename: 'packages/core/index.js' }];

      const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(testDir, changedFiles);
      expect(addedDirs).toEqual([]);
    });

    it('should add missing directories to sparse-checkout', async () => {
      // Create another directory structure we want to add
      await fs.mkdir(path.join(testDir, 'libs', 'shared'), { recursive: true });
      await fs.writeFile(path.join(testDir, 'libs', 'shared', 'helpers.js'), 'export {};\n');
      execSync('git add libs', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Add libs package"', { cwd: testDir, stdio: 'pipe' });

      // Enable sparse-checkout with only packages, not libs
      execSync('git sparse-checkout init', { cwd: testDir, stdio: 'pipe' });
      execSync('git sparse-checkout set packages', { cwd: testDir, stdio: 'pipe' });

      const changedFiles = [{ filename: 'libs/shared/helpers.js' }];

      const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(testDir, changedFiles);
      // Should add minimal directory set
      expect(addedDirs.length).toBeGreaterThan(0);
      expect(addedDirs.some(d => d.includes('libs'))).toBe(true);
    });

    it('should handle files with "file" property instead of "filename"', async () => {
      const changedFiles = [{ file: 'packages/core/index.js' }];

      // Even without sparse-checkout enabled, it should handle the file property
      const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(testDir, changedFiles);
      expect(addedDirs).toEqual([]);
    });

    it('should handle empty changedFiles array', async () => {
      // Enable sparse-checkout
      execSync('git sparse-checkout init', { cwd: testDir, stdio: 'pipe' });
      execSync('git sparse-checkout set packages', { cwd: testDir, stdio: 'pipe' });

      const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(testDir, []);
      expect(addedDirs).toEqual([]);
    });

    it('should handle files without filename or file property', async () => {
      // Enable sparse-checkout
      execSync('git sparse-checkout init', { cwd: testDir, stdio: 'pipe' });
      execSync('git sparse-checkout set packages', { cwd: testDir, stdio: 'pipe' });

      const changedFiles = [{ status: 'modified' }, { other: 'data' }];

      const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(testDir, changedFiles);
      expect(addedDirs).toEqual([]);
    });

    it('should only extract immediate parent directories, not all ancestors', async () => {
      // Create deeply nested structure
      await fs.mkdir(path.join(testDir, 'packages', 'foo', 'src', 'lib'), { recursive: true });
      await fs.writeFile(path.join(testDir, 'packages', 'foo', 'src', 'lib', 'deep.js'), 'export {};\n');
      execSync('git add .', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Add deep structure"', { cwd: testDir, stdio: 'pipe' });

      // Enable sparse-checkout with a minimal pattern
      execSync('git sparse-checkout init', { cwd: testDir, stdio: 'pipe' });
      execSync('git sparse-checkout set packages/core', { cwd: testDir, stdio: 'pipe' });

      const changedFiles = [
        { filename: 'packages/foo/src/lib/deep.js' }
      ];

      const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(testDir, changedFiles);
      // Should add only the immediate parent 'packages/foo/src/lib',
      // NOT 'packages', 'packages/foo', or 'packages/foo/src'
      expect(addedDirs).toEqual(['packages/foo/src/lib']);
    });

    it('should not consider parent dir covered when only a child pattern exists', async () => {
      // Setup: sparse-checkout has 'packages/core' but a changed file is
      // directly under 'packages/' (e.g., 'packages/package.json')
      await fs.writeFile(path.join(testDir, 'packages', 'package.json'), '{}\n');
      execSync('git add .', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Add packages/package.json"', { cwd: testDir, stdio: 'pipe' });

      // Enable sparse-checkout with only packages/core
      execSync('git sparse-checkout init', { cwd: testDir, stdio: 'pipe' });
      execSync('git sparse-checkout set packages/core', { cwd: testDir, stdio: 'pipe' });

      const changedFiles = [
        { filename: 'packages/package.json' }
      ];

      const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(testDir, changedFiles);
      // 'packages' should NOT be considered covered by 'packages/core' —
      // the child pattern doesn't cover files at the parent level
      expect(addedDirs).toContain('packages');
    });

    it('should find minimal set of directories (avoid redundant parents)', async () => {
      // Create nested structure first (before sparse-checkout)
      await fs.mkdir(path.join(testDir, 'src', 'utils', 'deep'), { recursive: true });
      await fs.writeFile(path.join(testDir, 'src', 'index.js'), 'export {};\n');
      await fs.writeFile(path.join(testDir, 'src', 'utils', 'helper.js'), 'export {};\n');
      await fs.writeFile(path.join(testDir, 'src', 'utils', 'deep', 'nested.js'), 'export {};\n');
      execSync('git add src', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit -m "Add src structure"', { cwd: testDir, stdio: 'pipe' });

      // Enable sparse-checkout with only packages directory
      execSync('git sparse-checkout init', { cwd: testDir, stdio: 'pipe' });
      execSync('git sparse-checkout set packages', { cwd: testDir, stdio: 'pipe' });

      const changedFiles = [
        { filename: 'src/index.js' },
        { filename: 'src/utils/helper.js' },
        { filename: 'src/utils/deep/nested.js' }
      ];

      const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(testDir, changedFiles);
      // Should add 'src' which covers all, not 'src', 'src/utils', 'src/utils/deep'
      expect(addedDirs).toContain('src');
      // Should not contain child directories if parent is added
      expect(addedDirs).not.toContain('src/utils');
      expect(addedDirs).not.toContain('src/utils/deep');
    });
  });

  describe('executeCheckoutScript', () => {
    it('should execute script with correct env vars and CWD', async () => {
      // Create a script that writes env vars and CWD to a file
      const outputFile = path.join(testDir, 'script-output.txt');
      const scriptPath = path.join(testDir, 'test-script.sh');
      await fs.writeFile(scriptPath, `#!/bin/sh
echo "CWD=$(pwd)" > "${outputFile}"
echo "BASE_BRANCH=$BASE_BRANCH" >> "${outputFile}"
echo "HEAD_BRANCH=$HEAD_BRANCH" >> "${outputFile}"
echo "BASE_SHA=$BASE_SHA" >> "${outputFile}"
echo "HEAD_SHA=$HEAD_SHA" >> "${outputFile}"
echo "PR_NUMBER=$PR_NUMBER" >> "${outputFile}"
echo "WORKTREE_PATH=$WORKTREE_PATH" >> "${outputFile}"
`, { mode: 0o755 });

      const env = {
        BASE_BRANCH: 'main',
        HEAD_BRANCH: 'feature/test',
        BASE_SHA: 'abc123',
        HEAD_SHA: 'def456',
        PR_NUMBER: '42',
        WORKTREE_PATH: testDir
      };

      await worktreeManager.executeCheckoutScript(scriptPath, testDir, env);

      const output = await fs.readFile(outputFile, 'utf8');
      // On macOS, /var is symlinked to /private/var, so pwd resolves the symlink.
      // Use fs.realpath to get the canonical path for comparison.
      const realTestDir = await fs.realpath(testDir);
      expect(output).toContain(`CWD=${realTestDir}`);
      expect(output).toContain('BASE_BRANCH=main');
      expect(output).toContain('HEAD_BRANCH=feature/test');
      expect(output).toContain('BASE_SHA=abc123');
      expect(output).toContain('HEAD_SHA=def456');
      expect(output).toContain('PR_NUMBER=42');
      expect(output).toContain(`WORKTREE_PATH=${testDir}`);
    });

    it('should resolve with stdout and stderr on success', async () => {
      const scriptPath = path.join(testDir, 'echo-script.sh');
      await fs.writeFile(scriptPath, `#!/bin/sh
echo "hello stdout"
echo "hello stderr" >&2
`, { mode: 0o755 });

      const result = await worktreeManager.executeCheckoutScript(scriptPath, testDir, {});
      expect(result.stdout).toContain('hello stdout');
      expect(result.stderr).toContain('hello stderr');
    });

    it('should reject on non-zero exit code with stdout/stderr in error', async () => {
      const scriptPath = path.join(testDir, 'fail-script.sh');
      await fs.writeFile(scriptPath, `#!/bin/sh
echo "some output"
echo "some error" >&2
exit 1
`, { mode: 0o755 });

      await expect(
        worktreeManager.executeCheckoutScript(scriptPath, testDir, {})
      ).rejects.toThrow(/exited with code 1/);

      try {
        await worktreeManager.executeCheckoutScript(scriptPath, testDir, {});
      } catch (err) {
        expect(err.message).toContain('some output');
        expect(err.message).toContain('some error');
      }
    });

    it('should reject on timeout', async () => {
      const scriptPath = path.join(testDir, 'slow-script.sh');
      await fs.writeFile(scriptPath, `#!/bin/sh
sleep 30
`, { mode: 0o755 });

      await expect(
        worktreeManager.executeCheckoutScript(scriptPath, testDir, {}, 100)
      ).rejects.toThrow(/timed out/);
    });

    it('should reject on ENOENT (command not found)', async () => {
      await expect(
        worktreeManager.executeCheckoutScript('/nonexistent/script.sh', testDir, {})
      ).rejects.toThrow(/not found|No such file|ENOENT|code 127/);
    });
  });
});
