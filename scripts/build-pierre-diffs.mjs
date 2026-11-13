#!/usr/bin/env node
// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
//
// Bundles @pierre/diffs for browser consumption.
// Outputs a single IIFE that attaches to window.PierreDiffs.
//
// Two flavours, both from scripts/pierre-diffs-entry.mjs:
//
//   node scripts/build-pierre-diffs.mjs
//     Production. public/js/vendor/pierre-diffs.js (minified,
//     NODE_ENV=production) plus the portable worker copied next to it. This is
//     what the app ships and what the E2E suite serves.
//
//   node scripts/build-pierre-diffs.mjs --dev
//     Development. tests/.cache/pierre-diffs.dev.js (unminified,
//     NODE_ENV=development). Only the vendor contract suite loads it: the
//     development build is the only one in which the vendor's own height
//     validator (`__devOnlyValidateItemHeights`) is compiled in. Nothing under
//     public/ is written, so this never changes what the app serves.
//
// Every bundle starts with a stamp line naming the vendor version it was built
// from. tests/unit/vendor-bundle-fresh.test.js compares the stamp with the
// installed package, so a dependency bump that was not followed by a rebuild
// fails a unit test instead of silently testing the old vendor.

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFile, mkdir, readFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const dev = process.argv.includes('--dev');
const mode = dev ? 'development' : 'production';
const vendorPackageDir = resolve(root, 'node_modules/@pierre/diffs');
const outfile = dev
  ? resolve(root, 'tests/.cache/pierre-diffs.dev.js')
  : resolve(root, 'public/js/vendor/pierre-diffs.js');

try {
  const { version } = JSON.parse(await readFile(resolve(vendorPackageDir, 'package.json'), 'utf8'));

  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, 'scripts/pierre-diffs-entry.mjs')],
    bundle: true,
    format: 'iife',
    globalName: 'PierreDiffs',
    outfile,
    platform: 'browser',
    target: ['es2020'],
    minify: !dev,
    sourcemap: false,
    // The stamp is parsed by parseBundleStamp in tests/contract/harness/paths.js
    // (used by the contract suite and by tests/unit/vendor-bundle-fresh.test.js).
    banner: {
      js: `/*! @pierre/diffs@${version} ${mode} */`,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
    },
    loader: {
      '.wasm': 'file',
    },
    logLevel: 'info',
  });

  if (dev) {
    console.log(`✓ @pierre/diffs ${version} (development) bundled to tests/.cache/pierre-diffs.dev.js`);
  } else {
    const vendorDir = dirname(outfile);
    await copyFile(
      resolve(vendorPackageDir, 'dist/worker/worker-portable.js'),
      resolve(vendorDir, 'pierre-diffs-worker.js')
    );

    console.log(`✓ @pierre/diffs ${version} bundled to public/js/vendor/pierre-diffs.js`);
    console.log('✓ @pierre/diffs worker copied to public/js/vendor/pierre-diffs-worker.js');
  }
} catch (err) {
  console.error('✗ Failed to bundle @pierre/diffs:', err.message);
  process.exit(1);
}
