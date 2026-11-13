// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Reads the export surface of scripts/pierre-diffs-entry.mjs (what esbuild
 * attaches to window.PierreDiffs) and the names a source text reads off that
 * global. Shared by tests/unit/pierre-diffs-entry-exports.test.js and the
 * contract suite's bundle spec.
 */

const fs = require('fs');
const path = require('path');

const ENTRY = path.resolve(__dirname, '..', '..', '..', 'scripts', 'pierre-diffs-entry.mjs');

/** Names in `export { ... } from '...'` blocks of a module source, comments stripped. */
function parseExportNames(source) {
  const names = new Set();
  for (const [, body] of source.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
    const cleaned = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const part of cleaned.split(',')) {
      // `a as b` exports the name `b`.
      const pieces = part.trim().split(/\s+as\s+/);
      const name = pieces[pieces.length - 1].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Every property a source text reads off the PierreDiffs global, with a plain
 * or an optional-chained member access.
 */
function parseConsumedNames(source) {
  const names = new Set();
  for (const [, name] of source.matchAll(/\bPierreDiffs\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) {
    names.add(name);
  }
  return names;
}

/** The entry's exported names, sorted. */
function readEntryExports() {
  return [...parseExportNames(fs.readFileSync(ENTRY, 'utf8'))].sort();
}

module.exports = { ENTRY, parseExportNames, parseConsumedNames, readEntryExports };
