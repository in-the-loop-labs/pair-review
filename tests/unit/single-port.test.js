// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  detectRunningServer,
  notifyVersion,
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

function createMockDeps(overrides = {}) {
  return {
    httpGet: mockHttpGetSuccess({ status: 'ok', service: 'pair-review', version: '3.2.0' }),
    httpRequest: mockHttpRequest(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    open: vi.fn().mockResolvedValue(undefined),
    PRArgumentParser: class {
      async parsePRArguments(args) {
        return { owner: 'test-owner', repo: 'test-repo', number: parseInt(args[0]) || 42 };
      }
    },
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
    const url = buildDelegationUrl(7247, 'local', { localPath: '/path with spaces/dir' });
    expect(url).toContain(encodeURIComponent('/path with spaces/dir'));
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
    const result = await attemptDelegation(
      baseConfig,
      { ai: false },
      ['https://github.com/acme/widgets/pull/99'],
      deps
    );
    expect(result).toBe(true);
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

  it('delegates server-only mode and opens browser', async () => {
    const deps = createMockDeps();
    const result = await attemptDelegation(baseConfig, {}, [], deps);
    expect(result).toBe(true);
    expect(deps.open).toHaveBeenCalledWith('http://localhost:7247/');
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
});

// ---------------------------------------------------------------------------
// HEALTH_TIMEOUT_MS
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('exports HEALTH_TIMEOUT_MS', () => {
    expect(HEALTH_TIMEOUT_MS).toBe(2000);
  });
});
