// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for the token-resolution ordering in src/main.js.
 *
 * Bug history: `handlePullRequest` used to call `getGitHubToken(config)`
 * BEFORE parsing PR arguments, so the no-repository lookup only saw
 * environment + top-level credentials. That rejected configs whose only
 * GitHub token lived under `repos["owner/repo"].token` (or `.token_command`,
 * or behind an alt-host `api_host`). `performHeadlessReview` already used
 * the safer ordering — these tests pin the fix in `handlePullRequest`.
 *
 * We use source-level assertions for the ordering invariant (matching the
 * `route-bindings.test.js` pattern) plus runtime checks against the real
 * `resolveHostBinding()` to prove the repo-scoped-only config actually
 * resolves a token.
 */
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const { resolveHostBinding } = require('../../src/config');
const { setupHostParam, resolvePreflightBinding } = require('../../src/utils/host-resolution');
const { resolveCliBindingRepository } = require('../../src/main');

function readMainSource() {
  return fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf-8');
}

describe('main.js — handlePullRequest token-resolution ordering', () => {
  it('parses PR arguments BEFORE resolving the token (so repo context drives binding)', () => {
    const src = readMainSource();
    const fnStart = src.indexOf('async function handlePullRequest(');
    expect(fnStart).toBeGreaterThan(-1);

    // Find the end of handlePullRequest by walking to the next top-level
    // `async function` declaration.
    const nextFnStart = src.indexOf('\nasync function ', fnStart + 1);
    const body = src.slice(fnStart, nextFnStart === -1 ? undefined : nextFnStart);

    const parsePosition = body.indexOf('parser.parsePRArguments');
    // Token/binding resolution now goes through the shared preflight helper,
    // which tolerates dual repos whose host is unknown (alt-only token).
    const bindingPosition = body.indexOf('resolvePreflightBinding(');
    expect(parsePosition).toBeGreaterThan(-1);
    expect(bindingPosition).toBeGreaterThan(-1);

    // The parser call must precede the binding-resolution call. This
    // guards against re-introducing the no-repo getGitHubToken preflight.
    expect(parsePosition).toBeLessThan(bindingPosition);

    // The legacy no-repo preflight (`getGitHubToken(config)` with no repo
    // arg) must not appear inside handlePullRequest anymore.
    expect(body).not.toMatch(/getGitHubToken\(\s*config\s*\)\s*[;]/);
  });

  it('error message names repo-scoped config locations', () => {
    const src = readMainSource();
    // The missing-token error is now built via the shared
    // `buildMissingTokenError` helper at module scope, so scan the whole
    // file rather than only the body of `handlePullRequest`.
    expect(src).toMatch(/function buildMissingTokenError/);
    // The fix requires actionable error text mentioning the per-repo
    // keys for both github.com and alt-host bindings.
    expect(src).toMatch(/repos\[/);
    expect(src).toMatch(/token_command/);
    expect(src).toMatch(/github_token/);
    // The handlePullRequest body invokes the helper, passing through
    // the resolved binding's apiHost so error messaging branches on
    // alt-host vs github.com.
    const fnStart = src.indexOf('async function handlePullRequest(');
    const nextFnStart = src.indexOf('\nasync function ', fnStart + 1);
    const body = src.slice(fnStart, nextFnStart === -1 ? undefined : nextFnStart);
    expect(body).toMatch(/buildMissingTokenError\(/);
  });
});

describe('main.js — buildMissingTokenError binding-aware messages (Fix #9)', () => {
  // Use a require() shim to surface the un-exported helper for testing
  // via the file system. The helper is intentionally not exported from
  // main.js (CLI-only surface), so we extract it for unit tests by
  // sourcing a tiny wrapper that re-runs the file in a sandbox VM.
  // Source-level assertions are sufficient here — the helper is small
  // and its branches are exhaustively covered by static patterns.
  it('alt-host message excludes GITHUB_TOKEN and points at repos[bindingRepository]', () => {
    const src = readMainSource();
    const start = src.indexOf('function buildMissingTokenError');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);
    // Alt-host branch must mention api_host and avoid suggesting
    // GITHUB_TOKEN (which is github.com-only after Fix #4).
    expect(body).toMatch(/apiHost/);
    expect(body).toMatch(/github\.com-only/);
    expect(body).toMatch(/repos\["\${bindingRepository}"\]/);
    // github.com branch keeps the legacy hint.
    expect(body).toMatch(/Set GITHUB_TOKEN env var/);
  });
});

describe('main.js — repo-scoped-only config resolves to a token', () => {
  it('resolveHostBinding finds a repo-scoped token even when top-level is empty', () => {
    // This is the configuration shape that USED to fail in handlePullRequest's
    // preflight: no top-level token, no env var, only `repos[*].token`.
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const config = {
        // Intentionally no `github_token` / `github_token_command`.
        repos: {
          'owner/repo': {
            token: 'repo-scoped-secret'
          }
        }
      };
      const binding = resolveHostBinding('owner/repo', config);
      expect(binding.token).toBe('repo-scoped-secret');
      expect(binding.source).toBe('repo:token');
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });

  it('alt-host repo-scoped token resolves even when GITHUB_TOKEN env var would otherwise fire', () => {
    // For alt-host repos the env var is intentionally NOT used (it's a
    // github.com token). The repo-scoped token must still be found.
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'github-com-token-must-not-leak-to-alt-host';
    try {
      const config = {
        repos: {
          'owner/alt': {
            api_host: 'https://ghe.example.com/api/v3',
            token: 'alt-host-secret',
            features: { review_lifecycle: 'rest', pending_review_comments: 'rest' }
          }
        }
      };
      const binding = resolveHostBinding('owner/alt', config);
      expect(binding.token).toBe('alt-host-secret');
      expect(binding.apiHost).toBe('https://ghe.example.com/api/v3');
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });
});

/**
 * The node-id feature gate.
 *
 * These were source-text assertions on `performHeadlessReview` until Phase 5
 * folded the headless write into `submitReview` (src/providers/review-submit.js)
 * — the gate now lives in exactly one place for all three callers, so grepping
 * src/main.js for it can only ever go stale. Asserted through the behaviour
 * instead, which is what the original bug was about: a github.com-only
 * assumption made an all-REST alt host unable to submit at all.
 */
describe('headless submit — node-id feature gating', () => {
  const { submitHeadlessAIReview } = require('../../src/main.js');
  const { SubmitReviewError } = require('../../src/providers/review-submit');

  const silentLogger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  function fakeClientClass(features) {
    return class {
      constructor() { this.features = features; }
      async getPendingReviewForUser() { return null; }
      async createReviewGraphQL(prNodeId, event, body, comments) {
        return {
          id: 'PRR_1', databaseId: 1, html_url: 'https://example.test/r/1',
          comments_count: comments.length, state: 'COMMENTED'
        };
      }
    };
  }

  function runHeadless({ features, nodeId }) {
    const { submitReview } = require('../../src/providers/review-submit');
    return submitHeadlessAIReview({
      db: {},
      reviewId: 1,
      prInfo: { owner: 'owner', repo: 'alt', number: 5 },
      storedPRData: { node_id: nodeId, head_sha: 'head1' },
      credential: { token: 'alt-host-secret', apiHost: 'https://ghe.example.com/api/v3', features },
      hostName: 'GHE',
      diffContent: '',
      options: { mode: 'review', reviewEvent: 'COMMENT', commentStatus: 'submitted' },
      _deps: {
        query: async () => [{ id: 1, file: 'a.js', line_start: 2, body: 'x', diff_position: null, title: 't', type: 'bug' }],
        submitReview: (params) => submitReview({
          ...params,
          _deps: {
            GitHubClient: fakeClientClass(features),
            ReviewRepository: class { async updateAfterSubmission() { return true; } },
            GitHubReviewRepository: class { async upsertFromGitHub() { return { id: 1 }; } },
            logger: silentLogger,
            query: async () => [],
            run: async () => ({ changes: 1 })
          }
        })
      }
    });
  }

  it('does NOT require a node id when the binding dispatches to REST', async () => {
    // The alt-host regression: an all-REST host addresses the PR by
    // (owner, repo, number) and never sees `prNodeId`.
    const result = await runHeadless({
      features: { review_lifecycle: 'rest', pending_review_comments: 'rest' },
      nodeId: null
    });
    expect(result.success).toBe(true);
  });

  it('still refuses when GraphQL is in play and node_id is missing', async () => {
    await expect(runHeadless({
      features: { review_lifecycle: 'graphql', pending_review_comments: 'graphql' },
      nodeId: null
    })).rejects.toThrow(/GraphQL PR node id required for owner\/alt#5[\s\S]*refresh the PR data and try again/);
  });

  it('classifies that refusal as a SubmitReviewError so callers can map it', async () => {
    await expect(runHeadless({
      features: { review_lifecycle: 'graphql', pending_review_comments: 'graphql' },
      nodeId: null
    })).rejects.toBeInstanceOf(SubmitReviewError);
  });
});

describe('main.js — CLI binding key is host-aware at every PR entry point', () => {
  const ALT = 'https://alt.example/api/v3';
  const MONOREPO_PATTERN = '^https://alt\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)';

  const dualMonorepo = {
    github_token: 'gh-tok',
    repos: {
      'acme/platform': { api_host: ALT, exclusive: false, url_pattern: MONOREPO_PATTERN, token: 'alt-tok' }
    }
  };
  const exclusiveMonorepo = {
    github_token: 'gh-tok',
    repos: {
      'acme/platform': { api_host: ALT, url_pattern: MONOREPO_PATTERN, token: 'alt-tok' }
    }
  };

  it('every in-process PR entry point resolves the key through the shared helper', () => {
    const src = readMainSource();
    // handlePullRequest, performHeadlessReview, and the headless PR path. Match
    // assignments only, so the function declaration itself is not counted.
    const calls = src.match(/=\s*resolveCliBindingRepository\(prInfo, config\)/g);
    expect(calls).toHaveLength(3);
    // The bare fallback that skipped the config probe must be gone.
    expect(src).not.toMatch(/prInfo\.bindingRepository\s*\n?\s*\|\|\s*normalizeRepository\(/);
  });

  it('a canonical github.com URL KEEPS a dual monorepo entry (its local config still applies)', () => {
    // Parser dropped its key (canonical github URL) and reports host null. The
    // dual entry does serve github.com, so it — and its path/pool/reset
    // configuration — must be retained.
    expect(resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: null },
      dualMonorepo
    )).toBe('acme/platform');
  });

  it('a canonical github.com URL rejects an EXCLUSIVE monorepo entry', () => {
    expect(resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: null },
      exclusiveMonorepo
    )).toBe('acme/widgets');
  });

  it('a bare PR number preflights against the configured monorepo entry', () => {
    // Host unknown: the entry serving this owner/repo must still be found, or the
    // preflight resolves the identity and misses the repo-scoped token.
    const key = resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: undefined },
      exclusiveMonorepo
    );
    expect(key).toBe('acme/platform');
    expect(resolveHostBinding(key, exclusiveMonorepo, { host: ALT }).token).toBe('alt-tok');
  });

  it('an alt-host URL keeps the key the parser matched', () => {
    expect(resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: ALT, bindingRepository: 'acme/platform' },
      exclusiveMonorepo
    )).toBe('acme/platform');
  });

  it('a directly keyed exclusive repo fails fast, naming the config fix', () => {
    // The CLI passes the parsed host straight into the preflight, so a canonical
    // github.com URL for a repo its own entry declares alt-host-only fails before
    // any network work. Documented in docs/alt-host.md alongside the web
    // surface's warn-and-continue behaviour — the two differ deliberately.
    const directlyKeyedExclusive = {
      github_token: 'gh-tok',
      repos: { 'acme/widgets': { api_host: ALT, token: 'alt-tok' } }
    };
    const key = resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: null },
      directlyKeyedExclusive
    );
    // Config wins over inference: the entry is kept, not escaped.
    expect(key).toBe('acme/widgets');
    expect(() => resolvePreflightBinding(key, directlyKeyedExclusive, null))
      .toThrow(/exclusive alt-host repo.*"exclusive": false/s);
  });

  it('announces the github sentinel for a canonical URL an alt entry could claim', () => {
    const src = readMainSource();
    // main.js must build the ?host= param through the shared mapping.
    expect(src).toMatch(/setupHostParam\(config, prInfo\.owner, prInfo\.repo, prInfo\.host\)/);

    // Without the sentinel, setup re-resolves the alt entry and fetches from it.
    expect(setupHostParam(exclusiveMonorepo, 'acme', 'widgets', null)).toBe('github');
  });
});
