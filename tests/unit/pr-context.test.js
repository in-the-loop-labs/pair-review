// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  getAssociatedPR,
  getPRContext,
  buildCapabilities,
  isUsablePRTarget,
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
  it('keeps the UNSHIPPED action flags (Phases 4-5) false regardless of inputs', () => {
    // These two are hard-coded false until the phase that implements them
    // lands. canShowPRMetadata (Phase 1), canViewPRComments (Phase 2) and
    // canCheckStaleVsPR (Phase 3) are real now and have their own truth
    // tables below.
    const cases = [
      { association: null, hasToken: false },
      { association: null, hasToken: true },
      { association: { prNumber: 1, repository: 'a/b' }, hasToken: false },
      { association: { prNumber: 1, repository: 'a/b' }, hasToken: true },
    ];

    for (const params of cases) {
      expect(buildCapabilities(params).canSyncDrafts).toBe(false);
      expect(buildCapabilities(params).canSubmitToGitHub).toBe(false);
    }
  });

  /**
   * Phase 3. Same truth table as canViewPRComments on purpose: both perform a
   * LIVE fetch and neither needs a warm `pr_metadata` cache, so neither is
   * gated on `prMetadataAvailable`. Pinning the independence here is what
   * stops a future "tidy-up" from folding the cache back into the gate and
   * silently hiding the feature on a cold cache.
   */
  describe('canCheckStaleVsPR (Phase 3)', () => {
    it('is true only with BOTH a usable association and a token', () => {
      expect(buildCapabilities({ association: null, hasToken: true }).canCheckStaleVsPR).toBe(false);
      expect(buildCapabilities({ association: { prNumber: 1, repository: 'a/b' }, hasToken: false }).canCheckStaleVsPR).toBe(false);
      expect(buildCapabilities({ association: { prNumber: 1, repository: 'a/b' }, hasToken: true }).canCheckStaleVsPR).toBe(true);
    });

    it('is NOT gated on prMetadataAvailable — a cold cache still allows the check', () => {
      const caps = buildCapabilities({
        association: { prNumber: 1, repository: 'a/b' },
        hasToken: true,
        prMetadataAvailable: false,
      });
      expect(caps.canShowPRMetadata).toBe(false);
      expect(caps.canCheckStaleVsPR).toBe(true);
    });

    it('falls with hasAssociatedPR when the association is not a usable target', () => {
      const caps = buildCapabilities({ association: { prNumber: '123', repository: 'a/b' }, hasToken: true });
      expect(caps.hasAssociatedPR).toBe(false);
      expect(caps.canCheckStaleVsPR).toBe(false);
    });
  });

  it('flips hasAssociatedPR only when both prNumber and repository present', () => {
    expect(buildCapabilities({ association: null, hasToken: true }).hasAssociatedPR).toBe(false);
    expect(buildCapabilities({ association: { prNumber: null, repository: 'a/b' }, hasToken: true }).hasAssociatedPR).toBe(false);
    expect(buildCapabilities({ association: { prNumber: 1, repository: '' }, hasToken: true }).hasAssociatedPR).toBe(false);
    expect(buildCapabilities({ association: { prNumber: 1, repository: 'a/b' }, hasToken: true }).hasAssociatedPR).toBe(true);
  });

  /**
   * `hasAssociatedPR` gates the controls whose ONE action is the
   * external-comments sync. That sync applies a stricter test than "both
   * fields are truthy": `buildCommentTarget` rejects a non-integer PR number
   * outright (→ generic "no PR target" 400) and `executeSync` rejects a
   * repository that does not split into owner AND repo (→ "Invalid
   * review.repository" 400). A looser flag here surfaces to the user as a
   * refresh that fails with no explanation.
   */
  describe('hasAssociatedPR agrees with the sync target rule', () => {
    it('rejects a non-integer PR number (string, float, NaN)', () => {
      // A string is truthy — this is precisely what the old test missed.
      expect(buildCapabilities({ association: { prNumber: '123', repository: 'a/b' }, hasToken: true }).hasAssociatedPR).toBe(false);
      expect(buildCapabilities({ association: { prNumber: 12.5, repository: 'a/b' }, hasToken: true }).hasAssociatedPR).toBe(false);
      expect(buildCapabilities({ association: { prNumber: NaN, repository: 'a/b' }, hasToken: true }).hasAssociatedPR).toBe(false);
    });

    it('rejects a repository that is not owner/repo', () => {
      expect(buildCapabilities({ association: { prNumber: 1, repository: 'norepo' }, hasToken: true }).hasAssociatedPR).toBe(false);
      expect(buildCapabilities({ association: { prNumber: 1, repository: '/repo' }, hasToken: true }).hasAssociatedPR).toBe(false);
      expect(buildCapabilities({ association: { prNumber: 1, repository: 'owner/' }, hasToken: true }).hasAssociatedPR).toBe(false);
      expect(buildCapabilities({ association: { prNumber: 1, repository: 42 }, hasToken: true }).hasAssociatedPR).toBe(false);
    });

    it('ACCEPTS a/b/c — the sync accepts it too, so the flag must not be stricter', () => {
      // splitRepository yields owner 'a', repo 'b/c'; buildCommentTarget's
      // two-element split yields owner 'a', repo 'b'. They disagree about what
      // `repo` CONTAINS but agree the target is usable, and this flag is only
      // the boolean. Pinning it here keeps a future "tidy-up" from making the
      // capability stricter than the endpoint it advertises.
      expect(buildCapabilities({ association: { prNumber: 1, repository: 'a/b/c' }, hasToken: true }).hasAssociatedPR).toBe(true);
    });

    it('drags canViewPRComments down with it — the flag it actually gates', () => {
      const caps = buildCapabilities({ association: { prNumber: '123', repository: 'a/b' }, hasToken: true });
      expect(caps.hasAssociatedPR).toBe(false);
      expect(caps.canViewPRComments).toBe(false);
      expect(caps.canShowPRMetadata).toBe(false);
    });

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

  describe('Phase 2: canViewPRComments', () => {
    const assoc = { prNumber: 1, repository: 'a/b' };

    it('is true only when an association AND a usable credential exist', () => {
      expect(buildCapabilities({ association: assoc, hasToken: true }).canViewPRComments).toBe(true);
      expect(buildCapabilities({ association: assoc, hasToken: false }).canViewPRComments).toBe(false);
      expect(buildCapabilities({ association: null, hasToken: true }).canViewPRComments).toBe(false);
      expect(buildCapabilities({ association: null, hasToken: false }).canViewPRComments).toBe(false);
    });

    it('does NOT depend on prMetadataAvailable — deliberate design decision', () => {
      // Comments and metadata are independent fetches. Withholding the
      // comments because the metadata cache happens to be cold would hide a
      // working feature; the anchor-trust check degrades to file-level
      // rendering instead. If someone "tidies" this into the
      // canShowPRMetadata gate, this test is the alarm.
      const cold = buildCapabilities({ association: assoc, hasToken: true, prMetadataAvailable: false });
      expect(cold.canViewPRComments).toBe(true);
      expect(cold.canShowPRMetadata).toBe(false);

      const warm = buildCapabilities({ association: assoc, hasToken: true, prMetadataAvailable: true });
      expect(warm.canViewPRComments).toBe(true);
      expect(warm.canShowPRMetadata).toBe(true);

      // Omitted entirely (Phase 0 callers) behaves like false.
      expect(buildCapabilities({ association: assoc, hasToken: true }).canViewPRComments).toBe(true);
    });

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
      head_sha: 'h',
      base_sha: null
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

  /**
   * `pr_metadata` has no TTL on purpose. The staleness that matters has a
   * known trigger instead — the local HEAD moving, or the user pressing
   * refresh — and `forceRefresh` is that path. Without it the ordinary
   * workflow (review uncommitted work at PR head, commit, refresh) leaves the
   * cached PR head behind forever, and every external thread renders in the
   * file zone claiming it was written against a different commit.
   */
  describe('forceRefresh', () => {
    /** Stub that starts warm and records every upsert. */
    class WarmRepo {
      constructor(row) { this.row = row; this.upserts = []; this.getCalls = 0; }
      async getByPR() { this.getCalls++; return this.row; }
      async upsertPRMetadata(args) {
        this.upserts.push(args);
        this.row = {
          title: args.prData.title,
          author: args.prData.author,
          head_sha: args.prData.head_sha,
          base_sha: args.prData.base_sha,
          pr_data_parsed: { state: args.prData.state, merged: args.prData.merged, html_url: args.prData.html_url }
        };
        return { id: 1, created: false };
      }
    }

    const staleRow = {
      title: 'Stale title', author: 'octocat',
      head_sha: 'old-head', base_sha: 'old-base',
      pr_data_parsed: { state: 'open', merged: false, html_url: 'https://x' }
    };

    const freshPR = {
      title: 'Fresh title', body: '', author: 'octocat',
      state: 'open', merged: false,
      base_branch: 'main', head_branch: 'feat',
      base_sha: 'new-base', head_sha: 'new-head',
      html_url: 'https://x', node_id: 'PR_x'
    };

    function deps(repo, calls) {
      return {
        PRMetadataRepository: function () { return repo; },
        GitHubClient: class {
          constructor(cred) { calls.push(cred); }
          async fetchPullRequest() { return freshPR; }
        },
        logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }
      };
    }

    it('serves the stale row and never calls GitHub when NOT forced', async () => {
      const repo = new WarmRepo({ ...staleRow });
      const calls = [];

      const result = await fetchPRMetadata({
        prNumber: 1, repository: 'a/b', githubToken: 'tok', db: {}, _deps: deps(repo, calls)
      });

      expect(result.head_sha).toBe('old-head');
      expect(calls).toHaveLength(0);
      expect(repo.upserts).toHaveLength(0);
    });

    it('skips the cache, re-fetches, and upserts when forced', async () => {
      const repo = new WarmRepo({ ...staleRow });
      const calls = [];

      const result = await fetchPRMetadata({
        prNumber: 1, repository: 'a/b', githubToken: 'tok', forceRefresh: true, db: {}, _deps: deps(repo, calls)
      });

      expect(calls).toHaveLength(1);
      expect(repo.upserts).toHaveLength(1);
      expect(result.title).toBe('Fresh title');
      expect(result.head_sha).toBe('new-head');
      expect(result.base_sha).toBe('new-base');
    });

    /**
     * The one that matters most: a forced refresh must not become a way to
     * persist a guessed host. `hostAmbiguous` means the caller never resolved
     * which host this dual repo's PR lives on; being asked a second time does
     * not resolve it, and writing the row is the irreversible harm (PR-mode
     * setup reads NULL `host` back as authoritative and stops probing).
     */
    it('STILL refuses when the binding host is ambiguous, even forced', async () => {
      const repo = new WarmRepo({ ...staleRow });
      const calls = [];

      const result = await fetchPRMetadata({
        prNumber: 1, repository: 'a/b',
        githubToken: 'tok',
        hostBinding: { token: 'tok', host: null, apiHost: null, hostAmbiguous: true },
        forceRefresh: true,
        db: {}, _deps: deps(repo, calls)
      });

      expect(calls).toHaveLength(0);        // no GitHubClient constructed
      expect(repo.upserts).toHaveLength(0); // and nothing stamped
      // Falls back to the row that already exists rather than to null — the
      // cached value is honest, it was stamped by whoever resolved the host.
      expect(result).toMatchObject({ title: 'Stale title', head_sha: 'old-head' });
    });

    it('keeps the cached row when a forced re-fetch throws', async () => {
      const repo = new WarmRepo({ ...staleRow });
      const result = await fetchPRMetadata({
        prNumber: 1, repository: 'a/b', githubToken: 'tok', forceRefresh: true, db: {},
        _deps: {
          PRMetadataRepository: function () { return repo; },
          GitHubClient: class { async fetchPullRequest() { throw new Error('403 rate limited'); } },
          logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }
        }
      });

      // Returning null here would flip canShowPRMetadata off over a transient
      // failure, hiding a pill that was rendering fine a second ago.
      expect(result).toMatchObject({ title: 'Stale title' });
      expect(repo.upserts).toHaveLength(0);
    });

    it('keeps the cached row when a forced refresh has no usable credential', async () => {
      const repo = new WarmRepo({ ...staleRow });
      const calls = [];

      const result = await fetchPRMetadata({
        prNumber: 1, repository: 'a/b',
        hostBinding: { token: '', host: 'https://ghe.acme.com/api/v3' },
        githubToken: 'ghp_dotcom',   // never borrowed for an alt host
        forceRefresh: true,
        db: {}, _deps: deps(repo, calls)
      });

      expect(calls).toHaveLength(0);
      expect(result).toMatchObject({ title: 'Stale title' });
    });
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

  /**
   * `base_sha` is what lets the frontend gate LEFT-side (removed-line)
   * anchors: those line numbers were resolved against the PR's BASE commit,
   * while the local diff's left side is the merge-base / base override /
   * scope. `head_sha` alone only answers the RIGHT-side question.
   */
  describe('base_sha', () => {
    it('surfaces base_sha from the column the repository merges out of pr_data', async () => {
      const Repo = class {
        async getByPR() {
          return {
            title: 't', author: 'a',
            head_sha: 'head-1', base_sha: 'base-1',
            pr_data_parsed: { state: 'open', html_url: 'u' }
          };
        }
      };
      const result = await getCachedPRMetadata({
        prNumber: 1, repository: 'a/b', db: {}, _deps: { PRMetadataRepository: Repo }
      });

      expect(result.base_sha).toBe('base-1');
      expect(result.head_sha).toBe('head-1');
    });

    it('falls back to pr_data when the merged column is absent', async () => {
      const result = await getCachedPRMetadata({
        prNumber: 1, repository: 'a/b', db: {},
        _deps: { PRMetadataRepository: class {
          async getByPR() {
            return { title: 't', author: 'a', pr_data_parsed: { state: 'open', html_url: 'u', base_sha: 'from-blob', head_sha: 'h' } };
          }
        } }
      });

      expect(result.base_sha).toBe('from-blob');
    });

    it('is null (never undefined) for a legacy row carrying neither', async () => {
      const result = await getCachedPRMetadata({
        prNumber: 1, repository: 'a/b', db: {},
        _deps: { PRMetadataRepository: cachedRow({ state: 'open', html_url: 'u' }) }
      });

      // Explicit null matters: the frontend distinguishes "no base sha known"
      // from "key missing" when merging this into existing state.
      expect(result.base_sha).toBeNull();
      expect('base_sha' in result).toBe(true);
    });
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
      head_sha: 'h',
      base_sha: null
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

/**
 * FINDING 1 + FINDING 2: `resolveRepositoryBinding` is the ONE resolver, and
 * it asks the checkout's remote BEFORE it asks the ambiguity rule.
 *
 * These drive the resolver directly (no Express app, no CLI) and then feed its
 * output into `fetchPRMetadata`, which is the whole point: the binding the
 * WRITE side detects with is byte-for-byte the binding the READ side fetches
 * and stamps with.
 */
describe('resolveRepositoryBinding: one resolver for detection and metadata-fetch', () => {
  const prContext = require('../../src/providers/pr-context');
  const configModule = require('../../src/config');
  const hostResolution = require('../../src/utils/host-resolution');
  const { resolveRepositoryBinding, resolveAssociationBinding, _hostBindingInternals } = prContext;

  const ALT_HOST = 'https://alt.example.com/api/v3';
  const REPO = 'acme/widgets';
  const CHECKOUT = '/checkout/widgets';

  /** DUAL: api_host + exclusive:false — PRs may live on either host. */
  const dualConfig = () => ({
    github_token: 'GH_TOKEN',
    repos: { [REPO]: { api_host: ALT_HOST, exclusive: false, token: 'ALT_TOKEN' } }
  });

  beforeEach(() => {
    vi.stubEnv('GITHUB_TOKEN', '');
    _hostBindingInternals.clearHostBindingFailureCache();
    _hostBindingInternals.clearRemoteHostnameCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _hostBindingInternals.clearHostBindingFailureCache();
    _hostBindingInternals.clearRemoteHostnameCache();
    vi.restoreAllMocks();
  });

  /** Repo stub that records what fetchPRMetadata persists. */
  class RecordingRepo {
    constructor() { this.row = null; this.upserts = []; }
    async getByPR() { return this.row; }
    async upsertPRMetadata(args) {
      this.upserts.push(args);
      this.row = {
        title: args.prData.title, author: args.prData.author, head_sha: args.prData.head_sha,
        pr_data_parsed: { state: args.prData.state, merged: false, html_url: args.prData.html_url }
      };
      return { id: 1, created: true };
    }
  }

  function fetchDeps(repo, seen) {
    return {
      PRMetadataRepository: function () { return repo; },
      GitHubClient: class {
        constructor(arg) { seen.push(arg); }
        async fetchPullRequest() {
          return { title: 'remote', author: 'octocat', state: 'open', merged: false, head_sha: 'bbb', html_url: 'https://x' };
        }
      }
    };
  }

  it('feeds the alt-host binding straight into fetchPRMetadata, which stamps that host', async () => {
    _hostBindingInternals.setRemoteHostname(CHECKOUT, 'alt.example.com');
    const config = dualConfig();

    // WRITE side: what branch → PR detection would use.
    const detectionBinding = resolveRepositoryBinding(REPO, config, { localPath: CHECKOUT });
    // READ side: what the metadata fetch would use for the association it wrote.
    const readBinding = resolveAssociationBinding({ prNumber: 77, repository: REPO }, config, { localPath: CHECKOUT });

    expect(detectionBinding).toMatchObject({ host: ALT_HOST, apiHost: ALT_HOST, token: 'ALT_TOKEN' });
    expect(readBinding.host).toBe(detectionBinding.host);
    expect(readBinding.token).toBe(detectionBinding.token);

    const repo = new RecordingRepo();
    const seen = [];
    const result = await fetchPRMetadata({
      prNumber: 77, repository: REPO, githubToken: 'GH_TOKEN',
      hostBinding: readBinding, db: {}, _deps: fetchDeps(repo, seen)
    });

    expect(result).toBeTruthy();
    expect(seen).toEqual([readBinding]);          // the alt binding, not the bare github token
    expect(repo.upserts[0].host).toBe(ALT_HOST);  // and the row is stamped with that host
  });

  it('stays ambiguous on BOTH sides when the remote matches neither host, and the fetch refuses', async () => {
    _hostBindingInternals.setRemoteHostname(CHECKOUT, 'mirror.internal');
    const config = dualConfig();

    const detectionBinding = resolveRepositoryBinding(REPO, config, { localPath: CHECKOUT });
    const readBinding = resolveAssociationBinding({ prNumber: 77, repository: REPO }, config, { localPath: CHECKOUT });

    expect(detectionBinding.hostAmbiguous).toBe(true);
    expect(readBinding.hostAmbiguous).toBe(true);

    const repo = new RecordingRepo();
    const seen = [];
    const result = await fetchPRMetadata({
      prNumber: 77, repository: REPO, githubToken: 'GH_TOKEN',
      hostBinding: readBinding, db: {}, _deps: fetchDeps(repo, seen)
    });

    // No GitHub call, no row: the ONLY honest encoding of "host unknown".
    expect(result).toBeNull();
    expect(seen).toEqual([]);
    expect(repo.upserts).toEqual([]);
  });

  // ------------------------------------------------------------------
  // FINDING 2: the discarded ambiguity-rule resolve
  // ------------------------------------------------------------------

  it('does NOT run the ambiguity-rule resolve when the remote answers', () => {
    // The ambiguity-rule resolve can execSync `github_token_command` (5s), and
    // its result was thrown away whenever the remote answered. Because the
    // binding actually RETURNED carries a token, the token-less failure memo
    // never recorded it either — so the shell-out recurred on every request to
    // the blocking page-load endpoints.
    _hostBindingInternals.setRemoteHostname(CHECKOUT, 'alt.example.com');
    const spy = vi.spyOn(configModule, 'resolveHostBinding');

    const binding = resolveRepositoryBinding(REPO, dualConfig(), { localPath: CHECKOUT });

    expect(binding.host).toBe(ALT_HOST);
    // Exactly one resolve, and it named a host — never the two-argument
    // ambiguity form whose answer would have been discarded.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toEqual({ host: ALT_HOST });
  });

  it('proves it with a token_command: the github chain is never consulted when the remote answers', () => {
    // The concrete cost the discarded resolve paid. `github_token_command` is
    // consulted ONLY by the github.com flavour of the binding — the one the
    // ambiguity rule produces — so a remote-derived alt binding must never
    // reach it. No top-level `github_token` here, or step 4 of the token chain
    // would short-circuit before the command and make this vacuous.
    _hostBindingInternals.setRemoteHostname(CHECKOUT, 'alt.example.com');
    let githubChainReads = 0;
    const config = {
      repos: { [REPO]: { api_host: ALT_HOST, exclusive: false, token: 'ALT_TOKEN' } }
    };
    Object.defineProperty(config, 'github_token_command', {
      enumerable: true,
      get() { githubChainReads++; return 'exit 1'; }
    });

    const binding = resolveRepositoryBinding(REPO, config, { localPath: CHECKOUT });

    expect(binding).toMatchObject({ host: ALT_HOST, token: 'ALT_TOKEN' });
    expect(githubChainReads).toBe(0);
  });

  it('still falls back to the ambiguity rule (once) when the remote cannot answer', () => {
    _hostBindingInternals.setRemoteHostname(CHECKOUT, null);
    const spy = vi.spyOn(configModule, 'resolveHostBinding');

    const binding = resolveRepositoryBinding(REPO, dualConfig(), { localPath: CHECKOUT });

    expect(binding.hostAmbiguous).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // The two-argument form: no host option.
    expect(spy.mock.calls[0][2]).toBeUndefined();
  });

  it('never reads the git remote for a NON-dual repo (nothing to disambiguate)', () => {
    const spy = vi.spyOn(hostResolution, 'getRemoteHostname');

    const plain = resolveRepositoryBinding(REPO, { github_token: 'GH_TOKEN', repos: {} }, { localPath: CHECKOUT });

    expect(plain.host).toBeNull();
    expect(plain.hostAmbiguous).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
