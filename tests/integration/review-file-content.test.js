// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import express from 'express';
import nodeFs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const fsPromises = require('fs').promises;
const { run } = require('../../src/database');
const { GitWorktreeManager } = require('../../src/git/worktree');
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
  let readFileSpy;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    readFileSpy = vi.spyOn(fsPromises, 'readFile');
  });

  afterEach(async () => {
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

      vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue(tempRepo);
      vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);

      const response = await request(app)
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
        head_sha: headSha
      });

      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [11, 'owner/repo', 'Test PR', 'Description', 'user', 'main', 'feature', prData]);

      const reviewResult = await run(db, `
        INSERT INTO reviews (pr_number, repository, status, created_at, updated_at)
        VALUES (?, ?, 'draft', datetime('now'), datetime('now'))
      `, [11, 'owner/repo']);

      vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue(tempRepo);
      vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);

      const response = await request(app)
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
});
