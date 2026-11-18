// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor functions the contract suite calls and the application does not.
 *
 * The bundle the application ships (scripts/pierre-diffs-entry.mjs) exports
 * exactly what production code reads. The suite also needs
 * `hydratePartialDiff`: it is how the vendor itself turns the diff of a patch
 * into one that carries the file's contents, and most of the facts pinned
 * here about a second diff of the same file (the pending swap, the row
 * window, expansion) were measured on its result. It is built into a bundle
 * of its own, from the same installed package, and loaded next to the
 * vendor bundle as `window.VendorTestExtras`. It is a pure function of plain
 * objects, so it does not matter that it comes from another copy of the
 * library than the viewer does.
 *
 * Written to tests/.cache (gitignored) by the suite's global setup, on every
 * run. Nothing under public/ is written.
 */

const esbuild = require('esbuild');
const { PATHS } = require('./paths');

/** The names on `window.VendorTestExtras`. */
const TEST_EXTRAS = ['hydratePartialDiff'];

/** Build the extras bundle. @returns {Promise<void>} */
async function buildTestExtras() {
  await esbuild.build({
    stdin: {
      contents: `export { ${TEST_EXTRAS.join(', ')} } from '@pierre/diffs';\n`,
      resolveDir: PATHS.repoRoot,
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    globalName: 'VendorTestExtras',
    outfile: PATHS.testExtras,
    platform: 'browser',
    target: ['es2020'],
    minify: false,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    loader: { '.wasm': 'file' },
    logLevel: 'silent',
  });
}

module.exports = { TEST_EXTRAS, buildTestExtras };
