// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * GitHub Collections Routes
 *
 * Handles endpoints for PR collections:
 * - Review Requests: PRs where the user's review is requested
 * - My PRs: PRs authored by the user
 */

const express = require('express');
const { query, run, withTransaction } = require('../database');
const { GitHubClient } = require('../github/client');
const { getGitHubToken } = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Get cached review request PRs.
 */
router.get('/api/github/review-requests', async (req, res) => {
  try {
    const db = req.app.get('db');
    const rows = await query(db, 'SELECT owner, repo, number, title, author, updated_at, html_url, state, fetched_at FROM github_pr_cache WHERE collection = ? ORDER BY updated_at DESC', ['review-requests']);

    const fetchedAt = rows.length > 0 ? rows[0].fetched_at : null;
    res.json({ success: true, prs: rows, fetched_at: fetchedAt });
  } catch (error) {
    logger.error('Failed to fetch review requests:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch review requests' });
  }
});

/**
 * Refresh review request PRs from GitHub.
 */
router.post('/api/github/review-requests/refresh', async (req, res) => {
  try {
    const config = req.app.get('config');
    const githubToken = getGitHubToken(config);
    if (!githubToken) {
      return res.status(401).json({ success: false, error: 'GitHub token not configured' });
    }

    const db = req.app.get('db');
    const client = new GitHubClient(githubToken);
    const user = await client.getAuthenticatedUser();
    const prs = await client.searchPullRequests(`is:pr is:open review-requested:${user.login}`);

    await withTransaction(db, async () => {
      await run(db, 'DELETE FROM github_pr_cache WHERE collection = ?', ['review-requests']);
      for (const pr of prs) {
        await run(db,
          'INSERT INTO github_pr_cache (owner, repo, number, title, author, updated_at, html_url, state, collection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [pr.owner, pr.repo, pr.number, pr.title, pr.author, pr.updated_at, pr.html_url, pr.state, 'review-requests']
        );
      }
    });

    const rows = await query(db, 'SELECT owner, repo, number, title, author, updated_at, html_url, state, fetched_at FROM github_pr_cache WHERE collection = ? ORDER BY updated_at DESC', ['review-requests']);
    const fetchedAt = rows.length > 0 ? rows[0].fetched_at : null;
    res.json({ success: true, prs: rows, fetched_at: fetchedAt });
  } catch (error) {
    logger.error('Failed to refresh review requests:', error.message);
    res.status(500).json({ success: false, error: 'Failed to refresh review requests' });
  }
});

/**
 * Get cached user's own PRs.
 */
router.get('/api/github/my-prs', async (req, res) => {
  try {
    const db = req.app.get('db');
    const rows = await query(db, 'SELECT owner, repo, number, title, author, updated_at, html_url, state, fetched_at FROM github_pr_cache WHERE collection = ? ORDER BY updated_at DESC', ['my-prs']);

    const fetchedAt = rows.length > 0 ? rows[0].fetched_at : null;
    res.json({ success: true, prs: rows, fetched_at: fetchedAt });
  } catch (error) {
    logger.error('Failed to fetch my PRs:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch my PRs' });
  }
});

/**
 * Refresh user's own PRs from GitHub.
 */
router.post('/api/github/my-prs/refresh', async (req, res) => {
  try {
    const config = req.app.get('config');
    const githubToken = getGitHubToken(config);
    if (!githubToken) {
      return res.status(401).json({ success: false, error: 'GitHub token not configured' });
    }

    const db = req.app.get('db');
    const client = new GitHubClient(githubToken);
    const user = await client.getAuthenticatedUser();
    const prs = await client.searchPullRequests(`is:pr is:open author:${user.login}`);

    await withTransaction(db, async () => {
      await run(db, 'DELETE FROM github_pr_cache WHERE collection = ?', ['my-prs']);
      for (const pr of prs) {
        await run(db,
          'INSERT INTO github_pr_cache (owner, repo, number, title, author, updated_at, html_url, state, collection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [pr.owner, pr.repo, pr.number, pr.title, pr.author, pr.updated_at, pr.html_url, pr.state, 'my-prs']
        );
      }
    });

    const rows = await query(db, 'SELECT owner, repo, number, title, author, updated_at, html_url, state, fetched_at FROM github_pr_cache WHERE collection = ? ORDER BY updated_at DESC', ['my-prs']);
    const fetchedAt = rows.length > 0 ? rows[0].fetched_at : null;
    res.json({ success: true, prs: rows, fetched_at: fetchedAt });
  } catch (error) {
    logger.error('Failed to refresh my PRs:', error.message);
    res.status(500).json({ success: false, error: 'Failed to refresh my PRs' });
  }
});

module.exports = router;
