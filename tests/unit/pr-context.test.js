// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  getAssociatedPR,
  getPRContext,
  buildCapabilities,
  splitRepository,
  fetchPRMetadata,
  getCachedPRMetadata,
  resolveFetchCredential
} = require('../../src/providers/pr-context');

describe('splitRepository', () => {
  it('returns null for falsy or non-string inputs', () => {
    expect(splitRepository(null)).toBeNull();
    expect(splitRepository(undefined)).toBeNull();
    expect(splitRepository('')).toBeNull();
    expect(splitRepository(42)).toBeNull();
    expect(splitRepository({})).toBeNull();
  });

  it('returns null when input has no slash', () => {
    expect(splitRepository('justname')).toBeNull();
  });

  it('returns null on a leading slash (empty owner)', () => {
    expect(splitRepository('/repo')).toBeNull();
  });

  it('returns null on a trailing slash (empty repo)', () => {
    expect(splitRepository('owner/')).toBeNull();
  });

  it('splits a clean owner/repo', () => {
    expect(splitRepository('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('keeps the trailing segments on multi-slash input (pins indexOf behavior)', () => {
    // Documents current behavior: indexOf('/') gives owner='a', repo='b/c'.
    // If we ever change this to lastIndexOf, this test fires the alarm.
    expect(splitRepository('a/b/c')).toEqual({ owner: 'a', repo: 'b/c' });
  });
});

describe('buildCapabilities', () => {
  it('keeps every action flag false in Phase 0 regardless of inputs', () => {
    const cases = [
      { association: null, hasToken: false },
      { association: null, hasToken: true },
      { association: { prNumber: 1, repository: 'a/b' }, hasToken: false },
      { association: { prNumber: 1, repository: 'a/b' }, hasToken: true },
    ];

    for (const params of cases) {
      const caps = buildCapabilities(params);
      expect(caps.canShowPRMetadata).toBe(false);
      expect(caps.canViewPRComments).toBe(false);
      expect(caps.canCheckStaleVsPR).toBe(false);
      expect(caps.canSyncDrafts).toBe(false);
      expect(caps.canSubmitToGitHub).toBe(false);
    }
  });

  it('flips hasAssociatedPR only when both prNumber and repository present', () => {
    expect(buildCapabilities({ association: null, hasToken: true }).hasAssociatedPR).toBe(false);
    expect(buildCapabilities({ association: { prNumber: null, repository: 'a/b' }, hasToken: true }).hasAssociatedPR).toBe(false);
    expect(buildCapabilities({ association: { prNumber: 1, repository: '' }, hasToken: true }).hasAssociatedPR).toBe(false);
    expect(buildCapabilities({ association: { prNumber: 1, repository: 'a/b' }, hasToken: true }).hasAssociatedPR).toBe(true);
  });

  it('flips hasGitHubToken from hasToken boolean', () => {
    expect(buildCapabilities({ association: null, hasToken: false }).hasGitHubToken).toBe(false);
    expect(buildCapabilities({ association: null, hasToken: true }).hasGitHubToken).toBe(true);
    // Truthy non-boolean inputs are coerced to true.
    expect(buildCapabilities({ association: null, hasToken: 'ghp_xxx' }).hasGitHubToken).toBe(true);
  });

  it('Phase 1: flips canShowPRMetadata only when association AND prMetadataAvailable', () => {
    const assoc = { prNumber: 1, repository: 'a/b' };
    // Both required:
    expect(buildCapabilities({ association: assoc, hasToken: true, prMetadataAvailable: true }).canShowPRMetadata).toBe(true);
    // Missing association:
    expect(buildCapabilities({ association: null, hasToken: true, prMetadataAvailable: true }).canShowPRMetadata).toBe(false);
    // Missing metadata:
    expect(buildCapabilities({ association: assoc, hasToken: true, prMetadataAvailable: false }).canShowPRMetadata).toBe(false);
    // Token absence does NOT block the cap (metadata can be served from cache).
    expect(buildCapabilities({ association: assoc, hasToken: false, prMetadataAvailable: true }).canShowPRMetadata).toBe(true);
  });
});

/**
 * The credential rule extracted out of fetchPRMetadata so the routes'
 * `hasGitHubToken` capability cannot drift from what the fetch will actually
 * do. The fetch-side behaviour is covered under "fetchPRMetadata > host
 * binding"; these pin the rule itself.
 */
describe('resolveFetchCredential', () => {
  it('prefers the binding whenever it carries a token', () => {
    const binding = { token: 'alt-token', host: 'https://ghe.acme.com/api/v3' };
    expect(resolveFetchCredential(binding, 'ghp_dotcom')).toBe(binding);
  });

  it('prefers a github.com binding with a token over the bare token', () => {
    const binding = { token: 'binding-token', host: null };
    expect(resolveFetchCredential(binding, 'ghp_dotcom')).toBe(binding);
  });

  it('falls back to the bare token for a github.com binding with no token', () => {
    expect(resolveFetchCredential({ token: '', host: null, apiHost: null }, 'ghp_dotcom')).toBe('ghp_dotcom');
  });

  it('falls back to the bare token when there is no binding at all', () => {
    expect(resolveFetchCredential(null, 'ghp_dotcom')).toBe('ghp_dotcom');
    expect(resolveFetchCredential(undefined, 'ghp_dotcom')).toBe('ghp_dotcom');
  });

  it('fails closed for an alt-host binding with an empty token, even with a global token', () => {
    // The whole point: `{ host: <alt>, token: '' }` means "no usable credential
    // for THIS host", not "no binding". Borrowing the github.com token would
    // send it to api.github.com against a same-named repo.
    expect(resolveFetchCredential(
      { token: '', host: 'https://ghe.acme.com/api/v3', apiHost: 'https://ghe.acme.com/api/v3' },
      'ghp_dotcom'
    )).toBeNull();
  });

  it('fails closed when the alt host is carried on apiHost only', () => {
    expect(resolveFetchCredential({ token: '', apiHost: 'https://ghe.acme.com/api/v3' }, 'ghp_dotcom')).toBeNull();
  });

  it('returns null when nothing is available', () => {
    expect(resolveFetchCredential(null, '')).toBeNull();
    expect(resolveFetchCredential(null, undefined)).toBeNull();
    expect(resolveFetchCredential({ token: '', host: null }, '')).toBeNull();
  });
});

describe('fetchPRMetadata', () => {
  function makeRow({ title = 'T', author = 'A', state = 'open', html_url = 'https://x', head_sha = 'h' } = {}) {
    return {
      title,
      author,
      head_sha,
      pr_data_parsed: { state, html_url, head_sha }
    };
  }

  class CachingRepoStub {
    constructor(initialRow = null) {
      this.row = initialRow;
      this.getCalls = 0;
      this.upsertCalls = 0;
    }
    async getByPR(_pr, _repo) {
      this.getCalls++;
      return this.row;
    }
    async upsertPRMetadata({ prData }) {
      this.upsertCalls++;
      this.row = makeRow({
        title: prData.title,
        author: prData.author,
        state: prData.state,
        html_url: prData.html_url,
        head_sha: prData.head_sha
      });
      return { id: 1, created: true };
    }
  }

  it('returns null when inputs are missing', async () => {
    expect(await fetchPRMetadata()).toBeNull();
    expect(await fetchPRMetadata({ prNumber: 1, repository: 'a/b' })).toBeNull();
    expect(await fetchPRMetadata({ prNumber: 1, db: {} })).toBeNull();
    expect(await fetchPRMetadata({ repository: 'a/b', db: {} })).toBeNull();
  });

  it('returns null when repository is malformed (no slash)', async () => {
    const repo = new CachingRepoStub(null);
    const result = await fetchPRMetadata({
      prNumber: 1,
      repository: 'badrepo',
      githubToken: 'tok',
      db: {},
      _deps: { PRMetadataRepository: function () { return repo; } }
    });
    expect(result).toBeNull();
  });

  it('returns cached metadata without hitting GitHub on a cache hit', async () => {
    const repo = new CachingRepoStub(makeRow({ title: 'cached', author: 'me' }));
    const githubCalls = { count: 0 };
    class GHStub {
      async fetchPullRequest() {
        githubCalls.count++;
        throw new Error('GitHub should not be called on cache hit');
      }
    }
    const result = await fetchPRMetadata({
      prNumber: 1,
      repository: 'a/b',
      githubToken: 'tok',
      db: {},
      _deps: {
        PRMetadataRepository: function () { return repo; },
        GitHubClient: GHStub
      }
    });
    expect(githubCalls.count).toBe(0);
    expect(result).toEqual({
      title: 'cached',
      author: 'me',
      url: 'https://x',
      state: 'open',
      merged: false,
      head_sha: 'h'
    });
  });

  it('Phase 1 contract: caches and returns from cache on second call', async () => {
    const repo = new CachingRepoStub(null);
    const githubCalls = { count: 0 };
    class GHStub {
      constructor(_tok) {}
      async fetchPullRequest(_owner, _repo, _pr) {
        githubCalls.count++;
        return {
          title: 'remote-title',
          author: 'remote-author',
          body: '',
          state: 'open',
          base_branch: 'main',
          head_branch: 'feat',
          base_sha: 'aaa',
          head_sha: 'bbb',
          html_url: 'https://github.com/a/b/pull/1',
          node_id: 'PR_x'
        };
      }
    }

    const deps = {
      PRMetadataRepository: function () { return repo; },
      GitHubClient: GHStub
    };

    // First call: cache miss → fetches GitHub once and writes through.
    const first = await fetchPRMetadata({ prNumber: 1, repository: 'a/b', githubToken: 'tok', db: {}, _deps: deps });
    expect(first.title).toBe('remote-title');
    expect(githubCalls.count).toBe(1);
    expect(repo.upsertCalls).toBe(1);

    // Second call: cache hit (stub stores the upserted row) → no GitHub.
    const second = await fetchPRMetadata({ prNumber: 1, repository: 'a/b', githubToken: 'tok', db: {}, _deps: deps });
    expect(second.title).toBe('remote-title');
    expect(githubCalls.count).toBe(1);
    expect(repo.upsertCalls).toBe(1);
  });

  it('returns null on cache miss when no token is provided (no GitHub call)', async () => {
    const repo = new CachingRepoStub(null);
    class GHStub {
      async fetchPullRequest() { throw new Error('should not be called without token'); }
    }
    const result = await fetchPRMetadata({
      prNumber: 1,
      repository: 'a/b',
      db: {},
      _deps: {
        PRMetadataRepository: function () { return repo; },
        GitHubClient: GHStub
      }
    });
    expect(result).toBeNull();
    expect(repo.upsertCalls).toBe(0);
  });

  it('swallows GitHub errors and returns null (frontend cap stays false)', async () => {
    const repo = new CachingRepoStub(null);
    class GHStub {
      async fetchPullRequest() { throw new Error('401 Unauthorized'); }
    }
    const result = await fetchPRMetadata({
      prNumber: 1,
      repository: 'a/b',
      githubToken: 'bad',
      db: {},
      _deps: {
        PRMetadataRepository: function () { return repo; },
        GitHubClient: GHStub,
        logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
      }
    });
    expect(result).toBeNull();
    expect(repo.upsertCalls).toBe(0);
  });

  // Host binding: the seam has to enforce the invariant rather than trusting
  // callers. A bare token is normalised by GitHubClient into a github.com
  // binding, so an alt-host repo would silently be queried against
  // github.com with the wrong credential — the association persists, the
  // metadata fetch 404s, and the pill never appears.
  describe('host binding', () => {
    /** Repo stub that records what it was asked to persist. */
    class RecordingRepo {
      constructor() { this.row = null; this.upserts = []; }
      async getByPR() { return this.row; }
      async upsertPRMetadata(args) {
        this.upserts.push(args);
        this.row = {
          title: args.prData.title,
          author: args.prData.author,
          head_sha: args.prData.head_sha,
          pr_data_parsed: { state: args.prData.state, merged: args.prData.merged, html_url: args.prData.html_url }
        };
        return { id: 1, created: true };
      }
    }

    const remotePR = {
      title: 'remote', body: '', author: 'octocat',
      state: 'open', merged: false,
      base_branch: 'main', head_branch: 'feat',
      base_sha: 'aaa', head_sha: 'bbb',
      html_url: 'https://ghe.example.com/a/b/pull/1', node_id: 'PR_x'
    };

    function makeDeps(repo, seen) {
      return {
        PRMetadataRepository: function () { return repo; },
        GitHubClient: class {
          constructor(arg) { seen.push(arg); }
          async fetchPullRequest() { return remotePR; }
        }
      };
    }

    it('hands the binding to GitHubClient instead of the bare token', async () => {
      const repo = new RecordingRepo();
      const seen = [];
      const binding = { token: 'alt-token', host: 'https://ghe.example.com/api/v3', apiHost: 'https://ghe.example.com/api/v3' };

      await fetchPRMetadata({
        prNumber: 1, repository: 'a/b',
        githubToken: 'github-com-token',
        hostBinding: binding,
        db: {}, _deps: makeDeps(repo, seen)
      });

      expect(seen).toEqual([binding]);
      expect(seen[0]).not.toBe('github-com-token');
    });

    it('stamps the binding host onto the cached row', async () => {
      const repo = new RecordingRepo();
      const seen = [];

      await fetchPRMetadata({
        prNumber: 1, repository: 'a/b',
        hostBinding: { token: 'alt-token', host: 'https://ghe.example.com/api/v3' },
        db: {}, _deps: makeDeps(repo, seen)
      });

      expect(repo.upserts[0].host).toBe('https://ghe.example.com/api/v3');
    });

    it('writes a null host for a github.com binding', async () => {
      const repo = new RecordingRepo();
      const seen = [];

      await fetchPRMetadata({
        prNumber: 1, repository: 'a/b',
        hostBinding: { token: 'gh-token', host: null },
        db: {}, _deps: makeDeps(repo, seen)
      });

      expect(repo.upserts[0].host).toBeNull();
    });

    it('authenticates with a binding token even when no bare token is supplied', async () => {
      // The global app token slot ignores repos[...].token; a repo-scoped
      // credential must still be enough to fetch.
      const repo = new RecordingRepo();
      const seen = [];

      const result = await fetchPRMetadata({
        prNumber: 1, repository: 'a/b',
        hostBinding: { token: 'repo-scoped', host: null },
        db: {}, _deps: makeDeps(repo, seen)
      });

      expect(result.title).toBe('remote');
      expect(seen).toHaveLength(1);
    });

    it('falls back to the bare token for a github.com binding with no token', async () => {
      // `host: null` is what resolveHostBinding returns for a github.com repo.
      // The top-level token IS that repo's credential, so borrowing it here is
      // correct — and load-bearing: a token-less binding would otherwise make
      // the GitHubClient constructor throw.
      const repo = new RecordingRepo();
      const seen = [];

      await fetchPRMetadata({
        prNumber: 1, repository: 'a/b',
        githubToken: 'github-com-token',
        hostBinding: { token: '', host: null },
        db: {}, _deps: makeDeps(repo, seen)
      });

      expect(seen).toEqual(['github-com-token']);
    });

    it('returns null when neither a binding token nor a bare token exists', async () => {
      const repo = new RecordingRepo();
      const seen = [];

      const result = await fetchPRMetadata({
        prNumber: 1, repository: 'a/b',
        hostBinding: { token: '', host: 'https://ghe.example.com/api/v3' },
        db: {}, _deps: makeDeps(repo, seen)
      });

      expect(result).toBeNull();
      expect(seen).toHaveLength(0);
    });

    it('fails closed: an alt-host binding with an empty token never borrows the github.com token', async () => {
      // resolveHostBinding refuses to hand top-level github.com credentials to
      // an alt-host binding, so `{ host: <alt>, token: '' }` means "no usable
      // credential for THIS host" — not "no binding". Falling back would send a
      // github.com token to api.github.com (GitHubClient normalises a bare
      // string to apiHost: null) and could cache a same-named github.com repo's
      // PR under the GHE host, in a row the cache-first read never expires.
      const repo = new RecordingRepo();
      const seen = [];

      const result = await fetchPRMetadata({
        prNumber: 1, repository: 'acme/service',
        githubToken: 'ghp_dotcom',
        hostBinding: { token: '', host: 'https://ghe.acme.com/api/v3', apiHost: 'https://ghe.acme.com/api/v3' },
        db: {}, _deps: makeDeps(repo, seen)
      });

      expect(result).toBeNull();
      expect(seen).toHaveLength(0);      // no GitHubClient constructed
      expect(repo.upserts).toHaveLength(0); // nothing written to the cache
    });

    /**
     * A `hostAmbiguous` binding means the caller only GUESSED the host: the
     * two-argument ambiguity rule yields the github.com flavour for a DUAL repo
     * (api_host + exclusive:false) whether or not the PR lives there.
     *
     * Persisting that guess is the harm. Omitting `host`, passing `undefined`
     * and passing `null` all store SQL NULL, and `storedHostToOption` maps NULL
     * on a dual repo to `{ host: null }` — so PR-mode setup reads the row back
     * as authoritative (`hostKnown = true`) and skips the alt-host-first probe
     * that exists to answer exactly this question. There is no honest "unknown"
     * to write, so the only honest option is not to create the row.
     */
    describe('ambiguous (guessed) host', () => {
      const ambiguousBinding = {
        token: 'gh-token', host: null, apiHost: null, hostAmbiguous: true
      };

      it('returns null on a cache MISS without calling GitHub or writing a row', async () => {
        const repo = new RecordingRepo();
        const seen = [];

        const result = await fetchPRMetadata({
          prNumber: 1, repository: 'a/b',
          githubToken: 'github-com-token',
          hostBinding: ambiguousBinding,
          db: {}, _deps: makeDeps(repo, seen)
        });

        expect(result).toBeNull();
        expect(seen).toHaveLength(0);         // no GitHubClient constructed
        expect(repo.upserts).toHaveLength(0); // and nothing stamped
      });

      it('still serves a cache HIT — an existing row was stamped by whoever resolved the host', async () => {
        const repo = new RecordingRepo();
        repo.row = {
          title: 'cached', author: 'octocat', head_sha: 'h',
          pr_data_parsed: { state: 'open', merged: false, html_url: 'https://x' }
        };
        const seen = [];

        const result = await fetchPRMetadata({
          prNumber: 1, repository: 'a/b',
          hostBinding: ambiguousBinding,
          db: {}, _deps: makeDeps(repo, seen)
        });

        expect(result).toMatchObject({ title: 'cached', author: 'octocat' });
        expect(seen).toHaveLength(0);
      });

      it('does not gate a binding without the marker (absence means "not known to be a guess")', async () => {
        const repo = new RecordingRepo();
        const seen = [];

        await fetchPRMetadata({
          prNumber: 1, repository: 'a/b',
          hostBinding: { token: 'gh-token', host: null, apiHost: null },
          db: {}, _deps: makeDeps(repo, seen)
        });

        expect(seen).toHaveLength(1);
        expect(repo.upserts[0].host).toBeNull();
      });
    });

    it('fails closed when the alt host is carried on apiHost only', async () => {
      const repo = new RecordingRepo();
      const seen = [];

      const result = await fetchPRMetadata({
        prNumber: 1, repository: 'acme/service',
        githubToken: 'ghp_dotcom',
        hostBinding: { token: '', apiHost: 'https://ghe.acme.com/api/v3' },
        db: {}, _deps: makeDeps(repo, seen)
      });

      expect(result).toBeNull();
      expect(seen).toHaveLength(0);
      expect(repo.upserts).toHaveLength(0);
    });

    // The two cases above hand-write the binding literal. These pin the same
    // behaviour against a binding produced by the REAL resolveHostBinding, so
    // the fix cannot silently drift from the shape config actually emits.
    describe('against bindings from the real resolveHostBinding', () => {
      const { resolveHostBinding } = require('../../src/config');

      beforeEach(() => {
        // resolveHostBinding consults GITHUB_TOKEN for github.com bindings; a
        // developer's real env must not decide the outcome.
        vi.stubEnv('GITHUB_TOKEN', '');
      });
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('fails closed for an alt-host repo with no repo-scoped credential', async () => {
        const binding = resolveHostBinding('acme/service', {
          github_token: 'ghp_dotcom',
          repos: { 'acme/service': { api_host: 'https://ghe.acme.com/api/v3' } }
        });
        // Shape guard: config really does emit host set + token empty here.
        expect(binding.host).toBe('https://ghe.acme.com/api/v3');
        expect(binding.token).toBe('');

        const repo = new RecordingRepo();
        const seen = [];
        const result = await fetchPRMetadata({
          prNumber: 1, repository: 'acme/service',
          githubToken: 'ghp_dotcom',
          hostBinding: binding,
          db: {}, _deps: makeDeps(repo, seen)
        });

        expect(result).toBeNull();
        expect(seen).toHaveLength(0);
        expect(repo.upserts).toHaveLength(0);
      });

      it('fails closed for a dual (exclusive:false) repo resolved to its alt host without a credential', async () => {
        const binding = resolveHostBinding('acme/service', {
          github_token: 'ghp_dotcom',
          repos: { 'acme/service': { api_host: 'https://ghe.acme.com/api/v3', exclusive: false } }
        }, { host: 'https://ghe.acme.com/api/v3' });
        expect(binding.host).toBe('https://ghe.acme.com/api/v3');
        expect(binding.token).toBe('');

        const repo = new RecordingRepo();
        const seen = [];
        const result = await fetchPRMetadata({
          prNumber: 1, repository: 'acme/service',
          githubToken: 'ghp_dotcom',
          hostBinding: binding,
          db: {}, _deps: makeDeps(repo, seen)
        });

        expect(result).toBeNull();
        expect(seen).toHaveLength(0);
      });

      it('still fetches for a plain github.com repo whose binding carries the top-level token', async () => {
        const binding = resolveHostBinding('octocat/hello-world', {
          github_token: 'ghp_dotcom',
          repos: {}
        });
        // github.com bindings resolve host to null (not undefined, not ''),
        // which is what makes the alt-host predicate safe.
        expect(binding.host).toBeNull();
        expect(binding.token).toBe('ghp_dotcom');

        const repo = new RecordingRepo();
        const seen = [];
        const result = await fetchPRMetadata({
          prNumber: 1, repository: 'octocat/hello-world',
          hostBinding: binding,
          db: {}, _deps: makeDeps(repo, seen)
        });

        expect(result.title).toBe('remote');
        expect(seen).toEqual([binding]); // binding passed through, not a bare token
        expect(repo.upserts[0].host).toBeNull();
      });

      it('falls back to the bare token for a github.com repo with no configured credential', async () => {
        const binding = resolveHostBinding('octocat/hello-world', { repos: {} });
        expect(binding.host).toBeNull();
        expect(binding.token).toBe('');

        const repo = new RecordingRepo();
        const seen = [];
        await fetchPRMetadata({
          prNumber: 1, repository: 'octocat/hello-world',
          githubToken: 'ghp_dotcom',
          hostBinding: binding,
          db: {}, _deps: makeDeps(repo, seen)
        });

        expect(seen).toEqual(['ghp_dotcom']);
      });
    });
  });
});

describe('normalizePRMetadata (via getCachedPRMetadata)', () => {
  function cachedRow(prData) {
    return class { async getByPR() { return { title: 't', author: 'a', head_sha: 'h', pr_data_parsed: prData }; } };
  }

  it('surfaces merged as its own boolean without rewriting state', async () => {
    // GitHub never returns 'merged' as a state. This payload is the Phase 2-5
    // surface, so a derived state here would mislead a later staleness check.
    const result = await getCachedPRMetadata({
      prNumber: 1, repository: 'a/b', db: {},
      _deps: { PRMetadataRepository: cachedRow({ state: 'closed', merged: true, html_url: 'u' }) }
    });

    expect(result.state).toBe('closed');
    expect(result.merged).toBe(true);
  });

  it('defaults merged to false for legacy rows written before the flag existed', async () => {
    const result = await getCachedPRMetadata({
      prNumber: 1, repository: 'a/b', db: {},
      _deps: { PRMetadataRepository: cachedRow({ state: 'open', html_url: 'u' }) }
    });

    expect(result.merged).toBe(false);
  });
});

describe('getCachedPRMetadata', () => {
  it('returns null when db/inputs missing', async () => {
    expect(await getCachedPRMetadata()).toBeNull();
    expect(await getCachedPRMetadata({ prNumber: 1, repository: 'a/b' })).toBeNull();
  });

  it('returns the normalized cached row without touching GitHub', async () => {
    const row = {
      title: 'cached',
      author: 'octocat',
      head_sha: 'h',
      pr_data_parsed: { state: 'open', html_url: 'u', head_sha: 'h' }
    };
    const FakeRepo = class { async getByPR() { return row; } };
    const result = await getCachedPRMetadata({
      prNumber: 1,
      repository: 'a/b',
      db: {},
      _deps: { PRMetadataRepository: FakeRepo }
    });
    expect(result).toEqual({
      title: 'cached',
      author: 'octocat',
      url: 'u',
      state: 'open',
      merged: false,
      head_sha: 'h'
    });
  });

  it('returns null when no cached row exists', async () => {
    const FakeRepo = class { async getByPR() { return null; } };
    const result = await getCachedPRMetadata({
      prNumber: 1,
      repository: 'a/b',
      db: {},
      _deps: { PRMetadataRepository: FakeRepo }
    });
    expect(result).toBeNull();
  });
});

describe('getAssociatedPR', () => {
  function makeRepoStub(review) {
    return class FakeRepo {
      constructor(_db) {}
      async getLocalReviewById(_id) { return review; }
    };
  }

  it('throws when db is not provided', async () => {
    await expect(getAssociatedPR(1)).rejects.toThrow(/requires db/);
  });

  it('returns null when the review does not exist', async () => {
    const FakeRepo = makeRepoStub(null);
    const result = await getAssociatedPR(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(result).toBeNull();
  });

  it('returns null when association columns are NULL', async () => {
    const FakeRepo = makeRepoStub({
      id: 1,
      associated_pr_number: null,
      associated_pr_repository: null
    });
    const result = await getAssociatedPR(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(result).toBeNull();
  });

  it('returns the persisted association from associated_pr_* columns', async () => {
    const FakeRepo = makeRepoStub({
      id: 1,
      associated_pr_number: 42,
      associated_pr_repository: 'owner/repo'
    });
    const result = await getAssociatedPR(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(result).toEqual({ prNumber: 42, repository: 'owner/repo' });
  });

  it('does NOT fall back to pr_number / repository (those columns are exclusive to PR rows)', async () => {
    // Even if the local row has pr_number/repository set (legacy phase-0 data
    // before migration #47 cleaned it up), getAssociatedPR must read only
    // from the dedicated columns.
    const FakeRepo = makeRepoStub({
      id: 1,
      pr_number: 99,
      repository: 'owner/repo',
      associated_pr_number: null,
      associated_pr_repository: null
    });
    const result = await getAssociatedPR(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(result).toBeNull();
  });
});

describe('getPRContext', () => {
  function makeRepoStub(review) {
    return class FakeRepo {
      constructor(_db) {}
      async getLocalReviewById(_id) { return review; }
    };
  }

  it('returns owner+repo split alongside prNumber+repository', async () => {
    const FakeRepo = makeRepoStub({
      associated_pr_number: 7,
      associated_pr_repository: 'octocat/hello-world'
    });
    const ctx = await getPRContext(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(ctx).toEqual({
      prNumber: 7,
      repository: 'octocat/hello-world',
      owner: 'octocat',
      repo: 'hello-world'
    });
  });

  it('returns null when association is missing', async () => {
    const FakeRepo = makeRepoStub({ associated_pr_number: null, associated_pr_repository: null });
    const ctx = await getPRContext(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(ctx).toBeNull();
  });

  it('returns null when associated_pr_repository is malformed (no slash)', async () => {
    const FakeRepo = makeRepoStub({
      associated_pr_number: 7,
      associated_pr_repository: 'badrepo'
    });
    const ctx = await getPRContext(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(ctx).toBeNull();
  });

  it('returns null when associated_pr_repository is empty', async () => {
    const FakeRepo = makeRepoStub({
      associated_pr_number: 7,
      associated_pr_repository: ''
    });
    const ctx = await getPRContext(1, { db: {}, _deps: { ReviewRepository: FakeRepo } });
    expect(ctx).toBeNull();
  });
});
