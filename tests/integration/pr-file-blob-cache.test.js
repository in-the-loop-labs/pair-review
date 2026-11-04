// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PR-mode file-content blob cache (issue #591).
 *
 * The file-content endpoints resolve a file's original content from the exact
 * diff blob recorded in `pr_metadata.pr_data`. That lookup is cached per PR, so
 * every pr_data writer must invalidate it or file-content serves lines from a
 * stale blob. The route tests below pin `updated_at` back to its pre-write
 * value after each write, so only the explicit invalidation (not the row
 * fingerprint) can make the new blob visible.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { execSync } from 'child_process';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase, SCHEMA_SQL } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const Database = require('better-sqlite3');
const { GitWorktreeManager } = require('../../src/git/worktree');
const { GitHubClient } = require('../../src/github/client');
const configModule = require('../../src/config');
const logger = require('../../src/utils/logger');

vi.mock('../../src/github/stack-walker', () => ({
  walkPRStack: vi.fn().mockResolvedValue(null)
}));
vi.mock('../../src/events/review-events', () => ({
  broadcastReviewEvent: vi.fn()
}));

const { run, queryOne } = require('../../src/database');
const prRoutes = require('../../src/routes/pr');
const reviewsRoutes = require('../../src/routes/reviews');
const summaryGenerator = require('../../src/ai/summary-generator');
const tourGenerator = require('../../src/ai/tour-generator');
const { storePRData } = require('../../src/setup/pr-setup');
const { resolveOriginalFileContentSpecs } = require('../../src/utils/diff-file-content');
const {
  getPRFileContentSpecs,
  invalidatePRFileBlobCache,
  MAX_CACHED_PRS
} = require('../../src/utils/pr-file-blob-cache');

const REPO = 'owner/repo';
const PR = 7;

const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-blob-cache-cfg-'));

function diffFor(fileName, oldBlob, newBlob) {
  return [
    `diff --git a/${fileName} b/${fileName}`,
    `index ${oldBlob}..${newBlob} 100644`,
    `--- a/${fileName}`,
    `+++ b/${fileName}`,
    '@@ -1 +1 @@',
    '-old',
    '+new'
  ].join('\n');
}

async function insertPR(db, prData, { prNumber = PR, repository = REPO } = {}) {
  return run(db, `
    INSERT INTO pr_metadata (pr_number, repository, title, pr_data)
    VALUES (?, ?, 'PR', ?)
  `, [prNumber, repository, typeof prData === 'string' ? prData : JSON.stringify(prData)]);
}

function countPrDataReads(db) {
  const prepareSpy = vi.spyOn(db, 'prepare');
  return () => prepareSpy.mock.calls.filter(([sql]) => /SELECT pr_data FROM pr_metadata WHERE id/.test(sql)).length;
}

describe('getPRFileContentSpecs', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (db) closeTestDatabase(db);
  });

  it('returns the same specs as resolving from the parsed pr_data', async () => {
    const prData = {
      base_sha: 'base123',
      diff: [
        diffFor('src/a.js', 'aaa1111', 'aaa2222'),
        'diff --git a/src/old.js b/src/new.js',
        'index bbb1111..bbb2222 100644',
        'diff --git a/src/added.js b/src/added.js',
        'new file mode 100644',
        'index 0000000..ccc2222'
      ].join('\n')
    };
    await insertPR(db, prData);

    for (const fileName of ['src/a.js', 'src/old.js', 'src/new.js', 'src/added.js', 'src/untouched.js']) {
      expect(getPRFileContentSpecs(db, REPO, PR, fileName))
        .toEqual(resolveOriginalFileContentSpecs(prData, fileName));
    }
    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')).toEqual([
      { gitSpec: 'aaa1111', source: 'diff blob' },
      { gitSpec: 'base123:src/a.js', source: 'base commit' }
    ]);
  });

  it('parses pr_data once across repeated lookups, matching the repository case-insensitively', async () => {
    await insertPR(db, { base_sha: 'base123', diff: diffFor('src/a.js', 'aaa1111', 'aaa2222') });
    const prDataReads = countPrDataReads(db);

    getPRFileContentSpecs(db, REPO, PR, 'src/a.js');
    getPRFileContentSpecs(db, REPO, PR, 'src/b.js');
    getPRFileContentSpecs(db, 'Owner/Repo', PR, 'src/a.js');

    expect(prDataReads()).toBe(1);
  });

  it('returns no specs when the PR has no metadata row', () => {
    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')).toEqual([]);
  });

  it('returns no specs for unparseable pr_data, warning only when it is loaded', async () => {
    await insertPR(db, '{not json');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')).toEqual([]);
    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('serves the new blob after an explicit invalidation, even when updated_at did not change', async () => {
    await insertPR(db, { diff: diffFor('src/a.js', 'aaa1111', 'aaa2222') });
    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')[0].gitSpec).toBe('aaa1111');

    await run(db, 'UPDATE pr_metadata SET pr_data = ? WHERE pr_number = ?', [
      JSON.stringify({ diff: diffFor('src/a.js', 'fff1111', 'fff2222') }), PR
    ]);
    invalidatePRFileBlobCache(db, 'OWNER/repo', PR);

    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')[0].gitSpec).toBe('fff1111');
  });

  it('reloads when updated_at changes, without an explicit invalidation', async () => {
    await insertPR(db, { diff: diffFor('src/a.js', 'aaa1111', 'aaa2222') });
    await run(db, "UPDATE pr_metadata SET updated_at = '2020-01-01 00:00:00'");
    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')[0].gitSpec).toBe('aaa1111');

    await run(db, "UPDATE pr_metadata SET pr_data = ?, updated_at = '2020-01-01 00:00:01'", [
      JSON.stringify({ diff: diffFor('src/a.js', 'fff1111', 'fff2222') })
    ]);

    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')[0].gitSpec).toBe('fff1111');
  });

  it('serves nothing for a deleted row and reloads a recreated one', async () => {
    await insertPR(db, { diff: diffFor('src/a.js', 'aaa1111', 'aaa2222') });
    getPRFileContentSpecs(db, REPO, PR, 'src/a.js');

    await run(db, 'DELETE FROM pr_metadata');
    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')).toEqual([]);

    await insertPR(db, { diff: diffFor('src/a.js', 'fff1111', 'fff2222') });
    expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')[0].gitSpec).toBe('fff1111');
  });

  it('keeps separate caches per database handle', async () => {
    const otherDb = createTestDatabase();
    try {
      await insertPR(db, { diff: diffFor('src/a.js', 'aaa1111', 'aaa2222') });
      await insertPR(otherDb, { diff: diffFor('src/a.js', 'fff1111', 'fff2222') });

      expect(getPRFileContentSpecs(db, REPO, PR, 'src/a.js')[0].gitSpec).toBe('aaa1111');
      expect(getPRFileContentSpecs(otherDb, REPO, PR, 'src/a.js')[0].gitSpec).toBe('fff1111');
    } finally {
      closeTestDatabase(otherDb);
    }
  });

  it('evicts the least recently used PR beyond the cap', async () => {
    for (let n = 1; n <= MAX_CACHED_PRS + 1; n++) {
      await insertPR(db, { diff: diffFor('src/a.js', 'aaa1111', 'aaa2222') }, { prNumber: n });
    }
    const prDataReads = countPrDataReads(db);

    for (let n = 1; n <= MAX_CACHED_PRS; n++) getPRFileContentSpecs(db, REPO, n, 'src/a.js');
    getPRFileContentSpecs(db, REPO, 1, 'src/a.js'); // touch PR 1 so PR 2 is oldest
    getPRFileContentSpecs(db, REPO, MAX_CACHED_PRS + 1, 'src/a.js'); // evicts PR 2
    expect(prDataReads()).toBe(MAX_CACHED_PRS + 1);

    getPRFileContentSpecs(db, REPO, 1, 'src/a.js');
    expect(prDataReads()).toBe(MAX_CACHED_PRS + 1);
    getPRFileContentSpecs(db, REPO, 2, 'src/a.js');
    expect(prDataReads()).toBe(MAX_CACHED_PRS + 2);
  });

  it("detects another connection's write even when updated_at is unchanged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-blob-cache-db-'));
    const dbPath = path.join(dir, 'test.db');
    const serverDb = new Database(dbPath);
    const cliDb = new Database(dbPath);
    try {
      serverDb.exec(SCHEMA_SQL.pr_metadata);
      serverDb.prepare(`
        INSERT INTO pr_metadata (pr_number, repository, pr_data, updated_at)
        VALUES (?, ?, ?, '2020-01-01 00:00:00')
      `).run(PR, REPO, JSON.stringify({ diff: diffFor('src/a.js', 'aaa1111', 'aaa2222') }));
      expect(getPRFileContentSpecs(serverDb, REPO, PR, 'src/a.js')[0].gitSpec).toBe('aaa1111');

      // A second process (e.g. a headless --no-server run) rewrites pr_data
      // within the same second and cannot invalidate the server's cache.
      cliDb.prepare('UPDATE pr_metadata SET pr_data = ?').run(
        JSON.stringify({ diff: diffFor('src/a.js', 'fff1111', 'fff2222') })
      );

      expect(getPRFileContentSpecs(serverDb, REPO, PR, 'src/a.js')[0].gitSpec).toBe('fff1111');
    } finally {
      serverDb.close();
      cliDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pr_data writers invalidate the file-content blob cache', () => {
  let db;
  let server;
  let tempRepo;
  let blobs;

  function git(cmd) {
    return execSync(`git ${cmd}`, { cwd: tempRepo, encoding: 'utf8', stdio: 'pipe' }).trim();
  }

  function createTestApp() {
    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.set('githubToken', 'test-token');
    app.set('config', { github_token: 'test-token', port: 7247, theme: 'light' });
    app.use('/', prRoutes);
    app.use('/', reviewsRoutes);
    return app;
  }

  async function fetchOriginal() {
    const res = await request(server)
      .get('/api/file-content-original/file.js')
      .query({ owner: 'owner', repo: 'repo', number: PR });
    expect(res.status).toBe(200);
    return res.body.lines[0];
  }

  async function pinUpdatedAt() {
    await run(db, "UPDATE pr_metadata SET updated_at = '2020-01-01 00:00:00'");
  }

  beforeEach(async () => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-blob-cache-repo-'));
    git('init -b main');
    git('config user.email "test@test.com"');
    git('config user.name "Test User"');
    blobs = {};
    for (const version of ['v1', 'v2', 'v3']) {
      fs.writeFileSync(path.join(tempRepo, 'file.js'), `${version} content\n`);
      git('add file.js');
      git(`commit -m ${version}`);
      blobs[version] = git('rev-parse HEAD:file.js');
    }

    vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue(tempRepo);
    vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
    vi.spyOn(GitWorktreeManager.prototype, 'updateWorktree').mockResolvedValue(tempRepo);
    vi.spyOn(GitWorktreeManager.prototype, 'generateUnifiedDiff')
      .mockResolvedValue(diffFor('file.js', blobs.v2, blobs.v3));
    vi.spyOn(GitWorktreeManager.prototype, 'getChangedFiles')
      .mockResolvedValue([{ file: 'file.js', additions: 1, deletions: 1 }]);
    vi.spyOn(GitHubClient.prototype, 'fetchPullRequest').mockResolvedValue({
      title: 'Refreshed PR', body: '', base_branch: 'main', head_branch: 'feature',
      state: 'open', base_sha: null, head_sha: 'head', node_id: 'PR_node'
    });
    vi.spyOn(configModule, 'getGitHubToken').mockReturnValue('test-token');
    vi.spyOn(configModule, 'getConfigDir').mockReturnValue(testConfigDir);
    vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockReturnValue(null);
    vi.spyOn(tourGenerator, 'kickOffTourJob').mockReturnValue(null);

    db = createTestDatabase();
    await insertPR(db, { node_id: 'PR_node', diff: diffFor('file.js', blobs.v1, blobs.v3) });
    await run(db, `
      INSERT INTO reviews (pr_number, repository, status, created_at, updated_at)
      VALUES (?, ?, 'draft', datetime('now'), datetime('now'))
    `, [PR, REPO]);
    await pinUpdatedAt();
    server = await listenOnLoopback(createTestApp());
  });

  afterEach(async () => {
    await closeServer(server);
    vi.restoreAllMocks();
    if (db) closeTestDatabase(db);
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  it('serves the refreshed diff blob after POST /refresh', async () => {
    expect(await fetchOriginal()).toBe('v1 content');

    const res = await request(server).post(`/api/pr/owner/repo/${PR}/refresh`).send({});
    expect(res.status).toBe(200);
    await pinUpdatedAt();

    expect(await fetchOriginal()).toBe('v2 content');
  });

  it('serves the refreshed diff blob from the review file-contents endpoint', async () => {
    const review = await queryOne(db, 'SELECT id FROM reviews WHERE pr_number = ?', [PR]);
    const fetchOld = async () => {
      const res = await request(server)
        .get(`/api/reviews/${review.id}/file-contents/file.js`)
        .query({ status: 'modified' });
      expect(res.status).toBe(200);
      return res.body.oldContents;
    };

    expect(await fetchOld()).toBe('v1 content\n');
    await request(server).post(`/api/pr/owner/repo/${PR}/refresh`).send({}).expect(200);
    await pinUpdatedAt();
    expect(await fetchOld()).toBe('v2 content\n');
  });

  it('invalidates when saving viewed files rewrites pr_data', async () => {
    expect(await fetchOriginal()).toBe('v1 content');

    // Stand-in for a same-connection write that forgot to invalidate; the
    // viewed-files save then re-serializes this pr_data and must invalidate.
    await run(db, 'UPDATE pr_metadata SET pr_data = ?', [
      JSON.stringify({ node_id: 'PR_node', diff: diffFor('file.js', blobs.v2, blobs.v3) })
    ]);
    await pinUpdatedAt();
    expect(await fetchOriginal()).toBe('v1 content');

    await request(server)
      .post(`/api/pr/owner/repo/${PR}/files/viewed`)
      .send({ files: ['file.js'] })
      .expect(200);
    await pinUpdatedAt();

    expect(await fetchOriginal()).toBe('v2 content');
  });

  it('invalidates when PR setup stores new PR data', async () => {
    expect(await fetchOriginal()).toBe('v1 content');

    await storePRData(
      db, { owner: 'owner', repo: 'repo', number: PR },
      { node_id: 'PR_node', title: 'PR', body: '', base_branch: 'main', head_branch: 'feature' },
      diffFor('file.js', blobs.v2, blobs.v3), [], tempRepo
    );
    await pinUpdatedAt();

    expect(await fetchOriginal()).toBe('v2 content');
  });
});
