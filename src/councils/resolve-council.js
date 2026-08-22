// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Council handle resolution helpers.
 *
 * Resolves user-supplied CLI handles (id, id-prefix, name, normalized name) to a
 * saved council row, and gathers "Last Used With" metadata for the council list.
 */

const { query } = require('../database');
const { createCouncilStore, isFileCouncilId, FILE_ID_PREFIX } = require('./council-store');
const { slugifyCouncilName } = require('../../public/js/utils/council-document');

/**
 * `error.code` values `resolveCouncilHandle` stamps on the two failures a
 * caller can meaningfully branch on.
 *
 * A code, not a message match: `council edit` falls back to editing a council
 * FILE only when the resolver found NOTHING, and identifying that case by
 * matching the message text would silently start editing files again the day
 * the wording changes. Anything without a code is an unexpected failure (a
 * database error, a missing handle) and must not be treated as either.
 */
const COUNCIL_NOT_FOUND = 'COUNCIL_NOT_FOUND';
const COUNCIL_AMBIGUOUS = 'COUNCIL_AMBIGUOUS';

/**
 * Normalize a string for fuzzy name matching: lowercase, collapse any run of
 * non-alphanumeric characters to a single dash, and strip leading/trailing dashes.
 *
 * INVARIANT: this is the same slug `councilFilenameStem` uses for exported
 * council documents (both delegate to `slugifyCouncilName` in
 * public/js/utils/council-document.js). The exported filename stem must remain a
 * resolvable `--council` handle: `dream-team.council.json` IS
 * `--council dream-team`. Note the deliberate asymmetry — matching uses the
 * no-fallback slug, so an unsluggable council name yields '' and never matches
 * the literal handle "council" that the filename falls back to.
 *
 * @param {string} s - Input string
 * @returns {string} Normalized slug-like string
 */
function normalizeForMatch(s) {
  return slugifyCouncilName(s);
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
 * Find the council a proposed name would collide with, in the SAME normalized
 * space `resolveCouncilHandle` matches in.
 *
 * A plain case-insensitive name comparison is too narrow to keep handles
 * usable: tier 4 below also matches the slugified name AND a file council's
 * filename stem, so "Dream Team", "dream-team" and `dream-team.council.json`
 * are one handle. Saving two of them makes `--council dream-team` ambiguous for
 * BOTH — an error only the raw uuid can route around. This helper is the one
 * place that rule lives, deliberately next to the matcher it mirrors; a
 * creation/rename surface that rolls its own comparison will drift from it.
 *
 * The empty slug is NOT special-cased, because tier 4 does not special-case it
 * either: two names that slugify to '' ("!!!" and "???") really do collide as
 * handles, and so does a council file named `_.json`.
 *
 * @param {Array<Object>} councils - Every council (a CouncilStore `list()`)
 * @param {string} name - The proposed name
 * @param {string} [excludeId] - Council allowed to hold the name (a rename's own row)
 * @returns {Object|null} The clashing council, or null when the name is free
 */
function findCouncilNameCollision(councils, name, excludeId) {
  const wantedName = String(name == null ? '' : name).trim().toLowerCase();
  const wantedSlug = normalizeForMatch(name);

  const clash = (councils || []).find(c => {
    if (!c || c.id === excludeId) return false;
    const councilName = String(c.name || '').trim();
    if (councilName.toLowerCase() === wantedName) return true;
    if (normalizeForMatch(councilName) === wantedSlug) return true;
    return isFileCouncilId(c.id) &&
      normalizeForMatch(c.id.slice(FILE_ID_PREFIX.length)) === wantedSlug;
  });

  return clash || null;
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
  // A name that resolves to both a file council and a saved one is a collision
  // the user can actually fix, and the fix differs from "use the id" — say so.
  const spansSources =
    matches.some(c => c.source === 'file') && matches.some(c => c.source !== 'file');
  const hint = spansSources
    ? '\nA council file and a saved council share this name. ' +
      'Delete or rename one to keep the name handle usable.'
    : '';
  const error = new Error(
    `Ambiguous council "${handle}" matches ${matches.length} councils. Disambiguate with the id:\n` +
    lines.join('\n') + hint
  );
  error.code = COUNCIL_AMBIGUOUS;
  return error;
}

/**
 * Resolve a user-supplied council handle to a full council row.
 *
 * Matching order (first unambiguous match wins):
 *   1. Exact id
 *   2. Id-prefix: `file:`-prefix for file-council ids, UUID-prefix for hex-ish
 *      handles of length >= 4
 *   3. Exact name (case-insensitive)
 *   4. Normalized name, OR a file council's filename stem compared in slug space
 *      (`my-security` finds `file:my-security` AND `file:my_security`, whatever
 *      the document's own name says)
 *   5. Partial (substring) name fragment (last resort, never shadows the above)
 *
 * @param {Database} db - Database instance
 * @param {string} handle - The handle to resolve (id, id-prefix, or name)
 * @returns {Promise<Object>} The matching council row
 * @throws {Error} If the handle is missing, ambiguous (`code`
 *   `COUNCIL_AMBIGUOUS`), or matches nothing (`code` `COUNCIL_NOT_FOUND`)
 */
async function resolveCouncilHandle(db, handle) {
  const all = await (await createCouncilStore(db)).list();

  if (!handle) {
    throw new Error('A council handle is required.');
  }

  // 1. Exact id
  const exactId = all.find(c => c.id === handle);
  if (exactId) return exactId;

  // 2a. `file:`-prefix match for file-council ids (`file:dream` → the file
  // council `file:dream-team`). The hex-ish UUID-prefix branch below can never
  // match these (':' fails its pattern), so this is its file-id counterpart.
  if (handle.length > FILE_ID_PREFIX.length && handle.toLowerCase().startsWith(FILE_ID_PREFIX)) {
    const m = all.filter(c => c.id.toLowerCase().startsWith(handle.toLowerCase()));
    if (m.length === 1) return m[0];
    if (m.length > 1) throw _ambiguityError(handle, m);
  }

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

  // 4. Normalized name, or a file council's filename stem. The stem is a
  // promised `--council` handle (`dream-team.council.json` IS
  // `--council dream-team`) even when it differs from the slugified document
  // name, so match it here rather than leaving it to the substring tier.
  // Handle and stem are BOTH compared in slug space: the loader admits any stem
  // that survives `encodeURIComponent` (so `my_security.council.json` and
  // `My.Security.council.json` are loadable), and comparing a slugified handle
  // against a raw stem would strand exactly those. A stem that collides with
  // another council's normalized name funnels into the ambiguity error instead
  // of silently picking one.
  {
    const hn = normalizeForMatch(handle);
    const m = all.filter(c =>
      normalizeForMatch(c.name) === hn ||
      (isFileCouncilId(c.id) && normalizeForMatch(c.id.slice(FILE_ID_PREFIX.length)) === hn)
    );
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
  const notFound = new Error(
    `No council matches "${handle}". Run \`pair-review --list-councils\` to see available councils.`
  );
  notFound.code = COUNCIL_NOT_FOUND;
  throw notFound;
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
  COUNCIL_NOT_FOUND,
  COUNCIL_AMBIGUOUS,
  normalizeForMatch,
  shortId,
  findCouncilNameCollision,
  resolveCouncilHandle,
  getCouncilLastUsedRepos
};
