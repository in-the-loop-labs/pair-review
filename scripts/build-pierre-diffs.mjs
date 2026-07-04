#!/usr/bin/env node
// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
//
// Bundles @pierre/diffs for browser consumption.
// Outputs a single IIFE that attaches to window.PierreDiffs.

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFile, mkdir } from 'fs/promises';

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
    sourcemap: false,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    loader: {
      '.wasm': 'file',
    },
    logLevel: 'info',
  });

  const vendorDir = resolve(root, 'public/js/vendor');
  await mkdir(vendorDir, { recursive: true });
  await copyFile(
    resolve(root, 'node_modules/@pierre/diffs/dist/worker/worker-portable.js'),
    resolve(vendorDir, 'pierre-diffs-worker.js')
  );

  console.log('✓ @pierre/diffs bundled to public/js/vendor/pierre-diffs.js');
  console.log('✓ @pierre/diffs worker copied to public/js/vendor/pierre-diffs-worker.js');
} catch (err) {
  console.error('✗ Failed to bundle @pierre/diffs:', err.message);
  process.exit(1);
}
