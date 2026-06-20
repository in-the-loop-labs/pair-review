// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Council handle resolution helpers.
 *
 * Resolves user-supplied CLI handles (id, id-prefix, name, normalized name) to a
 * saved council row, and gathers "Last Used With" metadata for the council list.
 */

const { query, CouncilRepository } = require('../database');

/**
 * Normalize a string for fuzzy name matching: lowercase, trim, collapse any run
 * of non-alphanumeric characters to a single dash, and strip leading/trailing dashes.
 * @param {string} s - Input string
 * @returns {string} Normalized slug-like string
 */
function normalizeForMatch(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Truncate an id to its first 8 characters for display.
 * @param {string} id - Full council id (UUID)
 * @returns {string} Short id
 */
function shortId(id) {
  return String(id || '').slice(0, 8);
}

/**
 * Build a clear, multi-line ambiguity error for a handle that matched several councils.
 * @param {string} handle - The user-supplied handle
 * @param {Array<Object>} matches - The matching council rows
 * @returns {Error} Error with a readable, aligned candidate list
 * @private
 */
function _ambiguityError(handle, matches) {
  const padTo = Math.max(...matches.map(c => String(c.name || '').length));
  const lines = matches.map(c => {
    const name = String(c.name || '').padEnd(padTo);
    // Show the FULL id, not shortId: when the collision is on the 8-char prefix,
    // every shortId would be identical and could not disambiguate.
    return `  ${name}  (${c.id})`;
  });
  return new Error(
    `Ambiguous council "${handle}" matches ${matches.length} councils. Disambiguate with the id:\n` +
    lines.join('\n')
  );
}

/**
 * Resolve a user-supplied council handle to a full council row.
 *
 * Matching order (first unambiguous match wins):
 *   1. Exact id
 *   2. UUID-prefix (only for hex-ish handles of length >= 4)
 *   3. Exact name (case-insensitive)
 *   4. Normalized name
 *   5. Partial (substring) name fragment (last resort, never shadows the above)
 *
 * @param {Database} db - Database instance
 * @param {string} handle - The handle to resolve (id, id-prefix, or name)
 * @returns {Promise<Object>} The matching council row
 * @throws {Error} If the handle is missing, ambiguous, or matches nothing
 */
async function resolveCouncilHandle(db, handle) {
  const all = await new CouncilRepository(db).list();

  if (!handle) {
    throw new Error('A council handle is required.');
  }

  // 1. Exact id
  const exactId = all.find(c => c.id === handle);
  if (exactId) return exactId;

  // 2. UUID-prefix match (only for hex-ish handles of meaningful length)
  if (handle.length >= 4 && /^[0-9a-f-]+$/i.test(handle)) {
    const m = all.filter(c => c.id.toLowerCase().startsWith(handle.toLowerCase()));
    if (m.length === 1) return m[0];
    if (m.length > 1) throw _ambiguityError(handle, m);
  }

  // 3. Exact name (case-insensitive)
  {
    const m = all.filter(c => c.name.toLowerCase() === handle.toLowerCase());
    if (m.length === 1) return m[0];
    if (m.length > 1) throw _ambiguityError(handle, m);
  }

  // 4. Normalized name
  {
    const hn = normalizeForMatch(handle);
    const m = all.filter(c => normalizeForMatch(c.name) === hn);
    if (m.length === 1) return m[0];
    if (m.length > 1) throw _ambiguityError(handle, m);
  }

  // 5. Partial (substring) name fragment — last resort. A council matches if its
  // name contains the handle (case-insensitive) OR its normalized name contains
  // the normalized handle. Union both, de-duplicated by id so a council matched
  // both ways isn't double-counted.
  {
    const hl = handle.toLowerCase();
    const hn = normalizeForMatch(handle);
    const seen = new Set();
    const m = [];
    for (const c of all) {
      const byName = String(c.name || '').toLowerCase().includes(hl);
      const byNorm = hn !== '' && normalizeForMatch(c.name).includes(hn);
      if ((byName || byNorm) && !seen.has(c.id)) {
        seen.add(c.id);
        m.push(c);
      }
    }
    if (m.length === 1) return m[0];
    if (m.length > 1) throw _ambiguityError(handle, m);
  }

  // No match
  throw new Error(
    `No council matches "${handle}". Run \`pair-review --list-councils\` to see available councils.`
  );
}

/**
 * Build a map of the most recent council RUN per saved council, for the
 * "Last Used With" column in the council list.
 *
 * Only counts true council runs (provider = 'council', model != 'inline-config').
 * Councils with no council run simply won't appear in the map.
 *
 * @param {Database} db - Database instance
 * @returns {Promise<Map<string, {repository: string, review_type: string, pr_number: number, last_started: string}>>}
 *   Map keyed by council id.
 */
async function getCouncilLastUsedRepos(db) {
  const rows = await query(db, `
    SELECT ar.model AS council_id,
           r.repository AS repository,
           r.review_type AS review_type,
           r.pr_number AS pr_number,
           MAX(ar.started_at) AS last_started
    FROM analysis_runs ar
    JOIN reviews r ON r.id = ar.review_id
    WHERE ar.provider = 'council' AND ar.model != 'inline-config'
    GROUP BY ar.model
  `);

  const map = new Map();
  for (const row of rows) {
    map.set(row.council_id, {
      repository: row.repository,
      review_type: row.review_type,
      pr_number: row.pr_number,
      last_started: row.last_started
    });
  }
  return map;
}

module.exports = {
  normalizeForMatch,
  shortId,
  resolveCouncilHandle,
  getCouncilLastUsedRepos
};
