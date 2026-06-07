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

// Valid `org/team` slug: two non-empty segments of GitHub-allowed characters.
// Used to guard against query injection when interpolating the team into the
// GitHub search query string. Must be applied server-side; client validation
// is UX only.
const TEAM_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Collection definitions. `buildQuery` receives the authenticated user's login
 * and an optional params object, and returns the GitHub search query for that
 * collection. Only collections with `supportsTeamFilter: true` consume
 * `params.team` (currently just `team-reviews`); the others accept and ignore
 * it. The flag also gates the team plumbing in `registerCollection`: a stray
 * `?team=` on a collection that doesn't support it is ignored rather than
 * validated or folded into the cache key, so it can never create a misleading
 * namespaced cache entry for a query whose results are identical to the
 * unfiltered view.
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
    supportsTeamFilter: true,
    // Review requested from a team the user belongs to, excluding PRs where the
    // user is requested directly (those appear under review-requests).
    //
    // When a specific `team` (org/team) is provided, narrow to that team's open
    // review requests and drop the `-user-review-requested` exclusion: once the
    // user explicitly picks a team, "show everything awaiting this team" is the
    // least surprising behavior. The team value MUST already be validated.
    buildQuery: (login, params) => {
      const team = params && params.team;
      if (team) {
        return `is:pr is:open archived:false team-review-requested:${team}`;
      }
      return `is:pr is:open archived:false review-requested:${login} -user-review-requested:${login}`;
    }
  },
  {
    name: 'my-prs',
    label: 'your pull requests',
    buildQuery: (login) => `is:pr is:open archived:false author:${login}`
  }
];

/**
 * Derive the cache storage key for a collection, namespacing by team so a
 * filtered view never clobbers the all-teams cache. Both the GET (read) and
 * POST refresh (write/delete) handlers must route through this single helper so
 * they never diverge.
 * @param {string} name - Collection name.
 * @param {string} [team] - Validated `org/team` slug, or falsy for all-teams.
 * @returns {string} The `collection` column value to use.
 */
function cacheKey(name, team) {
  return team ? `${name}:${team}` : name;
}

/**
 * Validate and normalize the `team` query param.
 * @param {*} raw - The raw `team` value from the request.
 * @returns {{ team: string|null, error: string|null }} `team` is the validated
 *   slug (or null for all-teams); `error` is set when the input is invalid.
 */
function parseTeamParam(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { team: null, error: null };
  }
  if (typeof raw !== 'string' || !TEAM_SLUG_PATTERN.test(raw)) {
    return { team: null, error: 'Invalid team. Use the form org/team.' };
  }
  return { team: raw, error: null };
}

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
 * @param {Object} def - Collection definition
 *   ({ name, label, buildQuery, supportsTeamFilter }).
 */
function registerCollection(def) {
  const { name, label, buildQuery, supportsTeamFilter } = def;

  // GET cached PRs.
  router.get(`/api/github/${name}`, async (req, res) => {
    try {
      // Only team-aware collections consume `team`; for the rest, ignore any
      // stray `?team=` so it can't validate-error or skew the cache key.
      let team = null;
      if (supportsTeamFilter) {
        const parsed = parseTeamParam(req.query.team);
        if (parsed.error) {
          return res.status(400).json({ success: false, error: parsed.error });
        }
        team = parsed.team;
      }

      const db = req.app.get('db');
      const rows = await getCachedRows(db, cacheKey(name, team));
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
      // Only team-aware collections consume `team` (from the query string or
      // request body); for the rest, ignore any stray value so it can't
      // validate-error or skew the cache key. Empty/absent means "all teams".
      let team = null;
      if (supportsTeamFilter) {
        const rawTeam = req.query.team !== undefined ? req.query.team : (req.body && req.body.team);
        const parsed = parseTeamParam(rawTeam);
        if (parsed.error) {
          return res.status(400).json({ success: false, error: parsed.error });
        }
        team = parsed.team;
      }

      const config = req.app.get('config');
      // Cross-repo search on github.com — no per-repo binding applies here.
      // Explicit `undefined` repository selects the no-repo (top-level) path.
      const githubToken = getGitHubToken(config, undefined);
      if (!githubToken) {
        return res.status(401).json({ success: false, error: 'GitHub token not configured' });
      }

      const db = req.app.get('db');
      const client = new GitHubClient(githubToken);
      const user = await client.getAuthenticatedUser();
      const prs = await client.searchPullRequests(buildQuery(user.login, { team }));

      // Namespace the cache so a filtered view never clobbers the all-teams
      // cache. Every distinct team string the user tries creates its own cached
      // rows that are never garbage-collected; negligible for a local SQLite
      // home-page feature.
      const key = cacheKey(name, team);
      await withTransaction(db, async () => {
        await run(db, 'DELETE FROM github_pr_cache WHERE collection = ?', [key]);
        for (const pr of prs) {
          await run(db,
            'INSERT INTO github_pr_cache (owner, repo, number, title, author, updated_at, html_url, state, collection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [pr.owner, pr.repo, pr.number, pr.title, pr.author, pr.updated_at, pr.html_url, pr.state, key]
          );
        }
      });

      const rows = await getCachedRows(db, key);
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
