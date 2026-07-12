// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Server-delegated headless execution.
 *
 * When `pair-review --headless` detects a healthy, version- and DB-compatible
 * pair-review server on `config.port`, it delegates the ANALYSIS EXECUTION to
 * that server (so the run populates the server's live council view + WebSocket
 * progress exactly like a button-click run) and waits for completion, then the
 * CLI emits the byte-identical `--json` document via `buildHeadlessJson`
 * (main.js) reading purely from the shared SQLite DB.
 *
 * This module owns the CLI side of the handshake in the plan
 * `plans/delegated-headless-live-view.md`:
 *   1. `probeServer`   — GET /health, gate on service/version/dbId.
 *   2. setup           — POST /api/setup/{local,pr/...}, poll the setup status.
 *   3. launch          — POST the resolved analysis config to the analyze route.
 *   4. wait            — poll GET /api/analyses/:id/status, echo progress, and
 *                        emit a clear error if the server dies mid-run.
 *
 * Follows the dependency-injection convention from `src/protocol-handler.js`: a
 * module-level `defaults` object (fetch impl, delay timer, process signal
 * hookup, logger) merged with an optional `_deps` override so every timer and
 * network call is deterministic under test. Node's global `fetch` is the
 * default transport.
 */

const logger = require('../utils/logger');
const { AnalysisRunRepository } = require('../database');
const { computeDbId, resolveDbPath } = require('../utils/db-identity');
const { version: packageVersion } = require('../../package.json');

// Per-request network deadlines. The health probe is short (a missing server
// must fail fast into the in-process fallback); setup/launch/status requests
// tolerate a busier server.
const HEALTH_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 15000;
// The cancel POST fired on Ctrl-C uses a short deadline so an interrupt never
// hangs on a wedged server — the process is exiting regardless.
const CANCEL_TIMEOUT_MS = 3000;

// Poll cadences. Setup usually completes in a few seconds; analysis runs for
// minutes, so it is polled less aggressively.
const SETUP_POLL_INTERVAL_MS = 1000;
const ANALYSIS_POLL_INTERVAL_MS = 3000;

// After this many CONSECUTIVE failed analysis-status polls, we consult the DB
// run row: a terminal row means the run finished (the server may have shed the
// in-memory entry); a still-running row means the server died mid-run.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const isTerminal = (status) => TERMINAL_STATUSES.has(status);

const SERVER_DIED_MESSAGE =
  'The pair-review server became unreachable while the analysis was still ' +
  'running. It may have crashed or been stopped mid-run; the analysis did not ' +
  'complete. Re-run without a server (or with --no-server) to analyze in-process.';

/**
 * Look up the persisted status of an analysis run row (the delegation fallback
 * source of truth when the server's in-memory status is gone). Injectable so
 * tests can drive the death/404 paths without a real database.
 *
 * @param {Object} db - Database instance
 * @param {string} runId - Analysis run id
 * @returns {Promise<string|null>} The run's status, or null if the row is absent
 */
async function defaultGetRunStatus(db, runId) {
  const run = await new AnalysisRunRepository(db).getById(runId, { includeDiff: false });
  return run ? run.status : null;
}

// Default dependencies (overridable for testing).
const defaults = {
  // Node's global fetch. Kept as a property so tests inject a stub and every
  // request in this module routes through it.
  fetch: (...args) => globalThis.fetch(...args),
  // Awaitable delay between polls. Injected as an immediate resolve in tests so
  // no wall-clock time elapses (see tests/CONVENTIONS.md — no fixed sleeps).
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Signal source + exit hook for cancel-on-SIGINT/SIGTERM. Injected in tests
  // so a simulated signal neither kills the test runner nor waits on the OS.
  process,
  exit: (code) => process.exit(code),
  logger,
  // DB run-row lookup (delegation fallback). Injected in tests.
  getRunStatus: defaultGetRunStatus,
  // Digest helpers — real by default; injected only to force a mismatch.
  computeDbId,
  resolveDbPath,
  // The CLI's own version, compared against the server's /health version.
  cliVersion: packageVersion,
};

/**
 * Perform a JSON HTTP request and return the parsed result without throwing on
 * a non-2xx status (the caller inspects `status`). Rejects only on a transport
 * failure (connection refused, timeout, DNS) — mirroring `fetch`'s own contract
 * — so callers can distinguish "server answered with an error" from "server is
 * unreachable".
 *
 * @param {Object} deps - Merged dependencies (must provide `fetch`)
 * @param {string} method - HTTP method
 * @param {string} url - Absolute URL
 * @param {Object|null} body - JSON body (omitted for GET/null)
 * @param {number} timeoutMs - Abort deadline
 * @returns {Promise<{status: number, json: Object|null}>}
 */
async function httpJson(deps, method, url, body, timeoutMs) {
  const options = {
    method,
    headers: { Accept: 'application/json' },
    // AbortSignal.timeout guards against a hung socket. Tests stub `fetch` and
    // ignore the signal, so this stays deterministic there.
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body != null) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await deps.fetch(url, options);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * Probe the configured port for a compatible pair-review server.
 *
 * Delegation is allowed only when the server is a pair-review instance whose
 * version EXACTLY matches this CLI's version and whose resolved database file
 * is the same as this CLI's (compared via `computeDbId` digests so the raw path
 * is never exposed over HTTP). Any other outcome — no server, foreign service,
 * version skew, different DB — returns `delegate: false` with a human-readable
 * `reason` for the stderr fallback note.
 *
 * @param {Object} config - Loaded config (uses `config.port`)
 * @param {Object} [_deps] - Dependency overrides for testing
 * @returns {Promise<{delegate: boolean, reason: string, baseUrl: string, serverVersion: string|null}>}
 */
async function probeServer(config, _deps) {
  const deps = { ...defaults, ..._deps };
  const port = config.port;
  const baseUrl = `http://localhost:${port}`;

  let result;
  try {
    result = await httpJson(deps, 'GET', `${baseUrl}/health`, null, HEALTH_TIMEOUT_MS);
  } catch {
    return { delegate: false, reason: `no server responding on port ${port}`, baseUrl, serverVersion: null };
  }

  const body = result.json || {};
  if (result.status < 200 || result.status >= 300 || body.service !== 'pair-review') {
    return {
      delegate: false,
      reason: `port ${port} is not serving a pair-review instance`,
      baseUrl,
      serverVersion: null,
    };
  }

  const serverVersion = body.version || null;
  if (serverVersion !== deps.cliVersion) {
    return {
      delegate: false,
      reason: `server version ${serverVersion || '(unknown)'} does not match CLI version ${deps.cliVersion}`,
      baseUrl,
      serverVersion,
    };
  }

  const expectedDbId = deps.computeDbId(deps.resolveDbPath(config));
  if (body.dbId !== expectedDbId) {
    return {
      delegate: false,
      reason: 'server is using a different database file',
      baseUrl,
      serverVersion,
    };
  }

  return { delegate: true, reason: 'compatible server', baseUrl, serverVersion };
}

/**
 * Generic status poller shared by setup and analysis waits.
 *
 * Owns every cross-cutting concern the two callers used to duplicate (and had
 * already drifted on): transport-error retry, 404 routing, non-2xx accounting
 * (INCLUDING 5xx — `httpJson` resolves rather than throws on a 500/503, so a
 * naive "reset the counter before the 2xx check" loop spins forever), the
 * consecutive-failure threshold, and recording WHICH failure kind ultimately
 * tripped it (so a transport-error streak capped by one stray 404 does not
 * report the misleading 404 message). Callers own only the semantics:
 *
 * @param {Object} deps - Merged dependencies
 * @param {Object} opts
 * @param {string} opts.url - Absolute status URL to GET
 * @param {number} opts.intervalMs - Delay between polls
 * @param {(json: Object) => ({done: boolean, value?: *}|undefined|Promise<...>)} opts.handleOk
 *   - Called on a confirmed 2xx. Return `{done:true, value}` to stop, a falsy
 *     value to keep polling, or throw to fail. Resets the failure counter.
 * @param {(deps: Object) => ({done: boolean, value?: *}|undefined|Promise<...>)} [opts.handle404]
 *   - Optional 404 handler. Return `{done:true, value}` to stop; a falsy value
 *     lets the 404 count as a failure. Absent → 404 is always a failure.
 * @param {(failure: {kind: string, status?: number, body?: Object, error?: Error}) => ({done: boolean, value?: *}|Promise<...>)} opts.onExhausted
 *   - Called once the failure threshold is crossed, with the LAST failure. Must
 *     return `{done:true, value}` or throw.
 * @returns {Promise<*>} The `value` from whichever handler resolved
 */
async function pollUntil(deps, { url, intervalMs, handleOk, handle404, onExhausted }) {
  let consecutiveFailures = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp;
    try {
      resp = await httpJson(deps, 'GET', url, null, REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        return (await onExhausted({ kind: 'transport', error: err })).value;
      }
      await deps.delay(intervalMs);
      continue;
    }

    if (resp.status === 404) {
      if (handle404) {
        const handled = await handle404(deps);
        if (handled && handled.done) return handled.value;
      }
      if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        return (await onExhausted({ kind: '404', status: 404, body: resp.json })).value;
      }
      await deps.delay(intervalMs);
      continue;
    }

    if (resp.status < 200 || resp.status >= 300) {
      const kind = resp.status >= 500 ? '5xx' : 'http';
      if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        return (await onExhausted({ kind, status: resp.status, body: resp.json })).value;
      }
      await deps.delay(intervalMs);
      continue;
    }

    // Confirmed 2xx — clear the streak and let the caller decide.
    consecutiveFailures = 0;
    const handled = await handleOk(resp.json || {});
    if (handled && handled.done) return handled.value;
    await deps.delay(intervalMs);
  }
}

/**
 * Poll a setup operation to completion via {@link pollUntil}.
 *
 * Resolves when the status reports `complete`; throws on `error`. A 404 or a
 * transport/5xx failure is tolerated up to MAX_CONSECUTIVE_POLL_FAILURES
 * consecutive occurrences — a CLI that polls in the instant between "server
 * returns setupId" and "status map seeded" would otherwise abort spuriously —
 * after which the message reflects the actual failure kind.
 *
 * @param {Object} deps - Merged dependencies
 * @param {string} baseUrl - Server base URL
 * @param {string} setupId - Setup operation id
 * @returns {Promise<{reviewUrl?: string, reviewId?: number}>}
 */
async function pollSetupStatus(deps, baseUrl, setupId) {
  return pollUntil(deps, {
    url: `${baseUrl}/api/setup/${setupId}/status`,
    intervalMs: SETUP_POLL_INTERVAL_MS,
    handleOk: (status) => {
      if (status.status === 'error') {
        throw new Error(`Server-side review setup failed: ${status.error || 'unknown error'}`);
      }
      if (status.status === 'complete') {
        return { done: true, value: { reviewUrl: status.reviewUrl, reviewId: status.reviewId } };
      }
      return undefined; // 'running' — keep polling.
    },
    onExhausted: (failure) => {
      if (failure.kind === 'transport') {
        throw new Error(`Lost contact with the pair-review server during setup: ${failure.error.message}`);
      }
      if (failure.kind === '404') {
        throw new Error('The pair-review server forgot the setup operation before it completed.');
      }
      const detail = (failure.body && failure.body.error) || `HTTP ${failure.status}`;
      throw new Error(`Server error during review setup: ${detail}`);
    },
  });
}

/**
 * Derive a local reviewId from a setup result. Prefers the explicit numeric
 * `reviewId`; falls back to parsing the trailing id out of a `/local/:id`
 * review URL (the short-circuit shape carries only a URL).
 *
 * @param {{reviewId?: number|string, reviewUrl?: string}} result
 * @returns {number|null}
 */
function deriveLocalReviewId(result) {
  if (result && result.reviewId != null) {
    const n = parseInt(result.reviewId, 10);
    if (!Number.isNaN(n)) return n;
  }
  const match = result && result.reviewUrl && /\/local\/(\d+)/.exec(result.reviewUrl);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Drive server-side local review setup and return the resolved reviewId.
 *
 * @param {Object} deps - Merged dependencies
 * @param {string} baseUrl - Server base URL
 * @param {{path: string, scope: string|null, base: string|null}} params
 * @returns {Promise<{reviewId: number, reviewUrl: string}>}
 */
async function setupLocal(deps, baseUrl, { path, scope, base }) {
  const body = { path };
  if (scope) body.scope = scope;
  if (base) body.base = base;

  const resp = await httpJson(deps, 'POST', `${baseUrl}/api/setup/local`, body, REQUEST_TIMEOUT_MS);
  if (resp.status < 200 || resp.status >= 300) {
    const detail = (resp.json && resp.json.error) || `HTTP ${resp.status}`;
    throw new Error(`Failed to start local review setup on the server: ${detail}`);
  }

  const data = resp.json || {};
  // Short-circuit shape: server may resolve an existing review inline with no
  // setupId (defensive — handle it without polling a nonexistent operation).
  let result = data;
  if (data.setupId) {
    result = await pollSetupStatus(deps, baseUrl, data.setupId);
  }

  const reviewId = deriveLocalReviewId(result);
  if (reviewId == null) {
    throw new Error('Server completed local setup but did not return a usable review id.');
  }
  return { reviewId, reviewUrl: result.reviewUrl || `/local/${reviewId}` };
}

/**
 * Drive server-side PR review setup. The server owns the worktree-pool hold, so
 * the delegating CLI never acquires a pool slot. Returns the canonical review
 * URL; the owner/repo/number the CLI already parsed drive the analyze launch,
 * so no server-side reviewId is needed.
 *
 * @param {Object} deps - Merged dependencies
 * @param {string} baseUrl - Server base URL
 * @param {{owner: string, repo: string, number: number, host?: string|null}} params
 * @returns {Promise<{reviewUrl: string}>}
 */
async function setupPr(deps, baseUrl, { owner, repo, number, host }) {
  const body = {};
  // Forward the host per the endpoint's body contract (null = github.com, a
  // string = that alt api_host; omit to let the server derive via stored host
  // or a probe). Only the raw parser value is faithful here — the URL 'github'
  // sentinel is a browser-relay convention, not the body contract.
  if (host !== undefined) body.host = host;

  const resp = await httpJson(
    deps, 'POST', `${baseUrl}/api/setup/pr/${owner}/${repo}/${number}`, body, REQUEST_TIMEOUT_MS
  );
  if (resp.status < 200 || resp.status >= 300) {
    const detail = (resp.json && resp.json.error) || `HTTP ${resp.status}`;
    throw new Error(`Failed to start PR review setup on the server: ${detail}`);
  }

  const data = resp.json || {};
  // Idempotent short-circuit: an already-set-up PR returns { existing, reviewUrl }
  // with no setupId — navigate directly without polling.
  if (data.existing || !data.setupId) {
    return { reviewUrl: data.reviewUrl || `/pr/${owner}/${repo}/${number}` };
  }

  const result = await pollSetupStatus(deps, baseUrl, data.setupId);
  return { reviewUrl: result.reviewUrl || `/pr/${owner}/${repo}/${number}` };
}

/**
 * Build the analyze-endpoint URL + request body for a resolved review config.
 *
 * The server never re-resolves: it receives the CLI-resolved explicit values
 * (council id, or provider/model), mirroring the repo convention of passing
 * resolved values down. `customInstructions` carries ONLY the per-run
 * `--instructions` text — the server derives global + repo instructions from
 * its own (shared) config/DB and merges them identically to the in-process
 * headless path, so the effective prompt matches.
 *
 * @param {string} baseUrl - Server base URL
 * @param {'local'|'pr'} mode
 * @param {Object} target - { reviewId } for local, { owner, repo, number } for PR
 * @param {Object} reviewConfig - resolveReviewConfig result (single|council)
 * @param {string|null} customInstructions - Per-run instructions (or null)
 * @returns {{url: string, body: Object}}
 */
function buildLaunchRequest(baseUrl, mode, target, reviewConfig, customInstructions) {
  const prefix = mode === 'local'
    ? `${baseUrl}/api/local/${target.reviewId}`
    : `${baseUrl}/api/pr/${target.owner}/${target.repo}/${target.number}`;

  if (reviewConfig.type === 'council') {
    return {
      url: `${prefix}/analyses/council`,
      body: {
        councilId: reviewConfig.council.id,
        configType: reviewConfig.configType,
        customInstructions,
      },
    };
  }
  return {
    url: `${prefix}/analyses`,
    body: {
      provider: reviewConfig.provider,
      model: reviewConfig.model,
      customInstructions,
    },
  };
}

/**
 * Launch analysis on the server and return the identifiers to wait on.
 *
 * @param {Object} deps - Merged dependencies
 * @param {string} baseUrl - Server base URL
 * @param {'local'|'pr'} mode
 * @param {Object} target - { reviewId } (local) or { owner, repo, number } (PR)
 * @param {Object} reviewConfig - resolveReviewConfig result
 * @param {string|null} customInstructions
 * @returns {Promise<{analysisId: string, runId: string}>}
 */
async function launchAnalysis(deps, baseUrl, mode, target, reviewConfig, customInstructions) {
  const { url, body } = buildLaunchRequest(baseUrl, mode, target, reviewConfig, customInstructions);
  const resp = await httpJson(deps, 'POST', url, body, REQUEST_TIMEOUT_MS);
  if (resp.status < 200 || resp.status >= 300) {
    const detail = (resp.json && resp.json.error) || `HTTP ${resp.status}`;
    // A 409 from the analyze endpoint is a PRECONDITION failure (empty scope,
    // worktree lock) whose server message is already user-meaningful. Surface it
    // VERBATIM so a delegated empty-scope run reads identically to the
    // in-process run (both emit the same `{ ok:false, error }` message) rather
    // than wrapping it. Every other non-2xx keeps the request-context prefix.
    if (resp.status === 409 && resp.json && resp.json.error) {
      throw new Error(resp.json.error);
    }
    throw new Error(`Server rejected the analysis request: ${detail}`);
  }
  const data = resp.json || {};
  if (!data.analysisId || !data.runId) {
    throw new Error('Server accepted the analysis request but did not return analysisId/runId.');
  }
  return { analysisId: data.analysisId, runId: data.runId };
}

/**
 * Best-effort cancel of an in-flight delegated analysis (fired on SIGINT/SIGTERM).
 * Swallows all errors — the process is exiting regardless.
 *
 * @param {Object} deps - Merged dependencies
 * @param {string} baseUrl - Server base URL
 * @param {string} analysisId
 */
async function cancelAnalysis(deps, baseUrl, analysisId) {
  try {
    await httpJson(deps, 'POST', `${baseUrl}/api/analyses/${analysisId}/cancel`, {}, CANCEL_TIMEOUT_MS);
  } catch {
    // Best-effort only.
  }
}

/**
 * Install SIGINT/SIGTERM handlers that cancel the delegated run before exiting.
 * Returns a cleanup function that removes them (call in a finally).
 *
 * A re-entry guard makes the FIRST interrupt fire the (short-deadline) cancel
 * POST and then exit, while a SECOND interrupt exits immediately — an impatient
 * double Ctrl-C never waits on the network or queues a duplicate cancel.
 *
 * @param {Object} deps - Merged dependencies
 * @param {string} baseUrl - Server base URL
 * @param {string} analysisId
 * @returns {() => void} cleanup
 */
function installCancelHandlers(deps, baseUrl, analysisId) {
  let cancelling = false;
  const handler = async () => {
    if (cancelling) {
      // Second interrupt — don't wait on the in-flight cancel, exit now.
      deps.exit(130);
      return;
    }
    cancelling = true;
    deps.logger.info('Received interrupt — cancelling the delegated analysis on the server...');
    await cancelAnalysis(deps, baseUrl, analysisId);
    // 130 = terminated by SIGINT, the conventional shell exit code.
    deps.exit(130);
  };
  deps.process.on('SIGINT', handler);
  deps.process.on('SIGTERM', handler);
  return () => {
    deps.process.removeListener('SIGINT', handler);
    deps.process.removeListener('SIGTERM', handler);
  };
}

/**
 * Condense an analysis status snapshot into one concise progress line for
 * stderr, so identical repeated polls can be throttled by the caller.
 *
 * @param {Object} status - activeAnalyses snapshot
 * @returns {string}
 */
function summarizeProgress(status) {
  if (!status) return '';
  const parts = [];
  if (status.status) parts.push(status.status);
  if (status.progress) parts.push(status.progress);
  if (status.levels && typeof status.levels === 'object') {
    const levelSummary = Object.entries(status.levels)
      .map(([key, value]) => `${key}:${(value && value.status) || '?'}`)
      .join(' ');
    if (levelSummary) parts.push(`(${levelSummary})`);
  }
  return parts.join(' ');
}

/**
 * Wait for a delegated analysis to reach a terminal state via {@link pollUntil},
 * echoing concise progress to stderr along the way.
 *
 * Poll semantics (per the plan):
 *   - GET /api/analyses/:id/status every ~3s.
 *   - A 404 means the server dropped its in-memory entry: consult the DB run row
 *     — terminal → done; still running → let it count as a poll failure.
 *   - A transport/5xx failure is a poll failure. Once the threshold is crossed
 *     with a still-non-terminal DB row, the server is presumed dead and we
 *     resolve a `failed` outcome explaining why.
 *
 * The DB row fetched on the LAST 404 is reused by the exhaustion handler (no
 * redundant re-fetch); a transport/5xx streak re-reads fresh, since no 404
 * branch ran to populate it and the server may have written a terminal row.
 *
 * @param {Object} deps - Merged dependencies
 * @param {string} baseUrl - Server base URL
 * @param {string} analysisId
 * @param {string} runId
 * @param {Object} db - Database instance (for the DB-row fallback)
 * @returns {Promise<{status: string, error?: string}>}
 */
async function waitForAnalysis(deps, baseUrl, analysisId, runId, db) {
  let lastSummary = null;
  let lastDbStatus; // populated by the 404 branch so onExhausted can reuse it

  return pollUntil(deps, {
    url: `${baseUrl}/api/analyses/${analysisId}/status`,
    intervalMs: ANALYSIS_POLL_INTERVAL_MS,
    handleOk: (status) => {
      const summary = summarizeProgress(status);
      if (summary && summary !== lastSummary) {
        deps.logger.info(`Analysis progress: ${summary}`);
        lastSummary = summary;
      }
      if (isTerminal(status.status)) {
        return { done: true, value: { status: status.status, error: status.error || status.progress } };
      }
      return undefined;
    },
    handle404: async () => {
      // In-memory entry gone — the DB row is authoritative. Cache it so a 404
      // streak that trips the threshold doesn't re-fetch in onExhausted.
      lastDbStatus = await deps.getRunStatus(db, runId);
      if (isTerminal(lastDbStatus)) return { done: true, value: { status: lastDbStatus } };
      return undefined;
    },
    onExhausted: async (failure) => {
      // A 404 streak already read the DB row this iteration — reuse it. A
      // transport/5xx streak did not, so read fresh (the run may have finished).
      const dbStatus = failure.kind === '404' ? lastDbStatus : await deps.getRunStatus(db, runId);
      if (isTerminal(dbStatus)) return { done: true, value: { status: dbStatus } };
      return { done: true, value: { status: 'failed', error: SERVER_DIED_MESSAGE } };
    },
  });
}

/**
 * Orchestrate a full delegated headless run: set up the review on the server,
 * launch the resolved analysis, and wait for it to finish. Returns the server's
 * `runId` so the caller emits the standard headless JSON from the shared DB.
 *
 * Throws on any failure (setup error, rejected launch, failed/cancelled run, or
 * a server that dies mid-run) so the CLI's existing `--json` error path emits
 * `{ ok: false, error }` and exits non-zero — identical failure semantics to
 * the in-process path.
 *
 * @param {Object} params
 * @param {string} params.baseUrl - Compatible server base URL (from probeServer)
 * @param {'local'|'pr'} params.mode
 * @param {Object} params.reviewConfig - resolveReviewConfig result (single|council)
 * @param {string|null} params.customInstructions - Per-run `--instructions` text
 * @param {Object} [params.prInfo] - { owner, repo, number } (PR mode)
 * @param {string|null} [params.host] - PR host body value (PR mode)
 * @param {string} [params.localPath] - Resolved repo path (local mode)
 * @param {string|null} [params.scope] - `--scope` (local mode)
 * @param {string|null} [params.base] - `--base` (local mode)
 * @param {Object} params.db - Database instance (DB-row fallback + final emit)
 * @param {Object} [params._deps] - Dependency overrides for testing
 * @returns {Promise<{runId: string, mode: 'local'|'pr'}>}
 */
async function runDelegatedAnalysis({
  baseUrl, mode, reviewConfig, customInstructions,
  prInfo, host, localPath, scope, base, db, _deps,
}) {
  const deps = { ...defaults, ..._deps };

  deps.logger.info(`Delegating headless analysis to the running pair-review server at ${baseUrl}`);

  // 1. Setup (server owns the worktree/pool in PR mode).
  let target;
  let reviewUrl;
  if (mode === 'local') {
    const setup = await setupLocal(deps, baseUrl, { path: localPath, scope, base });
    target = { reviewId: setup.reviewId };
    reviewUrl = setup.reviewUrl;
  } else {
    const setup = await setupPr(deps, baseUrl, {
      owner: prInfo.owner, repo: prInfo.repo, number: prInfo.number, host,
    });
    target = { owner: prInfo.owner, repo: prInfo.repo, number: prInfo.number };
    reviewUrl = setup.reviewUrl;
  }

  // 2. Launch the resolved analysis.
  const { analysisId, runId } = await launchAnalysis(
    deps, baseUrl, mode, target, reviewConfig, customInstructions
  );

  // Surface the live view early so a human can open it while the agent waits.
  deps.logger.info(`Live review view: ${baseUrl}${reviewUrl}`);

  // 3. Wait, cancelling on interrupt.
  const cleanup = installCancelHandlers(deps, baseUrl, analysisId);
  let outcome;
  try {
    outcome = await waitForAnalysis(deps, baseUrl, analysisId, runId, db);
  } finally {
    cleanup();
  }

  if (outcome.status !== 'completed') {
    const suffix = outcome.error ? `: ${outcome.error}` : '';
    throw new Error(`Delegated analysis ${outcome.status}${suffix}`);
  }

  return { runId, mode };
}

module.exports = {
  probeServer,
  runDelegatedAnalysis,
  // Exported for focused unit tests.
  setupLocal,
  setupPr,
  launchAnalysis,
  waitForAnalysis,
  buildLaunchRequest,
  summarizeProgress,
  deriveLocalReviewId,
  installCancelHandlers,
  cancelAnalysis,
  HEALTH_TIMEOUT_MS,
  MAX_CONSECUTIVE_POLL_FAILURES,
};
