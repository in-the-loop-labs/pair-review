// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * scripts/pierre-diffs-entry.mjs is the browser entry esbuild bundles into
 * window.PierreDiffs. The bundle is an IIFE, so a name that frontend code
 * reads but the entry does not export is not an import error: it is an
 * `undefined` at runtime, and the failure is a TypeError deep in a render
 * path (or, worse, a silent fallback to the legacy renderer).
 *
 * Both sides are derived from the real sources so neither can drift silently:
 *
 *  - the entry's `export { ... } from` blocks, and
 *  - every `window.PierreDiffs.X` read under public/js.
 *
 * The export list is also pinned exactly. During the CodeView migration
 * (plans/codeview-virtualized-diff.md) the list is deliberately wider than
 * what production reads: `CodeView` and `hydratePartialDiff` are exported for
 * the vendor contract suite before any production code uses them, and the
 * FileDiff-era names stay until the old renderer is deleted. The final phase
 * narrows the pinned list to exactly the consumed names.
 */

import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

const { parseExportNames, parseConsumedNames, readEntryExports } = require('../contract/harness/entry-exports');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_DIR = path.join(REPO_ROOT, 'public', 'js');
const VENDOR_BUNDLE_DIR = path.join(FRONTEND_DIR, 'vendor');
const CONTRACT_DIR = path.join(REPO_ROOT, 'tests', 'contract');

function jsFilesUnder(dir, { skip = [] } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (skip.includes(full)) continue;
    if (entry.isDirectory()) out.push(...jsFilesUnder(full, { skip }));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function consumedIn(files) {
  const names = new Set();
  for (const file of files) {
    for (const name of parseConsumedNames(fs.readFileSync(file, 'utf8'))) names.add(name);
  }
  return names;
}

const entryExports = () => new Set(readEntryExports());
// The built bundle itself is skipped: it is minified vendor code that mentions
// its own global.
const productionConsumed = () => consumedIn(jsFilesUnder(FRONTEND_DIR, { skip: [VENDOR_BUNDLE_DIR] }));
const contractConsumed = () => consumedIn(jsFilesUnder(CONTRACT_DIR));

describe('parse helpers', () => {
  it('parseExportNames reads names, ignores comments, and honours `as`', () => {
    const source = `
      export {
        // a comment, with a comma
        Alpha,
        beta, /* inline, comment */
        gamma as delta,
      } from 'pkg';
      export { Epsilon } from 'pkg/sub';
    `;
    expect([...parseExportNames(source)].sort()).toEqual(['Alpha', 'Epsilon', 'beta', 'delta']);
  });

  it('parseExportNames returns an empty set for a module with no re-exports', () => {
    expect(parseExportNames('const a = 1;\nexport default a;\n').size).toBe(0);
    expect(parseExportNames('').size).toBe(0);
  });

  it('parseConsumedNames reads plain and optional-chained property reads', () => {
    const source = `
      if (!window.PierreDiffs) return;
      new window.PierreDiffs.WorkerPoolManager({});
      window.PierreDiffs?.parsePatchFiles(input);
      const P = window.PierreDiffs; P.notCounted();
      PierreDiffs.CodeView;
    `;
    expect([...parseConsumedNames(source)].sort()).toEqual(['CodeView', 'WorkerPoolManager', 'parsePatchFiles']);
  });
});

describe('scripts/pierre-diffs-entry.mjs export surface', () => {
  it('exports exactly the pinned list', () => {
    // Adding or removing a name here is a deliberate change to what ships in
    // the 11 MB vendor bundle. Update the list in the same commit as the entry.
    expect([...entryExports()].sort()).toEqual([
      'CodeView',
      'File',
      'FileDiff',
      'WorkerPoolManager',
      'disposeHighlighter',
      'getLineAnnotationName',
      'getSharedHighlighter',
      'getSingularPatch',
      'hydratePartialDiff',
      'isHighlighterLoaded',
      'parseDiffFromFile',
      'parsePatchFiles',
      'preloadHighlighter',
      'registerCustomCSSVariableTheme',
      'registerCustomTheme',
      'trimPatchContext',
    ]);
  });

  it('exports every name production frontend code reads off window.PierreDiffs', () => {
    const exported = entryExports();
    const consumed = productionConsumed();
    // Guard against the scan silently matching nothing.
    expect(consumed.size).toBeGreaterThan(0);
    const missing = [...consumed].filter((name) => !exported.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('exports every name the vendor contract suite reads off window.PierreDiffs', () => {
    const exported = entryExports();
    const consumed = contractConsumed();
    expect(consumed.size).toBeGreaterThan(0);
    const missing = [...consumed].filter((name) => !exported.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('exports the two names the CodeView migration is built on', () => {
    const exported = entryExports();
    expect(exported.has('CodeView')).toBe(true);
    expect(exported.has('hydratePartialDiff')).toBe(true);
  });
});
