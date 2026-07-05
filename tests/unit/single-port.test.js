// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

const {
  detectRunningServer,
  notifyVersion,
  storeAnalysisConfigRemote,
  buildDelegationUrl,
  attemptDelegation,
  HEALTH_TIMEOUT_MS
} = require('../../src/single-port');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock http.get that resolves with the given JSON body. */
function mockHttpGetSuccess(body) {
  return (url, opts, cb) => {
    const res = {
      on(event, handler) {
        if (event === 'data') handler(JSON.stringify(body));
        if (event === 'end') handler();
        return res;
      }
    };
    cb(res);
    const req = {
      on() { return req; },
      destroy() {}
    };
    return req;
  };
}

/** Create a mock http.get that emits an error (e.g. ECONNREFUSED). */
function mockHttpGetError(code = 'ECONNREFUSED') {
  return (_url, _opts, _cb) => {
    const req = {
      on(event, handler) {
        if (event === 'error') {
          const err = new Error(code);
          err.code = code;
          handler(err);
        }
        return req;
      },
      destroy() {}
    };
    return req;
  };
}

/** Create a mock http.get that times out. */
function mockHttpGetTimeout() {
  return (_url, _opts, _cb) => {
    const req = {
      on(event, handler) {
        if (event === 'timeout') handler();
        return req;
      },
      destroy() {}
    };
    return req;
  };
}

/** Create a mock http.request (for POST). Returns the written data via capture. */
function mockHttpRequest(capture = {}) {
  return (opts, cb) => {
    capture.opts = opts;
    if (cb) cb({ on() {} });
    const req = {
      on() { return req; },
      write(data) { capture.body = data; return req; },
      end() { return req; },
      destroy() {}
    };
    return req;
  };
}

/**
 * Mock http.request that emits a JSON response (statusCode + body), captures the
 * request opts + written body, and can simulate transport error / timeout. Used
 * for storeAnalysisConfigRemote, which (unlike notifyVersion) reads the response.
 */
function mockHttpRequestWithResponse({ statusCode = 200, body = { success: true, id: 'cfg-xyz' }, error = null, timeout = false } = {}, capture = {}) {
  return (opts, cb) => {
    capture.opts = opts;
    if (cb && !error && !timeout) {
      const res = {
        statusCode,
        on(event, handler) {
          if (event === 'data') handler(JSON.stringify(body));
          if (event === 'end') handler();
          return res;
        }
      };
      cb(res);
    }
    const req = {
      on(event, handler) {
        if (event === 'error' && error) handler(error);
        if (event === 'timeout' && timeout) handler();
        return req;
      },
      write(data) { capture.body = data; return req; },
      end() { return req; },
      destroy() {}
    };
    return req;
  };
}

function createMockDeps(overrides = {}) {
  // Static field captures args across fresh instances, since production code
  // calls `new deps.PRArgumentParser()` each time.
  class MockPRArgumentParser {
    async parsePRArguments(args) {
      MockPRArgumentParser.lastArgs = args;
      return { owner: 'test-owner', repo: 'test-repo', number: parseInt(args[0]) || 42 };
    }
  }
  MockPRArgumentParser.lastArgs = null;

  return {
    httpGet: mockHttpGetSuccess({ status: 'ok', service: 'pair-review', version: '3.2.0' }),
    httpRequest: mockHttpRequest(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    open: vi.fn().mockResolvedValue(undefined),
    PRArgumentParser: MockPRArgumentParser,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// detectRunningServer
// ---------------------------------------------------------------------------

describe('detectRunningServer', () => {
  it('returns running=true, isPairReview=true when service is pair-review', async () => {
    const deps = createMockDeps();
    const result = await detectRunningServer(7247, deps);
    expect(result).toEqual({ running: true, isPairReview: true, version: '3.2.0' });
  });

  it('returns running=true, isPairReview=false for non-pair-review service', async () => {
    const deps = createMockDeps({
      httpGet: mockHttpGetSuccess({ status: 'ok' })
    });
    const result = await detectRunningServer(7247, deps);
    expect(result).toEqual({ running: true, isPairReview: false });
  });

  it('returns running=false on ECONNREFUSED', async () => {
    const deps = createMockDeps({
      httpGet: mockHttpGetError('ECONNREFUSED')
    });
    const result = await detectRunningServer(7247, deps);
    expect(result).toEqual({ running: false });
  });

  it('returns running=false on timeout', async () => {
    const deps = createMockDeps({
      httpGet: mockHttpGetTimeout()
    });
    const result = await detectRunningServer(7247, deps);
    expect(result).toEqual({ running: false });
  });

  it('returns isPairReview=false for non-JSON response', async () => {
    const httpGet = (_url, _opts, cb) => {
      const res = {
        on(event, handler) {
          if (event === 'data') handler('not json');
          if (event === 'end') handler();
          return res;
        }
      };
      cb(res);
      const req = { on() { return req; }, destroy() {} };
      return req;
    };
    const deps = createMockDeps({ httpGet });
    const result = await detectRunningServer(7247, deps);
    expect(result).toEqual({ running: true, isPairReview: false });
  });

  it('handles missing version field gracefully', async () => {
    const deps = createMockDeps({
      httpGet: mockHttpGetSuccess({ status: 'ok', service: 'pair-review' })
    });
    const result = await detectRunningServer(7247, deps);
    expect(result).toEqual({ running: true, isPairReview: true, version: null });
  });
});

// ---------------------------------------------------------------------------
// buildDelegationUrl
// ---------------------------------------------------------------------------

describe('buildDelegationUrl', () => {
  it('builds PR URL', () => {
    const url = buildDelegationUrl(7247, 'pr', { owner: 'acme', repo: 'widgets', number: 42 });
    expect(url).toBe('http://localhost:7247/pr/acme/widgets/42');
  });

  it('builds PR URL with analyze flag', () => {
    const url = buildDelegationUrl(7247, 'pr', { owner: 'acme', repo: 'widgets', number: 42, analyze: true });
    expect(url).toBe('http://localhost:7247/pr/acme/widgets/42?analyze=true');
  });

  it('builds local URL', () => {
    const url = buildDelegationUrl(7247, 'local', { localPath: '/home/user/project' });
    expect(url).toBe('http://localhost:7247/local?path=%2Fhome%2Fuser%2Fproject');
  });

  it('builds local URL with analyze flag', () => {
    const url = buildDelegationUrl(7247, 'local', { localPath: '/home/user/project', analyze: true });
    expect(url).toBe('http://localhost:7247/local?path=%2Fhome%2Fuser%2Fproject&analyze=true');
  });

  it('encodes special characters in local path', () => {
    const urlSpaces = buildDelegationUrl(7247, 'local', { localPath: '/path with spaces/dir' });
    expect(urlSpaces).toBe('http://localhost:7247/local?path=%2Fpath%20with%20spaces%2Fdir');
  });

  it('appends council to PR URL after analyze', () => {
    const url = buildDelegationUrl(7247, 'pr', { owner: 'acme', repo: 'widgets', number: 42, analyze: true, councilId: 'abc-123' });
    expect(url).toBe('http://localhost:7247/pr/acme/widgets/42?analyze=true&council=abc-123');
  });

  it('appends council to PR URL even without analyze', () => {
    const url = buildDelegationUrl(7247, 'pr', { owner: 'acme', repo: 'widgets', number: 42, councilId: 'abc-123' });
    expect(url).toBe('http://localhost:7247/pr/acme/widgets/42?council=abc-123');
  });

  it('appends council to local URL after analyze', () => {
    const url = buildDelegationUrl(7247, 'local', { localPath: '/tmp/project', analyze: true, councilId: 'abc-123' });
    expect(url).toBe('http://localhost:7247/local?path=%2Ftmp%2Fproject&analyze=true&council=abc-123');
  });

  it('appends analysisConfigId to PR URL and DROPS council when both are present', () => {
    const url = buildDelegationUrl(7247, 'pr', {
      owner: 'acme', repo: 'widgets', number: 42, analyze: true, councilId: 'abc-123', analysisConfigId: 'cfg-9'
    });
    // The id already encodes the council snapshot, so council= is omitted.
    expect(url).toBe('http://localhost:7247/pr/acme/widgets/42?analyze=true&analysisConfigId=cfg-9');
  });

  it('appends analysisConfigId to local URL and DROPS council when both are present', () => {
    const url = buildDelegationUrl(7247, 'local', {
      localPath: '/tmp/project', analyze: true, councilId: 'abc-123', analysisConfigId: 'cfg-9'
    });
    expect(url).toBe('http://localhost:7247/local?path=%2Ftmp%2Fproject&analyze=true&analysisConfigId=cfg-9');
  });

  it('url-encodes the analysisConfigId', () => {
    const url = buildDelegationUrl(7247, 'pr', {
      owner: 'acme', repo: 'widgets', number: 42, analyze: true, analysisConfigId: 'a b/c'
    });
    expect(url).toBe('http://localhost:7247/pr/acme/widgets/42?analyze=true&analysisConfigId=a%20b%2Fc');
  });

  it('appends an alt-host value as an encoded host param (FINDING C)', () => {
    const url = buildDelegationUrl(7247, 'pr', {
      owner: 'acme', repo: 'widgets', number: 42, host: 'https://althost.example/api/v3'
    });
    expect(url).toBe('http://localhost:7247/pr/acme/widgets/42?host=https%3A%2F%2Falthost.example%2Fapi%2Fv3');
  });

  it('appends the github sentinel host param', () => {
    const url = buildDelegationUrl(7247, 'pr', {
      owner: 'acme', repo: 'widgets', number: 42, host: 'github'
    });
    expect(url).toBe('http://localhost:7247/pr/acme/widgets/42?host=github');
  });

  it('omits the host param when context.host is absent', () => {
    const url = buildDelegationUrl(7247, 'pr', { owner: 'acme', repo: 'widgets', number: 42 });
    expect(url).toBe('http://localhost:7247/pr/acme/widgets/42');
  });

  it('builds server landing URL', () => {
    const url = buildDelegationUrl(7247, 'server');
    expect(url).toBe('http://localhost:7247/');
  });

  it('builds server URL for unknown mode', () => {
    const url = buildDelegationUrl(8080, 'unknown');
    expect(url).toBe('http://localhost:8080/');
  });
});

// ---------------------------------------------------------------------------
// notifyVersion
// ---------------------------------------------------------------------------

describe('notifyVersion', () => {
  it('sends POST with version in body', () => {
    const capture = {};
    const deps = createMockDeps({ httpRequest: mockHttpRequest(capture) });
    notifyVersion(7247, '3.3.0', deps);
    expect(capture.opts.method).toBe('POST');
    expect(capture.opts.port).toBe(7247);
    expect(capture.opts.path).toBe('/api/notify-update');
    expect(JSON.parse(capture.body)).toEqual({ version: '3.3.0' });
  });

  it('does not throw on request error', () => {
    const deps = createMockDeps({
      httpRequest: () => {
        const req = {
          on(event, handler) { if (event === 'error') handler(new Error('fail')); return req; },
          write() { return req; },
          end() { return req; },
          destroy() {}
        };
        return req;
      }
    });
    expect(() => notifyVersion(7247, '3.3.0', deps)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// storeAnalysisConfigRemote
// ---------------------------------------------------------------------------

describe('storeAnalysisConfigRemote', () => {
  const analysisConfig = { provider: 'claude', model: 'opus', customInstructions: 'be terse' };

  it('POSTs the analysisConfig and resolves the returned id', async () => {
    const capture = {};
    const httpRequest = mockHttpRequestWithResponse({ body: { success: true, id: 'cfg-42' } }, capture);
    const id = await storeAnalysisConfigRemote(7247, analysisConfig, { httpRequest });

    expect(id).toBe('cfg-42');
    expect(capture.opts.method).toBe('POST');
    expect(capture.opts.port).toBe(7247);
    expect(capture.opts.path).toBe('/api/bulk-analysis-configs');
    expect(JSON.parse(capture.body)).toEqual({ analysisConfig });
  });

  it('rejects with the server error message on a non-2xx status', async () => {
    const httpRequest = mockHttpRequestWithResponse({ statusCode: 400, body: { error: 'provider is required' } });
    await expect(storeAnalysisConfigRemote(7247, analysisConfig, { httpRequest }))
      .rejects.toThrow(/Failed to store analysis config on the running server: provider is required/);
  });

  it('rejects on a 2xx response with no id', async () => {
    const httpRequest = mockHttpRequestWithResponse({ statusCode: 200, body: { success: true } });
    await expect(storeAnalysisConfigRemote(7247, analysisConfig, { httpRequest }))
      .rejects.toThrow(/Failed to store analysis config/);
  });

  it('rejects on a transport error', async () => {
    const httpRequest = mockHttpRequestWithResponse({ error: new Error('ECONNRESET') });
    await expect(storeAnalysisConfigRemote(7247, analysisConfig, { httpRequest }))
      .rejects.toThrow(/Failed to reach pair-review server on port 7247: ECONNRESET/);
  });

  it('rejects on timeout', async () => {
    const httpRequest = mockHttpRequestWithResponse({ timeout: true });
    await expect(storeAnalysisConfigRemote(7247, analysisConfig, { httpRequest }))
      .rejects.toThrow(/Timed out storing analysis config/);
  });
});

// ---------------------------------------------------------------------------
// attemptDelegation
// ---------------------------------------------------------------------------

describe('attemptDelegation', () => {
  const baseConfig = { port: 7247, single_port: true };

  it('returns false when no server is running', async () => {
    const deps = createMockDeps({
      httpGet: mockHttpGetError('ECONNREFUSED')
    });
    const result = await attemptDelegation(baseConfig, {}, [], deps);
    expect(result).toBe(false);
  });

  it('throws when port is used by non-pair-review service', async () => {
    const deps = createMockDeps({
      httpGet: mockHttpGetSuccess({ status: 'ok' })
    });
    await expect(attemptDelegation(baseConfig, {}, [], deps))
      .rejects.toThrow('Port 7247 is in use by another service');
  });

  it('delegates PR mode and opens browser', async () => {
    const deps = createMockDeps();
    const prArgs = ['https://github.com/acme/widgets/pull/99'];
    const result = await attemptDelegation(
      baseConfig,
      { ai: false },
      prArgs,
      deps
    );
    expect(result).toBe(true);
    // Verify prArgs were forwarded verbatim to PRArgumentParser (guards against
    // production code accidentally passing an empty array or dropping the args).
    expect(deps.PRArgumentParser.lastArgs).toEqual(prArgs);
    expect(deps.open).toHaveBeenCalledWith(
      expect.stringContaining('/pr/test-owner/test-repo/')
    );
  });

  it('delegates local mode and opens browser', async () => {
    const deps = createMockDeps();
    const result = await attemptDelegation(
      baseConfig,
      { local: true, localPath: '/tmp/project' },
      [],
      deps
    );
    expect(result).toBe(true);
    expect(deps.open).toHaveBeenCalledWith(
      expect.stringContaining('/local?path=')
    );
  });

  it('rejects URL input for local mode before opening browser', async () => {
    const deps = createMockDeps();
    await expect(attemptDelegation(
      baseConfig,
      { local: true, localPath: 'https://github.com/owner/repo/pull/123' },
      [],
      deps
    )).rejects.toThrow('filesystem path');
    expect(deps.open).not.toHaveBeenCalled();
  });

  it('delegates server-only mode and opens browser', async () => {
    const deps = createMockDeps();
    const result = await attemptDelegation(baseConfig, {}, [], deps);
    expect(result).toBe(true);
    expect(deps.open).toHaveBeenCalledWith('http://localhost:7247/');
  });

  it('threads an alt host into the delegated PR URL (FINDING C)', async () => {
    class AltParser {
      async parsePRArguments() {
        return { owner: 'acme', repo: 'widgets', number: 42, host: 'https://alt.example/api/v3', bindingRepository: 'acme/widgets' };
      }
    }
    const deps = createMockDeps({ PRArgumentParser: AltParser });
    const config = { port: 7247, single_port: true, repos: { 'acme/widgets': { api_host: 'https://alt.example/api/v3', exclusive: false, token: 't' } } };
    await attemptDelegation(config, {}, ['https://alt.example/acme/widgets/pull/42'], deps);
    expect(deps.open).toHaveBeenCalledWith(expect.stringContaining('host=https%3A%2F%2Falt.example%2Fapi%2Fv3'));
  });

  it('threads the github sentinel for a dual repo opened via a github URL', async () => {
    class GithubDualParser {
      async parsePRArguments() { return { owner: 'acme', repo: 'widgets', number: 42, host: null }; }
    }
    const deps = createMockDeps({ PRArgumentParser: GithubDualParser });
    const config = { port: 7247, single_port: true, repos: { 'acme/widgets': { api_host: 'https://alt.example/api/v3', exclusive: false, token: 't' } } };
    await attemptDelegation(config, {}, ['https://github.com/acme/widgets/pull/42'], deps);
    expect(deps.open).toHaveBeenCalledWith(expect.stringContaining('host=github'));
  });

  it('omits the host param for a plain github repo', async () => {
    class PlainParser {
      async parsePRArguments() { return { owner: 'a', repo: 'b', number: 1, host: null }; }
    }
    const deps = createMockDeps({ PRArgumentParser: PlainParser });
    const config = { port: 7247, single_port: true, repos: {} };
    await attemptDelegation(config, {}, ['https://github.com/a/b/pull/1'], deps);
    expect(deps.open.mock.calls[0][0]).not.toContain('host=');
  });

  it('appends ?analyze=true when flags.ai is set for PR mode', async () => {
    const deps = createMockDeps();
    await attemptDelegation(baseConfig, { ai: true }, ['42'], deps);
    expect(deps.open).toHaveBeenCalledWith(
      expect.stringContaining('?analyze=true')
    );
  });

  it('appends analyze param when flags.ai is set for local mode', async () => {
    const deps = createMockDeps();
    await attemptDelegation(
      baseConfig,
      { local: true, localPath: '/tmp', ai: true },
      [],
      deps
    );
    expect(deps.open).toHaveBeenCalledWith(
      expect.stringContaining('&analyze=true')
    );
  });

  it('appends council to PR delegation URL when a resolved councilId is provided', async () => {
    const deps = createMockDeps();
    await attemptDelegation(baseConfig, { council: 'my-council' }, ['42'], deps, { councilId: 'abc-123' });
    expect(deps.open).toHaveBeenCalledWith(
      expect.stringContaining('/pr/test-owner/test-repo/42?analyze=true&council=abc-123')
    );
  });

  it('appends council to local delegation URL when a resolved councilId is provided', async () => {
    const deps = createMockDeps();
    await attemptDelegation(
      baseConfig,
      { local: true, localPath: '/tmp/project', council: 'my-council' },
      [],
      deps,
      { councilId: 'abc-123' }
    );
    const url = deps.open.mock.calls[0][0];
    expect(url).toContain('&analyze=true');
    expect(url).toContain('&council=abc-123');
  });

  it('treats flags.council as implying analyze=true even without flags.ai', async () => {
    const deps = createMockDeps();
    await attemptDelegation(baseConfig, { council: 'my-council' }, ['42'], deps, { councilId: 'abc-123' });
    expect(deps.open).toHaveBeenCalledWith(expect.stringContaining('analyze=true'));
  });

  it('does not append council when no councilId is resolved', async () => {
    const deps = createMockDeps();
    await attemptDelegation(baseConfig, { ai: true }, ['42'], deps);
    expect(deps.open).toHaveBeenCalledWith(expect.not.stringContaining('council='));
  });

  it('notifies version when current is newer than running server', async () => {
    const capture = {};
    const deps = createMockDeps({
      httpGet: mockHttpGetSuccess({ status: 'ok', service: 'pair-review', version: '1.0.0' }),
      httpRequest: mockHttpRequest(capture)
    });
    await attemptDelegation(baseConfig, {}, [], deps);
    expect(capture.body).toBeDefined();
    const body = JSON.parse(capture.body);
    // Should contain the current package.json version
    expect(body.version).toBeDefined();
  });

  it('does not notify version when current equals running server', async () => {
    const capture = {};
    // Use the actual package.json version so they match
    const { version } = require('../../package.json');
    const deps = createMockDeps({
      httpGet: mockHttpGetSuccess({ status: 'ok', service: 'pair-review', version }),
      httpRequest: mockHttpRequest(capture)
    });
    await attemptDelegation(baseConfig, {}, [], deps);
    expect(capture.body).toBeUndefined();
  });

  // ── Instruction handoff across delegation (Bug: --instructions silently
  //    dropped when a server is already running). When an analyzing mode carries
  //    instructions and an open DB is supplied, the resolved analysis config is
  //    POSTed to the running server and its id is threaded as analysisConfigId.
  describe('analysis-config handoff', () => {
    // Match the running version so notifyVersion never fires — keeps the single
    // captured httpRequest call the bulk-config POST.
    const { version } = require('../../package.json');
    const STORED = { provider: 'claude', model: 'opus', customInstructions: 'be terse' };

    function handoffDeps({ capture = {}, buildResult = STORED, httpRequestOpts = { body: { success: true, id: 'cfg-77' } } } = {}) {
      return createMockDeps({
        httpGet: mockHttpGetSuccess({ status: 'ok', service: 'pair-review', version }),
        httpRequest: mockHttpRequestWithResponse(httpRequestOpts, capture),
        buildInteractiveAnalysisConfig: vi.fn().mockResolvedValue(buildResult)
      });
    }

    it('PR mode: builds with the normalized repo, POSTs, and threads analysisConfigId (no council)', async () => {
      const capture = {};
      const deps = handoffDeps({ capture });
      await attemptDelegation(
        baseConfig,
        { ai: true, instructions: 'be terse' },
        ['42'],
        deps,
        { db: {}, councilId: 'abc-123' }
      );

      // Builder received the resolved (normalized) PR repository + same db/flags.
      expect(deps.buildInteractiveAnalysisConfig).toHaveBeenCalledTimes(1);
      const buildArgs = deps.buildInteractiveAnalysisConfig.mock.calls[0][0];
      expect(buildArgs.repository).toBe('test-owner/test-repo');
      expect(buildArgs.db).toEqual({});

      // The config was POSTed.
      expect(capture.opts.path).toBe('/api/bulk-analysis-configs');
      expect(JSON.parse(capture.body)).toEqual({ analysisConfig: STORED });

      // URL carries the stored id and DROPS council (the id encodes everything).
      const url = deps.open.mock.calls[0][0];
      expect(url).toContain('analysisConfigId=cfg-77');
      expect(url).not.toContain('council=');
    });

    it('local mode: builds with options.localRepository', async () => {
      const deps = handoffDeps();
      await attemptDelegation(
        baseConfig,
        { local: true, localPath: '/tmp/project', ai: true, instructions: 'be terse' },
        [],
        deps,
        { db: {}, localRepository: 'acme/local-repo' }
      );

      const buildArgs = deps.buildInteractiveAnalysisConfig.mock.calls[0][0];
      expect(buildArgs.repository).toBe('acme/local-repo');
      const url = deps.open.mock.calls[0][0];
      expect(url).toContain('analysisConfigId=cfg-77');
    });

    it('no instructions (builder returns null): no POST, falls back to council param', async () => {
      const capture = {};
      const deps = handoffDeps({ capture, buildResult: null });
      await attemptDelegation(
        baseConfig,
        { council: 'my-council' },
        ['42'],
        deps,
        { db: {}, councilId: 'abc-123' }
      );

      expect(deps.buildInteractiveAnalysisConfig).toHaveBeenCalledTimes(1);
      // No bulk-config POST happened.
      expect(capture.opts).toBeUndefined();
      const url = deps.open.mock.calls[0][0];
      expect(url).toContain('council=abc-123');
      expect(url).not.toContain('analysisConfigId=');
    });

    it('skips the handoff entirely when no db is supplied (gate)', async () => {
      const deps = handoffDeps();
      await attemptDelegation(
        baseConfig,
        { ai: true, instructions: 'be terse' },
        ['42'],
        deps,
        { councilId: 'abc-123' } // no db
      );
      expect(deps.buildInteractiveAnalysisConfig).not.toHaveBeenCalled();
      const url = deps.open.mock.calls[0][0];
      expect(url).not.toContain('analysisConfigId=');
    });

    it('throws (loud-fail) and does not open a browser when the POST fails', async () => {
      const deps = handoffDeps({ httpRequestOpts: { error: new Error('ECONNRESET') } });
      await expect(attemptDelegation(
        baseConfig,
        { ai: true, instructions: 'be terse' },
        ['42'],
        deps,
        { db: {} }
      )).rejects.toThrow(/Failed to reach pair-review server/);
      expect(deps.open).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// HEALTH_TIMEOUT_MS
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('exports HEALTH_TIMEOUT_MS', () => {
    expect(HEALTH_TIMEOUT_MS).toBe(2000);
  });
});
