// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { Octokit } = require('@octokit/rest');
const { GitHubClient } = require('../../../src/github/client');
const { validateRepoConfig, resolveHostBinding } = require('../../../src/config');

const ref = {
  owner: 'team', repo: 'project', pull_number: 12,
  github_comment_id: '91', github_comment_node_id: 'COMMENT_91',
  github_review_id: '7', github_node_id: 'REVIEW_7'
};
const body = 'line\r\n```suggestion\r\nreplacement  \r\n```  ';
const wire = {
  id: 91, node_id: 'COMMENT_91', html_url: 'https://github.com/team/project/pull/12#discussion_r91',
  user: { login: 'author' }, in_reply_to_id: null, path: 'a.js',
  line: 9, start_line: 7, side: 'LEFT', start_side: 'LEFT',
  original_line: 8, original_start_line: 6, subject_type: 'line',
  body, created_at: '2026-10-01T00:00:00Z'
};
const graphRow = {
  id: wire.node_id, fullDatabaseId: String(wire.id), url: wire.html_url,
  author: { login: 'author' }, replyTo: null, path: wire.path,
  line: 9, startLine: 7, originalLine: 8, originalStartLine: 6,
  subjectType: 'LINE', body, createdAt: wire.created_at
};

function harness(mode, handler, features = {}, apiHost = null) {
  const calls = [];
  const client = new GitHubClient({ token: 'fake-token', apiHost, features: { review_comment_edit: mode, ...features } });
  client.octokit = new Octokit({ baseUrl: apiHost || undefined, request: { fetch: async (url, options) => {
    const call = { url: String(url), method: options.method, payload: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    // This sentinel applies to ALL transport calls, including failures and ID reads.
    if (call.method === 'POST') {
      expect(call.url).toBe('https://api.github.com/graphql');
      expect(call.payload.query).not.toMatch(/\b(?:add|create)\w*\s*\(/i);
    } else {
      expect(['GET', 'PATCH']).toContain(call.method);
    }
    const result = await handler(call, calls.length);
    return new Response(JSON.stringify(result.data), {
      status: result.status || 200,
      headers: { 'content-type': 'application/json', ...result.headers }
    });
  } } });
  return { client, calls };
}

for (const mode of ['graphql', 'rest', 'host']) {
  describe(`review_comment_edit ${mode}`, () => {
    it('updates exactly the existing comment and returns the unmodified host body', async () => {
      const { client, calls } = harness(mode, call => {
        if (mode === 'graphql') {
          expect(call.payload.variables).toMatchObject({ id: 'COMMENT_91', body });
          expect(call.payload.query).toContain('updatePullRequestReviewComment');
          return { data: { data: { updatePullRequestReviewComment: { pullRequestReviewComment: graphRow } } } };
        }
        expect(call.method).toBe('PATCH');
        expect(call.url).toBe('https://api.github.com/repos/team/project/pulls/comments/91');
        expect(call.payload).toEqual({ body });
        return { data: wire };
      });
      expect(await client.updateReviewComment(ref, body)).toEqual({
        github_comment_id: '91', github_comment_node_id: 'COMMENT_91', github_comment_url: wire.html_url, body
      });
      expect(calls).toHaveLength(1);
    });

    it('paginates the pending review, keeps replies distinct and preserves raw bodies/geometry', async () => {
      const { client, calls } = harness(mode, call => {
        if (call.method === 'POST') {
          expect(call.payload.query).toContain('comments(first: 100, after: $cursor)');
          expect(call.payload.variables.id).toBe('REVIEW_7');
          const second = call.payload.variables.cursor === 'next';
          return { data: { data: { node: { fullDatabaseId: '7', state: 'PENDING', comments: {
            nodes: [second ? { ...graphRow, id: 'COMMENT_92', fullDatabaseId: '92', replyTo: { fullDatabaseId: '91' } } : graphRow],
            pageInfo: { hasNextPage: !second, endCursor: second ? null : 'next' }
          } } } } };
        }
        expect(call.url).toContain('/repos/team/project/pulls/12/reviews/7/comments');
        const second = call.url.includes('page=2');
        return {
          data: [second ? { ...wire, id: 92, node_id: 'COMMENT_92', in_reply_to_id: 91 } : wire],
          headers: second ? {} : { link: '<https://api.github.com/repos/team/project/pulls/12/reviews/7/comments?per_page=100&page=2>; rel="next"' }
        };
      });
      const rows = await client.listCommentsForReview(ref);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: '91', node_id: 'COMMENT_91', github_comment_id: '91',
        html_url: wire.html_url, author_login: 'author', user: { login: 'author' },
        in_reply_to_id: null, path: 'a.js', line: 9, start_line: 7,
        side: 'LEFT', start_side: 'LEFT', original_line: 8, original_start_line: 6,
        subject_type: 'line', body, created_at: wire.created_at
      });
      expect(rows[1].in_reply_to_id).toBe('91');
      expect(calls).toHaveLength(mode === 'graphql' ? 4 : 2);
    });

    for (const [status, code] of [[404, 'not_found'], [403, 'forbidden'], [422, 'forbidden']]) {
      it(`reports ${status} as ${code} and never recreates`, async () => {
        const { client, calls } = harness(mode, () => ({ status, data: { message: 'No update' } }));
        await expect(client.updateReviewComment(ref, body)).rejects.toMatchObject({ code, status });
        expect(calls).toHaveLength(1);
      });
    }

    it('returns the host snapshot when editing a comment in a pending draft', async () => {
      const sent = 'new draft body';
      const returned = 'new draft body\r\n  ';
      const { client, calls } = harness(mode, () => mode === 'graphql'
        ? { data: { data: { updatePullRequestReviewComment: { pullRequestReviewComment: { ...graphRow, body: returned, state: 'PENDING' } } } } }
        : { data: { ...wire, body: returned, state: 'PENDING' } });
      expect((await client.updateReviewComment(ref, sent)).body).toBe(returned);
      expect(calls).toHaveLength(1);
    });

    it('rejects a missing comment identity without a request', async () => {
      const { client, calls } = harness(mode, () => { throw new Error('must not call'); });
      await expect(client.updateReviewComment({ owner: 'team', repo: 'project' }, body)).rejects.toMatchObject({ code: 'invalid_ref' });
      expect(calls).toHaveLength(0);
    });

    it('rejects a missing review identity without a request', async () => {
      const { client, calls } = harness(mode, () => { throw new Error('must not call'); });
      await expect(client.listCommentsForReview({ owner: 'team', repo: 'project', pull_number: 12 })).rejects.toMatchObject({ code: 'invalid_ref' });
      expect(calls).toHaveLength(0);
    });
  });
}

describe('review comment safe reads', () => {
  it('resolves a numeric comment id to a node id with a GET before editing', async () => {
    const { client, calls } = harness('graphql', call => call.method === 'GET'
      ? { data: wire }
      : { data: { data: { updatePullRequestReviewComment: { pullRequestReviewComment: graphRow } } } });
    await client.updateReviewComment({ ...ref, github_comment_node_id: null }, body);
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST']);
    expect(calls[1].payload.variables.id).toBe('COMMENT_91');
  });

  it('resolves a node comment id with a GraphQL query before REST editing', async () => {
    const { client, calls } = harness('rest', call => call.method === 'POST'
      ? { data: { data: { node: { fullDatabaseId: '91' } } } }
      : { data: wire });
    await client.updateReviewComment({ ...ref, github_comment_id: null }, body);
    expect(calls[0].payload.query).toMatch(/^query/);
    expect(calls[1].method).toBe('PATCH');
  });

  it('resolves a numeric review with a safe GET and lists a file-level pending comment in GraphQL', async () => {
    const { client, calls } = harness('graphql', call => call.method === 'GET'
      ? { data: { node_id: 'REVIEW_7' } }
      : { data: { data: { node: { fullDatabaseId: '7', comments: {
        nodes: [{ ...graphRow, line: null, startLine: null, subjectType: 'FILE' }],
        pageInfo: { hasNextPage: false }
      } } } } });
    expect((await client.listCommentsForReview({ ...ref, github_node_id: null }))[0].subject_type).toBe('file');
    expect(calls).toHaveLength(2);
  });

  it.each(['NOT_FOUND', 'FORBIDDEN', 'UNPROCESSABLE'])('maps GraphQL %s to a stable code', async type => {
    const { client } = harness('graphql', () => ({ data: { errors: [{ type, message: type }] } }));
    await expect(client.updateReviewComment(ref, body)).rejects.toMatchObject({ code: type === 'NOT_FOUND' ? 'not_found' : 'forbidden' });
  });

  it('abstains when a numeric comment lookup cannot find the original', async () => {
    const { client, calls } = harness('graphql', () => ({ status: 404, data: { message: 'deleted' } }));
    await expect(client.updateReviewComment({ ...ref, github_comment_node_id: null }, body)).rejects.toMatchObject({ code: 'not_found' });
    expect(calls.map(call => call.method)).toEqual(['GET']);
  });

  it('resolves a node-only review id for REST listing', async () => {
    const { client, calls } = harness('rest', call => call.method === 'POST'
      ? { data: { data: { node: { fullDatabaseId: '7' } } } } : { data: [wire] });
    expect(await client.listCommentsForReview({ ...ref, github_review_id: null })).toHaveLength(1);
    expect(calls[0].payload.query).toMatch(/^query/);
    expect(calls[1].url).toContain('/reviews/7/comments');
  });

  it('does not infer a side if the same-review REST list omits the comment', async () => {
    const { client } = harness('graphql', call => call.method === 'POST'
      ? { data: { data: { node: { fullDatabaseId: '7', comments: {
        nodes: [graphRow], pageInfo: { hasNextPage: false }
      } } } } } : { data: [] });
    const rows = await client.listCommentsForReview(ref);
    expect(rows[0].side).toBeNull();
    expect(rows[0].subject_type).toBe('line');
  });

  it('retains unexpected errors as a cause with operation context', async () => {
    const { client } = harness('rest', () => ({ status: 500, data: { message: 'server error' } }));
    await expect(client.updateReviewComment(ref, body)).rejects.toMatchObject({ message: expect.stringContaining('updateReviewComment (rest)'), cause: expect.any(Error) });
  });

  it('uses host templates on the bound host, encoding all repeated placeholders', async () => {
    const { client, calls } = harness('host', () => ({ data: wire }), {
      review_comment_edit_endpoint: '/custom/{owner}/{repo}/{comment_id}?same={comment_id}'
    }, 'https://alt.example/api/v3');
    await client.updateReviewComment({ ...ref, owner: 'a b' }, body);
    expect(calls[0].url).toBe('https://alt.example/api/v3/custom/a%20b/project/91?same=91');
  });

  it('uses a configured review-list endpoint on the bound host', async () => {
    const { client, calls } = harness('host', () => ({ data: [wire] }), {
      review_comment_edit_list_endpoint: '/custom/{owner}/{repo}/pull/{pull_number}/review/{review_id}'
    }, 'https://alt.example/api/v3');
    expect(await client.listCommentsForReview(ref)).toHaveLength(1);
    expect(calls[0].url).toBe('https://alt.example/api/v3/custom/team/project/pull/12/review/7?per_page=100');
  });

  it('caches successful authenticated user reads and retries failed reads', async () => {
    let attempt = 0;
    const { client, calls } = harness('rest', () => ++attempt === 1
      ? { status: 500, data: { message: 'unavailable' } } : { data: { login: 'author' } });
    await expect(client.getAuthenticatedUser()).rejects.toThrow();
    const [a, b] = await Promise.all([client.getAuthenticatedUser(), client.getAuthenticatedUser()]);
    expect(a.login).toBe('author');
    expect(a).toBe(b);
    await client.getAuthenticatedUser();
    expect(calls).toHaveLength(2);
  });
});

describe('review_comment_edit config', () => {
  const config = features => ({ repos: { 'team/project': {
    ...(features.review_comment_edit === 'host' ? { api_host: 'https://alt.example/api' } : {}), features
  } } });
  it.each(['graphql', 'rest', 'host'])('accepts mode %s', mode => {
    expect(() => validateRepoConfig(config({ review_comment_edit: mode }))).not.toThrow();
  });
  it('defaults to GraphQL on github.com and REST for alt-hosts', async () => {
    expect((await resolveHostBinding('team/project', { github_token: 'fake' })).features.review_comment_edit).toBe('graphql');
    expect((await resolveHostBinding('team/project', { github_token: 'fake', repos: { 'team/project': { api_host: 'https://alt.example/api' } } })).features.review_comment_edit).toBe('rest');
  });
  for (const [key, value] of [
    ['review_comment_edit_endpoint', '/repos/{owner}/{repo}/comments/{comment_id}'],
    ['review_comment_edit_list_endpoint', '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments']
  ]) {
    it(`validates ${key}`, () => {
      expect(() => validateRepoConfig(config({ review_comment_edit: 'host', [key]: value }))).not.toThrow();
      for (const invalid of ['', 42, 'https://evil.example' + value, '//' + value, '/missing/{owner}']) {
        expect(() => validateRepoConfig(config({ review_comment_edit: 'host', [key]: invalid }))).toThrow();
      }
      expect(() => validateRepoConfig(config({ review_comment_edit: 'rest', [key]: value }))).toThrow(/only valid/);
    });
  }
});
