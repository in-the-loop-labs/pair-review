// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from 'vitest';

const fs = require('fs');
const path = require('path');

const {
  STALE_REASONS,
  PR_HEAD_CHECK_TIMEOUT_MS,
  PR_HEAD_TIMEOUT_ERROR,
  buildStaleReasons,
  describeGitHubError,
  fetchRemotePRHead,
  checkPRHeadState,
  withoutTokenRefresh,
} = require('../../src/providers/stale-check');

const { PRMetadataRepository } = require('../../src/database');
// The real error type `GitHubClient.handleApiError` throws — tests here drive
// it rather than a hand-shaped stand-in the producer cannot emit.
const { GitHubApiError } = require('../../src/github/errors');

/** Silence the provider's own logging without touching the real logger. */
const quietLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };

/**
 * A GitHubClient stand-in. `constructed` records every credential the provider
 * bound, so tests can assert the credential is passed through unchanged.
 */
function makeClientStub(impl) {
  const constructed = [];
  const fetchPullRequest = vi.fn(impl);
  class Stub {
    constructor(credential) {
      constructed.push(credential);
      this.fetchPullRequest = fetchPullRequest;
    }
  }
  return { Stub, constructed, fetchPullRequest };
}

const PR_OK = {
  number: 7,
  head_sha: 'remote-head',
  base_sha: 'remote-base',
  state: 'open',
  merged: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  quietLogger.debug.mockClear();
  quietLogger.warn.mockClear();
});

describe('STALE_REASONS', () => {
  it('is frozen and covers every code the two routes flag', () => {
    expect(Object.isFrozen(STALE_REASONS)).toBe(true);
    expect(Object.keys(STALE_REASONS)).toEqual([
      'working-tree-changed',
      'local-head-moved',
      'no-baseline-digest',
      'digest-unavailable',
      'head-sha-unavailable',
      'pr-head-moved',
      'local-head-differs-from-pr',
      'pr-closed',
      'pr-merged',
    ]);
  });

  it('carries no commit SHAs — the frontend abbreviates those itself', () => {
    for (const message of Object.values(STALE_REASONS)) {
      expect(message).not.toMatch(/[0-9a-f]{7,}/);
    }
  });
});

describe('buildStaleReasons', () => {
  it('returns an empty array for missing / non-object flags', () => {
    expect(buildStaleReasons()).toEqual([]);
    expect(buildStaleReasons(null)).toEqual([]);
    expect(buildStaleReasons('nope')).toEqual([]);
    expect(buildStaleReasons(42)).toEqual([]);
  });

  it('returns an empty array when every flag is false', () => {
    expect(buildStaleReasons({ 'working-tree-changed': false, 'pr-merged': false })).toEqual([]);
  });

  it('emits {code, message} pairs using the canonical message', () => {
    expect(buildStaleReasons({ 'working-tree-changed': true })).toEqual([
      { code: 'working-tree-changed', message: STALE_REASONS['working-tree-changed'] },
    ]);
  });

  it('orders by STALE_REASONS declaration order, not flag insertion order', () => {
    const reasons = buildStaleReasons({
      'pr-merged': true,
      'working-tree-changed': true,
      'pr-head-moved': true,
      'local-head-moved': true,
    });
    expect(reasons.map((r) => r.code)).toEqual([
      'working-tree-changed',
      'local-head-moved',
      'pr-head-moved',
      'pr-merged',
    ]);
  });

  it('is deterministic across calls with differently-ordered flag objects', () => {
    const a = buildStaleReasons({ 'pr-closed': true, 'digest-unavailable': true });
    const b = buildStaleReasons({ 'digest-unavailable': true, 'pr-closed': true });
    expect(a).toEqual(b);
  });

  it('ignores unknown keys rather than inventing a message for them', () => {
    expect(buildStaleReasons({ 'not-a-real-code': true })).toEqual([]);
    expect(buildStaleReasons({ 'not-a-real-code': true, 'pr-merged': true }).map((r) => r.code))
      .toEqual(['pr-merged']);
  });

  it('treats any truthy value as set (routes pass raw comparisons through)', () => {
    expect(buildStaleReasons({ 'pr-merged': 1 }).map((r) => r.code)).toEqual(['pr-merged']);
  });
});

describe('describeGitHubError', () => {
  it('maps 404 to a not-found message', () => {
    expect(describeGitHubError({ status: 404, message: 'raw' })).toBe('PR not found on GitHub');
  });

  it('maps 401 and 403 to an auth message', () => {
    expect(describeGitHubError({ status: 401, message: 'raw' })).toBe('GitHub authentication issue');
    expect(describeGitHubError({ status: 403, message: 'raw' })).toBe('GitHub authentication issue');
  });

  it('maps connection error codes to a connectivity message', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT']) {
      expect(describeGitHubError({ code, message: 'raw' })).toBe('Could not connect to GitHub');
    }
  });

  // The `.code` cases above are a secondary guard for callers passing a raw
  // socket error. THIS is what the only real producer emits: GitHubClient
  // funnels every failure through `handleApiError`, which normalises to a
  // `GitHubApiError` carrying `name`, `message` and `status` — and never
  // `.code`. Driving the synthetic shape alone passed vacuously while the two
  // commonest transient failures shipped raw internals to the user.
  it('maps the GitHubApiError shapes the client actually throws', () => {
    const offline = new GitHubApiError(
      'Network error: getaddrinfo ENOTFOUND api.github.com. Please check your internet connection.',
      503
    );
    expect(offline.code).toBeUndefined();
    expect(describeGitHubError(offline)).toBe('Could not connect to GitHub');

    // The raw message here promises a retry that this fail-open path never
    // performs, which is why it must not reach the user.
    const limited = new GitHubApiError('GitHub API rate limit exceeded. Retrying in 3600 seconds...', 429);
    expect(describeGitHubError(limited)).toBe('GitHub API rate limit exceeded. Please try again later.');
  });

  it('falls back to the raw message for anything else', () => {
    expect(describeGitHubError(new Error('boom'))).toBe('boom');
    expect(describeGitHubError({ status: 500, message: 'server exploded' })).toBe('server exploded');
  });

  it('never returns undefined for a missing error', () => {
    expect(describeGitHubError(null)).toBe('Unknown GitHub error');
    expect(describeGitHubError(undefined)).toBe('Unknown GitHub error');
  });

  it('never returns undefined for a thrown value that is not Error-like', () => {
    // `JSON.stringify` DROPS undefined-valued keys, so an undefined return
    // deleted the `error` key from PR mode's fail-open response entirely.
    for (const thrown of [{}, { status: 500 }, 'a string', 42, true]) {
      const described = describeGitHubError(thrown);
      expect(typeof described, JSON.stringify(thrown)).toBe('string');
      expect(described.length).toBeGreaterThan(0);
    }
    expect(describeGitHubError({})).toBe('Unknown GitHub error');
  });
});

describe('fetchRemotePRHead', () => {
  it('returns the normalized head/base/state/merged on success', async () => {
    const { Stub, constructed, fetchPullRequest } = makeClientStub(async () => PR_OK);

    const result = await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' },
      { GitHubClient: Stub, logger: quietLogger }
    );

    expect(result).toEqual({
      ok: true,
      headSha: 'remote-head',
      baseSha: 'remote-base',
      state: 'open',
      merged: false,
    });
    expect(constructed).toEqual(['tok']);
    expect(fetchPullRequest).toHaveBeenCalledWith('o', 'r', 7, expect.any(Object));
  });

  it('strips the token-refresh closure before constructing the client', async () => {
    // `GitHubClient` calls `binding.refresh()` after a 401, and for a
    // `token_command` binding that closure runs `execSync` — a synchronous
    // block no deadline can preempt, on an advisory path the browser abandons
    // at 2000ms. Resolving `cachedTokensOnly` does not prevent it: the closure
    // rides on the CACHED binding and deliberately does not inherit the flag.
    const refresh = vi.fn(() => 'fresh-token');
    const binding = {
      apiHost: 'https://ghe.example/api/v3',
      host: 'https://ghe.example/api/v3',
      token: 'ghe-tok',
      features: { graphql: true },
      source: 'repo:token_command',
      refresh,
    };
    const { Stub, constructed } = makeClientStub(async () => PR_OK);

    await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: binding },
      { GitHubClient: Stub, logger: quietLogger }
    );

    expect(constructed[0].refresh).toBeNull();
    // ...and everything the client actually needs is still there.
    expect(constructed[0]).toMatchObject({
      apiHost: 'https://ghe.example/api/v3',
      host: 'https://ghe.example/api/v3',
      token: 'ghe-tok',
      features: { graphql: true },
    });
    // The caller's binding is shared with other request paths that DO want the
    // refresh, so it must not be mutated.
    expect(binding.refresh).toBe(refresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('passes a host binding through to GitHubClient unchanged', async () => {
    const binding = { apiHost: 'https://ghe.example/api/v3', host: 'https://ghe.example/api/v3', token: 'ghe-tok' };
    const { Stub, constructed } = makeClientStub(async () => PR_OK);

    await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: binding },
      { GitHubClient: Stub, logger: quietLogger }
    );

    expect(constructed).toEqual([binding]);
  });

  it('normalizes a merged PR', async () => {
    const { Stub } = makeClientStub(async () => ({ ...PR_OK, state: 'closed', merged: true }));
    const result = await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' },
      { GitHubClient: Stub, logger: quietLogger }
    );
    expect(result).toMatchObject({ ok: true, state: 'closed', merged: true });
  });

  it('refuses without a credential and never constructs a client', async () => {
    const { Stub, constructed } = makeClientStub(async () => PR_OK);

    const result = await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: '' },
      { GitHubClient: Stub, logger: quietLogger }
    );

    expect(result).toEqual({ ok: false, error: 'GitHub token not configured' });
    expect(constructed).toEqual([]);
  });

  it('rejects an unusable target without calling GitHub', async () => {
    const { Stub, constructed } = makeClientStub(async () => PR_OK);
    const deps = { GitHubClient: Stub, logger: quietLogger };

    for (const params of [
      { owner: '', repo: 'r', prNumber: 7, credential: 'tok' },
      { owner: 'o', repo: '', prNumber: 7, credential: 'tok' },
      { owner: 'o', repo: 'r', prNumber: '7', credential: 'tok' },
      { owner: 'o', repo: 'r', prNumber: 0, credential: 'tok' },
    ]) {
      expect(await fetchRemotePRHead(params, deps)).toEqual({
        ok: false,
        error: 'Invalid pull request target',
      });
    }
    expect(constructed).toEqual([]);
  });

  it('maps a 404 through describeGitHubError instead of throwing', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    const { Stub } = makeClientStub(async () => { throw err; });

    const result = await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' },
      { GitHubClient: Stub, logger: quietLogger }
    );

    expect(result).toEqual({ ok: false, error: 'PR not found on GitHub' });
  });

  it('maps a 401 through describeGitHubError', async () => {
    const err = Object.assign(new Error('Bad credentials'), { status: 401 });
    const { Stub } = makeClientStub(async () => { throw err; });

    expect(await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' },
      { GitHubClient: Stub, logger: quietLogger }
    )).toEqual({ ok: false, error: 'GitHub authentication issue' });
  });

  it('maps a network error through describeGitHubError', async () => {
    const err = Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' });
    const { Stub } = makeClientStub(async () => { throw err; });

    expect(await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' },
      { GitHubClient: Stub, logger: quietLogger }
    )).toEqual({ ok: false, error: 'Could not connect to GitHub' });
  });

  it('treats a null PR payload as not found rather than throwing', async () => {
    const { Stub } = makeClientStub(async () => null);
    expect(await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' },
      { GitHubClient: Stub, logger: quietLogger }
    )).toEqual({ ok: false, error: 'PR not found on GitHub' });
  });

  it('survives a synchronous throw from the client constructor', async () => {
    class Exploding {
      constructor() { throw new Error('bad binding'); }
    }
    expect(await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' },
      { GitHubClient: Exploding, logger: quietLogger }
    )).toEqual({ ok: false, error: 'bad binding' });
  });

  it('tolerates being called with no arguments at all', async () => {
    expect(await fetchRemotePRHead()).toEqual({ ok: false, error: 'Invalid pull request target' });
  });
});

describe('checkPRHeadState', () => {
  const target = { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' };

  it('reports prAdvanced when the remote head differs from the known (cached) head', async () => {
    const { Stub } = makeClientStub(async () => PR_OK);

    const state = await checkPRHeadState(
      { ...target, knownHeadSha: 'stale-cached-head' },
      { GitHubClient: Stub, logger: quietLogger }
    );

    expect(state).toEqual({
      checked: true,
      remoteHeadSha: 'remote-head',
      cachedHeadSha: 'stale-cached-head',
      prAdvanced: true,
      prState: 'open',
      merged: false,
      error: null,
    });
  });

  it('reports prAdvanced false when remote and cached agree', async () => {
    const { Stub } = makeClientStub(async () => PR_OK);
    const state = await checkPRHeadState(
      { ...target, knownHeadSha: 'remote-head' },
      { GitHubClient: Stub, logger: quietLogger }
    );
    expect(state.prAdvanced).toBe(false);
  });

  it('reports prAdvanced false when the cached head is unknown — absence is not movement', async () => {
    const { Stub } = makeClientStub(async () => PR_OK);
    const state = await checkPRHeadState(target, { GitHubClient: Stub, logger: quietLogger });
    expect(state.cachedHeadSha).toBeNull();
    expect(state.prAdvanced).toBe(false);
  });

  it('surfaces a fetch failure as checked:true with an error and null remote head', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    const { Stub } = makeClientStub(async () => { throw err; });

    const state = await checkPRHeadState(
      { ...target, knownHeadSha: 'cached' },
      { GitHubClient: Stub, logger: quietLogger }
    );

    expect(state).toEqual({
      checked: true,
      remoteHeadSha: null,
      cachedHeadSha: 'cached',
      prAdvanced: false,
      prState: null,
      merged: false,
      error: 'PR not found on GitHub',
    });
  });

  it('surfaces a missing credential without contacting GitHub', async () => {
    const { Stub, constructed } = makeClientStub(async () => PR_OK);
    const state = await checkPRHeadState(
      { ...target, credential: null },
      { GitHubClient: Stub, logger: quietLogger }
    );
    expect(state.error).toBe('GitHub token not configured');
    expect(state.checked).toBe(true);
    expect(constructed).toEqual([]);
  });

  /**
   * The invariant lives in TWO files at once: the provider's server-side
   * deadline must stay meaningfully under the browser's abort. Asserting
   * against a hardcoded 2000 pinned only half of it — lowering STALE_TIMEOUT in
   * public/js/pr.js would leave this suite green while the feature broke, since
   * the client would start aborting check-stale before the server answered and
   * local mode would lose its working-directory answer to an advisory extra.
   *
   * So read the real declaration out of the browser file. (Other suites reach
   * into public/js the same way — local-stale-badge.test.js defines
   * `global.STALE_TIMEOUT` before requiring local.js, because pr.js's `const`
   * is module-scoped and cannot be imported.)
   */
  const PR_JS_PATH = path.resolve(__dirname, '../../public/js/pr.js');
  const REQUIRED_HEADROOM_MS = 500;

  it('keeps the deadline meaningfully under the client abort declared in public/js/pr.js', () => {
    const source = fs.readFileSync(PR_JS_PATH, 'utf8');
    const match = source.match(/^\s*const\s+STALE_TIMEOUT\s*=\s*(\d+)\s*;/m);

    expect(
      match,
      `Could not find "const STALE_TIMEOUT = <ms>;" in ${PR_JS_PATH}. `
      + 'src/providers/stale-check.js sizes PR_HEAD_CHECK_TIMEOUT_MS against that value; '
      + 'if the declaration moved or was renamed, update this test so the cross-file '
      + 'invariant stays pinned rather than silently unpinned.'
    ).toBeTruthy();

    const clientAbortMs = Number(match[1]);
    expect(Number.isFinite(clientAbortMs) && clientAbortMs > 0).toBe(true);

    expect(
      PR_HEAD_CHECK_TIMEOUT_MS <= clientAbortMs - REQUIRED_HEADROOM_MS,
      `PR_HEAD_CHECK_TIMEOUT_MS is ${PR_HEAD_CHECK_TIMEOUT_MS}ms (src/providers/stale-check.js) but `
      + `STALE_TIMEOUT is ${clientAbortMs}ms (public/js/pr.js). The browser aborts the check-stale `
      + `request at STALE_TIMEOUT, so the server deadline must stay at least ${REQUIRED_HEADROOM_MS}ms `
      + 'below it (headroom for the concurrent local git work and response serialisation). '
      + 'Change one of these two files and you must change the other.'
    ).toBe(true);
  });

  it('pins the shipped default deadline', () => {
    expect(PR_HEAD_CHECK_TIMEOUT_MS).toBe(1200);
  });

  it('gives up at the deadline when GitHub never answers', async () => {
    // A hung fetch, elapsed with fake timers — never a real sleep
    // (tests/CONVENTIONS.md). `finally` restores real timers even on failure.
    const { Stub } = makeClientStub(() => new Promise(() => {}));
    try {
      vi.useFakeTimers();
      const pending = checkPRHeadState(
        { ...target, knownHeadSha: 'cached' },
        { GitHubClient: Stub, logger: quietLogger }
      );
      await vi.advanceTimersByTimeAsync(PR_HEAD_CHECK_TIMEOUT_MS + 1);
      const state = await pending;

      expect(state).toEqual({
        checked: true,
        remoteHeadSha: null,
        cachedHeadSha: 'cached',
        prAdvanced: false,
        prState: null,
        merged: false,
        error: PR_HEAD_TIMEOUT_ERROR,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours an injected deadline via _deps.prHeadTimeoutMs', async () => {
    const { Stub } = makeClientStub(() => new Promise(() => {}));
    try {
      vi.useFakeTimers();
      const pending = checkPRHeadState(
        target,
        { GitHubClient: Stub, logger: quietLogger, prHeadTimeoutMs: 25 }
      );
      await vi.advanceTimersByTimeAsync(26);
      expect((await pending).error).toBe(PR_HEAD_TIMEOUT_ERROR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the constant when a dep override is present but not a number', async () => {
    // `{ ...defaults, ..._deps }` lets an EXPLICIT undefined overwrite the
    // default, and `setTimeout(fn, undefined)` is a ZERO-ms deadline — the race
    // would be lost before the fetch ever got a turn, so every call reported
    // "PR head check timed out" without contacting GitHub at all.
    //
    // A fetch that answers on a timer (not in a microtask) is what makes the
    // difference observable: at 0ms the deadline wins, at 1200ms the fetch does.
    for (const bad of [undefined, null, NaN, 'soon']) {
      const { Stub } = makeClientStub(
        () => new Promise((resolve) => setTimeout(() => resolve(PR_OK), 100))
      );
      try {
        vi.useFakeTimers();
        const pending = checkPRHeadState(
          { ...target, knownHeadSha: 'cached' },
          { GitHubClient: Stub, logger: quietLogger, prHeadTimeoutMs: bad }
        );
        await vi.advanceTimersByTimeAsync(100);
        const state = await pending;

        expect(state.error, `prHeadTimeoutMs: ${String(bad)}`).toBeNull();
        expect(state.remoteHeadSha).toBe('remote-head');
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('ignores a non-numeric per-call timeoutMs too', async () => {
    // Same shape as the `_deps` twin above, and for the same reason: a stub
    // that resolves in a MICROTASK beats `setTimeout(fn, undefined)` — a 0ms
    // macrotask — every time, so it would pass with or without the finiteness
    // guard. A fetch that answers on a timer is what makes the bug observable.
    for (const bad of [undefined, null, NaN, 'soon']) {
      const { Stub } = makeClientStub(
        () => new Promise((resolve) => setTimeout(() => resolve(PR_OK), 100))
      );
      try {
        vi.useFakeTimers();
        const pending = checkPRHeadState(
          { ...target, knownHeadSha: 'cached', timeoutMs: bad },
          { GitHubClient: Stub, logger: quietLogger }
        );
        await vi.advanceTimersByTimeAsync(100);
        const state = await pending;

        expect(state.error, `timeoutMs: ${String(bad)}`).toBeNull();
        expect(state.remoteHeadSha).toBe('remote-head');
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('ABORTS the losing fetch rather than leaving it in flight', async () => {
    // `Promise.race` stops the waiting, not the request. Without a signal the
    // abandoned HTTP call — plus any retry Octokit performs internally — stays
    // open with its result discarded, and this check now fires on every local
    // page load AND after every refresh.
    let observed = null;
    const { Stub } = makeClientStub((owner, repo, prNumber, options) => {
      observed = options && options.signal;
      return new Promise(() => {});
    });
    try {
      vi.useFakeTimers();
      const pending = checkPRHeadState(
        { ...target, timeoutMs: 25 },
        { GitHubClient: Stub, logger: quietLogger }
      );
      await vi.advanceTimersByTimeAsync(26);
      expect((await pending).error).toBe(PR_HEAD_TIMEOUT_ERROR);
    } finally {
      vi.useRealTimers();
    }

    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed.aborted).toBe(true);
  });

  it('does not leave a signal aborted-looking for a fetch that won', async () => {
    // The abort fires in `finally` either way; a request that already answered
    // is unaffected, and the caller still gets its result.
    const { Stub } = makeClientStub(async () => PR_OK);
    const state = await checkPRHeadState({ ...target, timeoutMs: 5000 }, { GitHubClient: Stub, logger: quietLogger });
    expect(state.error).toBeNull();
    expect(state.remoteHeadSha).toBe('remote-head');
  });

  it('honours a per-call timeoutMs over the dependency default', async () => {
    const { Stub } = makeClientStub(() => new Promise(() => {}));
    try {
      vi.useFakeTimers();
      const pending = checkPRHeadState(
        { ...target, timeoutMs: 10 },
        { GitHubClient: Stub, logger: quietLogger, prHeadTimeoutMs: 999999 }
      );
      await vi.advanceTimersByTimeAsync(11);
      expect((await pending).error).toBe(PR_HEAD_TIMEOUT_ERROR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a fetch that answers before the deadline', async () => {
    const { Stub } = makeClientStub(async () => PR_OK);
    const state = await checkPRHeadState(
      { ...target, timeoutMs: 60000 },
      { GitHubClient: Stub, logger: quietLogger }
    );
    expect(state.error).toBeNull();
    expect(state.remoteHeadSha).toBe('remote-head');
  });
});

/**
 * HAZARD 1. `fetchPRMetadata` (providers/pr-context.js) is the tempting reuse
 * here, but it WRITES THROUGH to `pr_metadata` — and that cache holds the
 * `knownHeadSha` this very check compares against. A check that refreshed the
 * cache would report "not stale" on every call after the first, silently
 * destroying PR mode's stale detection. The provider must observe only.
 */
describe('the check never writes to pr_metadata (Hazard 1)', () => {
  it('constructs no PRMetadataRepository and calls no upsert during a check', async () => {
    const upsert = vi.spyOn(PRMetadataRepository.prototype, 'upsertPRMetadata')
      .mockResolvedValue(undefined);
    const getByPR = vi.spyOn(PRMetadataRepository.prototype, 'getByPR')
      .mockResolvedValue(null);
    const { Stub } = makeClientStub(async () => PR_OK);

    await checkPRHeadState(
      { owner: 'o', repo: 'r', prNumber: 7, knownHeadSha: 'cached', credential: 'tok' },
      { GitHubClient: Stub, logger: quietLogger }
    );
    await fetchRemotePRHead(
      { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' },
      { GitHubClient: Stub, logger: quietLogger }
    );

    expect(upsert).not.toHaveBeenCalled();
    expect(getByPR).not.toHaveBeenCalled();
  });

  it('exports no cache-writing surface at all', () => {
    const surface = require('../../src/providers/stale-check');
    expect(Object.keys(surface).sort()).toEqual([
      'PR_HEAD_CHECK_TIMEOUT_MS',
      'PR_HEAD_TIMEOUT_ERROR',
      'STALE_REASONS',
      'buildStaleReasons',
      'checkPRHeadState',
      'describeGitHubError',
      'fetchRemotePRHead',
      'withoutTokenRefresh',
    ]);
  });
});

describe('withoutTokenRefresh', () => {
  it('returns a copy with refresh nulled, leaving the original alone', () => {
    const refresh = () => 'tok';
    const binding = { token: 't', host: 'h', apiHost: 'a', features: { x: 1 }, refresh };

    const stripped = withoutTokenRefresh(binding);

    expect(stripped).not.toBe(binding);
    expect(stripped.refresh).toBeNull();
    expect(stripped).toMatchObject({ token: 't', host: 'h', apiHost: 'a', features: { x: 1 } });
    expect(binding.refresh).toBe(refresh);
  });

  it('returns non-refreshable credentials as they are', () => {
    const bare = { token: 't', refresh: null };
    expect(withoutTokenRefresh(bare)).toBe(bare);
    expect(withoutTokenRefresh('bare-token')).toBe('bare-token');
    expect(withoutTokenRefresh(null)).toBeNull();
    expect(withoutTokenRefresh(undefined)).toBeUndefined();
  });
});
