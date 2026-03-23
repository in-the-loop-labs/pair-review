// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const { generateBranchDiff, getBranchCommitCount, getFirstCommitSubject } = require('../../src/local-review');

describe('generateBranchDiff', () => {
  let testDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-branch-test-'));

    // Initialize git repo with a main branch
    execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });

    // Create initial commit on main
    await fs.writeFile(path.join(testDir, 'file.txt'), 'initial content\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });

    // Create a feature branch with commits
    execSync('git checkout -b feature', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'file.txt'), 'modified content\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "First feature change"', { cwd: testDir, stdio: 'pipe' });

    await fs.writeFile(path.join(testDir, 'new-file.js'), 'console.log("hello");\n');
    execSync('git add new-file.js', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Add new file"', { cwd: testDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('generates diff between feature branch and main', async () => {
    const result = await generateBranchDiff(testDir, 'main');

    expect(result.diff).toContain('diff --git');
    expect(result.diff).toContain('modified content');
    expect(result.diff).toContain('new-file.js');
    expect(result.stats.trackedChanges).toBe(2);
    expect(result.mergeBaseSha).toMatch(/^[a-f0-9]{40}$/);
  });

  it('returns empty diff when branch matches base', async () => {
    // Switch to main — main has no changes ahead of itself
    execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });

    // Create a no-op branch at the same point as main
    execSync('git checkout -b no-changes', { cwd: testDir, stdio: 'pipe' });

    const result = await generateBranchDiff(testDir, 'main');

    expect(result.diff.trim()).toBe('');
    expect(result.stats.trackedChanges).toBe(0);
  });

  it('respects hideWhitespace option', async () => {
    // Go back to main and add a file, then branch and make whitespace-only change
    execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'ws-file.txt'), 'hello world\n');
    execSync('git add ws-file.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Add ws file on main"', { cwd: testDir, stdio: 'pipe' });

    execSync('git checkout -b ws-test', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'ws-file.txt'), 'hello   world\n');
    execSync('git add ws-file.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Whitespace change"', { cwd: testDir, stdio: 'pipe' });

    const withWs = await generateBranchDiff(testDir, 'main');
    const withoutWs = await generateBranchDiff(testDir, 'main', { hideWhitespace: true });

    // With -w, the whitespace-only file should NOT appear in the diff
    expect(withWs.diff).toContain('ws-file.txt');
    expect(withoutWs.diff).not.toContain('ws-file.txt');
  });
});

describe('getBranchCommitCount', () => {
  let testDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-count-test-'));

    execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });

    await fs.writeFile(path.join(testDir, 'file.txt'), 'initial\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial"', { cwd: testDir, stdio: 'pipe' });

    execSync('git checkout -b feature', { cwd: testDir, stdio: 'pipe' });

    // Add 3 commits on the feature branch
    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(path.join(testDir, `file${i}.txt`), `content ${i}\n`);
      execSync(`git add file${i}.txt`, { cwd: testDir, stdio: 'pipe' });
      execSync(`git commit -m "Commit ${i}"`, { cwd: testDir, stdio: 'pipe' });
    }
  });

  afterEach(async () => {
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('returns correct commit count', async () => {
    const count = await getBranchCommitCount(testDir, 'main');
    expect(count).toBe(3);
  });

  it('returns 0 when on same commit as base', async () => {
    execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });
    execSync('git checkout -b same-as-main', { cwd: testDir, stdio: 'pipe' });

    const count = await getBranchCommitCount(testDir, 'main');
    expect(count).toBe(0);
  });
});

describe('getFirstCommitSubject', () => {
  let testDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-subject-test-'));

    execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'pipe' });

    await fs.writeFile(path.join(testDir, 'file.txt'), 'initial\n');
    execSync('git add file.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial"', { cwd: testDir, stdio: 'pipe' });

    execSync('git checkout -b feature', { cwd: testDir, stdio: 'pipe' });

    await fs.writeFile(path.join(testDir, 'a.txt'), '1\n');
    execSync('git add a.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "First feature commit"', { cwd: testDir, stdio: 'pipe' });

    await fs.writeFile(path.join(testDir, 'b.txt'), '2\n');
    execSync('git add b.txt', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Second feature commit"', { cwd: testDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('returns the first commit subject on the branch', async () => {
    const subject = await getFirstCommitSubject(testDir, 'main');
    expect(subject).toBe('First feature commit');
  });

  it('returns null when no commits ahead', async () => {
    execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });
    execSync('git checkout -b no-commits', { cwd: testDir, stdio: 'pipe' });

    const subject = await getFirstCommitSubject(testDir, 'main');
    expect(subject).toBeNull();
  });
});
