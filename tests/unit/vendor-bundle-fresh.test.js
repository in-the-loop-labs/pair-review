// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The vendor bundle the app serves (public/js/vendor/pierre-diffs.js) and the
 * worker next to it are build outputs: gitignored, written by
 * scripts/build-pierre-diffs.mjs from node_modules/@pierre/diffs. The E2E
 * server serves them as static files.
 *
 * Nothing rebuilds them when the dependency changes without a `pnpm install`
 * (a branch switch, a lockfile edit applied with --ignore-scripts, a manual
 * copy). The app and the whole E2E suite would then keep running the OLD
 * vendor while package.json names the new one, and every result would be
 * about a version nobody ships. A new bundle next to an old worker is the
 * other realistic failure: the two speak a versioned message protocol.
 *
 * The build script stamps the vendor version into the first line of the
 * bundle. These tests compare that stamp, and the worker's bytes, with what
 * is installed.
 */

import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const { parseBundleStamp, readBundleStamp } = require('../contract/harness/paths');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR_PACKAGE_DIR = path.join(REPO_ROOT, 'node_modules', '@pierre', 'diffs');
const BUNDLE = path.join(REPO_ROOT, 'public', 'js', 'vendor', 'pierre-diffs.js');
const WORKER = path.join(REPO_ROOT, 'public', 'js', 'vendor', 'pierre-diffs-worker.js');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-pierre-diffs.mjs');

const REBUILD_HINT = 'Run `pnpm run build:diffs` to rebuild the vendor bundle.';

function installedVersion() {
  return JSON.parse(fs.readFileSync(path.join(VENDOR_PACKAGE_DIR, 'package.json'), 'utf8')).version;
}

describe('vendor bundle freshness', () => {
  it('parseBundleStamp reads a stamp line and rejects anything else', () => {
    expect(parseBundleStamp('/*! @pierre/diffs@1.6.4 production */\nvar PierreDiffs=')).toEqual({
      version: '1.6.4',
      mode: 'production',
    });
    expect(parseBundleStamp('/*! @pierre/diffs@2.0.0-beta.1 development */\n')).toEqual({
      version: '2.0.0-beta.1',
      mode: 'development',
    });
    // An unstamped bundle (built before the stamp existed) is not "fresh".
    expect(parseBundleStamp('var PierreDiffs=(()=>{')).toBeNull();
    // The stamp must be the first thing in the file.
    expect(parseBundleStamp('\n/*! @pierre/diffs@1.6.4 production */')).toBeNull();
    expect(parseBundleStamp('')).toBeNull();
  });

  it('readBundleStamp returns null for a missing file', () => {
    expect(readBundleStamp(path.join(REPO_ROOT, 'tests', 'no-such-bundle.js'))).toBeNull();
  });

  it('the build script writes the stamp format this test parses', () => {
    const source = fs.readFileSync(BUILD_SCRIPT, 'utf8');
    expect(source).toContain('js: `/*! @pierre/diffs@${version} ${mode} */`');
  });

  it('the served bundle exists', () => {
    expect(fs.existsSync(BUNDLE), `${BUNDLE} is missing. ${REBUILD_HINT}`).toBe(true);
    expect(fs.existsSync(WORKER), `${WORKER} is missing. ${REBUILD_HINT}`).toBe(true);
  });

  it('the served bundle was built from the installed @pierre/diffs, in production mode', () => {
    const stamp = readBundleStamp(BUNDLE);
    expect(stamp, `${BUNDLE} has no version stamp. ${REBUILD_HINT}`).not.toBeNull();
    expect(
      stamp.version,
      `public/js/vendor/pierre-diffs.js was built from @pierre/diffs ${stamp.version} but ` +
        `${installedVersion()} is installed. ${REBUILD_HINT}`
    ).toBe(installedVersion());
    // The development flavour belongs in tests/.cache only: it is unminified
    // and compiles in vendor self-checks that log on every layout pass.
    expect(stamp.mode).toBe('production');
  });

  it('the served worker is byte-identical to the installed portable worker', () => {
    const installed = fs.readFileSync(path.join(VENDOR_PACKAGE_DIR, 'dist', 'worker', 'worker-portable.js'));
    const served = fs.readFileSync(WORKER);
    expect(
      served.equals(installed),
      `public/js/vendor/pierre-diffs-worker.js differs from the installed worker. ${REBUILD_HINT}`
    ).toBe(true);
  });
});
