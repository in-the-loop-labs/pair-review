// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../utils/logger');

const DEFAULT_TRUNK_BRANCHES = ['main', 'master', 'develop'];
const MAX_WALK_DEPTH = 20;

const FETCH_PR_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number title baseRefName headRefName state url
      }
    }
  }
`;

const FIND_PRS_BY_HEAD_QUERY = `
  query($owner: String!, $repo: String!, $branch: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(headRefName: $branch, states: [OPEN, MERGED], first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { number title baseRefName headRefName state url }
      }
    }
  }
`;

const FIND_PRS_BY_BASE_QUERY = `
  query($owner: String!, $repo: String!, $branch: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(baseRefName: $branch, states: [OPEN], first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { number title baseRefName headRefName state url }
      }
    }
  }
`;

/**
 * Select the best PR from a list of candidates for the same branch.
 * Prefers OPEN over MERGED.
 *
 * @param {Array} prs - Array of PR nodes from GraphQL
 * @returns {Object|null} The best candidate or null
 */
function pickBestPR(prs) {
  if (!prs || prs.length === 0) return null;
  const open = prs.find(pr => pr.state === 'OPEN');
  if (open) return open;
  return prs[0];
}

/**
 * Walk a GitHub PR stack by following the branch chain via GraphQL.
 *
 * Starting from a given PR, walks up toward trunk (following baseRefName)
 * and down toward the tip (following headRefName) to discover the full stack.
 *
 * @param {Object} client - GitHubClient instance (uses client.octokit.graphql)
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} prNumber - Starting PR number
 * @param {Object} [_deps] - Optional dependency overrides for testing
 * @param {string[]} [_deps.defaultBranches] - Branch names considered trunk
 * @returns {Promise<Array>} Ordered stack from trunk to tip
 */
async function walkPRStack(client, owner, repo, prNumber, _deps) {
  const deps = { defaultBranches: DEFAULT_TRUNK_BRANCHES, ..._deps };
  const graphql = client.octokit.graphql.bind(client.octokit);
  const visited = new Set();

  // Step 1: Fetch the starting PR
  const startResult = await graphql(FETCH_PR_QUERY, { owner, repo, number: prNumber });
  const startPR = startResult.repository?.pullRequest;
  if (!startPR) {
    throw new Error(`PR #${prNumber} not found in ${owner}/${repo}`);
  }

  logger.debug(`Stack walker: starting from PR #${startPR.number} (${startPR.headRefName} -> ${startPR.baseRefName})`);
  visited.add(startPR.headRefName);

  // Step 2: Walk UP toward trunk
  const parents = []; // will be reversed at the end
  let currentBase = startPR.baseRefName;
  let walkUpDepth = 0;

  while (walkUpDepth < MAX_WALK_DEPTH) {
    if (deps.defaultBranches.includes(currentBase)) {
      // Reached trunk
      break;
    }
    if (visited.has(currentBase)) {
      logger.warn(`Stack walker: cycle detected at branch "${currentBase}", stopping upward walk`);
      break;
    }
    visited.add(currentBase);

    let parentPR;
    try {
      const result = await graphql(FIND_PRS_BY_HEAD_QUERY, { owner, repo, branch: currentBase });
      const candidates = result.repository?.pullRequests?.nodes || [];
      parentPR = pickBestPR(candidates);
    } catch (err) {
      logger.warn(`Stack walker: GraphQL error walking up at branch "${currentBase}": ${err.message}`);
      break;
    }

    if (!parentPR) {
      // No parent PR found — currentBase is effectively trunk for this stack
      break;
    }

    parents.push({
      branch: parentPR.headRefName,
      isTrunk: false,
      prNumber: parentPR.number,
      title: parentPR.title,
      state: parentPR.state,
      url: parentPR.url,
    });

    currentBase = parentPR.baseRefName;
    walkUpDepth++;
  }

  if (walkUpDepth >= MAX_WALK_DEPTH) {
    logger.warn(`Stack walker: upward walk reached max depth of ${MAX_WALK_DEPTH}`);
  }

  // The trunk entry is whatever branch the topmost PR targets
  const trunkBranch = currentBase;

  // Step 3: Walk DOWN toward tip
  const children = [];
  let currentHead = startPR.headRefName;
  let walkDownDepth = 0;

  while (walkDownDepth < MAX_WALK_DEPTH) {
    let childPR;
    try {
      const result = await graphql(FIND_PRS_BY_BASE_QUERY, { owner, repo, branch: currentHead });
      const candidates = result.repository?.pullRequests?.nodes || [];
      childPR = pickBestPR(candidates);
    } catch (err) {
      logger.warn(`Stack walker: GraphQL error walking down at branch "${currentHead}": ${err.message}`);
      break;
    }

    if (!childPR) {
      break;
    }

    if (visited.has(childPR.headRefName)) {
      logger.warn(`Stack walker: cycle detected at branch "${childPR.headRefName}", stopping downward walk`);
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
    });

    currentHead = childPR.headRefName;
    walkDownDepth++;
  }

  if (walkDownDepth >= MAX_WALK_DEPTH) {
    logger.warn(`Stack walker: downward walk reached max depth of ${MAX_WALK_DEPTH}`);
  }

  // Step 4: Assemble the ordered stack (trunk -> ... -> parents -> start -> children -> ... -> tip)
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
    },
    ...children,
  ];

  logger.debug(`Stack walker: found ${stack.length} entries (${stack.filter(e => !e.isTrunk).length} PRs)`);
  return stack;
}

module.exports = { walkPRStack, DEFAULT_TRUNK_BRANCHES };
