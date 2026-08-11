// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * scripts/pierre-diffs-entry.mjs is the browser entry esbuild bundles into
 * window.PierreDiffs. Its export list must match, exactly, what production
 * frontend code reads off that global:
 *
 *  - A CONSUMED-BUT-UNEXPORTED name is an undefined at runtime (the bundle is
 *    an IIFE; there is no import error to catch it, just a TypeError deep in a
 *    render path).
 *  - An EXPORTED-BUT-UNCONSUMED name is dead vendor surface pulled into the
 *    bundle for nothing. The per-file FileDiff/File components (dead since the
 *    CodeView migration) and the highlighter/theme/annotation-name helpers
 *    (never read from the bridge) were exactly that.
 *
 * Derives both sides from the real sources so neither can drift silently.
 */

import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(REPO_ROOT, 'scripts', 'pierre-diffs-entry.mjs');
const FRONTEND_DIR = path.join(REPO_ROOT, 'public', 'js');

/** Names in the entry's `export { ... } from '...'` blocks, comments stripped. */
function entryExports() {
  const src = fs.readFileSync(ENTRY, 'utf8');
  const names = new Set();
  const blocks = src.matchAll(/export\s*\{([^}]*)\}\s*from/g);
  for (const [, body] of blocks) {
    const cleaned = body.replace(/\/\/[^\n]*/g, '');
    for (const part of cleaned.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Every `window.PierreDiffs.X` / `window.PierreDiffs?.X` read in public/js. */
function consumedNames() {
  const names = new Set();
  for (const file of jsFilesUnder(FRONTEND_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, name] of src.matchAll(/window\.PierreDiffs\??\.\s*([A-Za-z_$][\w$]*)/g)) {
      names.add(name);
    }
  }
  return names;
}

describe('scripts/pierre-diffs-entry.mjs export surface', () => {
  it('exports exactly the five names the CodeView path needs', () => {
    expect([...entryExports()].sort()).toEqual([
      'CodeView',
      'WorkerPoolManager',
      'getSingularPatch',
      'parseDiffFromFile',
      'parsePatchFiles',
    ]);
  });

  it('exports every name production frontend code reads off window.PierreDiffs', () => {
    const exported = entryExports();
    const missing = [...consumedNames()].filter((n) => !exported.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it('exports nothing production frontend code never reads (no dead vendor surface)', () => {
    const consumed = consumedNames();
    const dead = [...entryExports()].filter((n) => !consumed.has(n)).sort();
    expect(dead).toEqual([]);
  });

  it('does not re-introduce the per-file FileDiff/File components', () => {
    const exported = entryExports();
    expect(exported.has('FileDiff')).toBe(false);
    expect(exported.has('File')).toBe(false);
  });
});
