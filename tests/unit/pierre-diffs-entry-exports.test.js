// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * scripts/pierre-diffs-entry.mjs is the browser entry esbuild bundles into
 * window.PierreDiffs. The bundle is an IIFE, so a name that frontend code
 * reads but the entry does not export is not an import error: it is an
 * `undefined` at runtime, and the failure is a TypeError deep in a render
 * path.
 *
 * Both sides are derived from the real sources so neither can drift silently:
 *
 *  - the entry's `export { ... } from` blocks, and
 *  - every `window.PierreDiffs.X` read under public/js and under
 *    tests/contract (the vendor contract suite, which pins the vendor facts
 *    the application relies on).
 *
 * The export list is also pinned exactly, and nothing may be exported that
 * production code does not read: the bundle ships to every user. A vendor
 * function only the contract suite calls comes from that suite's own bundle
 * (tests/contract/harness/vendor-extras.js, `window.VendorTestExtras`).
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
      'VirtualizedFileDiff',
      'WorkerPoolManager',
      'parseDiffFromFile',
      'parsePatchFiles',
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

  it('exports nothing that production code does not read', () => {
    const read = productionConsumed();
    const dead = [...entryExports()].filter((name) => !read.has(name)).sort();
    expect(dead).toEqual([]);
  });

  it('the contract suite\'s own bundle names nothing the shipped bundle exports', () => {
    const { TEST_EXTRAS } = require('../contract/harness/vendor-extras');
    expect(TEST_EXTRAS.length).toBeGreaterThan(0);
    expect(TEST_EXTRAS.filter((name) => entryExports().has(name))).toEqual([]);
  });

  it('production code reads exactly the viewer, its diff item class, the two parsers and the worker pool', () => {
    // What the application itself depends on. A new name here is a new
    // dependency on the vendor's API: it needs a contract test of what the
    // application relies on (tests/contract/vendor). VirtualizedFileDiff is
    // read for one method (PierreBridge.coverPaneWithRowWindow; vendor fact
    // F30, tests/contract/vendor/row-window.spec.js).
    expect([...productionConsumed()].sort()).toEqual(['CodeView', 'VirtualizedFileDiff', 'WorkerPoolManager', 'parseDiffFromFile', 'parsePatchFiles']);
  });
});
