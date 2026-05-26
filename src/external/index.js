// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * External comment source dispatcher.
 *
 * Each external source (currently GitHub; GitLab/Linear planned) ships a
 * sibling adapter module that exports `{ name, fetchComments, mapComment }`.
 * This file maintains the keyed registry and resolves a `source` string to
 * the matching adapter. Adding a new source is a one-file change here plus
 * the new adapter module — no routes or repositories need to know.
 */

const githubAdapter = require('./github-adapter');

const adapters = {
  [githubAdapter.name]: githubAdapter,
};

/**
 * Look up an adapter by its `source` string.
 *
 * @param {string} source - e.g. 'github'
 * @returns {{ name: string, fetchComments: Function, mapComment: Function }}
 * @throws {Error} when no adapter is registered for the source name
 */
function getAdapter(source) {
  // Own-property guard: `adapters` is a plain object, so `adapters['toString']`
  // would resolve to Object.prototype.toString (a function) and the route's
  // unknown-source check (which depends on this function throwing) would
  // silently pass. Use hasOwnProperty so only registered adapters resolve.
  if (typeof source !== 'string' || !Object.prototype.hasOwnProperty.call(adapters, source)) {
    throw new Error(`Unknown external comment source: ${source}`);
  }
  return adapters[source];
}

module.exports = { getAdapter, adapters };
