// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../../../utils/logger');

/**
 * REST implementation of the stack-walker area.
 *
 * Mirrors `impl/graphql/stack-walker.js` but uses REST endpoints:
 *
 *   - Q3 FETCH_PR_QUERY        -> `pulls.get({ owner, repo, pull_number })`
 *   - Q4 FIND_PRS_BY_HEAD_QUERY -> `pulls.list({ owner, repo, head, state: 'all' })`
 *   - Q5 FIND_PRS_BY_BASE_QUERY -> `pulls.list({ owner, repo, base, state: 'open' })`
 *
 * Returns the ordered stack shape `walkPRStack` historically returned
 * (trunk -> parents (oldest first when reversed in caller) -> starting
 * PR -> children). PR entries match the GraphQL impl's normalised node
 * shape: { number, title, baseRefName, headRefName, headRefOid, state,
 * url }, with `state` normalised to uppercase to match GraphQL
 * semantics.
 *
 * Discovery scope: `findPRsByHead` passes `head: "${owner}:${branch}"`
 * to `pulls.list`. GitHub REST's `head` filter is strictly
 * `user:branch` and only matches PRs whose head ref lives on the same
 * owner as the base repo; PRs opened from contributor forks are
 * silently excluded. The GraphQL impl's `headRefName` filter has no
 * such restriction.
 *
 * This impl is intended for alt-hosts (GitHub Enterprise, etc.) where
 * stacking workflows do not involve forks. On github.com, `stack_walker`
 * defaults to GraphQL (see `GRAPHQL_DEFAULT_AREAS` in `src/config.js`),
 * where the fork restriction does not apply.
 */

const DEFAULT_TRUNK_BRANCHES = ['main', 'master', 'develop'];
const MAX_WALK_DEPTH = 20;

/**
 * Normalise a REST PR object to the GraphQL-style shape used by the
 * stack walker. REST exposes `state` in lowercase (`open`/`closed`) and
 * separates `merged` via `merged_at != null`; GraphQL exposes
 * `OPEN`/`CLOSED`/`MERGED` directly. Normalising here keeps the
 * downstream walk logic transport-agnostic.
 *
 * @param {Object} pr - REST PR object (from `pulls.get` or `pulls.list`)
 * @returns {Object} GraphQL-shaped PR node
 */
function normalisePR(pr) {
  let state;
  if (pr.merged_at) {
    state = 'MERGED';
  } else if (typeof pr.state === 'string') {
    state = pr.state.toUpperCase();
  } else {
    state = 'OPEN';
  }
  return {
    number: pr.number,
    title: pr.title,
    baseRefName: pr.base && pr.base.ref,
    headRefName: pr.head && pr.head.ref,
    headRefOid: pr.head && pr.head.sha,
    state,
    url: pr.html_url
  };
}

/**
 * Select the best PR from a list of candidates for the same branch.
 * Prefers OPEN over MERGED. Mirrors the GraphQL impl exactly.
 *
 * @param {Array} prs - Array of normalised PR nodes
 * @returns {Object|null}
 */
function pickBestPR(prs) {
  if (!prs || prs.length === 0) return null;
  const open = prs.find(pr => pr.state === 'OPEN');
  if (open) return open;
  return prs[0];
}

/**
 * Fetch the starting PR by number.
 *
 * @param {Object} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<Object|null>}
 */
async function fetchPR(octokit, owner, repo, prNumber) {
  try {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber
    });
    return normalisePR(data);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Find PRs whose HEAD branch matches `branch`. Filters to OPEN + MERGED
 * to match the GraphQL impl's `states: [OPEN, MERGED]`.
 *
 * Ordering note: GraphQL uses `orderBy: { field: UPDATED_AT, direction:
 * DESC }`. The REST `pulls.list` endpoint sorts by `updated_at`
 * descending by default; we pass it explicitly to stay
 * observationally-identical.
 *
 * @param {Object} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @returns {Promise<Array>}
 */
async function findPRsByHead(octokit, owner, repo, branch) {
  // REST `state` filter accepts only `open|closed|all`. `closed`
  // includes merged. We need OPEN + MERGED but not CLOSED-without-merge,
  // so fetch with `state: 'all'` and filter client-side.
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: 5
  });
  return data
    .map(normalisePR)
    .filter(pr => pr.state === 'OPEN' || pr.state === 'MERGED');
}

/**
 * Find PRs whose BASE branch matches `branch`. Mirrors GraphQL's
 * `states: [OPEN]`.
 *
 * @param {Object} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @returns {Promise<Array>}
 */
async function findPRsByBase(octokit, owner, repo, branch) {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    base: branch,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: 5
  });
  return data.map(normalisePR);
}

/**
 * Walk a PR stack using REST endpoints.
 *
 * Same algorithm as the GraphQL implementation; only the transport
 * differs.
 *
 * @param {Object} octokit - Octokit instance bound to the host's baseUrl
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {Object} [_deps]
 * @param {string[]} [_deps.defaultBranches]
 * @returns {Promise<Array>}
 */
async function walkPRStack(octokit, owner, repo, prNumber, _deps) {
  const deps = { defaultBranches: DEFAULT_TRUNK_BRANCHES, ..._deps };
  const visited = new Set();

  // Step 1: Fetch the starting PR
  const startPR = await fetchPR(octokit, owner, repo, prNumber);
  if (!startPR) {
    throw new Error(`PR #${prNumber} not found in ${owner}/${repo}`);
  }

  logger.debug(`Stack walker (REST): starting from PR #${startPR.number} (${startPR.headRefName} -> ${startPR.baseRefName})`);
  visited.add(startPR.headRefName);

  // Step 2: Walk UP toward trunk
  const parents = [];
  let currentBase = startPR.baseRefName;
  let walkUpDepth = 0;

  while (walkUpDepth < MAX_WALK_DEPTH) {
    if (deps.defaultBranches.includes(currentBase)) {
      break;
    }
    if (visited.has(currentBase)) {
      logger.warn(`Stack walker (REST): cycle detected at branch "${currentBase}", stopping upward walk`);
      break;
    }
    visited.add(currentBase);

    let parentPR;
    try {
      const candidates = await findPRsByHead(octokit, owner, repo, currentBase);
      parentPR = pickBestPR(candidates);
    } catch (err) {
      logger.warn(`Stack walker (REST): error walking up at branch "${currentBase}": ${err.message}`);
      break;
    }

    if (!parentPR) {
      break;
    }

    parents.push({
      branch: parentPR.headRefName,
      isTrunk: false,
      prNumber: parentPR.number,
      title: parentPR.title,
      state: parentPR.state,
      url: parentPR.url,
      headSha: parentPR.headRefOid,
    });

    currentBase = parentPR.baseRefName;
    walkUpDepth++;
  }

  if (walkUpDepth >= MAX_WALK_DEPTH) {
    logger.warn(`Stack walker (REST): upward walk reached max depth of ${MAX_WALK_DEPTH}`);
  }

  const trunkBranch = currentBase;

  // Step 3: Walk DOWN toward tip
  const children = [];
  let currentHead = startPR.headRefName;
  let walkDownDepth = 0;

  while (walkDownDepth < MAX_WALK_DEPTH) {
    let childPR;
    try {
      const candidates = await findPRsByBase(octokit, owner, repo, currentHead);
      childPR = pickBestPR(candidates);
    } catch (err) {
      logger.warn(`Stack walker (REST): error walking down at branch "${currentHead}": ${err.message}`);
      break;
    }

    if (!childPR) {
      break;
    }

    if (visited.has(childPR.headRefName)) {
      logger.warn(`Stack walker (REST): cycle detected at branch "${childPR.headRefName}", stopping downward walk`);
      break;
    }
    visited.add(childPR.headRefName);

    children.push({
      branch: childPR.headRefName,
      isTrunk: false,
      prNumber: childPR.number,
      title: childPR.title,
      state: childPR.state,
      url: childPR.url,
      headSha: childPR.headRefOid,
    });

    currentHead = childPR.headRefName;
    walkDownDepth++;
  }

  if (walkDownDepth >= MAX_WALK_DEPTH) {
    logger.warn(`Stack walker (REST): downward walk reached max depth of ${MAX_WALK_DEPTH}`);
  }

  // Step 4: Assemble the ordered stack
  const stack = [
    { branch: trunkBranch, isTrunk: true },
    ...parents.reverse(),
    {
      branch: startPR.headRefName,
      isTrunk: false,
      prNumber: startPR.number,
      title: startPR.title,
      state: startPR.state,
      url: startPR.url,
      headSha: startPR.headRefOid,
    },
    ...children,
  ];

  logger.debug(`Stack walker (REST): found ${stack.length} entries (${stack.filter(e => !e.isTrunk).length} PRs)`);
  return stack;
}

module.exports = {
  walkPRStack,
  DEFAULT_TRUNK_BRANCHES,
  MAX_WALK_DEPTH,
  // Exposed for tests and parity verification.
  _internals: {
    normalisePR,
    pickBestPR,
    fetchPR,
    findPRsByHead,
    findPRsByBase
  }
};
