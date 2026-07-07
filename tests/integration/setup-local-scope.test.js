// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * POST /api/setup/local scope/base handling (the delegated --scope/--base seam).
 *
 * This is the receiving end of single-port delegation: the CLI carries
 * `--scope`/`--base` on the /local?path=... URL, the setup page relays them into
 * this POST body, and the route re-validates + applies them via the shared
 * scope-resolution helpers. Uses the REAL setupLocalReview against a per-test
 * temp git repo (no mocking) so persistence is exercised end to end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const setupRoutes = require('../../src/routes/setup');
const { activeSetups } = require('../../src/routes/shared');

function git(cwd, args) {
  execSync(`git ${args}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Build a temp repo on `feature` with a branch commit + unstaged + untracked changes. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-scope-'));
  git(dir, 'init -q -b main');
  git(dir, 'config user.email t@t.com');
  git(dir, 'config user.name t');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\n');
  git(dir, 'add a.txt');
  git(dir, 'commit -qm init');
  git(dir, 'checkout -q -b feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
  git(dir, 'commit -qam "First feature commit subject"');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\nunstaged\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');
  return dir;
}

/** The single local review row (each test uses its own DB). */
function localReviewRow(db) {
  return db.prepare("SELECT * FROM reviews WHERE review_type = 'local'").get();
}

describe('POST /api/setup/local — scope/base', () => {
  let db;
  let server;
  let repoDir;

  beforeEach(async () => {
    db = createTestDatabase();
    activeSetups.clear();
    repoDir = makeRepo();

    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.set('config', {});
    app.use(setupRoutes);
    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    activeSetups.clear();
    closeTestDatabase(db);
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('applies and persists a branch scope with explicit base, auto-naming the review', async () => {
    const res = await request(server)
      .post('/api/setup/local')
      .send({ path: repoDir, scope: 'branch..untracked', base: 'main' });
    expect(res.status).toBe(200);
    expect(res.body.setupId).toBeTruthy();

    await vi.waitFor(() => {
      const row = localReviewRow(db);
      expect(row && row.local_scope_start).toBe('branch');
    }, { timeout: 5000 });

    const row = localReviewRow(db);
    expect(row.local_scope_start).toBe('branch');
    expect(row.local_scope_end).toBe('untracked');
    expect(row.local_base_branch).toBe('main');
    expect(row.local_head_branch).toBe('feature');
    expect(row.local_mode).toBe('branch');
    // Auto-named from the first commit subject on the branch.
    expect(row.name).toBe('First feature commit subject');
  });

  it('leaves default scope untouched when no scope/base params are sent', async () => {
    const res = await request(server)
      .post('/api/setup/local')
      .send({ path: repoDir });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(localReviewRow(db)).toBeTruthy();
    }, { timeout: 5000 });

    const row = localReviewRow(db);
    // Schema default scope, no branch base, no auto-name — byte-identical to before.
    expect(row.local_scope_start).toBe('unstaged');
    expect(row.local_scope_end).toBe('untracked');
    expect(row.local_base_branch).toBeNull();
    expect(row.name).toBeNull();
  });

  it('rejects an invalid scope with 400 and the valid-ranges message; no session created', async () => {
    const res = await request(server)
      .post('/api/setup/local')
      .send({ path: repoDir, scope: 'branch..staged' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid scope value "branch\.\.staged"/);
    expect(res.body.error).toMatch(/branch\.\.untracked/);
    expect(res.body.error).toMatch(/must include 'unstaged'/);
    // Validation happens before any setup work — nothing persisted.
    expect(localReviewRow(db)).toBeUndefined();
  });

  it('rejects base with a non-branch scope (400)', async () => {
    const res = await request(server)
      .post('/api/setup/local')
      .send({ path: repoDir, scope: 'unstaged..untracked', base: 'main' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base requires a branch-relative scope/);
    expect(localReviewRow(db)).toBeUndefined();
  });

  it('rejects base without any scope (400)', async () => {
    const res = await request(server)
      .post('/api/setup/local')
      .send({ path: repoDir, base: 'main' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base requires a branch-relative scope/);
    expect(localReviewRow(db)).toBeUndefined();
  });

  it('rejects an unsafe base branch name (400)', async () => {
    const res = await request(server)
      .post('/api/setup/local')
      .send({ path: repoDir, scope: 'branch..untracked', base: 'bad;rm -rf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid base branch name/);
    expect(localReviewRow(db)).toBeUndefined();
  });
});
