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
    it('happy path: returns { client } constructed with the resolved token', () => {
      const FakeGitHubClient = vi.fn(function (tok) { this.tok = tok; });
      const getGitHubToken = vi.fn(() => 'ghp_test_token');

      const result = githubAdapter.resolveCredentials(
        { github_token: 'ghp_test_token' },
        { GitHubClient: FakeGitHubClient, getGitHubToken }
      );

      expect(getGitHubToken).toHaveBeenCalledTimes(1);
      expect(getGitHubToken).toHaveBeenCalledWith({ github_token: 'ghp_test_token' });
      expect(FakeGitHubClient).toHaveBeenCalledWith('ghp_test_token');
      expect(result.client).toBeInstanceOf(FakeGitHubClient);
      expect(result.client.tok).toBe('ghp_test_token');
    });

    it('missing token: throws GitHubApiError(status=401) naming GITHUB_TOKEN', () => {
      const FakeGitHubClient = vi.fn();
      const getGitHubToken = vi.fn(() => '');

      let captured = null;
      try {
        githubAdapter.resolveCredentials(
          {},
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

    it('null config: still calls getGitHubToken with an empty object', () => {
      const getGitHubToken = vi.fn(() => 'tok');
      const FakeGitHubClient = vi.fn();

      githubAdapter.resolveCredentials(
        null,
        { GitHubClient: FakeGitHubClient, getGitHubToken }
      );

      expect(getGitHubToken).toHaveBeenCalledWith({});
    });

    it('uses module defaults when _deps is omitted (production code path)', () => {
      // No _deps argument — this exercises the production defaults: the
      // real getGitHubToken (which reads from config) and the real
      // GitHubClient. Pass a config with the token to drive resolution
      // without touching env vars.
      const result = githubAdapter.resolveCredentials({ github_token: 'real-tok' });
      const { GitHubClient } = require('../../../src/github/client');
      expect(result.client).toBeInstanceOf(GitHubClient);
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
  });
});
