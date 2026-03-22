#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bundles @pierre/diffs for browser consumption.
// Outputs a single IIFE that attaches to window.PierreDiffs.

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

try {
  await build({
    entryPoints: [resolve(root, 'scripts/pierre-diffs-entry.mjs')],
    bundle: true,
    format: 'iife',
    globalName: 'PierreDiffs',
    outfile: resolve(root, 'public/js/vendor/pierre-diffs.js'),
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    loader: {
      '.wasm': 'file',
    },
    logLevel: 'info',
  });

  console.log('✓ @pierre/diffs bundled to public/js/vendor/pierre-diffs.js');
} catch (err) {
  console.error('✗ Failed to bundle @pierre/diffs:', err.message);
  process.exit(1);
}
