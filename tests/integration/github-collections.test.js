// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const { GitHubClient } = require('../../src/github/client');
const configModule = require('../../src/config');
const { run, query } = require('../../src/database');

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
});
