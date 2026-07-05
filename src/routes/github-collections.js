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
const { getGitHubToken, resolveHostBinding } = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

// `host` is additive: NULL for github.com rows, the repo's `api_host` URL for
// alt-host rows. Both GET and the refresh re-read echo it so the frontend can
// open a PR against the system it actually lives on without re-probing.
const SELECT_COLUMNS = 'owner, repo, number, title, author, updated_at, html_url, state, fetched_at, host';

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
// Each definition also carries a `classifyAlt(pr, login, team)` predicate that
// buckets a REST-listed alt-host PR into this collection. Alt-hosts generally
// have no Search API, so the collection semantics that `buildQuery` expresses
// as a github.com search string are re-expressed here as a local predicate
// over the fields `client.listOpenPullRequests` returns. `pr.requested_teams`
// holds team *slugs*; `team`, when set, is a validated `org/team` slug.
const COLLECTIONS = [
  {
    name: 'review-requests',
    label: 'review requests',
    buildQuery: (login) => `is:pr is:open archived:false user-review-requested:${login}`,
    classifyAlt: (pr, login) => pr.requested_reviewers.includes(login)
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
    },
    // A specific `team` filters to PRs requesting that team's slug (the part
    // after the slash, since REST `requested_teams` carries bare slugs, not
    // `org/team`); the all-teams view keeps the same "exclude direct requests"
    // rule as the github.com search so a directly-requested PR shows under
    // review-requests, not here.
    classifyAlt: (pr, login, team) => {
      if (pr.requested_teams.length === 0) return false;
      if (team) {
        const slug = team.slice(team.indexOf('/') + 1);
        return pr.requested_teams.includes(slug);
      }
      return !pr.requested_reviewers.includes(login);
    }
  },
  {
    name: 'my-prs',
    label: 'your pull requests',
    buildQuery: (login) => `is:pr is:open archived:false author:${login}`,
    classifyAlt: (pr, login) => pr.author === login
  }
];

/**
 * Derive an `owner/repo` pair from a `config.repos` key. Alt-host config
 * entries are keyed by the canonical `owner/repo`; monorepo-style entries can
 * be keyed by something else and matched to PRs via `url_pattern`, but the
 * collections sweep needs a concrete owner/repo to call `pulls.list`, so those
 * keys are skipped rather than guessed at.
 * @param {string} repoKey - A `config.repos` key.
 * @returns {{ owner: string, repo: string }|null} Null when not owner/repo shaped.
 */
function ownerRepoFromKey(repoKey) {
  if (typeof repoKey !== 'string') return null;
  const parts = repoKey.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Sweep every alt-host repo in config for open PRs belonging to `collection`,
 * classifying each with `def.classifyAlt`. Best-effort per host: a failure for
 * one repo is captured in the returned `hosts` array and never thrown, so the
 * github.com results already gathered by the caller are never lost. Rows are
 * stamped with the repo's `api_host` string for the `host` column.
 *
 * `credentialedRepoCount` counts alt-host repos that resolved a non-empty
 * token (i.e. could authenticate), regardless of whether the subsequent fetch
 * then succeeded. The refresh route uses it to decide whether ANY source can
 * authenticate before returning 401 on an install with no github.com token.
 *
 * @param {Object} config - Server config (from loadConfig()).
 * @param {Object} def - The collection definition (needs `classifyAlt`).
 * @param {string|null} team - Validated `org/team` filter, or null.
 * @returns {Promise<{ rows: Array<Object>, hosts: Array<{host: string, repo: string, ok: boolean, error?: string}>, credentialedRepoCount: number }>}
 */
async function sweepAltHosts(config, def, team) {
  const rows = [];
  const hosts = [];
  let credentialedRepoCount = 0;
  const repos = (config && config.repos) || {};
  if (typeof def.classifyAlt !== 'function') {
    return { rows, hosts, credentialedRepoCount };
  }

  // One `GET /user` per (host, token) per refresh — multiple repos can share a
  // host, and a login lookup per repo would be wasteful. Keyed by token too so
  // distinct credentials on the same host resolve their own identity.
  const loginCache = new Map();

  for (const [repoKey, repoEntry] of Object.entries(repos)) {
    if (!repoEntry || typeof repoEntry !== 'object') continue;
    const apiHost = (typeof repoEntry.api_host === 'string' && repoEntry.api_host) ? repoEntry.api_host : null;
    if (!apiHost) continue;

    const ownerRepo = ownerRepoFromKey(repoKey);
    if (!ownerRepo) {
      logger.warn(`Collections: skipping alt-host repo "${repoKey}" (${apiHost}) — key is not an owner/repo pair, cannot derive a repo for pulls.list`);
      hosts.push({ host: apiHost, repo: repoKey, ok: false, error: 'config key is not an owner/repo pair' });
      continue;
    }

    try {
      const binding = resolveHostBinding(repoKey, config, { host: apiHost });

      // A repo with `api_host` but no repo-scoped token yields an empty-token
      // binding. Probing anyway would 401 once per collection per refresh and
      // spam error logs; surface it as a per-host status instead (debug, not
      // error — it's a config gap, not a runtime failure).
      if (!binding.token) {
        logger.debug(`Collections: skipping alt-host repo "${repoKey}" (${apiHost}) — no repo-scoped credentials configured`);
        hosts.push({ host: apiHost, repo: repoKey, ok: false, error: 'no credentials configured' });
        continue;
      }
      credentialedRepoCount++;

      const client = new GitHubClient(binding);

      const loginKey = `${apiHost}\u0000${binding.token}`;
      let login = loginCache.get(loginKey);
      if (login === undefined) {
        const user = await client.getAuthenticatedUser();
        login = user.login;
        loginCache.set(loginKey, login);
      }

      const prs = await client.listOpenPullRequests(ownerRepo.owner, ownerRepo.repo);
      for (const pr of prs) {
        if (def.classifyAlt(pr, login, team)) {
          rows.push({ ...pr, host: apiHost });
        }
      }
      hosts.push({ host: apiHost, repo: repoKey, ok: true });
    } catch (error) {
      logger.error(`Collections: alt-host refresh failed for ${repoKey} (${apiHost}): ${error.message}`);
      hosts.push({ host: apiHost, repo: repoKey, ok: false, error: error.message });
    }
  }

  return { rows, hosts, credentialedRepoCount };
}

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
      const db = req.app.get('db');

      // The dashboard has two independent PR sources: the github.com search
      // (top-level token) and the per-repo alt-host sweep. Treat them
      // independently so an alt-host-only install (repo-scoped alt credentials,
      // NO global github token) can still refresh. A missing github token skips
      // ONLY the github branch; a per-source status is recorded instead.
      // Cross-repo search on github.com — no per-repo binding applies here.
      // Explicit `undefined` repository selects the no-repo (top-level) path.
      const githubToken = getGitHubToken(config, undefined);
      const sourceStatuses = [];
      let prs = [];
      if (githubToken) {
        const client = new GitHubClient(githubToken);
        const user = await client.getAuthenticatedUser();
        prs = await client.searchPullRequests(buildQuery(user.login, { team }));
      } else {
        // host:null, repo:null identifies the github.com cross-repo source
        // (mirrors the NULL-host = github.com convention used for cache rows).
        sourceStatuses.push({ host: null, repo: null, ok: false, error: 'no github.com token configured' });
      }

      // Alt-host repos (both exclusive and dual) have no Search API, so sweep
      // them via REST and classify locally. Best-effort: a failing host is
      // reported in `hosts` and never aborts the github.com rows below. Done
      // BEFORE the transaction so a slow alt host doesn't hold a write lock.
      const { rows: altRows, hosts, credentialedRepoCount } = await sweepAltHosts(config, def, team);

      // Only 401 when NO source can authenticate at all: no github token AND no
      // alt-host repo with credentials. If either can authenticate, proceed and
      // report the unavailable source in the response.
      if (!githubToken && credentialedRepoCount === 0) {
        return res.status(401).json({ success: false, error: 'GitHub token not configured' });
      }

      // Namespace the cache so a filtered view never clobbers the all-teams
      // cache. Every distinct team string the user tries creates its own cached
      // rows that are never garbage-collected; negligible for a local SQLite
      // home-page feature.
      const key = cacheKey(name, team);
      await withTransaction(db, async () => {
        // DELETE-then-INSERT clears prior github AND alt rows for this key, so a
        // retry re-derives the whole view rather than duplicating. github rows
        // stamp host NULL; alt rows carry their api_host string.
        await run(db, 'DELETE FROM github_pr_cache WHERE collection = ?', [key]);
        for (const pr of prs) {
          await run(db,
            'INSERT INTO github_pr_cache (owner, repo, number, title, author, updated_at, html_url, state, collection, host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [pr.owner, pr.repo, pr.number, pr.title, pr.author, pr.updated_at, pr.html_url, pr.state, key, null]
          );
        }
        for (const pr of altRows) {
          await run(db,
            'INSERT INTO github_pr_cache (owner, repo, number, title, author, updated_at, html_url, state, collection, host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [pr.owner, pr.repo, pr.number, pr.title, pr.author, pr.updated_at, pr.html_url, pr.state, key, pr.host]
          );
        }
      });

      const rows = await getCachedRows(db, key);
      const fetchedAt = rows.length > 0 ? rows[0].fetched_at : null;
      // `hosts` is additive; omit it entirely when every source is healthy (no
      // alt-host repos and a working github token) so the github-only happy-path
      // response shape is byte-identical to before. A skipped github source or
      // any alt-host status makes it appear.
      const allStatuses = sourceStatuses.concat(hosts);
      const payload = { success: true, prs: rows, fetched_at: fetchedAt };
      if (allStatuses.length > 0) payload.hosts = allStatuses;
      res.json(payload);
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
