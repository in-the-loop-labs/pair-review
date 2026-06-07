// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Backward-compatibility shim for the legacy `walkPRStack(client, ...)`
 * signature. The real implementation now lives in
 * `src/github/operations/stack-walker.js` (the dispatcher) and
 * `src/github/impl/graphql/stack-walker.js` (the GraphQL implementation).
 *
 * Direct importers of this module (`src/routes/pr.js` and tests) pass a
 * GitHubClient-like object as the first argument. The dispatcher accepts
 * that shape and routes to the correct transport via
 * `client.binding.features.stack_walker` when present, defaulting to
 * `"graphql"` otherwise — preserving pre-refactor behaviour exactly.
 */

const operations = require('./operations/stack-walker');

module.exports = {
  walkPRStack: operations.walkPRStack,
  DEFAULT_TRUNK_BRANCHES: operations.DEFAULT_TRUNK_BRANCHES
};
