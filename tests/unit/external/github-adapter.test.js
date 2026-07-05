// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

const githubAdapter = require('../../../src/external/github-adapter');

describe('github-adapter', () => {
  describe('name', () => {
    it('is "github"', () => {
      expect(githubAdapter.name).toBe('github');
    });
  });

  describe('fetchComments', () => {
    it('delegates to client.listReviewComments with { owner, repo, pull_number }', async () => {
      const rows = [{ id: 1 }, { id: 2 }];
      const client = {
        listReviewComments: vi.fn().mockResolvedValue(rows),
      };

      const result = await githubAdapter.fetchComments({
        client,
        owner: 'octocat',
        repo: 'hello-world',
        pull_number: 42,
      });

      expect(client.listReviewComments).toHaveBeenCalledTimes(1);
      expect(client.listReviewComments).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello-world',
        pull_number: 42,
      });
      expect(result).toBe(rows);
    });
  });

  describe('credentialEnvVar', () => {
    it('advertises GITHUB_TOKEN', () => {
      // Surfaced in credential-missing errors so the user is told which env
      // var to set. Future adapters declare their own.
      expect(githubAdapter.credentialEnvVar).toBe('GITHUB_TOKEN');
    });
  });

  describe('resolveCredentials', () => {
    // --- No-repo fallback path (repository omitted) ---

    it('no-repo fallback: returns { client } constructed with the resolved token', () => {
      const FakeGitHubClient = vi.fn(function (tok) { this.tok = tok; });
      const getGitHubToken = vi.fn(() => 'ghp_test_token');

      const result = githubAdapter.resolveCredentials(
        { github_token: 'ghp_test_token' },
        undefined,
        { GitHubClient: FakeGitHubClient, getGitHubToken }
      );

      expect(getGitHubToken).toHaveBeenCalledTimes(1);
      expect(getGitHubToken).toHaveBeenCalledWith({ github_token: 'ghp_test_token' });
      expect(FakeGitHubClient).toHaveBeenCalledWith('ghp_test_token');
      expect(result.client).toBeInstanceOf(FakeGitHubClient);
      expect(result.client.tok).toBe('ghp_test_token');
      // No-repo fallback always targets api.github.com — never alt-host.
      expect(result.isAltHost).toBe(false);
    });

    it('no-repo fallback: missing token throws GitHubApiError(status=401) naming GITHUB_TOKEN', () => {
      const FakeGitHubClient = vi.fn();
      const getGitHubToken = vi.fn(() => '');

      let captured = null;
      try {
        githubAdapter.resolveCredentials(
          {},
          undefined,
          { GitHubClient: FakeGitHubClient, getGitHubToken }
        );
      } catch (err) {
        captured = err;
      }

      // Use the canonical error type so the route's catch ladder can
      // instanceof-match without string sniffing.
      const { GitHubApiError } = require('../../../src/github/client');
      expect(captured).toBeInstanceOf(GitHubApiError);
      expect(captured.status).toBe(401);
      expect(captured.message).toContain('GITHUB_TOKEN');
      // Client must NOT be constructed when credentials are missing.
      expect(FakeGitHubClient).not.toHaveBeenCalled();
    });

    it('no-repo fallback: null config still calls getGitHubToken with an empty object', () => {
      const getGitHubToken = vi.fn(() => 'tok');
      const FakeGitHubClient = vi.fn();

      githubAdapter.resolveCredentials(
        null,
        undefined,
        { GitHubClient: FakeGitHubClient, getGitHubToken }
      );

      expect(getGitHubToken).toHaveBeenCalledWith({});
    });

    it('no-repo fallback: uses module defaults when _deps is omitted (production code path)', () => {
      // No _deps argument — this exercises the production defaults: the
      // real getGitHubToken (which reads from config) and the real
      // GitHubClient. Pass a config with the token to drive resolution
      // without touching env vars.
      const result = githubAdapter.resolveCredentials({ github_token: 'real-tok' });
      const { GitHubClient } = require('../../../src/github/client');
      expect(result.client).toBeInstanceOf(GitHubClient);
    });

    // --- Binding-aware path (repository supplied) ---

    it('github.com repo (no api_host): builds client with the github.com binding and does NOT use the no-repo fallback', () => {
      // Drive resolution through the REAL config helpers so we exercise the
      // production resolveHostBinding path. A repo with no `repos[...]`
      // entry resolves to apiHost:null (api.github.com) using the top-level
      // github_token — identical to the old behaviour.
      const FakeGitHubClient = vi.fn(function (binding) { this.binding = binding; });
      const getGitHubToken = vi.fn(() => 'should-not-be-called');

      const result = githubAdapter.resolveCredentials(
        { github_token: 'top-level-token' },
        'octocat/hello-world',
        { GitHubClient: FakeGitHubClient, getGitHubToken }
      );

      // The no-repo fallback (getGitHubToken + bare token) must NOT run.
      expect(getGitHubToken).not.toHaveBeenCalled();

      // GitHubClient is constructed from the FULL binding object.
      expect(FakeGitHubClient).toHaveBeenCalledTimes(1);
      const binding = FakeGitHubClient.mock.calls[0][0];
      expect(typeof binding).toBe('object');
      // github.com → apiHost is null → Octokit defaults to api.github.com.
      expect(binding.apiHost).toBeNull();
      // Token comes from the top-level github.com config, same as before.
      expect(binding.token).toBe('top-level-token');
      expect(result.client).toBeInstanceOf(FakeGitHubClient);
      // No api_host on the binding → github.com → NOT alt-host. Keeps the
      // position-based mapComment path.
      expect(result.isAltHost).toBe(false);
    });

    it('alt-host repo (api_host + repo token): builds client with the alt-host binding and the repo-scoped token', () => {
      // A repos["owner/repo"] entry with api_host + token must route to that
      // host with that token — NOT api.github.com / the top-level token.
      const FakeGitHubClient = vi.fn(function (binding) { this.binding = binding; });

      const config = {
        github_token: 'github-com-top-level-token',
        repos: {
          'shop/world-gitstream-perf': {
            api_host: 'https://git.example.com/api/v3',
            token: 'alt-host-repo-token'
          }
        }
      };

      const result = githubAdapter.resolveCredentials(
        config,
        'shop/world-gitstream-perf',
        { GitHubClient: FakeGitHubClient }
      );

      expect(FakeGitHubClient).toHaveBeenCalledTimes(1);
      const binding = FakeGitHubClient.mock.calls[0][0];
      // Routes to the alt-host api_host, not api.github.com.
      expect(binding.apiHost).toBe('https://git.example.com/api/v3');
      // Uses the repo-scoped token, NOT the top-level github.com token.
      expect(binding.token).toBe('alt-host-repo-token');
      expect(binding.token).not.toBe('github-com-top-level-token');
      expect(result.client).toBeInstanceOf(FakeGitHubClient);
      // api_host present on the binding → alt-host → drives line-based
      // anchoring in mapComment.
      expect(result.isAltHost).toBe(true);
    });

    it('binding-aware: resolves the binding key via resolveBindingRepositoryFromPR before resolveHostBinding', () => {
      // Verify the helper chain wiring using injected fakes: the binding key
      // returned by resolveBindingRepositoryFromPR is what gets passed to
      // resolveHostBinding (mirrors resolveBindingForRequest in routes/pr.js).
      const FakeGitHubClient = vi.fn(function (binding) { this.binding = binding; });
      const fakeBinding = { apiHost: 'https://ghe.internal/api/v3', token: 'tok', features: {}, source: 'repo:token' };
      const resolveBindingRepositoryFromPR = vi.fn(() => 'monorepo/key');
      const resolveHostBinding = vi.fn(() => fakeBinding);

      const result = githubAdapter.resolveCredentials(
        { repos: {} },
        'OctoCat/Hello-World',
        { GitHubClient: FakeGitHubClient, resolveBindingRepositoryFromPR, resolveHostBinding }
      );

      expect(resolveBindingRepositoryFromPR).toHaveBeenCalledWith('OctoCat', 'Hello-World', { repos: {} });
      // Third arg is the resolved host option; with no storedHost it is {} (ambiguity).
      expect(resolveHostBinding).toHaveBeenCalledWith('monorepo/key', { repos: {} }, {});
      expect(FakeGitHubClient).toHaveBeenCalledWith(fakeBinding);
      expect(result.client.binding).toBe(fakeBinding);
      // fakeBinding.apiHost is set → alt-host.
      expect(result.isAltHost).toBe(true);
    });

    it('dual repo: a stored alt host pins the alt binding (options.storedHost = api_host)', () => {
      // Dual repo (api_host + exclusive:false). A stored alt host must resolve
      // the ALT binding (and isAltHost=true → line-based anchoring), not the
      // two-arg github ambiguity binding.
      const FakeGitHubClient = vi.fn(function (binding) { this.binding = binding; });
      const config = {
        github_token: 'gh-tok',
        repos: {
          'acme/widgets': { api_host: 'https://alt.example/api/v3', exclusive: false, token: 'alt-tok' }
        }
      };

      const result = githubAdapter.resolveCredentials(
        config,
        'acme/widgets',
        { GitHubClient: FakeGitHubClient },
        { storedHost: 'https://alt.example/api/v3' }
      );

      const binding = FakeGitHubClient.mock.calls[0][0];
      expect(binding.apiHost).toBe('https://alt.example/api/v3');
      expect(binding.token).toBe('alt-tok');
      expect(result.isAltHost).toBe(true);
    });

    it('dual repo: a stored NULL host binds github.com (options.storedHost = null)', () => {
      const FakeGitHubClient = vi.fn(function (binding) { this.binding = binding; });
      const config = {
        github_token: 'gh-tok',
        repos: {
          'acme/widgets': { api_host: 'https://alt.example/api/v3', exclusive: false, token: 'alt-tok' }
        }
      };

      const result = githubAdapter.resolveCredentials(
        config,
        'acme/widgets',
        { GitHubClient: FakeGitHubClient },
        { storedHost: null }
      );

      const binding = FakeGitHubClient.mock.calls[0][0];
      expect(binding.apiHost).toBe(null);
      expect(binding.token).toBe('gh-tok');
      expect(result.isAltHost).toBe(false);
    });

    it('binding-aware: alt-host repo with no token throws GitHubApiError(status=401) mentioning repo-scoped token', () => {
      // An alt-host repo (api_host set) does NOT fall back to the github.com
      // top-level token, so a missing repo-scoped token must surface a 401.
      const FakeGitHubClient = vi.fn();

      const config = {
        github_token: 'github-com-top-level-token',
        repos: {
          'shop/world-gitstream-perf': {
            api_host: 'https://git.example.com/api/v3'
            // no token / token_command
          }
        }
      };

      let captured = null;
      try {
        githubAdapter.resolveCredentials(
          config,
          'shop/world-gitstream-perf',
          { GitHubClient: FakeGitHubClient }
        );
      } catch (err) {
        captured = err;
      }

      const { GitHubApiError } = require('../../../src/github/client');
      expect(captured).toBeInstanceOf(GitHubApiError);
      expect(captured.status).toBe(401);
      // Mentions the canonical env var/config key AND the repo-scoped token.
      expect(captured.message).toContain('GITHUB_TOKEN');
      expect(captured.message).toMatch(/token_command|repos\[/);
      // Client must NOT be constructed when credentials are missing.
      expect(FakeGitHubClient).not.toHaveBeenCalled();
    });
  });

  describe('mapComment', () => {
    function baseRow(overrides = {}) {
      return {
        id: 100,
        in_reply_to_id: null,
        html_url: 'https://github.com/octocat/hello-world/pull/42#discussion_r100',
        user: {
          login: 'octocat',
          html_url: 'https://github.com/octocat',
        },
        path: 'src/file.js',
        side: 'RIGHT',
        start_line: null,
        line: 17,
        position: 5,
        commit_id: 'abc123',
        original_start_line: null,
        original_line: 17,
        original_commit_id: 'def456',
        body: 'Nice work here.',
        created_at: '2026-01-02T03:04:05Z',
        ...overrides,
      };
    }

    it('happy path: maps a typical single-line comment', () => {
      const row = baseRow();
      const mapped = githubAdapter.mapComment(row);

      expect(mapped).toEqual({
        external_id: '100',
        in_reply_to_id: null,
        external_url: 'https://github.com/octocat/hello-world/pull/42#discussion_r100',
        author: 'octocat',
        author_url: 'https://github.com/octocat',
        file: 'src/file.js',
        side: 'RIGHT',
        line_start: 17,
        line_end: 17,
        diff_position: 5,
        commit_sha: 'abc123',
        is_outdated: 0,
        original_line_start: 17,
        original_line_end: 17,
        original_commit_sha: 'def456',
        body: 'Nice work here.',
        external_created_at: '2026-01-02T03:04:05Z',
      });
      expect(mapped).not.toHaveProperty('source');
      expect(mapped).not.toHaveProperty('synced_at');
      expect(mapped).not.toHaveProperty('parent_id');
    });

    it('multi-line comment: start_line populated, line is the end', () => {
      const row = baseRow({
        start_line: 12,
        line: 17,
        original_start_line: 12,
        original_line: 17,
      });
      const mapped = githubAdapter.mapComment(row);

      expect(mapped.line_start).toBe(12);
      expect(mapped.line_end).toBe(17);
      expect(mapped.original_line_start).toBe(12);
      expect(mapped.original_line_end).toBe(17);
    });

    it('reply: in_reply_to_id is stringified', () => {
      const row = baseRow({ id: 200, in_reply_to_id: 100 });
      const mapped = githubAdapter.mapComment(row);

      expect(mapped.external_id).toBe('200');
      expect(mapped.in_reply_to_id).toBe('100');
      expect(typeof mapped.in_reply_to_id).toBe('string');
    });

    it('outdated comment: position null → is_outdated 1, current line fields null, original fields populated', () => {
      const row = baseRow({
        position: null,
        line: null,
        start_line: null,
        commit_id: null,
        original_start_line: 12,
        original_line: 17,
        original_commit_id: 'old-sha',
      });
      const mapped = githubAdapter.mapComment(row);

      expect(mapped.is_outdated).toBe(1);
      expect(mapped.diff_position).toBeNull();
      expect(mapped.line_start).toBeNull();
      expect(mapped.line_end).toBeNull();
      expect(mapped.commit_sha).toBeNull();
      expect(mapped.original_line_start).toBe(12);
      expect(mapped.original_line_end).toBe(17);
      expect(mapped.original_commit_sha).toBe('old-sha');
    });

    it('outdated with leftover line: position null but line populated → line_* still nulled, original_* preserved', () => {
      // GitHub sometimes returns `line` populated even when `position` is
      // null. The adapter must treat position=null as the source of truth
      // for "outdated" and null out current-anchor fields, otherwise the
      // row carries two contradictory truths (line_end set AND is_outdated=1)
      // and the lost-anchor filter under-counts.
      const row = baseRow({
        position: null,
        line: 42,
        start_line: 40,
        original_start_line: 12,
        original_line: 17,
      });
      const mapped = githubAdapter.mapComment(row);

      expect(mapped.is_outdated).toBe(1);
      expect(mapped.line_start).toBeNull();
      expect(mapped.line_end).toBeNull();
      expect(mapped.diff_position).toBeNull();
      expect(mapped.original_line_start).toBe(12);
      expect(mapped.original_line_end).toBe(17);
    });

    it('lost anchor: position and original_position both null still produces a row, no throw', () => {
      const row = baseRow({
        position: null,
        original_position: null,
        line: null,
        start_line: null,
        original_line: null,
        original_start_line: null,
        commit_id: null,
        original_commit_id: null,
      });

      let mapped;
      expect(() => {
        mapped = githubAdapter.mapComment(row);
      }).not.toThrow();

      expect(mapped.is_outdated).toBe(1);
      expect(mapped.line_start).toBeNull();
      expect(mapped.line_end).toBeNull();
      expect(mapped.diff_position).toBeNull();
      expect(mapped.original_line_start).toBeNull();
      expect(mapped.original_line_end).toBeNull();
      // Still has identity / body / file
      expect(mapped.external_id).toBe('100');
      expect(mapped.file).toBe('src/file.js');
    });

    it('deleted user: user: null → author and author_url null, no throw', () => {
      const row = baseRow({ user: null });
      const mapped = githubAdapter.mapComment(row);

      expect(mapped.author).toBeNull();
      expect(mapped.author_url).toBeNull();
    });

    it('missing path: throws with a clear message', () => {
      const row = baseRow();
      delete row.path;

      expect(() => githubAdapter.mapComment(row)).toThrow(
        /GitHub adapter: comment missing required field "path"/
      );
    });

    it('null apiRow: throws with a clear message', () => {
      expect(() => githubAdapter.mapComment(null)).toThrow(
        /GitHub adapter: comment missing required field "path"/
      );
    });

    it('missing id: throws with a clear message (prevents String(undefined) UNIQUE collision)', () => {
      // Regression: without this validation, `String(undefined)` becomes
      // the literal 'undefined' and gets upserted as a valid external_id.
      // Multiple bad rows would then UNIQUE-collide on 'undefined' and
      // overwrite each other.
      const row = baseRow();
      delete row.id;
      expect(() => githubAdapter.mapComment(row)).toThrow(
        /GitHub adapter: comment missing required field "id"/
      );
    });

    it('id === null: throws with a clear message', () => {
      const row = baseRow({ id: null });
      expect(() => githubAdapter.mapComment(row)).toThrow(
        /GitHub adapter: comment missing required field "id"/
      );
    });

    it('missing body: defaults to empty string', () => {
      const row = baseRow();
      delete row.body;
      const mapped = githubAdapter.mapComment(row);
      expect(mapped.body).toBe('');
    });

    it('missing optional fields: yields nulls without throwing', () => {
      const row = {
        id: 999,
        path: 'a/b.js',
        user: { login: 'u' }, // no html_url
      };
      const mapped = githubAdapter.mapComment(row);
      expect(mapped.external_id).toBe('999');
      expect(mapped.author).toBe('u');
      expect(mapped.author_url).toBeNull();
      expect(mapped.side).toBeNull();
      expect(mapped.line_start).toBeNull();
      expect(mapped.line_end).toBeNull();
      expect(mapped.diff_position).toBeNull();
      expect(mapped.commit_sha).toBeNull();
      expect(mapped.external_url).toBeNull();
      expect(mapped.external_created_at).toBeNull();
      expect(mapped.is_outdated).toBe(1);
    });

    // --- github.com parity pin (CRITICAL) ---
    // These pin the github.com (default / isAltHost:false) path so the
    // host-aware change can NEVER regress github.com behavior.

    it('github.com (explicit isAltHost:false): position null + line present → is_outdated 1, line_* null, diff_position null', () => {
      // Byte-identical to the implicit-default behavior. `position` is the
      // outdated signal on github.com; a leftover `line` must be discarded.
      const row = baseRow({
        position: null,
        line: 42,
        start_line: 40,
        original_start_line: 12,
        original_line: 17,
      });
      const mapped = githubAdapter.mapComment(row, { isAltHost: false });

      expect(mapped.is_outdated).toBe(1);
      expect(mapped.line_start).toBeNull();
      expect(mapped.line_end).toBeNull();
      expect(mapped.diff_position).toBeNull();
      // original_* still authoritative.
      expect(mapped.original_line_start).toBe(12);
      expect(mapped.original_line_end).toBe(17);
    });

    it('github.com: a normal current comment maps as today (position-based)', () => {
      // No options arg == github.com. A current comment (position set) keeps
      // its line anchors and is_outdated 0.
      const row = baseRow({ position: 5, line: 17, start_line: 12 });
      const mapped = githubAdapter.mapComment(row);

      expect(mapped.is_outdated).toBe(0);
      expect(mapped.line_start).toBe(12);
      expect(mapped.line_end).toBe(17);
      expect(mapped.diff_position).toBe(5);
    });
  });

  // --- Alt-host mapComment (line-based anchoring) ---
  describe('mapComment (alt-host)', () => {
    function baseRow(overrides = {}) {
      return {
        id: 100,
        in_reply_to_id: null,
        html_url: 'https://git.example.com/owner/repo/pull/42#discussion_r100',
        user: { login: 'octocat', html_url: 'https://git.example.com/octocat' },
        path: 'src/file.js',
        side: 'RIGHT',
        start_line: null,
        line: 41,
        // Alt-hosts don't implement GitHub's deprecated diff-relative
        // `position`, so it arrives null even for current comments.
        position: null,
        commit_id: 'abc123',
        original_start_line: null,
        original_line: 41,
        original_commit_id: 'def456',
        body: 'Alt-host comment.',
        created_at: '2026-01-02T03:04:05Z',
        ...overrides,
      };
    }

    it('current comment: position null but line present → line-anchored, is_outdated 0, diff_position null', () => {
      // The user's exact symptom: alt-host returns position:null + a good
      // `line`. The github.com path would discard `line` (→ lost anchor).
      // The alt-host path must keep it.
      const row = baseRow({ position: null, line: 41, start_line: null });
      const mapped = githubAdapter.mapComment(row, { isAltHost: true });

      expect(mapped.is_outdated).toBe(0);
      expect(mapped.line_end).toBe(41);
      // line_start falls back to line when start_line is null.
      expect(mapped.line_start).toBe(41);
      // diff_position carried through (null is fine — frontend renders by line).
      expect(mapped.diff_position).toBeNull();
    });

    it('range comment: start_line + line map both anchors', () => {
      const row = baseRow({ position: null, start_line: 38, line: 41 });
      const mapped = githubAdapter.mapComment(row, { isAltHost: true });

      expect(mapped.is_outdated).toBe(0);
      expect(mapped.line_start).toBe(38);
      expect(mapped.line_end).toBe(41);
    });

    it('genuinely outdated: line null, original_line set → is_outdated 1, anchored via original_*', () => {
      const row = baseRow({
        position: null,
        line: null,
        start_line: null,
        original_start_line: null,
        original_line: 38,
        original_commit_id: 'old-sha',
      });
      const mapped = githubAdapter.mapComment(row, { isAltHost: true });

      expect(mapped.is_outdated).toBe(1);
      expect(mapped.line_start).toBeNull();
      expect(mapped.line_end).toBeNull();
      expect(mapped.original_line_start).toBe(38);
      expect(mapped.original_line_end).toBe(38);
      expect(mapped.original_commit_sha).toBe('old-sha');
    });

    it('truly lost anchor: line null AND original_line null → both anchors null (still counts as lost)', () => {
      const row = baseRow({
        position: null,
        line: null,
        start_line: null,
        original_line: null,
        original_start_line: null,
      });
      const mapped = githubAdapter.mapComment(row, { isAltHost: true });

      expect(mapped.is_outdated).toBe(1);
      expect(mapped.line_end).toBeNull();
      expect(mapped.original_line_end).toBeNull();
      // Still a valid row (identity/body preserved) — the route filters it.
      expect(mapped.external_id).toBe('100');
    });

    it('carries position through when an alt-host does happen to return it', () => {
      // Uniformly line-based: even if `position` is non-null, anchoring keys
      // off `line`. position is carried through to diff_position unchanged.
      const row = baseRow({ position: 7, line: 41 });
      const mapped = githubAdapter.mapComment(row, { isAltHost: true });

      expect(mapped.is_outdated).toBe(0);
      expect(mapped.line_end).toBe(41);
      expect(mapped.diff_position).toBe(7);
    });
  });
});
