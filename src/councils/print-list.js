// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The council list renderer behind `pair-review council list` — and therefore
 * behind `--list-councils`, which now delegates to that verb.
 *
 * It lives here rather than in src/main.js because the council subcommand
 * (./cli.js) is required BY main.js — a `require('../main')` from the
 * subcommand would resolve to a half-initialized module (main.js assigns its
 * exports last), so `printCouncilList` would be `undefined` at call time.
 * Every caller requires it directly from here; main.js does not re-export it.
 *
 * Deliberately writes with `console.log`, not `logger`: this is CLI output the
 * user asked for, not diagnostics.
 */

const { createCouncilStore } = require('./council-store');
const { getCouncilLastUsedRepos, shortId } = require('./resolve-council');

/**
 * Print the list of saved councils (handles, names, types, and "last used"
 * metadata) as an aligned table, then exit guidance.
 *
 * @param {Object} db - Database instance
 */
async function printCouncilList(db) {
  const councils = await (await createCouncilStore(db)).list();

  if (!councils || councils.length === 0) {
    console.log('No councils found. Create one in the web UI under Analysis settings.');
    return;
  }

  const repoMap = await getCouncilLastUsedRepos(db);

  const rows = councils.map(c => {
    const entry = repoMap.get(c.id);
    const lastTs = entry?.last_started || c.last_used_at;
    const lastUsed = lastTs ? String(lastTs).slice(0, 10) : 'never';
    let lastUsedWith = '—';
    if (entry) {
      lastUsedWith = `${entry.repository}${entry.pr_number ? `#${entry.pr_number}` : ''}`;
    }
    return {
      // A file council's printed handle must stay resolvable: `file:` ids are
      // not UUIDs, so an 8-char slice would resolve to nothing — print the
      // full id instead.
      handle: c.source === 'file' ? c.id : shortId(c.id),
      name: c.name || '',
      type: c.type || '',
      source: c.source || 'db',
      lastUsed,
      lastUsedWith
    };
  });

  const headers = {
    handle: 'HANDLE',
    name: 'NAME',
    type: 'TYPE',
    source: 'SOURCE',
    lastUsed: 'LAST USED',
    lastUsedWith: 'LAST USED WITH'
  };

  const widths = {};
  for (const key of Object.keys(headers)) {
    widths[key] = Math.max(
      headers[key].length,
      ...rows.map(r => String(r[key]).length)
    );
  }

  const formatRow = r =>
    [
      String(r.handle).padEnd(widths.handle),
      String(r.name).padEnd(widths.name),
      String(r.type).padEnd(widths.type),
      String(r.source).padEnd(widths.source),
      String(r.lastUsed).padEnd(widths.lastUsed),
      String(r.lastUsedWith).padEnd(widths.lastUsedWith)
    ].join('  ');

  console.log(formatRow(headers));
  for (const r of rows) {
    console.log(formatRow(r));
  }

  console.log('');
  console.log('Pass a handle with --council, e.g.:');
  console.log('  pair-review <pr> --ai-draft --council ' + rows[0].handle);
}

module.exports = { printCouncilList };
