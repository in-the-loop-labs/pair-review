// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Playwright global setup for the contract suite: make sure both vendor
 * bundles exist and were built from the installed @pierre/diffs.
 *
 * The development flavour (tests/.cache, gitignored) is rebuilt on every run:
 * it takes about 100 ms and a stale one would validate the wrong vendor. The
 * production bundle under public/ is rebuilt only when its stamp does not
 * match, so a contract run never churns the file the app serves.
 */

const { execFileSync } = require('child_process');
const { PATHS, readBundleStamp, installedVendorVersion } = require('./paths');

function build(args) {
  execFileSync(process.execPath, [PATHS.buildScript, ...args], { cwd: PATHS.repoRoot, stdio: 'inherit' });
}

module.exports = async function globalSetup() {
  const installed = installedVendorVersion();

  build(['--dev']);
  const dev = readBundleStamp(PATHS.devBundle);
  if (!dev || dev.version !== installed || dev.mode !== 'development') {
    throw new Error(`Contract suite: development bundle is not @pierre/diffs ${installed} (stamp: ${JSON.stringify(dev)})`);
  }

  const prod = readBundleStamp(PATHS.prodBundle);
  if (!prod || prod.version !== installed || prod.mode !== 'production') {
    build([]);
    const rebuilt = readBundleStamp(PATHS.prodBundle);
    if (!rebuilt || rebuilt.version !== installed || rebuilt.mode !== 'production') {
      throw new Error(`Contract suite: production bundle is not @pierre/diffs ${installed} (stamp: ${JSON.stringify(rebuilt)})`);
    }
  }
};
