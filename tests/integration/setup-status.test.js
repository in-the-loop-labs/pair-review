// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * GET /api/setup/:setupId/status — the poll-friendly mirror of the
 * `setup:{setupId}` WebSocket pushes that the delegated-headless CLI polls
 * instead of opening a WebSocket (avoids the missed-event race).
 *
 * Both setup paths (local + PR) must seed a `running` entry when they mint a
 * setupId and flip it to `complete`/`error` at their terminal event. Unknown
 * ids → 404. The local test drives the REAL setupLocalReview against a temp git
 * repo (gated so `running` is observable before completion); the PR tests mock
 * setupPRReview to drive the complete/error branches deterministically.
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

// Capture the real implementations BEFORE spying so the gated local test can
// delegate to the genuine setup path (real repo persistence).
const localSetupModule = require('../../src/setup/local-setup');
const realSetupLocalReview = localSetupModule.setupLocalReview;
const prSetupModule = require('../../src/setup/pr-setup');
const configModule = require('../../src/config');

// setup.js destructures these at import time, so the spies MUST exist before the
// route module is required below (mirrors tests/integration/setup-routes.test.js).
vi.spyOn(localSetupModule, 'setupLocalReview');
vi.spyOn(prSetupModule, 'setupPRReview');
vi.spyOn(configModule, 'getGitHubToken');

const setupRoutes = require('../../src/routes/setup');
const { activeSetups, localReviewDiffs } = require('../../src/routes/shared');

function git(cwd, args) {
  execSync(`git ${args}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Temp repo with a committed file plus an unstaged edit (default scope has a diff). */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-status-'));
  git(dir, 'init -q -b main');
  git(dir, 'config user.email t@t.com');
  git(dir, 'config user.name t');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\n');
  git(dir, 'add a.txt');
  git(dir, 'commit -qm init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
  return dir;
}

function makeApp(db, config = {}) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('config', config);
  app.use(setupRoutes);
  return app;
}

describe('GET /api/setup/:setupId/status — unknown id', () => {
  let db;
  let server;

  beforeEach(async () => {
    db = createTestDatabase();
    activeSetups.clear();
    // Real setupLocalReview populates the process-global localReviewDiffs cache;
    // clear it too so stale diffs never leak across tests reusing small review IDs.
    localReviewDiffs.clear();
    server = await listenOnLoopback(makeApp(db));
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    activeSetups.clear();
    // Real setupLocalReview populates the process-global localReviewDiffs cache;
    // clear it too so stale diffs never leak across tests reusing small review IDs.
    localReviewDiffs.clear();
    closeTestDatabase(db);
  });

  it('404s with { error: "Setup not found" } for an id that was never started', async () => {
    const res = await request(server).get('/api/setup/does-not-exist/status');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Setup not found' });
  });
});

describe('GET /api/setup/:setupId/status — local setup running→complete', () => {
  let db;
  let server;
  let repoDir;
  let release;

  beforeEach(async () => {
    db = createTestDatabase();
    activeSetups.clear();
    // Real setupLocalReview populates the process-global localReviewDiffs cache;
    // clear it too so stale diffs never leak across tests reusing small review IDs.
    localReviewDiffs.clear();
    repoDir = makeRepo();
    // Gate the real setup so `running` is observable before completion, then
    // delegate to the genuine implementation once released.
    const gate = new Promise((resolve) => { release = resolve; });
    localSetupModule.setupLocalReview.mockImplementation(async (args) => {
      await gate;
      return realSetupLocalReview(args);
    });
    server = await listenOnLoopback(makeApp(db));
  });

  afterEach(async () => {
    if (release) release(); // never leave the gated promise pending
    await closeServer(server);
    server = null;
    activeSetups.clear();
    // Real setupLocalReview populates the process-global localReviewDiffs cache;
    // clear it too so stale diffs never leak across tests reusing small review IDs.
    localReviewDiffs.clear();
    localSetupModule.setupLocalReview.mockReset();
    closeTestDatabase(db);
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('reports running immediately, then complete with reviewUrl/reviewId (real repo)', async () => {
    const startRes = await request(server)
      .post('/api/setup/local')
      .send({ path: repoDir });
    expect(startRes.status).toBe(200);
    const setupId = startRes.body.setupId;
    expect(setupId).toBeTruthy();

    // Seeded synchronously before the (gated) work runs → deterministically running.
    const running = await request(server).get(`/api/setup/${setupId}/status`);
    expect(running.status).toBe(200);
    expect(running.body.status).toBe('running');

    release();

    await vi.waitFor(async () => {
      const res = await request(server).get(`/api/setup/${setupId}/status`);
      expect(res.body.status).toBe('complete');
    }, { timeout: 5000 });

    const done = await request(server).get(`/api/setup/${setupId}/status`);
    expect(done.body.status).toBe('complete');
    expect(done.body.reviewUrl).toMatch(/^\/local\/\d+$/);
    expect(done.body.reviewId).toBeTruthy();
    // The review row really was created by the real setup path.
    const row = db.prepare("SELECT id FROM reviews WHERE review_type = 'local'").get();
    expect(row.id).toBe(done.body.reviewId);
  });
});

describe('GET /api/setup/:setupId/status — PR setup terminal states (mocked)', () => {
  let db;
  let server;

  beforeEach(async () => {
    db = createTestDatabase();
    activeSetups.clear();
    // Real setupLocalReview populates the process-global localReviewDiffs cache;
    // clear it too so stale diffs never leak across tests reusing small review IDs.
    localReviewDiffs.clear();
    configModule.getGitHubToken.mockReturnValue('test-token');
    server = await listenOnLoopback(makeApp(db, { github_token: 'test-token' }));
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    activeSetups.clear();
    // Real setupLocalReview populates the process-global localReviewDiffs cache;
    // clear it too so stale diffs never leak across tests reusing small review IDs.
    localReviewDiffs.clear();
    prSetupModule.setupPRReview.mockReset();
    configModule.getGitHubToken.mockReset();
    closeTestDatabase(db);
  });

  it('flips to complete with reviewUrl when setupPRReview resolves', async () => {
    prSetupModule.setupPRReview.mockResolvedValue({
      reviewUrl: '/pr/owner/repo/42',
      title: 'Test PR'
    });

    const startRes = await request(server).post('/api/setup/pr/owner/repo/42');
    expect(startRes.status).toBe(200);
    const setupId = startRes.body.setupId;
    expect(setupId).toBeTruthy();

    await vi.waitFor(async () => {
      const res = await request(server).get(`/api/setup/${setupId}/status`);
      expect(res.body.status).toBe('complete');
    }, { timeout: 5000 });

    const done = await request(server).get(`/api/setup/${setupId}/status`);
    expect(done.body.reviewUrl).toBe('/pr/owner/repo/42');
  });

  it('flips to error with the failure message when setupPRReview rejects', async () => {
    prSetupModule.setupPRReview.mockRejectedValue(new Error('boom during setup'));

    const startRes = await request(server).post('/api/setup/pr/owner/repo/43');
    expect(startRes.status).toBe(200);
    const setupId = startRes.body.setupId;

    await vi.waitFor(async () => {
      const res = await request(server).get(`/api/setup/${setupId}/status`);
      expect(res.body.status).toBe('error');
    }, { timeout: 5000 });

    const done = await request(server).get(`/api/setup/${setupId}/status`);
    expect(done.body.error).toBe('boom during setup');
  });
});
