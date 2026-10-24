// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import express from 'express';
import nodeFs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const fsPromises = require('fs').promises;
const { run } = require('../../src/database');
const reviewsRoutes = require('../../src/routes/reviews');

function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.use('/', reviewsRoutes);
  return app;
}

describe('GET /api/reviews/:reviewId/file-content/:fileName', () => {
  let db;
  let app;
  let server;
  let readFileSpy;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    server = await listenOnLoopback(app);
    readFileSpy = vi.spyOn(fsPromises, 'readFile');
  });

  afterEach(async () => {
    await closeServer(server);
    readFileSpy?.mockRestore();
    vi.restoreAllMocks();
    if (db) {
      await closeTestDatabase(db);
    }
  });

  it('prefers the diff blob over a stale base_sha in PR mode', async () => {
    const tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-file-content-'));

    try {
      execSync('git init -b main', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git config user.name "Test User"', { cwd: tempRepo, stdio: 'pipe' });

      const relativeFile = 'src/file.js';
      const repoFile = path.join(tempRepo, relativeFile);
      nodeFs.mkdirSync(path.dirname(repoFile), { recursive: true });

      nodeFs.writeFileSync(repoFile, 'stale line 1\nstale line 2\nshared line\n');
      execSync(`git add ${relativeFile}`, { cwd: tempRepo, stdio: 'pipe' });
      execSync('git commit -m "stale base"', { cwd: tempRepo, stdio: 'pipe' });
      const staleBaseSha = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();

      nodeFs.writeFileSync(repoFile, 'correct old 1\ncorrect old 2\nshared line\n');
      execSync(`git add ${relativeFile}`, { cwd: tempRepo, stdio: 'pipe' });
      execSync('git commit -m "real base"', { cwd: tempRepo, stdio: 'pipe' });
      const actualBaseSha = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();

      nodeFs.writeFileSync(repoFile, 'correct new 1\ncorrect old 2\nshared line\nadded line\n');
      execSync(`git add ${relativeFile}`, { cwd: tempRepo, stdio: 'pipe' });
      execSync('git commit -m "head"', { cwd: tempRepo, stdio: 'pipe' });
      const headSha = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
      const diff = execSync(`git diff --unified=3 ${actualBaseSha}...${headSha} -- ${relativeFile}`, {
        cwd: tempRepo,
        encoding: 'utf8'
      });

      const prData = JSON.stringify({
        worktree_path: tempRepo,
        state: 'open',
        diff,
        changed_files: [{ file: relativeFile, additions: 2, deletions: 1 }],
        base_sha: staleBaseSha,
        head_sha: headSha
      });

      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [10, 'owner/repo', 'Test PR', 'Description', 'user', 'main', 'feature', prData]);

      const reviewResult = await run(db, `
        INSERT INTO reviews (pr_number, repository, status, created_at, updated_at)
        VALUES (?, ?, 'draft', datetime('now'), datetime('now'))
      `, [10, 'owner/repo']);

      const response = await request(server)
        .get(`/api/reviews/${reviewResult.lastID}/file-content/${encodeURIComponent(relativeFile)}`);

      expect(response.status).toBe(200);
      expect(response.body.lines.slice(0, 3)).toEqual([
        'correct old 1',
        'correct old 2',
        'shared line'
      ]);
      expect(response.body.lines[0]).not.toBe('stale line 1');
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      nodeFs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('falls back from an unusable diff blob to base_sha content before reading HEAD', async () => {
    const tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-file-content-'));

    try {
      execSync('git init -b main', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git config user.name "Test User"', { cwd: tempRepo, stdio: 'pipe' });

      const relativeFile = 'src/file.js';
      const repoFile = path.join(tempRepo, relativeFile);
      nodeFs.mkdirSync(path.dirname(repoFile), { recursive: true });

      nodeFs.writeFileSync(repoFile, 'correct old 1\ncorrect old 2\nshared line\n');
      execSync(`git add ${relativeFile}`, { cwd: tempRepo, stdio: 'pipe' });
      execSync('git commit -m "real base"', { cwd: tempRepo, stdio: 'pipe' });
      const baseSha = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();

      nodeFs.writeFileSync(repoFile, 'correct new 1\ncorrect old 2\nshared line\nadded line\n');
      execSync(`git add ${relativeFile}`, { cwd: tempRepo, stdio: 'pipe' });
      execSync('git commit -m "head"', { cwd: tempRepo, stdio: 'pipe' });
      const headSha = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();

      const prData = JSON.stringify({
        state: 'open',
        diff: [
          `diff --git a/${relativeFile} b/${relativeFile}`,
          'index deadbee..feedbee 100644',
          `--- a/${relativeFile}`,
          `+++ b/${relativeFile}`,
          '@@ -1,3 +1,4 @@'
        ].join('\n'),
        changed_files: [{ file: relativeFile, additions: 2, deletions: 1 }],
        base_sha: baseSha,
        head_sha: headSha,
        worktree_path: tempRepo
      });

      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [11, 'owner/repo', 'Test PR', 'Description', 'user', 'main', 'feature', prData]);

      const reviewResult = await run(db, `
        INSERT INTO reviews (pr_number, repository, status, created_at, updated_at)
        VALUES (?, ?, 'draft', datetime('now'), datetime('now'))
      `, [11, 'owner/repo']);

      const response = await request(server)
        .get(`/api/reviews/${reviewResult.lastID}/file-content/${encodeURIComponent(relativeFile)}`);

      expect(response.status).toBe(200);
      expect(response.body.lines.slice(0, 3)).toEqual([
        'correct old 1',
        'correct old 2',
        'shared line'
      ]);
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      nodeFs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('reads an off-diff file from the PR head after the base branch advances', async () => {
    const tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-base-drift-'));
    try {
      execSync('git init -b main', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git config user.name "Test User"', { cwd: tempRepo, stdio: 'pipe' });
      nodeFs.writeFileSync(path.join(tempRepo, 'helper.js'), 'head line 1\nhead line 2\n');
      nodeFs.writeFileSync(path.join(tempRepo, 'changed.js'), 'before\n');
      execSync('git add .', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git commit -m fork', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git checkout -b feature', { cwd: tempRepo, stdio: 'pipe' });
      nodeFs.writeFileSync(path.join(tempRepo, 'changed.js'), 'after\n');
      execSync('git add .', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git commit -m feature', { cwd: tempRepo, stdio: 'pipe' });
      const headSha = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
      execSync('git checkout main', { cwd: tempRepo, stdio: 'pipe' });
      nodeFs.writeFileSync(path.join(tempRepo, 'helper.js'), 'base-only prepended line\nhead line 1\nhead line 2\n');
      execSync('git add .', { cwd: tempRepo, stdio: 'pipe' });
      execSync('git commit -m base-drift', { cwd: tempRepo, stdio: 'pipe' });
      const baseSha = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
      execSync('git checkout feature', { cwd: tempRepo, stdio: 'pipe' });
      const diff = execSync('git diff main...feature', { cwd: tempRepo, encoding: 'utf8' });
      expect(diff).not.toContain('helper.js');
      const prData = JSON.stringify({
        worktree_path: tempRepo, diff, base_sha: baseSha, head_sha: headSha,
        changed_files: [{ file: 'changed.js' }]
      });
      await run(db, `INSERT INTO pr_metadata (pr_number, repository, pr_data)
        VALUES (12, 'owner/repo', ?)`, [prData]);
      const review = await run(db, `INSERT INTO reviews (pr_number, repository, status)
        VALUES (12, 'owner/repo', 'draft')`);

      const response = await request(server).get(`/api/reviews/${review.lastID}/file-content/helper.js`);

      expect(response.status).toBe(200);
      expect(response.body.lines.slice(0, 2)).toEqual(['head line 1', 'head line 2']);
      expect(readFileSpy).toHaveBeenCalled();
    } finally {
      nodeFs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  // The diff spells these names quoted: `quo"te.js` always, `café.js` in a
  // diff cached with git's default core.quotePath=true. Membership decodes the
  // headers, so both are in-diff files served from the base blob, not the
  // checkout an unchanged (context) file is read from.
  it.each(['quo"te.js', 'café.js'])('serves the base version of in-diff file %s whose header is quoted', async file => {
    const tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-quoted-file-content-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: tempRepo, encoding: 'utf8', stdio: 'pipe' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test User');
      git('config', 'core.quotePath', 'true');
      nodeFs.writeFileSync(path.join(tempRepo, file), 'base line 1\nbase line 2\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      const baseSha = git('rev-parse', 'HEAD').trim();
      nodeFs.writeFileSync(path.join(tempRepo, file), 'head line 1\nbase line 2\n');
      git('commit', '-q', '-am', 'head');
      const headSha = git('rev-parse', 'HEAD').trim();
      const diff = git('diff', '--full-index', `${baseSha}...${headSha}`);
      expect(diff).toMatch(/^diff --git "a\//m);

      await run(db, `INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (14, 'owner/repo', ?)`, [
        JSON.stringify({ worktree_path: tempRepo, diff, base_sha: baseSha, head_sha: headSha, changed_files: [{ file }] })
      ]);
      const review = await run(db, `INSERT INTO reviews (pr_number, repository, status) VALUES (14, 'owner/repo', 'draft')`);

      const response = await request(server).get(`/api/reviews/${review.lastID}/file-content/${encodeURIComponent(file)}`);

      expect(response.status).toBe(200);
      expect(response.body.lines[0]).toBe('base line 1');
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      nodeFs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('returns 404 when the PR checkout cannot be found', async () => {
    await run(db, `INSERT INTO pr_metadata (pr_number, repository, pr_data)
      VALUES (13, 'owner/repo', ?)`, [JSON.stringify({ diff: '', changed_files: [] })]);
    const review = await run(db, `INSERT INTO reviews (pr_number, repository, status)
      VALUES (13, 'owner/repo', 'draft')`);

    const response = await request(server).get(`/api/reviews/${review.lastID}/file-content/helper.js`);

    expect(response.status).toBe(404);
  });

  describe('Local mode', () => {
    let tempRepo;
    let outsideDir;
    let headSha;

    function git(command) {
      return execSync(`git ${command}`, { cwd: tempRepo, encoding: 'utf8', stdio: 'pipe' });
    }

    // The persisted diff snapshot holds only the unstaged edit (changed.js),
    // as the default unstaged..untracked scope would after `git diff`.
    async function insertLocalReview({ head = headSha, snapshot = true } = {}) {
      const review = await run(db, `
        INSERT INTO reviews (review_type, repository, local_path, local_head_sha, status, local_scope_start, local_scope_end)
        VALUES ('local', 'local/repo', ?, ?, 'draft', 'unstaged', 'untracked')
      `, [tempRepo, head]);
      if (snapshot) {
        await run(db, 'INSERT INTO local_diffs (review_id, diff_text) VALUES (?, ?)', [review.lastID, git('diff')]);
      }
      return review.lastID;
    }

    const fileContent = (reviewId, file) =>
      request(server).get(`/api/reviews/${reviewId}/file-content/${encodeURIComponent(file)}`);

    beforeEach(() => {
      tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-local-file-content-'));
      outsideDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-local-outside-'));
      git('init -b main');
      git('config user.email "test@test.com"');
      git('config user.name "Test User"');
      nodeFs.writeFileSync(path.join(tempRepo, 'staged.js'), 'head line 1\nhead line 2\n');
      nodeFs.writeFileSync(path.join(tempRepo, 'changed.js'), 'head changed 1\nhead changed 2\n');
      git('add .');
      git('commit -m base');
      headSha = git('rev-parse HEAD').trim();
      // Staged only: outside the default unstaged..untracked scope, yet the
      // working tree (what the AI read) differs from HEAD.
      nodeFs.writeFileSync(path.join(tempRepo, 'staged.js'), 'inserted line\nhead line 1\nhead line 2\n');
      git('add staged.js');
      // Unstaged: inside the scope and the diff.
      nodeFs.writeFileSync(path.join(tempRepo, 'changed.js'), 'worktree changed 1\nhead changed 2\n');
      // Untracked: not in HEAD at all.
      nodeFs.writeFileSync(path.join(tempRepo, 'untracked.js'), 'untracked line\n');
    });

    afterEach(() => {
      nodeFs.rmSync(tempRepo, { recursive: true, force: true });
      nodeFs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('serves the working tree for a file outside the diff', async () => {
      const reviewId = await insertLocalReview();
      const response = await fileContent(reviewId, 'staged.js');

      expect(response.status).toBe(200);
      expect(response.body.lines.slice(0, 3)).toEqual(['inserted line', 'head line 1', 'head line 2']);
      expect(readFileSpy).toHaveBeenCalled();
    });

    it('serves HEAD for a file in the diff', async () => {
      const reviewId = await insertLocalReview();
      const response = await fileContent(reviewId, 'changed.js');

      expect(response.status).toBe(200);
      expect(response.body.lines.slice(0, 2)).toEqual(['head changed 1', 'head changed 2']);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('serves HEAD first when the review has no diff snapshot', async () => {
      const reviewId = await insertLocalReview({ snapshot: false });
      const response = await fileContent(reviewId, 'staged.js');

      expect(response.status).toBe(200);
      expect(response.body.lines[0]).toBe('head line 1');
    });

    it('serves the working tree for a file that is not in HEAD', async () => {
      const reviewId = await insertLocalReview();
      const response = await fileContent(reviewId, 'untracked.js');

      expect(response.status).toBe(200);
      expect(response.body.lines[0]).toBe('untracked line');
    });

    it('serves the working tree when the review has no HEAD sha', async () => {
      const reviewId = await insertLocalReview({ head: null });
      const response = await fileContent(reviewId, 'changed.js');

      expect(response.status).toBe(200);
      expect(response.body.lines[0]).toBe('worktree changed 1');
    });

    it('refuses a path that resolves outside the repository', async () => {
      nodeFs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret\n');
      nodeFs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(tempRepo, 'escape.txt'));
      const reviewId = await insertLocalReview();
      const response = await fileContent(reviewId, 'escape.txt');

      expect(response.status).toBe(403);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    // `git diff` in this repo quotes both names (core.quotePath defaults to
    // true), as a snapshot cached by an older version would. Decoded, both
    // are in the diff and read HEAD, not the working tree.
    it.each(['quo"te.js', 'café.js'])('serves HEAD for in-diff file %s whose snapshot header is quoted', async file => {
      nodeFs.writeFileSync(path.join(tempRepo, file), 'head quoted 1\n');
      git('add -A');
      git('commit -m quoted');
      const quotedHead = git('rev-parse HEAD').trim();
      nodeFs.writeFileSync(path.join(tempRepo, file), 'worktree quoted 1\n');
      expect(git('diff')).toMatch(/^diff --git "a\//m);

      const reviewId = await insertLocalReview({ head: quotedHead });
      const response = await fileContent(reviewId, file);

      expect(response.status).toBe(200);
      expect(response.body.lines[0]).toBe('head quoted 1');
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('returns 404 for a file missing from the working tree', async () => {
      const reviewId = await insertLocalReview();
      const response = await fileContent(reviewId, 'missing.js');

      expect(response.status).toBe(404);
    });
  });
});
