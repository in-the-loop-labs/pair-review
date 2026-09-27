// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const Database = require('better-sqlite3');
const { reviewPublication, transformPublication, validateTransformed, publicationPolicy,
  assertInteractivePublication } = require('../../src/review-publication');

const target = { owner: 'example', repo: 'project', repository: 'example/project', number: 7 };
const revision = { head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), state: 'open' };
const diff = 'diff --git a/a.cc b/a.cc\n--- a/a.cc\n+++ b/a.cc\n@@ -1,2 +1,2 @@\n old\n+new\n';

describe('previewed review publication', () => {
  let db, client, request, transform, args;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE reviews (id INTEGER PRIMARY KEY, review_data TEXT);
      CREATE TABLE pr_metadata (repository TEXT, pr_number INTEGER, pr_data TEXT);
      CREATE TABLE comments (id INTEGER PRIMARY KEY, review_id INTEGER, source TEXT, status TEXT,
        file TEXT, line_start INTEGER, line_end INTEGER, body TEXT, side TEXT, commit_sha TEXT,
        is_file_level INTEGER, updated_at TEXT, parent_id INTEGER, ai_run_id TEXT);
      CREATE TABLE analysis_runs (id TEXT PRIMARY KEY, head_sha TEXT);`);
    db.prepare('INSERT INTO reviews VALUES (1, ?)').run(JSON.stringify({ worktree_path: '/local' }));
    db.prepare('INSERT INTO pr_metadata VALUES (?, ?, ?)').run(target.repository, target.number, JSON.stringify(revision));
    db.prepare("INSERT INTO comments VALUES (1,1,'user','active','a.cc',2,2,'Private draft','RIGHT',?,0,NULL,NULL,NULL)").run(revision.head_sha);
    request = { body: 'Private summary', event: 'COMMENT', headSha: revision.head_sha, baseSha: revision.base_sha };
    client = {
      fetchPullRequest: vi.fn(async () => revision), getPendingReviewForUser: vi.fn(async () => null),
      octokit: { paginate: vi.fn(async () => []), rest: {
        users: { getAuthenticated: vi.fn(async () => ({ data: { id: 9 } })) },
        pulls: { get: vi.fn(async () => ({ data: diff })), listReviews: vi.fn(),
          createReview: vi.fn(async () => ({ data: { id: 101, html_url: 'https://github.com/example/project/pull/7#pullrequestreview-101' } })) }
      } }
    };
    transform = vi.fn(async input => ({ body: 'Public summary', comments: input.comments.map(c => ({ ...c, body: 'Public finding' })) }));
    args = { db, reviewId: 1, target, request, policy: { command: 'transform' }, client };
  });
  afterEach(() => db.close());
  const run = args => reviewPublication(args, { transform });
  async function prepare() {
    const preview = await run(args);
    request.publicationToken = preview.publicationToken;
    return preview;
  }

  it('prepares without writes, then sends the exact preview and records a retryable receipt', async () => {
    const preview = await prepare();
    expect(client.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(preview.body).not.toContain('Private');
    const receipt = await run(args);
    expect(client.octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith({
      owner: target.owner, repo: target.repo, pull_number: 7, commit_id: revision.head_sha,
      event: 'COMMENT', body: preview.body, comments: preview.comments.map(({ id, ...c }) => c)
    });
    expect(await run(args)).toEqual(receipt);
    expect(client.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT status FROM comments').get().status).toBe('submitted');
    expect(JSON.parse(db.prepare('SELECT review_data FROM reviews').get().review_data).worktree_path).toBe('/local');
  });

  it.each(['body', 'event', 'agent edit', 'policy', 'head', 'base', 'closed', 'account'])('rejects a changed %s after preview', async change => {
    await prepare();
    if (change === 'body') request.body = 'Edited';
    if (change === 'event') request.event = 'APPROVE';
    if (change === 'agent edit') db.prepare("UPDATE comments SET body = 'Agent edit'").run();
    if (change === 'policy') args.policy = { command: 'other' };
    if (change === 'head') client.fetchPullRequest.mockResolvedValue({ ...revision, head_sha: 'c'.repeat(40) });
    if (change === 'base') client.fetchPullRequest.mockResolvedValue({ ...revision, base_sha: 'c'.repeat(40) });
    if (change === 'closed') client.fetchPullRequest.mockResolvedValue({ ...revision, state: 'closed' });
    if (change === 'account') client.octokit.rest.users.getAuthenticated.mockResolvedValue({ data: { id: 10 } });
    await expect(run(args)).rejects.toThrow();
    expect(client.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('checks concurrent edits made while sanitizing', async () => {
    transform.mockImplementation(async input => {
      db.prepare("UPDATE comments SET body = 'Changed during transform'").run();
      return input;
    });
    await expect(run(args)).rejects.toThrow(/changed during preparation/);
  });

  it('rejects an adopted suggestion from an older analysis even without a comment SHA', async () => {
    db.prepare("INSERT INTO analysis_runs VALUES ('old-run', 'old-head')").run();
    db.prepare("INSERT INTO comments (id, review_id, source, ai_run_id) VALUES (2, 1, 'ai', 'old-run')").run();
    db.prepare('UPDATE comments SET commit_sha = NULL, parent_id = 2 WHERE id = 1').run();
    await expect(run(args)).rejects.toThrow(/older commit/);
    expect(client.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('leaves omitted findings as local drafts', async () => {
    transform.mockResolvedValue({ body: 'Public summary', comments: [] });
    expect((await prepare()).omittedComments).toBe(1);
    await run(args);
    expect(db.prepare('SELECT status FROM comments').get().status).toBe('active');
  });

  it.each(['failed transform', 'pending draft', 'file comment', 'missing revision', 'old comment', 'DRAFT', 'bad token'])('fails closed for %s', async failure => {
    if (failure === 'failed transform') transform.mockRejectedValue(new Error('transform failed'));
    if (failure === 'pending draft') client.getPendingReviewForUser.mockResolvedValue({ id: 1 });
    if (failure === 'file comment') db.prepare('UPDATE comments SET is_file_level = 1').run();
    if (failure === 'missing revision') delete request.headSha;
    if (failure === 'old comment') db.prepare("UPDATE comments SET commit_sha = 'old'").run();
    if (failure === 'DRAFT') request.event = 'DRAFT';
    if (failure === 'bad token') request.publicationToken = 'invented';
    await expect(run(args)).rejects.toThrow();
    expect(client.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('serializes concurrent publishes', async () => {
    await prepare();
    const results = await Promise.allSettled([run(args), run(args)]);
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    expect(client.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });

  it('recovers an uncertain write after a restart without sending again', async () => {
    const preview = await prepare();
    client.octokit.rest.pulls.createReview.mockRejectedValue(new Error('connection lost'));
    await expect(run(args)).rejects.toThrow(/did not confirm/);
    await expect(run(args)).rejects.toThrow(/may still be in progress/);
    delete request.publicationToken;
    const restored = await run(args);
    expect(restored.publicationToken).toBe(preview.publicationToken);
    request.publicationToken = restored.publicationToken;
    client.octokit.paginate.mockResolvedValue([{ id: 101, user: { id: 9 }, body: preview.body,
      state: 'COMMENTED', commit_id: revision.head_sha, html_url: 'https://github.com/review' }]);
    expect((await run(args)).github_review_id).toBe(101);
    expect(client.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });

  it('keeps comments edited while publishing as local drafts', async () => {
    await prepare();
    client.octokit.rest.pulls.createReview.mockImplementation(async () => {
      db.prepare("UPDATE comments SET body = 'New draft'").run();
      return { data: { id: 101, html_url: 'https://github.com/review' } };
    });
    await run(args);
    expect(db.prepare('SELECT status FROM comments').get().status).toBe('active');
  });

  it('allows correction after a definite provider rejection', async () => {
    await prepare();
    client.octokit.rest.pulls.createReview.mockRejectedValueOnce(Object.assign(new Error('validation'), { status: 422 }));
    await expect(run(args)).rejects.toThrow(/provider rejected/);
    delete request.publicationToken;
    request.body = 'Corrected draft';
    await prepare();
    expect((await run(args)).success).toBe(true);
  });
});

describe('publication transform contract', () => {
  const input = { body: 'summary', comments: [{ id: 1, path: 'a.cc', line: 2, side: 'RIGHT', body: 'finding' }] };
  it.each(['anchor', 'duplicate', 'metadata'])('rejects invented %s', kind => {
    const output = structuredClone(input);
    if (kind === 'anchor') output.comments[0].line = 9;
    if (kind === 'duplicate') output.comments.push(output.comments[0]);
    if (kind === 'metadata') output.reasoning = 'private';
    expect(() => validateTransformed(input, output)).toThrow();
  });
  it('runs a local argv transform and cleans up its private directory', async () => {
    const policy = { command: process.execPath, args: ['-e',
      "const fs = require('fs'); fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1]));", '{input}', '{output}'] };
    expect(await transformPublication(input, policy)).toEqual(input);
  });
  it('rejects nonzero exit even with a valid output file', async () => {
    const policy = { command: process.execPath, args: ['-e',
      "const fs = require('fs'); fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1])); process.exit(1);", '{input}', '{output}'] };
    await expect(transformPublication(input, policy)).rejects.toThrow(/transform failed/);
  });
  it('requires the file protocol', async () => {
    await expect(transformPublication(input, { command: 'x', args: [] })).rejects.toThrow(/requires/);
  });
  it('blocks headless writes for global and case-insensitive repo policy', () => {
    const globalConfig = { review_submission: { command: 'x' } };
    expect(() => assertInteractivePublication(globalConfig, 'any/repo', { aiReview: true })).toThrow(/preview/);
    const config = { repos: { 'Example/Project': { review_submission: { command: 'x' } } } };
    expect(publicationPolicy(config, 'example/project')).toEqual({ command: 'x' });
    expect(() => assertInteractivePublication(config, 'example/project', { aiDraft: true })).toThrow(/preview/);
    expect(() => assertInteractivePublication(config, 'example/project', {})).not.toThrow();
  });
});
