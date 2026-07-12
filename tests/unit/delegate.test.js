// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/headless/delegate.js — the CLI side of server-delegated
 * headless analysis. Every network call and timer is injected via the module's
 * `_deps` seam (mirroring src/protocol-handler.js), so these tests do no real
 * I/O, wait no wall-clock time, and never spawn a browser (per tests/CONVENTIONS.md).
 */

import { describe, it, expect, vi } from 'vitest';

const {
  probeServer,
  runDelegatedAnalysis,
  setupLocal,
  launchAnalysis,
  buildLaunchRequest,
  summarizeProgress,
  deriveLocalReviewId,
  installCancelHandlers,
  MAX_CONSECUTIVE_POLL_FAILURES,
} = require('../../src/headless/delegate');
const { EMPTY_SCOPE_MESSAGE } = require('../../src/local-scope');

const CLI_VERSION = '9.9.9-test';
const DB_ID = 'db-id-abcdef';

/** A minimal Response stand-in: only { status, json() } is consumed. */
function jsonRes(status, body) {
  return { status, json: async () => body };
}

/** A fake process EventEmitter for signal-handler tests. */
function createFakeProcess() {
  const listeners = {};
  return {
    on: vi.fn((sig, fn) => { (listeners[sig] = listeners[sig] || []).push(fn); }),
    removeListener: vi.fn((sig, fn) => {
      listeners[sig] = (listeners[sig] || []).filter((f) => f !== fn);
    }),
    async emit(sig) {
      for (const fn of listeners[sig] || []) await fn();
    },
    listeners,
  };
}

/** Baseline injected deps: immediate delay, silent logger, matching version/dbId. */
function baseDeps(overrides = {}) {
  return {
    delay: vi.fn(() => Promise.resolve()),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    process: createFakeProcess(),
    exit: vi.fn(),
    getRunStatus: vi.fn(),
    computeDbId: vi.fn(() => DB_ID),
    resolveDbPath: vi.fn(() => '/fake/db/path'),
    cliVersion: CLI_VERSION,
    ...overrides,
  };
}

/** Parse the JSON body a fetch call was invoked with. */
function bodyOf(call) {
  return JSON.parse(call[1].body);
}

/** Find the first fetch call whose URL matches a substring and method. */
function findCall(fetch, method, urlSubstr) {
  return fetch.mock.calls.find(
    ([url, opts]) => (opts?.method || 'GET') === method && url.includes(urlSubstr)
  );
}

const CONFIG = { port: 7247 };

describe('probeServer', () => {
  it('delegates to a matching-version, same-DB pair-review server', async () => {
    const fetch = vi.fn(async () =>
      jsonRes(200, { status: 'ok', service: 'pair-review', version: CLI_VERSION, dbId: DB_ID })
    );
    const result = await probeServer(CONFIG, baseDeps({ fetch }));
    expect(result).toMatchObject({ delegate: true, baseUrl: 'http://localhost:7247', serverVersion: CLI_VERSION });
    expect(fetch).toHaveBeenCalledWith('http://localhost:7247/health', expect.objectContaining({ method: 'GET' }));
  });

  it('does NOT delegate when no server is responding (fetch rejects)', async () => {
    const fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await probeServer(CONFIG, baseDeps({ fetch }));
    expect(result.delegate).toBe(false);
    expect(result.reason).toMatch(/no server/i);
  });

  it('does NOT delegate to a foreign service on the port', async () => {
    const fetch = vi.fn(async () => jsonRes(200, { service: 'something-else' }));
    const result = await probeServer(CONFIG, baseDeps({ fetch }));
    expect(result.delegate).toBe(false);
    expect(result.reason).toMatch(/not serving a pair-review/i);
  });

  it('does NOT delegate on a version mismatch (schema/behavior skew guard)', async () => {
    const fetch = vi.fn(async () =>
      jsonRes(200, { status: 'ok', service: 'pair-review', version: '1.0.0-old', dbId: DB_ID })
    );
    const result = await probeServer(CONFIG, baseDeps({ fetch }));
    expect(result.delegate).toBe(false);
    expect(result.reason).toMatch(/version/i);
    expect(result.serverVersion).toBe('1.0.0-old');
  });

  it('does NOT delegate when the server uses a different database file', async () => {
    const fetch = vi.fn(async () =>
      jsonRes(200, { status: 'ok', service: 'pair-review', version: CLI_VERSION, dbId: 'a-different-db' })
    );
    const result = await probeServer(CONFIG, baseDeps({ fetch }));
    expect(result.delegate).toBe(false);
    expect(result.reason).toMatch(/different database/i);
  });

  it('does NOT delegate on a 5xx /health (transient server error, empty body)', async () => {
    const fetch = vi.fn(async () => jsonRes(503, {}));
    const result = await probeServer(CONFIG, baseDeps({ fetch }));
    expect(result.delegate).toBe(false);
    expect(result.reason).toMatch(/not serving a pair-review/i);
  });
});

describe('setupLocal (setup-poll resilience)', () => {
  it('rejects after MAX_CONSECUTIVE_POLL_FAILURES on a persistent 5xx status (no infinite spin)', async () => {
    let statusPolls = 0;
    const fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && url.endsWith('/api/setup/local')) return jsonRes(200, { setupId: 's-5xx' });
      if (url.includes('/api/setup/s-5xx/status')) { statusPolls++; return jsonRes(503, { error: 'overloaded' }); }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const deps = baseDeps({ fetch });

    await expect(setupLocal(deps, 'http://localhost:7247', { path: '/repo', scope: null, base: null }))
      .rejects.toThrow(/Server error during review setup.*overloaded/i);
    // The poll loop terminated at the threshold instead of spinning forever.
    expect(statusPolls).toBe(MAX_CONSECUTIVE_POLL_FAILURES);
  });
});

describe('launchAnalysis (error surfacing)', () => {
  it('rejects a generic non-2xx with the request-context prefix', async () => {
    const fetch = vi.fn(async () => jsonRes(500, { error: 'boom' }));
    const deps = baseDeps({ fetch });
    await expect(launchAnalysis(
      deps, 'http://localhost:7247', 'local', { reviewId: 1 },
      { type: 'single', provider: 'claude', model: 'opus' }, null
    )).rejects.toThrow(/Server rejected the analysis request.*boom/i);
  });

  it('surfaces a 409 precondition (empty scope) VERBATIM for cross-mode message parity', async () => {
    const fetch = vi.fn(async () => jsonRes(409, { error: EMPTY_SCOPE_MESSAGE }));
    const deps = baseDeps({ fetch });
    // Must equal the shared message exactly — no "Server rejected" wrapper — so a
    // delegated empty-scope run reads identically to the in-process run.
    await expect(launchAnalysis(
      deps, 'http://localhost:7247', 'local', { reviewId: 1 },
      { type: 'single', provider: 'claude', model: 'opus' }, null
    )).rejects.toThrow(EMPTY_SCOPE_MESSAGE);
  });
});

describe('buildLaunchRequest (endpoint + instruction-parity mapping)', () => {
  it('maps a local council run to /analyses/council with resolved councilId', () => {
    const rc = { type: 'council', council: { id: 'council-77' }, configType: 'advanced' };
    const { url, body } = buildLaunchRequest('http://x', 'local', { reviewId: 42 }, rc, 'focus on X');
    expect(url).toBe('http://x/api/local/42/analyses/council');
    expect(body).toEqual({ councilId: 'council-77', configType: 'advanced', customInstructions: 'focus on X' });
  });

  it('maps a local single run to /analyses with resolved provider/model', () => {
    const rc = { type: 'single', provider: 'claude', model: 'opus' };
    const { url, body } = buildLaunchRequest('http://x', 'local', { reviewId: 7 }, rc, null);
    expect(url).toBe('http://x/api/local/7/analyses');
    expect(body).toEqual({ provider: 'claude', model: 'opus', customInstructions: null });
  });

  it('maps a PR council run to the PR council endpoint', () => {
    const rc = { type: 'council', council: { id: 'c1' }, configType: 'basic' };
    const { url } = buildLaunchRequest('http://x', 'pr', { owner: 'o', repo: 'r', number: 5 }, rc, null);
    expect(url).toBe('http://x/api/pr/o/r/5/analyses/council');
  });

  it('maps a PR single run to the PR analyses endpoint', () => {
    const rc = { type: 'single', provider: 'codex', model: 'gpt-5.5' };
    const { url, body } = buildLaunchRequest('http://x', 'pr', { owner: 'o', repo: 'r', number: 5 }, rc, 'note');
    expect(url).toBe('http://x/api/pr/o/r/5/analyses');
    expect(body).toEqual({ provider: 'codex', model: 'gpt-5.5', customInstructions: 'note' });
  });
});

describe('runDelegatedAnalysis — happy paths', () => {
  it('local council: sets up, polls, launches council, waits, returns runId', async () => {
    const fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && url.endsWith('/api/setup/local')) return jsonRes(200, { setupId: 's1' });
      if (url.includes('/api/setup/s1/status')) return jsonRes(200, { status: 'complete', reviewId: 42, reviewUrl: '/local/42' });
      if (method === 'POST' && url.endsWith('/api/local/42/analyses/council')) return jsonRes(200, { analysisId: 'a1', runId: 'r1' });
      if (url.includes('/api/analyses/a1/status')) return jsonRes(200, { status: 'completed' });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const deps = baseDeps({ fetch });

    const result = await runDelegatedAnalysis({
      baseUrl: 'http://localhost:7247',
      mode: 'local',
      reviewConfig: { type: 'council', council: { id: 'council-9' }, configType: 'advanced' },
      customInstructions: 'be thorough',
      localPath: '/repo',
      scope: 'branch..untracked',
      base: 'main',
      db: {},
      _deps: deps,
    });

    expect(result).toEqual({ runId: 'r1', mode: 'local' });

    // Setup body carries path + scope + base.
    const setupBody = bodyOf(findCall(fetch, 'POST', '/api/setup/local'));
    expect(setupBody).toEqual({ path: '/repo', scope: 'branch..untracked', base: 'main' });

    // Launch body carries the RESOLVED council id + per-run instructions only.
    const launchBody = bodyOf(findCall(fetch, 'POST', '/api/local/42/analyses/council'));
    expect(launchBody).toEqual({ councilId: 'council-9', configType: 'advanced', customInstructions: 'be thorough' });
  });

  it('local single: launches the single-model endpoint with provider/model', async () => {
    const fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && url.endsWith('/api/setup/local')) return jsonRes(200, { setupId: 's2' });
      if (url.includes('/api/setup/s2/status')) return jsonRes(200, { status: 'complete', reviewId: 8, reviewUrl: '/local/8' });
      if (method === 'POST' && url.endsWith('/api/local/8/analyses')) return jsonRes(200, { analysisId: 'a2', runId: 'r2' });
      if (url.includes('/api/analyses/a2/status')) return jsonRes(200, { status: 'completed' });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const deps = baseDeps({ fetch });

    const result = await runDelegatedAnalysis({
      baseUrl: 'http://localhost:7247',
      mode: 'local',
      reviewConfig: { type: 'single', provider: 'claude', model: 'opus' },
      customInstructions: null,
      localPath: '/repo',
      scope: null,
      base: null,
      db: {},
      _deps: deps,
    });

    expect(result).toEqual({ runId: 'r2', mode: 'local' });
    const launchBody = bodyOf(findCall(fetch, 'POST', '/api/local/8/analyses'));
    expect(launchBody).toEqual({ provider: 'claude', model: 'opus', customInstructions: null });
    // Scope/base omitted from the setup body when not supplied.
    expect(bodyOf(findCall(fetch, 'POST', '/api/setup/local'))).toEqual({ path: '/repo' });
  });

  it('PR existing short-circuit: skips setup polling, launches directly', async () => {
    const fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && url.endsWith('/api/setup/pr/o/r/5')) return jsonRes(200, { existing: true, reviewUrl: '/pr/o/r/5' });
      if (method === 'POST' && url.endsWith('/api/pr/o/r/5/analyses/council')) return jsonRes(200, { analysisId: 'a3', runId: 'r3' });
      if (url.includes('/api/analyses/a3/status')) return jsonRes(200, { status: 'completed' });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const deps = baseDeps({ fetch });

    const result = await runDelegatedAnalysis({
      baseUrl: 'http://localhost:7247',
      mode: 'pr',
      reviewConfig: { type: 'council', council: { id: 'c9' }, configType: 'advanced' },
      customInstructions: null,
      prInfo: { owner: 'o', repo: 'r', number: 5 },
      host: undefined,
      db: {},
      _deps: deps,
    });

    expect(result).toEqual({ runId: 'r3', mode: 'pr' });
    // No setup-status GET should have happened (short-circuit, no setupId).
    expect(findCall(fetch, 'GET', '/api/setup/')).toBeUndefined();
    // host omitted from the body (undefined → server derives it).
    expect(bodyOf(findCall(fetch, 'POST', '/api/setup/pr/o/r/5'))).toEqual({});
  });
});

describe('runDelegatedAnalysis — failure and resilience', () => {
  it('server-death mid-poll: consecutive status failures + non-terminal DB row → throws', async () => {
    let statusPolls = 0;
    const fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && url.endsWith('/api/setup/local')) return jsonRes(200, { setupId: 's4' });
      if (url.includes('/api/setup/s4/status')) return jsonRes(200, { status: 'complete', reviewId: 1, reviewUrl: '/local/1' });
      if (method === 'POST' && url.endsWith('/api/local/1/analyses')) return jsonRes(200, { analysisId: 'a4', runId: 'r4' });
      if (url.includes('/api/analyses/a4/status')) { statusPolls++; throw new Error('ECONNRESET'); }
      throw new Error(`unexpected ${method} ${url}`);
    });
    // DB row still 'running' → the server truly died mid-run.
    const deps = baseDeps({ fetch, getRunStatus: vi.fn(async () => 'running') });

    await expect(runDelegatedAnalysis({
      baseUrl: 'http://localhost:7247',
      mode: 'local',
      reviewConfig: { type: 'single', provider: 'claude', model: 'opus' },
      customInstructions: null,
      localPath: '/repo',
      db: {},
      _deps: deps,
    })).rejects.toThrow(/unreachable|died|failed/i);

    expect(statusPolls).toBeGreaterThanOrEqual(MAX_CONSECUTIVE_POLL_FAILURES);
  });

  it('status 404 with a terminal DB row: completes from the DB (run finished, entry shed)', async () => {
    const fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && url.endsWith('/api/setup/local')) return jsonRes(200, { setupId: 's5' });
      if (url.includes('/api/setup/s5/status')) return jsonRes(200, { status: 'complete', reviewId: 3, reviewUrl: '/local/3' });
      if (method === 'POST' && url.endsWith('/api/local/3/analyses')) return jsonRes(200, { analysisId: 'a5', runId: 'r5' });
      if (url.includes('/api/analyses/a5/status')) return jsonRes(404, { error: 'Analysis not found' });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const getRunStatus = vi.fn(async () => 'completed');
    const deps = baseDeps({ fetch, getRunStatus });

    const result = await runDelegatedAnalysis({
      baseUrl: 'http://localhost:7247',
      mode: 'local',
      reviewConfig: { type: 'single', provider: 'claude', model: 'opus' },
      customInstructions: null,
      localPath: '/repo',
      db: {},
      _deps: deps,
    });

    expect(result).toEqual({ runId: 'r5', mode: 'local' });
    expect(getRunStatus).toHaveBeenCalledWith(expect.anything(), 'r5');
  });

  it('a failed run status throws (in-process error-path parity)', async () => {
    const fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && url.endsWith('/api/setup/local')) return jsonRes(200, { setupId: 's6' });
      if (url.includes('/api/setup/s6/status')) return jsonRes(200, { status: 'complete', reviewId: 2, reviewUrl: '/local/2' });
      if (method === 'POST' && url.endsWith('/api/local/2/analyses')) return jsonRes(200, { analysisId: 'a6', runId: 'r6' });
      if (url.includes('/api/analyses/a6/status')) return jsonRes(200, { status: 'failed', error: 'provider exploded' });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const deps = baseDeps({ fetch });

    await expect(runDelegatedAnalysis({
      baseUrl: 'http://localhost:7247',
      mode: 'local',
      reviewConfig: { type: 'single', provider: 'claude', model: 'opus' },
      customInstructions: null,
      localPath: '/repo',
      db: {},
      _deps: deps,
    })).rejects.toThrow(/failed.*provider exploded/i);
  });

  it('setup error surfaces as a thrown error', async () => {
    const fetch = vi.fn(async (url, opts) => {
      const method = opts?.method || 'GET';
      if (method === 'POST' && url.endsWith('/api/setup/local')) return jsonRes(200, { setupId: 's7' });
      if (url.includes('/api/setup/s7/status')) return jsonRes(200, { status: 'error', error: 'no git repo' });
      throw new Error(`unexpected ${method} ${url}`);
    });
    const deps = baseDeps({ fetch });

    await expect(runDelegatedAnalysis({
      baseUrl: 'http://localhost:7247',
      mode: 'local',
      reviewConfig: { type: 'single', provider: 'claude', model: 'opus' },
      customInstructions: null,
      localPath: '/repo',
      db: {},
      _deps: deps,
    })).rejects.toThrow(/setup failed.*no git repo/i);
  });
});

describe('installCancelHandlers (cancel-on-signal)', () => {
  it('cancels the delegated analysis and exits on SIGINT', async () => {
    const fetch = vi.fn(async () => jsonRes(200, { success: true }));
    const deps = baseDeps({ fetch });

    const cleanup = installCancelHandlers(deps, 'http://localhost:7247', 'a1');
    expect(deps.process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(deps.process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    await deps.process.emit('SIGINT');

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:7247/api/analyses/a1/cancel',
      expect.objectContaining({ method: 'POST' })
    );
    expect(deps.exit).toHaveBeenCalledWith(130);

    cleanup();
    expect(deps.process.removeListener).toHaveBeenCalledTimes(2);
  });

  it('still exits when the cancel POST fails (best-effort)', async () => {
    const fetch = vi.fn(async () => { throw new Error('gone'); });
    const deps = baseDeps({ fetch });

    installCancelHandlers(deps, 'http://localhost:7247', 'a1');
    await deps.process.emit('SIGTERM');

    expect(deps.exit).toHaveBeenCalledWith(130);
  });

  it('a second interrupt exits immediately without queuing a duplicate cancel', async () => {
    // First cancel POST hangs (never resolves) so the second signal arrives
    // while the first is still in flight.
    const fetch = vi.fn(() => new Promise(() => {}));
    const deps = baseDeps({ fetch });

    installCancelHandlers(deps, 'http://localhost:7247', 'a1');
    // Fire two SIGINTs; do not await the first (its cancel POST never resolves).
    deps.process.emit('SIGINT');
    await deps.process.emit('SIGINT');

    // Exactly ONE cancel POST was issued (the re-entry guard suppressed the 2nd)...
    expect(fetch).toHaveBeenCalledTimes(1);
    // ...and the second interrupt still forced an exit.
    expect(deps.exit).toHaveBeenCalledWith(130);
  });
});

describe('pure helpers', () => {
  it('deriveLocalReviewId prefers explicit reviewId then parses the URL', () => {
    expect(deriveLocalReviewId({ reviewId: 42 })).toBe(42);
    expect(deriveLocalReviewId({ reviewId: '13' })).toBe(13);
    expect(deriveLocalReviewId({ reviewUrl: '/local/57' })).toBe(57);
    expect(deriveLocalReviewId({ reviewUrl: '/pr/o/r/5' })).toBeNull();
    expect(deriveLocalReviewId({})).toBeNull();
  });

  it('summarizeProgress condenses status + progress + per-level state', () => {
    expect(summarizeProgress({ status: 'running', progress: 'Level 1' })).toBe('running Level 1');
    expect(summarizeProgress({ status: 'running', levels: { 1: { status: 'completed' }, 2: { status: 'running' } } }))
      .toBe('running (1:completed 2:running)');
    expect(summarizeProgress(null)).toBe('');
  });
});
