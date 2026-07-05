// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const { GitHubClient } = require('../../src/github/client');
const configModule = require('../../src/config');
const { run, query } = require('../../src/database');
const logger = require('../../src/utils/logger');

// Capture the real getAuthenticatedUser before spying. The alt-host sweep and
// the github.com search share the same prototype, so alt-host tests mock this
// with an implementation that delegates the alt client (apiHost set) to the
// REAL octokit call — hitting a loopback alt host — while the github.com client
// (apiHost null) stays mocked. `listOpenPullRequests` is intentionally NOT
// spied so the alt client exercises the real REST path against the loopback.
const realGetAuthenticatedUser = GitHubClient.prototype.getAuthenticatedUser;

// Spy on config module to prevent writing to user's real config
vi.spyOn(configModule, 'getGitHubToken');

// Spy on GitHubClient prototype methods used by the collections routes
vi.spyOn(GitHubClient.prototype, 'getAuthenticatedUser');
vi.spyOn(GitHubClient.prototype, 'searchPullRequests');

// Load the route module (will use the mocked modules)
const githubCollectionsRoutes = require('../../src/routes/github-collections');

/**
 * Create a test Express app with the github-collections route
 */
function createTestApp(db, config = {}) {
  const app = express();
  app.use(express.json());

  app.set('db', db);
  app.set('config', config);

  app.use('/', githubCollectionsRoutes);

  return app;
}

/**
 * Insert a test row into github_pr_cache
 */
async function insertCachedPR(db, { owner, repo, number, title, author, updated_at, html_url, state, collection }) {
  await run(db,
    'INSERT INTO github_pr_cache (owner, repo, number, title, author, updated_at, html_url, state, collection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [owner, repo, number, title, author, updated_at, html_url, state, collection]
  );
}

// ============================================================================
// GitHub Collections Route Tests
// ============================================================================

describe('GitHub Collections Routes', () => {
  let db;
  let app;
  let server;

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db, {
      github_token: 'test-token',
      port: 7247,
      theme: 'light'
    });
    server = await listenOnLoopback(app);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await closeServer(server);
    if (db) {
      closeTestDatabase(db);
    }
  });

  // ==========================================================================
  // GET /api/github/review-requests
  // ==========================================================================

  describe('GET /api/github/review-requests', () => {
    it('should return empty array when no cached data', async () => {
      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toEqual([]);
      expect(res.body.fetched_at).toBeNull();
    });

    it('should return cached data when present', async () => {
      await insertCachedPR(db, {
        owner: 'my-org', repo: 'my-repo', number: 42,
        title: 'Fix bug', author: 'alice',
        updated_at: '2025-03-01T10:00:00Z',
        html_url: 'https://github.com/my-org/my-repo/pull/42',
        state: 'open', collection: 'review-requests'
      });

      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0]).toMatchObject({
        owner: 'my-org',
        repo: 'my-repo',
        number: 42,
        title: 'Fix bug',
        author: 'alice',
        state: 'open'
      });
      expect(res.body.fetched_at).toBeTruthy();
    });

    it('should return data sorted by updated_at DESC', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 1,
        title: 'Older PR', author: 'alice',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/1',
        state: 'open', collection: 'review-requests'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 2,
        title: 'Newer PR', author: 'bob',
        updated_at: '2025-03-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/2',
        state: 'open', collection: 'review-requests'
      });

      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(2);
      expect(res.body.prs[0].number).toBe(2); // Newer first
      expect(res.body.prs[1].number).toBe(1);
    });

    it('should not return data from other collections', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 1,
        title: 'Review request', author: 'alice',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/1',
        state: 'open', collection: 'review-requests'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 2,
        title: 'My PR', author: 'bob',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/2',
        state: 'open', collection: 'my-prs'
      });

      const res = await request(server).get('/api/github/review-requests');

      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(1);
    });
  });

  // ==========================================================================
  // POST /api/github/review-requests/refresh
  // ==========================================================================

  describe('POST /api/github/review-requests/refresh', () => {
    it('should return 401 when no GitHub token configured', async () => {
      configModule.getGitHubToken.mockReturnValue(null);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('token not configured');
    });

    it('should refresh cache with data from GitHub on success', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'project', number: 10,
          title: 'New feature', author: 'alice',
          updated_at: '2025-03-05T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/10',
          state: 'open'
        },
        {
          owner: 'org', repo: 'project', number: 11,
          title: 'Bug fix', author: 'bob',
          updated_at: '2025-03-04T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/11',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(2);
      expect(res.body.prs[0].number).toBe(10); // Sorted by updated_at DESC
      expect(res.body.prs[1].number).toBe(11);
      expect(res.body.fetched_at).toBeTruthy();

      // Verify the search query includes the authenticated user's login
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false user-review-requested:testuser'
      );
    });

    it('should clear old cached data before inserting new data', async () => {
      // Pre-populate cache with old data
      await insertCachedPR(db, {
        owner: 'old-org', repo: 'old-repo', number: 99,
        title: 'Stale PR', author: 'old-user',
        updated_at: '2024-01-01T00:00:00Z',
        html_url: 'https://github.com/old-org/old-repo/pull/99',
        state: 'open', collection: 'review-requests'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'new-org', repo: 'new-repo', number: 1,
          title: 'Fresh PR', author: 'new-user',
          updated_at: '2025-03-05T12:00:00Z',
          html_url: 'https://github.com/new-org/new-repo/pull/1',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].owner).toBe('new-org');
      // Old data should be gone
      const oldRows = await query(db, "SELECT * FROM github_pr_cache WHERE owner = 'old-org'", []);
      expect(oldRows).toHaveLength(0);
    });

    it('should not clear data from other collections', async () => {
      // Pre-populate my-prs cache
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 50,
        title: 'My PR', author: 'me',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/50',
        state: 'open', collection: 'my-prs'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);

      await request(server).post('/api/github/review-requests/refresh');

      // my-prs data should still be intact
      const myPrs = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'my-prs'", []);
      expect(myPrs).toHaveLength(1);
      expect(myPrs[0].number).toBe(50);
    });

    it('should return 401 when GitHub API returns 401 auth error', async () => {
      configModule.getGitHubToken.mockReturnValue('invalid-token');
      const authError = new Error('Bad credentials');
      authError.status = 401;
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(authError);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('invalid or expired');
    });

    it('should return 401 when GitHub API returns 403 auth error', async () => {
      configModule.getGitHubToken.mockReturnValue('bad-token');
      const forbiddenError = new Error('Forbidden');
      forbiddenError.status = 403;
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(forbiddenError);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('invalid or expired');
    });

    it('should return 500 on unexpected errors', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(new Error('Network timeout'));

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // GET /api/github/my-prs
  // ==========================================================================

  describe('GET /api/github/my-prs', () => {
    it('should return empty array when no cached data', async () => {
      const res = await request(server).get('/api/github/my-prs');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toEqual([]);
      expect(res.body.fetched_at).toBeNull();
    });

    it('should return cached data when present', async () => {
      await insertCachedPR(db, {
        owner: 'my-org', repo: 'my-repo', number: 15,
        title: 'My change', author: 'me',
        updated_at: '2025-02-15T10:00:00Z',
        html_url: 'https://github.com/my-org/my-repo/pull/15',
        state: 'open', collection: 'my-prs'
      });

      const res = await request(server).get('/api/github/my-prs');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0]).toMatchObject({
        owner: 'my-org',
        repo: 'my-repo',
        number: 15,
        title: 'My change',
        author: 'me',
        state: 'open'
      });
      expect(res.body.fetched_at).toBeTruthy();
    });

    it('should return data sorted by updated_at DESC', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 3,
        title: 'Old PR', author: 'me',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/3',
        state: 'open', collection: 'my-prs'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 4,
        title: 'Recent PR', author: 'me',
        updated_at: '2025-03-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/4',
        state: 'open', collection: 'my-prs'
      });

      const res = await request(server).get('/api/github/my-prs');

      expect(res.body.prs).toHaveLength(2);
      expect(res.body.prs[0].number).toBe(4); // Newer first
      expect(res.body.prs[1].number).toBe(3);
    });

    it('should not return data from other collections', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 20,
        title: 'My PR', author: 'me',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/20',
        state: 'open', collection: 'my-prs'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 21,
        title: 'Review request', author: 'someone',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/21',
        state: 'open', collection: 'review-requests'
      });

      const res = await request(server).get('/api/github/my-prs');

      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(20);
    });
  });

  // ==========================================================================
  // POST /api/github/my-prs/refresh
  // ==========================================================================

  describe('POST /api/github/my-prs/refresh', () => {
    it('should return 401 when no GitHub token configured', async () => {
      configModule.getGitHubToken.mockReturnValue(null);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('token not configured');
    });

    it('should refresh cache with data from GitHub on success', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'myuser', name: 'My User', avatar_url: 'https://example.com/me.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'repo', number: 100,
          title: 'My big feature', author: 'myuser',
          updated_at: '2025-03-05T15:00:00Z',
          html_url: 'https://github.com/org/repo/pull/100',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(100);
      expect(res.body.fetched_at).toBeTruthy();

      // Verify the search query includes the authenticated user's login with author:
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false author:myuser'
      );
    });

    it('should clear old cached data before inserting new data', async () => {
      await insertCachedPR(db, {
        owner: 'old-org', repo: 'old-repo', number: 88,
        title: 'Old my PR', author: 'me',
        updated_at: '2024-06-01T00:00:00Z',
        html_url: 'https://github.com/old-org/old-repo/pull/88',
        state: 'open', collection: 'my-prs'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'me', name: 'Me', avatar_url: 'https://example.com/me.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'new-org', repo: 'new-repo', number: 200,
          title: 'Fresh PR', author: 'me',
          updated_at: '2025-03-05T12:00:00Z',
          html_url: 'https://github.com/new-org/new-repo/pull/200',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].owner).toBe('new-org');
      const oldRows = await query(db, "SELECT * FROM github_pr_cache WHERE owner = 'old-org'", []);
      expect(oldRows).toHaveLength(0);
    });

    it('should not clear data from other collections', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 60,
        title: 'Review request', author: 'someone',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/60',
        state: 'open', collection: 'review-requests'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'me', name: 'Me', avatar_url: 'https://example.com/me.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);

      await request(server).post('/api/github/my-prs/refresh');

      const reviewRequests = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'review-requests'", []);
      expect(reviewRequests).toHaveLength(1);
      expect(reviewRequests[0].number).toBe(60);
    });

    it('should return 401 when GitHub API returns 401 auth error', async () => {
      configModule.getGitHubToken.mockReturnValue('invalid-token');
      const authError = new Error('Bad credentials');
      authError.status = 401;
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(authError);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('invalid or expired');
    });

    it('should return 401 when GitHub API returns 403 auth error', async () => {
      configModule.getGitHubToken.mockReturnValue('bad-token');
      const forbiddenError = new Error('Forbidden');
      forbiddenError.status = 403;
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(forbiddenError);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('invalid or expired');
    });

    it('should return 500 on unexpected errors', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(new Error('Something broke'));

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // GET /api/github/team-reviews
  // ==========================================================================

  describe('GET /api/github/team-reviews', () => {
    it('should return empty array when no cached data', async () => {
      const res = await request(server).get('/api/github/team-reviews');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toEqual([]);
      expect(res.body.fetched_at).toBeNull();
    });

    it('should return only team-reviews cached data', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 1,
        title: 'Direct request', author: 'alice',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/1',
        state: 'open', collection: 'review-requests'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 2,
        title: 'Team request', author: 'bob',
        updated_at: '2025-01-02T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/2',
        state: 'open', collection: 'team-reviews'
      });

      const res = await request(server).get('/api/github/team-reviews');

      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(2);
    });
  });

  // ==========================================================================
  // POST /api/github/team-reviews/refresh
  // ==========================================================================

  describe('POST /api/github/team-reviews/refresh', () => {
    it('should return 401 when no GitHub token configured', async () => {
      configModule.getGitHubToken.mockReturnValue(null);

      const res = await request(server).post('/api/github/team-reviews/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('token not configured');
    });

    it('should query for team requests excluding direct requests', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'project', number: 20,
          title: 'Team feature', author: 'carol',
          updated_at: '2025-03-05T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/20',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/team-reviews/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(20);

      // Team reviews = requested via a team, excluding direct user requests
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false review-requested:testuser -user-review-requested:testuser'
      );
    });

    it('should query a specific team and omit the user exclusion when ?team is given', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'project', number: 30,
          title: 'Platform team PR', author: 'dave',
          updated_at: '2025-03-06T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/30',
          state: 'open'
        }
      ]);

      const res = await request(server)
        .post('/api/github/team-reviews/refresh')
        .query({ team: 'org/platform' });

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(30);

      // Filtered view drops the -user-review-requested exclusion.
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false team-review-requested:org/platform'
      );
    });

    it('should accept the team value from the request body', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);

      const res = await request(server)
        .post('/api/github/team-reviews/refresh')
        .send({ team: 'org/platform' });

      expect(res.status).toBe(200);
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false team-review-requested:org/platform'
      );
    });

    it.each(['foo', 'a/b/c', 'org/team;extra', 'org/te am', ''.padStart(3, ' ')])(
      'should return 400 and make no GitHub call for invalid team %j',
      async (team) => {
        configModule.getGitHubToken.mockReturnValue('test-token');
        GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
          login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
        });

        const res = await request(server)
          .post('/api/github/team-reviews/refresh')
          .query({ team });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/org\/team/);
        expect(GitHubClient.prototype.searchPullRequests).not.toHaveBeenCalled();
        expect(GitHubClient.prototype.getAuthenticatedUser).not.toHaveBeenCalled();
      }
    );

    it('should cache filtered results under a namespaced key without clobbering all-teams', async () => {
      // Seed the all-teams cache directly.
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 1,
        title: 'All-teams PR', author: 'alice',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/1',
        state: 'open', collection: 'team-reviews'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'project', number: 30,
          title: 'Platform team PR', author: 'dave',
          updated_at: '2025-03-06T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/30',
          state: 'open'
        }
      ]);

      // Refresh the filtered view.
      await request(server)
        .post('/api/github/team-reviews/refresh')
        .query({ team: 'org/platform' });

      // Filtered rows live under the namespaced collection key.
      const namespaced = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'team-reviews:org/platform'", []);
      expect(namespaced).toHaveLength(1);
      expect(namespaced[0].number).toBe(30);

      // The all-teams cache is untouched.
      const allTeams = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'team-reviews'", []);
      expect(allTeams).toHaveLength(1);
      expect(allTeams[0].number).toBe(1);

      // GET with the same ?team returns the namespaced rows.
      const getRes = await request(server)
        .get('/api/github/team-reviews')
        .query({ team: 'org/platform' });
      expect(getRes.status).toBe(200);
      expect(getRes.body.prs).toHaveLength(1);
      expect(getRes.body.prs[0].number).toBe(30);

      // GET without ?team still returns the all-teams cache.
      const getAll = await request(server).get('/api/github/team-reviews');
      expect(getAll.body.prs).toHaveLength(1);
      expect(getAll.body.prs[0].number).toBe(1);
    });

    it('should return 400 on GET with an invalid team', async () => {
      const res = await request(server)
        .get('/api/github/team-reviews')
        .query({ team: 'not-a-slug' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should not clear data from other collections', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 50,
        title: 'Direct request', author: 'me',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/50',
        state: 'open', collection: 'review-requests'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);

      await request(server).post('/api/github/team-reviews/refresh');

      const reviewRequests = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'review-requests'", []);
      expect(reviewRequests).toHaveLength(1);
      expect(reviewRequests[0].number).toBe(50);
    });

    it('should return 401 when GitHub API returns 403 auth error', async () => {
      configModule.getGitHubToken.mockReturnValue('bad-token');
      const forbiddenError = new Error('Forbidden');
      forbiddenError.status = 403;
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(forbiddenError);

      const res = await request(server).post('/api/github/team-reviews/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('invalid or expired');
    });

    it('should return 500 on unexpected errors', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(new Error('Network timeout'));

      const res = await request(server).post('/api/github/team-reviews/refresh');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // Alt-host sweep — refresh lists PRs from configured api_host repos too
  // ==========================================================================

  describe('alt-host sweep on refresh', () => {
    let altServer;
    let apiHost;

    // Alt-host PR fixtures (REST `pulls.list` shape). Classification:
    //   #101 authored by altuser        → my-prs
    //   #102 requests reviewer altuser   → review-requests
    //   #103 requests team platform only → team-reviews (all-teams)
    const ALT_PULLS = [
      {
        number: 101, title: 'Alt my PR', state: 'open',
        updated_at: '2025-04-01T10:00:00Z',
        html_url: 'https://althost.example/altorg/altrepo/pull/101',
        user: { login: 'altuser' }, requested_reviewers: [], requested_teams: []
      },
      {
        number: 102, title: 'Alt review request', state: 'open',
        updated_at: '2025-04-02T10:00:00Z',
        html_url: 'https://althost.example/altorg/altrepo/pull/102',
        user: { login: 'someoneelse' },
        requested_reviewers: [{ login: 'altuser' }], requested_teams: []
      },
      {
        number: 103, title: 'Alt team request', state: 'open',
        updated_at: '2025-04-03T10:00:00Z',
        html_url: 'https://althost.example/altorg/altrepo/pull/103',
        user: { login: 'other' },
        requested_reviewers: [], requested_teams: [{ slug: 'platform' }]
      }
    ];

    /**
     * Stand up a loopback HTTP server that speaks the alt-host REST subset the
     * sweep needs (`GET /user`, `GET /repos/:owner/:repo/pulls`). Handlers are
     * overridable to simulate failures.
     */
    async function startAltHost({ user, pulls, userStatus, pullsStatus } = {}) {
      const altApp = express();
      altApp.get('/user', (req, res) => {
        if (userStatus && userStatus >= 400) return res.status(userStatus).json({ message: 'alt /user failed' });
        res.json(user || { login: 'altuser' });
      });
      altApp.get('/repos/:owner/:repo/pulls', (req, res) => {
        if (pullsStatus && pullsStatus >= 400) return res.status(pullsStatus).json({ message: 'alt pulls failed' });
        res.json(pulls || ALT_PULLS);
      });
      altServer = await listenOnLoopback(altApp);
      apiHost = `http://127.0.0.1:${altServer.address().port}`;
      return apiHost;
    }

    /**
     * Replace the outer no-repos app/server with one whose config has an
     * alt-host repo pointing at the loopback alt host.
     */
    async function useAltRepo(repoOverrides = {}) {
      await closeServer(server);
      const repos = {
        'altorg/altrepo': { api_host: apiHost, token: 'alt-token', exclusive: false, ...repoOverrides }
      };
      app = createTestApp(db, { github_token: 'test-token', port: 7247, theme: 'light', repos });
      server = await listenOnLoopback(app);
    }

    /** Wire the github.com client mocks (search + identity branch by apiHost). */
    function mockGithub(githubLogin, githubPrs) {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.searchPullRequests.mockResolvedValue(githubPrs);
      GitHubClient.prototype.getAuthenticatedUser.mockImplementation(function () {
        // Alt client (apiHost set) hits the real loopback; github client is mocked.
        if (this.apiHost) return realGetAuthenticatedUser.call(this);
        return Promise.resolve({ login: githubLogin, name: 'GH User', avatar_url: '' });
      });
    }

    afterEach(async () => {
      await closeServer(altServer);
      altServer = null;
    });

    it('contributes alt-host rows (host stamped) alongside github rows (host NULL)', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', [
        {
          owner: 'gh-org', repo: 'gh-repo', number: 5,
          title: 'GitHub my PR', author: 'ghuser',
          updated_at: '2025-03-01T12:00:00Z',
          html_url: 'https://github.com/gh-org/gh-repo/pull/5', state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // github row stamped NULL, alt row #101 (authored by altuser) stamped host.
      const githubRow = res.body.prs.find(p => p.number === 5);
      const altRow = res.body.prs.find(p => p.number === 101);
      expect(githubRow).toBeTruthy();
      expect(githubRow.host).toBeNull();
      expect(altRow).toBeTruthy();
      expect(altRow.host).toBe(apiHost);
      expect(altRow.owner).toBe('altorg');
      expect(altRow.repo).toBe('altrepo');
      expect(altRow.author).toBe('altuser');

      // Only the my-prs alt PR is included; the review/team ones are not.
      expect(res.body.prs.some(p => p.number === 102 || p.number === 103)).toBe(false);

      // Per-host status reported, additive and honest.
      expect(res.body.hosts).toEqual([{ host: apiHost, repo: 'altorg/altrepo', ok: true }]);

      // Persisted with host column.
      const dbRows = await query(db, "SELECT number, host FROM github_pr_cache WHERE collection = 'my-prs' ORDER BY number", []);
      expect(dbRows).toEqual([
        { number: 5, host: null },
        { number: 101, host: apiHost }
      ]);
    });

    it('classifies review-requests by requested_reviewers on the alt host', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', []);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(200);
      const numbers = res.body.prs.map(p => p.number).sort();
      expect(numbers).toEqual([102]); // only the PR requesting altuser as reviewer
      expect(res.body.prs[0].host).toBe(apiHost);
    });

    it('classifies team-reviews by requested_teams (all-teams view)', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', []);

      const res = await request(server).post('/api/github/team-reviews/refresh');

      expect(res.status).toBe(200);
      const numbers = res.body.prs.map(p => p.number).sort();
      expect(numbers).toEqual([103]); // only the team-requested PR
    });

    it('keeps github rows intact and reports the error when an alt host fails', async () => {
      await startAltHost({ pullsStatus: 500 });
      await useAltRepo();
      mockGithub('ghuser', [
        {
          owner: 'gh-org', repo: 'gh-repo', number: 7,
          title: 'GitHub PR', author: 'ghuser',
          updated_at: '2025-03-02T12:00:00Z',
          html_url: 'https://github.com/gh-org/gh-repo/pull/7', state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      // github.com refresh still succeeds with its rows.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(7);
      expect(res.body.prs[0].host).toBeNull();

      // The alt host failure is surfaced, not swallowed.
      expect(res.body.hosts).toHaveLength(1);
      expect(res.body.hosts[0]).toMatchObject({ host: apiHost, repo: 'altorg/altrepo', ok: false });
      expect(res.body.hosts[0].error).toBeTruthy();

      // Cache holds only the github row.
      const dbRows = await query(db, "SELECT number, host FROM github_pr_cache WHERE collection = 'my-prs'", []);
      expect(dbRows).toEqual([{ number: 7, host: null }]);
    });

    it('a failing /user on the alt host does not break the github refresh', async () => {
      await startAltHost({ userStatus: 500 });
      await useAltRepo();
      mockGithub('ghuser', []);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.hosts[0].ok).toBe(false);
    });

    it('retrying refresh does not duplicate alt-host rows', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', []);

      await request(server).post('/api/github/my-prs/refresh');
      await request(server).post('/api/github/my-prs/refresh');

      const dbRows = await query(db, "SELECT number, host FROM github_pr_cache WHERE collection = 'my-prs'", []);
      expect(dbRows).toEqual([{ number: 101, host: apiHost }]);
    });

    it('GET returns the host column for cached rows', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', []);

      await request(server).post('/api/github/my-prs/refresh');
      const res = await request(server).get('/api/github/my-prs');

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].host).toBe(apiHost);
    });

    it('refreshes an alt-host-only install with no github.com token (skips github branch)', async () => {
      await startAltHost();
      await useAltRepo(); // alt repo HAS a token ('alt-token')
      // No top-level github token — alt-host-only install.
      configModule.getGitHubToken.mockReturnValue(null);
      GitHubClient.prototype.getAuthenticatedUser.mockImplementation(function () {
        if (this.apiHost) return realGetAuthenticatedUser.call(this);
        return Promise.resolve({ login: 'ghuser', name: 'GH User', avatar_url: '' });
      });

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      // Alt rows still written (PR #101 authored by altuser → my-prs).
      expect(res.body.prs.some(p => p.number === 101 && p.host === apiHost)).toBe(true);
      // github.com search never ran without a token.
      expect(GitHubClient.prototype.searchPullRequests).not.toHaveBeenCalled();
      // Both sources reported: github skipped, alt host ok.
      expect(res.body.hosts).toContainEqual({ host: null, repo: null, ok: false, error: 'no github.com token configured' });
      expect(res.body.hosts).toContainEqual({ host: apiHost, repo: 'altorg/altrepo', ok: true });

      // Persisted alt row present; no github rows.
      const dbRows = await query(db, "SELECT number, host FROM github_pr_cache WHERE collection = 'my-prs'", []);
      expect(dbRows).toEqual([{ number: 101, host: apiHost }]);
    });

    it('returns 401 when NO source can authenticate (no github token, token-less alt repo)', async () => {
      await closeServer(server);
      app = createTestApp(db, {
        port: 7247, theme: 'light',
        // Alt repo with api_host but no credentials, and no top-level github token.
        repos: { 'altorg/altrepo': { api_host: 'https://althost.example/api/v3', exclusive: false } }
      });
      server = await listenOnLoopback(app);
      configModule.getGitHubToken.mockReturnValue(null);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('token not configured');
      // No probe attempted against the token-less repo.
      expect(GitHubClient.prototype.getAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('omits the hosts field for a healthy github-only install (backward compatible)', async () => {
      // Default outer app has a github token and no repos.
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({ login: 'ghuser', name: '', avatar_url: '' });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('hosts');
    });

    it('reports a token-less alt repo without probing or error-logging', async () => {
      // Repo has api_host but no repo-scoped credentials → empty-token binding.
      // The sweep must NOT construct a client or probe (which would 401 and
      // spam error logs); it reports a per-host status at debug level instead.
      await closeServer(server);
      const missingCredHost = 'https://althost.example/api/v3';
      app = createTestApp(db, {
        github_token: 'test-token', port: 7247, theme: 'light',
        repos: { 'altorg/altrepo': { api_host: missingCredHost, exclusive: false } }
      });
      server = await listenOnLoopback(app);
      mockGithub('ghuser', [
        {
          owner: 'gh-org', repo: 'gh-repo', number: 11,
          title: 'GitHub PR', author: 'ghuser',
          updated_at: '2025-03-04T12:00:00Z',
          html_url: 'https://github.com/gh-org/gh-repo/pull/11', state: 'open'
        }
      ]);
      const errorSpy = vi.spyOn(logger, 'error');

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      // github rows intact.
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(11);
      // Per-host status surfaced with the config-gap reason.
      expect(res.body.hosts).toEqual([
        { host: missingCredHost, repo: 'altorg/altrepo', ok: false, error: 'no credentials configured' }
      ]);
      // No probe happened: getAuthenticatedUser called once (github only), and
      // no error-level log for a mere config gap.
      expect(GitHubClient.prototype.getAuthenticatedUser).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('skips a non-owner/repo config key and reports it without crashing', async () => {
      await startAltHost();
      await closeServer(server);
      // A monorepo-style key that is not `owner/repo`; the sweep cannot derive
      // a repo for pulls.list, so it must be skipped (not crash the refresh).
      app = createTestApp(db, {
        github_token: 'test-token', port: 7247, theme: 'light',
        repos: { 'weird-monorepo-key': { api_host: apiHost, token: 'alt-token', exclusive: false } }
      });
      server = await listenOnLoopback(app);
      mockGithub('ghuser', [
        {
          owner: 'gh-org', repo: 'gh-repo', number: 9,
          title: 'GitHub PR', author: 'ghuser',
          updated_at: '2025-03-03T12:00:00Z',
          html_url: 'https://github.com/gh-org/gh-repo/pull/9', state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(9);
      expect(res.body.hosts).toHaveLength(1);
      expect(res.body.hosts[0]).toMatchObject({ host: apiHost, repo: 'weird-monorepo-key', ok: false });
      expect(res.body.hosts[0].error).toMatch(/owner\/repo/);
    });
  });
});
