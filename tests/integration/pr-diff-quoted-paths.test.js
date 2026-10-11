// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * GET /api/pr/:owner/:repo/:number/diff path spelling.
 *
 * - A review cached by an older version holds git's quoted spelling in both
 *   the diff headers and changed_files; the endpoint serves decoded paths
 *   with no duplicate entries until the review is refreshed.
 * - `?w=1` regenerates the diff from the worktree (a real git repo here, with
 *   core.quotePath=true in its config) and builds changed_files from that
 *   diff: verbatim non-ASCII names, explicit renames, numstat-equal counts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const configModule = require('../../src/config');
const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-cfg-'));
vi.spyOn(configModule, 'getConfigDir').mockReturnValue(testConfigDir);

const prRoutes = require('../../src/routes/pr');
const { run } = require('../../src/database');
const { QUOTEPATH_TRUE_DIFF } = require('../utils/git-path-fixtures');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

let repo;
let baseSha;
let headSha;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-pr-quoted-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@test.com');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'core.quotePath', 'true');
  fs.mkdirSync(path.join(repo, 'old'));
  fs.writeFileSync(path.join(repo, 'café.js'), 'a\nb\n');
  fs.writeFileSync(path.join(repo, 'old/thing.js'), 'one\ntwo\nthree\nfour\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  baseSha = git(repo, 'rev-parse', 'HEAD').trim();
  fs.mkdirSync(path.join(repo, 'totally'));
  git(repo, 'mv', 'old/thing.js', 'totally/different.txt');
  // Whitespace-only change plus a real one: -w keeps only the real one
  fs.writeFileSync(path.join(repo, 'café.js'), 'a  \nB\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head');
  headSha = git(repo, 'rev-parse', 'HEAD').trim();
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(testConfigDir, { recursive: true, force: true });
});

describe('GET /api/pr/:owner/:repo/:number/diff with quoted paths', () => {
  let db;
  let server;

  beforeEach(async () => {
    db = createTestDatabase();
    const app = express();
    app.set('db', db);
    app.set('config', { github_token: 'test-token' });
    app.use('/', prRoutes);
    server = await listenOnLoopback(app);

    // Cached by an older version: quoted headers and quoted changed_files
    const prData = JSON.stringify({
      state: 'open',
      diff: QUOTEPATH_TRUE_DIFF,
      changed_files: [
        { file: String.raw`"src/caf\303\251.js"`, insertions: 1, deletions: 1, changes: 2, binary: false }
      ],
      additions: 2,
      deletions: 2,
      base_sha: baseSha,
      head_sha: headSha
    });
    await run(db, `
      INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [1, 'owner/repo', 'Test PR', '', 'testuser', 'main', 'feature', prData]);
    const now = new Date().toISOString();
    await run(db, `
      INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['wt1', 1, 'owner/repo', 'feature', repo, now, now]);
  });

  afterEach(async () => {
    await closeServer(server);
    closeTestDatabase(db);
  });

  it('serves a cached quoted entry under its decoded name without duplicating it', async () => {
    const response = await request(server).get('/api/pr/owner/repo/1/diff');

    expect(response.status).toBe(200);
    const files = response.body.changed_files.map(entry => entry.file);
    expect(files.filter(file => file === 'src/café.js')).toHaveLength(1);
    expect(files).not.toContain(String.raw`"src/caf\303\251.js"`);
    expect(files).toContain('ñew dir/moved é.js');
  });

  it('builds ?w=1 changed_files from the regenerated diff with verbatim names', async () => {
    const response = await request(server).get('/api/pr/owner/repo/1/diff?w=1');

    expect(response.status).toBe(200);
    expect(response.body.diff).toContain('diff --git a/café.js b/café.js');
    expect(response.body.diff).not.toMatch(/\\3\d\d/);

    const byFile = Object.fromEntries(response.body.changed_files.map(entry => [entry.file, entry]));
    expect(Object.keys(byFile).sort()).toEqual(['café.js', 'totally/different.txt']);
    // -w drops the whitespace-only line change and counts the real one
    expect(byFile['café.js']).toMatchObject({ insertions: 1, deletions: 1, binary: false, generated: false });
    expect(byFile['totally/different.txt']).toMatchObject({ renamed: true, renamedFrom: 'old/thing.js' });
    expect(response.body.stats).toEqual({ additions: 1, deletions: 1, changed_files: 2 });
  });
});
