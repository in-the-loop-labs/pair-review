// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * GitHub Collections Routes
 *
 * Handles endpoints for PR collections:
 * - Review Requests: PRs where the user's review is requested directly
 * - Team Review Requests: PRs where a team the user belongs to is requested,
 *   but the user is not requested directly
 * - My PRs: PRs authored by the user
 *
 * Each collection exposes two endpoints registered by `registerCollection`:
 * - GET  /api/github/:collection          → cached rows from github_pr_cache
 * - POST /api/github/:collection/refresh  → fetch from GitHub and re-cache
 */

const express = require('express');
const { query, run, withTransaction } = require('../database');
const { GitHubClient } = require('../github/client');
const { getGitHubToken } = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

const SELECT_COLUMNS = 'owner, repo, number, title, author, updated_at, html_url, state, fetched_at';

/**
 * Collection definitions. `buildQuery` receives the authenticated user's login
 * and returns the GitHub search query for that collection.
 */
const COLLECTIONS = [
  {
    name: 'review-requests',
    label: 'review requests',
    buildQuery: (login) => `is:pr is:open archived:false user-review-requested:${login}`
  },
  {
    name: 'team-reviews',
    label: 'team review requests',
    // Review requested from a team the user belongs to, excluding PRs where the
    // user is requested directly (those appear under review-requests).
    buildQuery: (login) => `is:pr is:open archived:false review-requested:${login} -user-review-requested:${login}`
  },
  {
    name: 'my-prs',
    label: 'your pull requests',
    buildQuery: (login) => `is:pr is:open archived:false author:${login}`
  }
];

/**
 * Fetch cached rows for a collection, newest first.
 */
async function getCachedRows(db, collection) {
  return query(
    db,
    `SELECT ${SELECT_COLUMNS} FROM github_pr_cache WHERE collection = ? ORDER BY updated_at DESC`,
    [collection]
  );
}

/**
 * Register the GET (cached) and POST (refresh) routes for a single collection.
 * @param {Object} def - Collection definition ({ name, label, buildQuery }).
 */
function registerCollection(def) {
  const { name, label, buildQuery } = def;

  // GET cached PRs.
  router.get(`/api/github/${name}`, async (req, res) => {
    try {
      const db = req.app.get('db');
      const rows = await getCachedRows(db, name);
      const fetchedAt = rows.length > 0 ? rows[0].fetched_at : null;
      res.json({ success: true, prs: rows, fetched_at: fetchedAt });
    } catch (error) {
      logger.error(`Failed to fetch ${label}:`, error);
      res.status(500).json({ success: false, error: `Failed to fetch ${label}` });
    }
  });

  // POST refresh from GitHub.
  router.post(`/api/github/${name}/refresh`, async (req, res) => {
    try {
      const config = req.app.get('config');
      const githubToken = getGitHubToken(config);
      if (!githubToken) {
        return res.status(401).json({ success: false, error: 'GitHub token not configured' });
      }

      const db = req.app.get('db');
      const client = new GitHubClient(githubToken);
      const user = await client.getAuthenticatedUser();
      const prs = await client.searchPullRequests(buildQuery(user.login));

      await withTransaction(db, async () => {
        await run(db, 'DELETE FROM github_pr_cache WHERE collection = ?', [name]);
        for (const pr of prs) {
          await run(db,
            'INSERT INTO github_pr_cache (owner, repo, number, title, author, updated_at, html_url, state, collection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [pr.owner, pr.repo, pr.number, pr.title, pr.author, pr.updated_at, pr.html_url, pr.state, name]
          );
        }
      });

      const rows = await getCachedRows(db, name);
      const fetchedAt = rows.length > 0 ? rows[0].fetched_at : null;
      res.json({ success: true, prs: rows, fetched_at: fetchedAt });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        return res.status(401).json({ success: false, error: 'GitHub token is invalid or expired' });
      }
      logger.error(`Failed to refresh ${label}:`, error);
      res.status(500).json({ success: false, error: `Failed to refresh ${label}` });
    }
  });
}

COLLECTIONS.forEach(registerCollection);

module.exports = router;
