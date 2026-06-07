// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const graphqlImpl = require('../impl/graphql/stack-walker');
const restImpl = require('../impl/rest/stack-walker');

/**
 * Dispatcher for the `stack_walker` area.
 *
 * `walkPRStack` historically accepted a `client` (with `.octokit.graphql`).
 * To preserve backward compatibility while still routing through the
 * dispatcher, this module accepts either:
 *   - the new signature `(octokit, features, owner, repo, prNumber, _deps)`
 *   - the legacy signature `(client, owner, repo, prNumber, _deps)` where
 *     `client` looks like `{ octokit }` and the features map is omitted.
 *
 * `features.stack_walker` selects the transport:
 *   - `"graphql"` (default for github.com): delegates to
 *     `impl/graphql/stack-walker.js`.
 *   - `"rest"`: delegates to `impl/rest/stack-walker.js`. Returns the
 *     same ordered stack shape; PR `state` is normalised to GraphQL's
 *     uppercase form so consumers don't need to branch.
 *   - `"host"`: not yet implemented — Phase 5.
 */

const AREA = 'stack_walker';
// Modes actually implemented by the dispatcher below. Co-located with the
// dispatch logic so validateRepoConfig() and the dispatcher can't drift.
// `host` is reserved for Phase 5 and is not yet implemented.
const IMPLEMENTED_MODES = new Set(['graphql', 'rest']);

function selectFeature(features) {
  return (features && features[AREA]) || 'graphql';
}

/**
 * Walk a PR stack starting from a given PR.
 *
 * Detects whether it has been called with the new dispatcher signature
 * `(octokit, features, owner, repo, prNumber, _deps)` or the legacy
 * `(client, owner, repo, prNumber, _deps)` shape used by the original
 * `stack-walker.js` module so the existing call sites
 * (`src/routes/pr.js`, tests) keep working without modification.
 */
async function walkPRStack(arg0, arg1, arg2, arg3, arg4, arg5) {
  let octokit;
  let features;
  let owner;
  let repo;
  let prNumber;
  let deps;

  // Legacy shape: arg0 is a GitHubClient-like object with .octokit.
  if (arg0 && typeof arg0 === 'object' && arg0.octokit) {
    octokit = arg0.octokit;
    // Legacy callers don't pass features; treat as default github.com.
    features = arg0.binding?.features;
    owner = arg1;
    repo = arg2;
    prNumber = arg3;
    deps = arg4;
  } else {
    octokit = arg0;
    features = arg1;
    owner = arg2;
    repo = arg3;
    prNumber = arg4;
    deps = arg5;
  }

  const mode = selectFeature(features);
  if (mode === 'graphql') {
    return graphqlImpl.walkPRStack(octokit, owner, repo, prNumber, deps);
  }
  if (mode === 'rest') {
    return restImpl.walkPRStack(octokit, owner, repo, prNumber, deps);
  }
  if (mode === 'host') {
    throw new Error('Host implementation for stack_walker not yet available (Phase 5)');
  }
  throw new Error(`Unknown features.stack_walker value: "${mode}"`);
}

module.exports = {
  walkPRStack,
  DEFAULT_TRUNK_BRANCHES: graphqlImpl.DEFAULT_TRUNK_BRANCHES,
  AREA,
  IMPLEMENTED_MODES
};
