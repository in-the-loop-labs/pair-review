// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const http = require('http');
const path = require('path');
const semver = require('semver');
const { PRArgumentParser } = require('./github/parser');
const logger = require('./utils/logger');
const { rejectUrlLikeLocalReviewPath } = require('./utils/local-path-input');
const { normalizeRepository } = require('./utils/paths');
const { buildInteractiveAnalysisConfig } = require('./interactive-analysis-config');
const { version: packageVersion } = require('../package.json');

const HEALTH_TIMEOUT_MS = 2000;

// Default dependencies (overridable for testing)
const defaults = {
  httpGet: http.get,
  httpRequest: http.request,
  logger,
  open: (...args) => process.env.PAIR_REVIEW_NO_OPEN
    ? Promise.resolve()
    : import('open').then(({ default: open }) => open(...args)),
  PRArgumentParser,
  // Injected so the delegation handoff can be stubbed in tests without a DB.
  buildInteractiveAnalysisConfig
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
 * Hand a resolved analysis config off to a DIFFERENT (already-running) pair-review
 * process by POSTing it to its `/api/bulk-analysis-configs` endpoint, returning the
 * short id the server assigns. This is the cross-process counterpart to the
 * in-process `createBulkAnalysisConfig` store: the CLI invocation and the running
 * server do not share memory, so a `--instructions` payload can only reach the
 * server's store over HTTP.
 *
 * Rejects (does NOT swallow) on transport error, timeout, non-2xx status, or an
 * unparseable/idless body — the caller converts that into a loud failure rather
 * than silently dropping the instructions.
 *
 * @param {number} port
 * @param {Object} analysisConfig - Resolved config (single or council snapshot)
 * @param {object} [_deps] - Dependency overrides for testing
 * @returns {Promise<string>} The stored analysis-config id
 */
function storeAnalysisConfigRemote(port, analysisConfig, _deps) {
  const deps = { ...defaults, ..._deps };
  const payload = JSON.stringify({ analysisConfig });
  return new Promise((resolve, reject) => {
    const req = deps.httpRequest({
      hostname: 'localhost',
      port,
      path: '/api/bulk-analysis-configs',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: HEALTH_TIMEOUT_MS
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = null;
        try {
          body = data ? JSON.parse(data) : null;
        } catch {
          return reject(new Error(
            `Invalid response from pair-review server on port ${port} while storing analysis config.`
          ));
        }
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300 && body && body.id) {
          resolve(body.id);
        } else {
          const detail = (body && body.error) || `unexpected status ${status}`;
          reject(new Error(`Failed to store analysis config on the running server: ${detail}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Failed to reach pair-review server on port ${port}: ${err.message}`));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timed out storing analysis config on pair-review server (port ${port}).`));
    });
    req.write(payload);
    req.end();
  });
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
 * @param {string} [context.councilId] - Resolved council id for council auto-analysis
 * @param {string} [context.analysisConfigId] - Stored analysis-config id (encodes
 *   the resolved provider/model or council snapshot PLUS custom instructions). When
 *   present it supersedes `councilId` — the id already carries the council selection,
 *   mirroring the cold-start precedence in handlePullRequest/handleLocalReview.
 * @returns {string} Full URL
 */
function buildDelegationUrl(port, mode, context = {}) {
  const base = `http://localhost:${port}`;
  if (mode === 'pr') {
    let url = `${base}/pr/${context.owner}/${context.repo}/${context.number}`;
    const query = [];
    if (context.analyze) query.push('analyze=true');
    if (context.analysisConfigId) {
      query.push(`analysisConfigId=${encodeURIComponent(context.analysisConfigId)}`);
    } else if (context.councilId) {
      query.push(`council=${encodeURIComponent(context.councilId)}`);
    }
    if (query.length) url += `?${query.join('&')}`;
    return url;
  }
  if (mode === 'local') {
    // The `?path=` segment is always present, so analyze/config append with `&`.
    let url = `${base}/local?path=${encodeURIComponent(context.localPath)}`;
    if (context.analyze) url += '&analyze=true';
    if (context.analysisConfigId) {
      url += `&analysisConfigId=${encodeURIComponent(context.analysisConfigId)}`;
    } else if (context.councilId) {
      url += `&council=${encodeURIComponent(context.councilId)}`;
    }
    return url;
  }
  return `${base}/`;
}

/**
 * Parse PR arguments for URL construction without starting a server.
 * Reuses PRArgumentParser — synchronous for URLs, async for bare numbers.
 * @param {string[]} prArgs - Raw CLI PR arguments
 * @param {object} [config] - Pair-review config, passed to the parser so
 *   that per-repo `url_pattern` regexes are tried before the built-in
 *   GitHub/Graphite parsers. Pass null to disable config-driven matching.
 * @param {object} [_deps] - Dependency overrides for testing
 * @returns {Promise<{owner: string, repo: string, number: number}>}
 */
async function parsePRArgsForDelegation(prArgs, config = null, _deps) {
  const deps = { ...defaults, ..._deps };
  const parser = new deps.PRArgumentParser(config);
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
 * @param {object} [options] - Pre-resolved values from the caller
 * @param {string|null} [options.councilId] - Resolved council id (the caller
 *   resolves `flags.council` against the DB before delegation, since this
 *   module has no DB access). When set, the delegated URL carries
 *   `&council=<id>` and auto-analysis is forced on.
 * @param {object|null} [options.db] - Open DB handle. Required to carry
 *   `--instructions` across delegation: the analysis config (provider/model or
 *   council snapshot + instructions) is resolved here and POSTed to the running
 *   server, whose returned id is threaded as `analysisConfigId`. Without it, the
 *   handoff is skipped and only `councilId`/`analyze` flow through (prior shape).
 * @param {string|null} [options.localRepository] - owner/repo for local-mode
 *   repo-default resolution (the caller resolves it via getRepositoryName, the
 *   same value the cold-start session uses; PR mode derives it from prArgs here).
 * @returns {Promise<boolean>} true if delegated, false if should start fresh
 */
async function attemptDelegation(config, flags, prArgs, _deps, options = {}) {
  const deps = { ...defaults, ..._deps };
  const port = config.port;
  const councilId = options.councilId || null;
  // A council selection implies analysis: the browser-side council
  // auto-analysis is gated on the `council` param + `analyze=true`, mirroring
  // the cold-start URL built in handlePullRequest/handleLocalReview.
  const analyze = !!(flags.ai || flags.council);

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

  // Resolve + hand off the analysis config (provider/model or council snapshot +
  // custom instructions) to the RUNNING server so a delegated `--ai`/`--council`
  // run with `--instructions` honors them instead of silently dropping them. The
  // build is gated on an analyzing mode + an open DB; it returns null when no
  // instructions were supplied, in which case we fall back to the bare
  // councilId/analyze params (unchanged prior behavior). A failed POST throws —
  // the contract is loud-fail, never silent drop.
  const handoffAnalysisConfigId = async (repository) => {
    if (!analyze || !options.db) return null;
    const analysisConfig = await deps.buildInteractiveAnalysisConfig({
      db: options.db, config, flags, repository
    });
    if (!analysisConfig) return null;
    deps.logger.info('Handing off analysis configuration (with instructions) to the running server');
    return storeAnalysisConfigRemote(port, analysisConfig, _deps);
  };

  // Determine mode and build URL
  let url;
  if (flags.local) {
    rejectUrlLikeLocalReviewPath(flags.localPath);
    const targetPath = path.resolve(flags.localPath || process.cwd());
    const analysisConfigId = await handoffAnalysisConfigId(options.localRepository || null);
    url = buildDelegationUrl(port, 'local', { localPath: targetPath, analyze, councilId, analysisConfigId });
  } else if (prArgs.length > 0) {
    const prInfo = await parsePRArgsForDelegation(prArgs, config, _deps);
    const repository = normalizeRepository(prInfo.owner, prInfo.repo);
    const analysisConfigId = await handoffAnalysisConfigId(repository);
    url = buildDelegationUrl(port, 'pr', { ...prInfo, analyze, councilId, analysisConfigId });
  } else {
    url = buildDelegationUrl(port, 'server');
  }

  // Notify running server of newer version if applicable
  if (result.version && semver.valid(packageVersion) && semver.valid(result.version)) {
    if (semver.gt(packageVersion, result.version)) {
      deps.logger.info(`Notifying server of newer version: ${packageVersion} > ${result.version}`);
      notifyVersion(port, packageVersion, _deps);
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
  storeAnalysisConfigRemote,
  buildDelegationUrl,
  parsePRArgsForDelegation,
  attemptDelegation,
  HEALTH_TIMEOUT_MS
};
