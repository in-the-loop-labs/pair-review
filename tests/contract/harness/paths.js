// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Where the contract harness finds things on disk, and how it maps the
 * virtual origin's URLs onto them. Shared by the fixture and global setup.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Virtual origin. Every request to it is fulfilled from disk; no port is bound. */
const ORIGIN = 'http://contract.test';

const PATHS = {
  repoRoot: REPO_ROOT,
  harnessDir: __dirname,
  workload: path.join(REPO_ROOT, 'tests', 'contract', 'fixtures', 'workload.js'),
  // Development flavour: the only build with the vendor's height validator.
  devBundle: path.join(REPO_ROOT, 'tests', '.cache', 'pierre-diffs.dev.js'),
  // The two files the app actually ships and serves.
  prodBundle: path.join(REPO_ROOT, 'public', 'js', 'vendor', 'pierre-diffs.js'),
  worker: path.join(REPO_ROOT, 'public', 'js', 'vendor', 'pierre-diffs-worker.js'),
  publicDir: path.join(REPO_ROOT, 'public'),
  vendorPackageJson: path.join(REPO_ROOT, 'node_modules', '@pierre', 'diffs', 'package.json'),
  buildScript: path.join(REPO_ROOT, 'scripts', 'build-pierre-diffs.mjs'),
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

/**
 * Version and mode from a bundle's stamp line, the first line the build script
 * writes (see scripts/build-pierre-diffs.mjs). Null when the text does not
 * start with one.
 * @param {string} head - the beginning of a bundle file
 * @returns {{version: string, mode: 'production'|'development'}|null}
 */
function parseBundleStamp(head) {
  const match = /^\/\*! @pierre\/diffs@(\S+) (production|development) \*\//.exec(head);
  return match ? { version: match[1], mode: match[2] } : null;
}

/** Stamp of a bundle file, reading only its first bytes. Null when missing or unstamped. */
function readBundleStamp(file) {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(200);
    const bytesRead = fs.readSync(fd, buffer, 0, 200, 0);
    return parseBundleStamp(buffer.toString('utf8', 0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}

function installedVendorVersion() {
  return JSON.parse(fs.readFileSync(PATHS.vendorPackageJson, 'utf8')).version;
}

/**
 * Resolve a URL path on the virtual origin.
 * @returns {{file: string}|{body: string, contentType: string}|{status: number}}
 */
function resolveVirtualPath(urlPath) {
  switch (urlPath) {
    case '/harness.html': return { file: path.join(PATHS.harnessDir, 'harness.html') };
    case '/harness.js': return { file: path.join(PATHS.harnessDir, 'harness.js') };
    case '/workload.js': return { file: PATHS.workload };
    case '/vendor/pierre-diffs.dev.js': return { file: PATHS.devBundle };
    case '/vendor/pierre-diffs.js': return { file: PATHS.prodBundle };
    case '/vendor/pierre-diffs-worker.js': return { file: PATHS.worker };
    // A worker that loads and never answers (gate G7).
    case '/worker/silent.js': return { body: 'self.onmessage = () => {};\n', contentType: CONTENT_TYPES['.js'] };
    // A worker script that does not exist (fact F18).
    case '/worker/missing.js': return { status: 404 };
    default: break;
  }
  // The app's public/ directory, read-only, so real CSS and real modules
  // (pr.css, pierre-context.js, pierre-bridge.js, ...) load unmodified:
  //   /app/<path>          explicit form used by specs
  //   /js/..., /css/...    the absolute URLs app code itself requests (the
  //                        bridge's worker is /js/vendor/pierre-diffs-worker.js)
  let relative = null;
  if (urlPath.startsWith('/app/')) relative = urlPath.slice('/app/'.length);
  else if (urlPath.startsWith('/js/') || urlPath.startsWith('/css/')) relative = urlPath.slice(1);
  if (relative !== null) {
    const file = path.normalize(path.join(PATHS.publicDir, relative));
    if (file.startsWith(PATHS.publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return { file };
    }
  }
  return { status: 404 };
}

module.exports = { ORIGIN, PATHS, CONTENT_TYPES, parseBundleStamp, readBundleStamp, installedVendorVersion, resolveVirtualPath };
