// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const http = require('http');
const semver = require('semver');
const { PRArgumentParser } = require('./github/parser');
const logger = require('./utils/logger');

const HEALTH_TIMEOUT_MS = 2000;

// Default dependencies (overridable for testing)
const defaults = {
  httpGet: http.get,
  httpRequest: http.request,
  logger,
  open: (...args) => process.env.PAIR_REVIEW_NO_OPEN
    ? Promise.resolve()
    : import('open').then(({ default: open }) => open(...args)),
  PRArgumentParser
};

/**
 * Check if a pair-review server is already running on the given port.
 * @param {number} port
 * @param {object} [_deps] - Dependency overrides for testing
 * @returns {Promise<{running: boolean, isPairReview?: boolean, version?: string}>}
 */
function detectRunningServer(port, _deps) {
  const deps = { ...defaults, ..._deps };
  return new Promise((resolve) => {
    const req = deps.httpGet(`http://localhost:${port}/health`, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (body.service === 'pair-review') {
            resolve({ running: true, isPairReview: true, version: body.version || null });
          } else {
            resolve({ running: true, isPairReview: false });
          }
        } catch {
          resolve({ running: true, isPairReview: false });
        }
      });
    });

    req.on('error', () => {
      resolve({ running: false });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false });
    });
  });
}

/**
 * Notify the running server that a newer version is available.
 * Fire-and-forget — does not block on response.
 * @param {number} port
 * @param {string} currentVersion - Version of the current CLI invocation
 * @param {object} [_deps] - Dependency overrides for testing
 */
function notifyVersion(port, currentVersion, _deps) {
  const deps = { ...defaults, ..._deps };
  const payload = JSON.stringify({ version: currentVersion });
  const req = deps.httpRequest({
    hostname: 'localhost',
    port,
    path: '/api/notify-update',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: HEALTH_TIMEOUT_MS
  }, () => { /* ignore response */ });

  req.on('error', () => { /* fire and forget */ });
  req.on('timeout', () => { req.destroy(); });
  req.write(payload);
  req.end();
}

/**
 * Build the URL to delegate to an existing server.
 * @param {number} port
 * @param {'pr'|'local'|'server'} mode
 * @param {object} context
 * @param {string} [context.owner]
 * @param {string} [context.repo]
 * @param {number} [context.number]
 * @param {string} [context.localPath]
 * @param {boolean} [context.analyze] - Whether to trigger auto-analysis
 * @returns {string} Full URL
 */
function buildDelegationUrl(port, mode, context = {}) {
  const base = `http://localhost:${port}`;
  if (mode === 'pr') {
    let url = `${base}/pr/${context.owner}/${context.repo}/${context.number}`;
    if (context.analyze) url += '?analyze=true';
    return url;
  }
  if (mode === 'local') {
    let url = `${base}/local?path=${encodeURIComponent(context.localPath)}`;
    if (context.analyze) url += '&analyze=true';
    return url;
  }
  return `${base}/`;
}

/**
 * Parse PR arguments for URL construction without starting a server.
 * Reuses PRArgumentParser — synchronous for URLs, async for bare numbers.
 * @param {string[]} prArgs - Raw CLI PR arguments
 * @param {object} [_deps] - Dependency overrides for testing
 * @returns {Promise<{owner: string, repo: string, number: number}>}
 */
async function parsePRArgsForDelegation(prArgs, _deps) {
  const deps = { ...defaults, ..._deps };
  const parser = new deps.PRArgumentParser();
  return parser.parsePRArguments(prArgs);
}

/**
 * Attempt single-port delegation. Returns true if delegation happened (caller should exit).
 * Returns false if no running server was found (caller should start normally).
 * Throws if port is occupied by a non-pair-review service.
 *
 * @param {object} config - Loaded config
 * @param {object} flags - Parsed CLI flags
 * @param {string[]} prArgs - PR arguments from CLI
 * @param {object} [_deps] - Dependency overrides for testing
 * @returns {Promise<boolean>} true if delegated, false if should start fresh
 */
async function attemptDelegation(config, flags, prArgs, _deps) {
  const deps = { ...defaults, ..._deps };
  const port = config.port;

  const result = await detectRunningServer(port, _deps);

  if (result.running && !result.isPairReview) {
    throw new Error(
      `Port ${port} is in use by another service. ` +
      `Either stop that service, or set a different port in ~/.pair-review/config.json`
    );
  }

  if (!result.running) {
    return false;
  }

  // Server is running — delegate to it
  deps.logger.info(`Existing pair-review server detected on port ${port} (v${result.version})`);

  // Determine mode and build URL
  let url;
  if (flags.local) {
    const targetPath = require('path').resolve(flags.localPath || process.cwd());
    url = buildDelegationUrl(port, 'local', { localPath: targetPath, analyze: flags.ai });
  } else if (prArgs.length > 0) {
    const prInfo = await parsePRArgsForDelegation(prArgs, _deps);
    url = buildDelegationUrl(port, 'pr', { ...prInfo, analyze: flags.ai });
  } else {
    url = buildDelegationUrl(port, 'server');
  }

  // Notify running server of newer version if applicable
  const currentVersion = require('../package.json').version;
  if (result.version && semver.valid(currentVersion) && semver.valid(result.version)) {
    if (semver.gt(currentVersion, result.version)) {
      deps.logger.info(`Notifying server of newer version: ${currentVersion} > ${result.version}`);
      notifyVersion(port, currentVersion, _deps);
    }
  }

  // Open browser and exit
  deps.logger.info(`Delegating to running server: ${url}`);
  await deps.open(url);
  return true;
}

module.exports = {
  detectRunningServer,
  notifyVersion,
  buildDelegationUrl,
  parsePRArgsForDelegation,
  attemptDelegation,
  HEALTH_TIMEOUT_MS
};
