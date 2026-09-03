// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for `src/providers/review-submit.js` — the review WRITE shared by
 * PR mode's `POST /api/pr/:owner/:repo/:number/submit-review` and local mode's
 * `POST /api/local/:reviewId/submit-review` (Phase 5 of
 * plans/bridge-local-and-pr-modes.md).
 *
 * The route-level ladders live beside their routes
 * (tests/integration/local-submit-review.test.js and the PR-mode block in
 * tests/integration/routes.test.js). What is pinned here is the provider's own
 * three contracts: which comments keep a line number, when a submission is
 * refused before any write, and what the write records afterwards.
 */

const {
  SUBMIT_EVENTS,
  SubmitReviewError,
  submitReview,
  checkSubmitPreconditions,
  _internals: { formatCommentsForGraphQL, filesNotInDiff }
} = require('../../src/providers/review-submit');

const silentLogger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * A diff touching two files. `a.js` gains a line at 2; `b.js` gains one at 3.
 * Anything outside those hunks is expanded context as far as GitHub is
 * concerned.
 */
const DIFF = [
  'diff --git a/a.js b/a.js',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1,3 +1,4 @@',
  ' one',
  '+two',
  ' three',
  ' four',
  'diff --git a/b.js b/b.js',
  '--- a/b.js',
  '+++ b/b.js',
  '@@ -1,4 +1,5 @@',
  ' alpha',
  ' beta',
  '+gamma',
  ' delta',
  ' epsilon',
  ''
].join('\n');

/**
 * A diff that DELETES lines, so the left column has hunk lines of its own.
 * `c.js` loses old lines 2 and 3; old 1, 4 and 5 survive as context. Every one
 * of 1-5 is therefore a LEFT entry — which is the point of the LEFT-anchor
 * gate: almost any plausible old-side number lands inside a hunk, so "is it in
 * the diff" cannot tell a good left anchor from a shifted one.
 */
const DELETION_DIFF = [
  'diff --git a/c.js b/c.js',
  '--- a/c.js',
  '+++ b/c.js',
  '@@ -1,5 +1,3 @@',
  ' keep-one',
  '-gone-two',
  '-gone-three',
  ' keep-four',
  ' keep-five',
  ''
].join('\n');

/** A `GitHubApiError` as `GitHubClient.fetchPullRequest` really rejects with. */
const { GitHubApiError } = require('../../src/github/errors');
const apiError = (status, message) => new GitHubApiError(message, status);

function comment(overrides = {}) {
  return {
    id: 1,
    file: 'a.js',
    line_start: 2,
    line_end: 2,
    body: 'a note',
    diff_position: null,
    side: 'RIGHT',
    commit_sha: 'abc123',
    is_file_level: 0,
    ...overrides
  };
}

/** A `GitHubClient` stand-in. `features` drives the node-id requirement. */
function makeClient({
  features = { review_lifecycle: 'graphql', pending_review_comments: 'graphql' },
  existingDraft = null,
  createResult,
  draftResult,
  pendingError = null,
  createError = null,
  draftError = null
} = {}) {
  const calls = { create: [], draft: [], pending: [] };
  class FakeClient {
    constructor(credential) {
      this.credential = credential;
      this.features = features;
    }
    async getPendingReviewForUser(owner, repo, prNumber) {
      calls.pending.push({ owner, repo, prNumber });
      if (pendingError) throw pendingError;
      return existingDraft;
    }
    async createReviewGraphQL(prNodeId, event, body, comments, draftId, prContext) {
      calls.create.push({ prNodeId, event, body, comments, draftId, prContext });
      if (createError) throw createError;
      return createResult || {
        id: 'PRR_node1',
        databaseId: 555,
        html_url: 'https://github.com/o/r/pull/7#pullrequestreview-555',
        comments_count: comments.length,
        state: 'COMMENTED'
      };
    }
    async createDraftReviewGraphQL(prNodeId, body, comments, draftId, prContext) {
      calls.draft.push({ prNodeId, body, comments, draftId, prContext });
      if (draftError) throw draftError;
      return draftResult || {
        id: 'PRR_draft1',
        databaseId: 777,
        html_url: 'https://github.com/o/r/pull/7#pullrequestreview-777',
        comments_count: comments.length,
        state: 'PENDING'
      };
    }
  }
  return { FakeClient, calls };
}

/**
 * Fake `query` / `run`. Records every statement so the transaction boundary and
 * the comment status transitions can be asserted without a database.
 */
function makeDb({ comments = [], failOn = null } = {}) {
  const statements = [];
  const deps = {
    query: async (_db, sql, params) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return comments;
    },
    run: async (_db, sql, params) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      statements.push({ sql: flat, params });
      if (failOn && flat.includes(failOn)) throw new Error('db exploded');
      return { changes: 1 };
    }
  };
  return { deps, statements };
}

function makeRepos({ updateAfterSubmission, upsertFromGitHub } = {}) {
  const calls = { update: [], upsert: [] };
  class FakeReviewRepository {
    async updateAfterSubmission(id, data) {
      calls.update.push({ id, data });
      if (updateAfterSubmission) return updateAfterSubmission(id, data);
      return true;
    }
  }
  class FakeGitHubReviewRepository {
    async upsertFromGitHub(reviewId, data) {
      calls.upsert.push({ reviewId, data });
      if (upsertFromGitHub) return upsertFromGitHub(reviewId, data);
      return { id: 1 };
    }
  }
  return { FakeReviewRepository, FakeGitHubReviewRepository, calls };
}

describe('review-submit provider', () => {
  describe('SUBMIT_EVENTS', () => {
    it('is the four events both routes accept', () => {
      expect([...SUBMIT_EVENTS]).toEqual(['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'DRAFT']);
    });
  });

  describe('formatCommentsForGraphQL', () => {
    const fmt = (params) => formatCommentsForGraphQL(params, { logger: silentLogger });

    it('keeps a line number for a comment inside a diff hunk', () => {
      const [out] = fmt({ comments: [comment()], diffContent: DIFF });
      expect(out).toEqual({
        path: 'a.js',
        line: 2,
        body: 'a note',
        side: 'RIGHT',
        isFileLevel: false
      });
    });

    it('carries start_line AND start_side for a range whose endpoints are both in the diff', () => {
      // Both coordinates or neither: GitHub defaults `startSide` to RIGHT
      // independently of `side`, so a range that names only one side is a
      // mixed-side range, not a same-side one.
      const [out] = fmt({
        comments: [comment({ file: 'b.js', line_start: 2, line_end: 4 })],
        diffContent: DIFF
      });
      expect(out.start_line).toBe(2);
      expect(out.start_side).toBe('RIGHT');
      expect(out.line).toBe(4);
      expect(out.side).toBe('RIGHT');
      expect(out.isFileLevel).toBe(false);
    });

    it('gives a LEFT range a LEFT start_side, not the RIGHT default', () => {
      // The bug this pins: a LEFT multi-line comment reached the transport with
      // `side: LEFT` and no start side, so GitHub's RIGHT default anchored the
      // start of the range on the new file.
      const [out] = fmt({
        comments: [comment({ file: 'c.js', side: 'LEFT', line_start: 2, line_end: 3 })],
        diffContent: DELETION_DIFF
      });
      expect(out).toEqual({
        path: 'c.js',
        start_line: 2,
        start_side: 'LEFT',
        line: 3,
        side: 'LEFT',
        body: 'a note',
        isFileLevel: false
      });
    });

    it('sends NO start_side for a single-line comment', () => {
      // It describes where the START line lives; without a range there is none.
      const [out] = fmt({ comments: [comment()], diffContent: DIFF });
      expect(out).not.toHaveProperty('start_side');
      expect(out).not.toHaveProperty('start_line');
    });

    it('posts an explicit file-level comment with no line reference', () => {
      const [out] = fmt({ comments: [comment({ is_file_level: 1 })], diffContent: DIFF });
      expect(out).toEqual({ path: 'a.js', body: 'a note', isFileLevel: true });
    });

    it('degrades an expanded-context comment to file level with a line reference', () => {
      const [out] = fmt({ comments: [comment({ line_start: 99, line_end: 99 })], diffContent: DIFF });
      expect(out).toEqual({ path: 'a.js', body: '(Ref Line 99) a note', isFileLevel: true });
    });

    it('degrades a range whose START is outside the diff even though its end is inside', () => {
      // The regression this guards: submitting `start_line` for a line GitHub
      // cannot place produces a position it will not render.
      const [out] = fmt({
        comments: [comment({ file: 'b.js', line_start: 99, line_end: 3 })],
        diffContent: DIFF
      });
      expect(out.isFileLevel).toBe(true);
      expect(out.body).toBe('(Ref Lines 99-3) a note');
    });

    it('degrades EVERY comment when the diff could not be generated', () => {
      const out = fmt({ comments: [comment(), comment({ id: 2, file: 'b.js', line_start: 3, line_end: 3 })], diffContent: '' });
      expect(out.every(c => c.isFileLevel)).toBe(true);
    });

    it('degrades a comment whose file carries uncommitted local edits', () => {
      // Local mode renders the working tree; an uncommitted edit above the
      // comment shifts its line number while the shifted number still lands
      // inside a hunk, so the diff check alone cannot catch it.
      const [out] = fmt({
        comments: [comment()],
        diffContent: DIFF,
        filesWithLocalEdits: new Set(['a.js'])
      });
      expect(out).toEqual({ path: 'a.js', body: '(Ref Line 2) a note', isFileLevel: true });
    });

    it('leaves comments on OTHER files alone when one file is dirty', () => {
      const out = fmt({
        comments: [comment(), comment({ id: 2, file: 'b.js', line_start: 3, line_end: 3 })],
        diffContent: DIFF,
        filesWithLocalEdits: new Set(['a.js'])
      });
      expect(out[0].isFileLevel).toBe(true);
      expect(out[1].isFileLevel).toBe(false);
      expect(out[1].line).toBe(3);
    });

    it('treats a null dirty set as PR mode — no file is suspect', () => {
      const [out] = fmt({ comments: [comment()], diffContent: DIFF, filesWithLocalEdits: null });
      expect(out.isFileLevel).toBe(false);
    });

    describe('LEFT-side anchor trust', () => {
      const leftComment = (overrides = {}) => comment({
        file: 'c.js',
        side: 'LEFT',
        line_start: 2,
        line_end: 2,
        ...overrides
      });

      it('keeps a line number for a LEFT comment inside a deletion hunk when trust is granted', () => {
        const [out] = fmt({ comments: [leftComment()], diffContent: DELETION_DIFF });
        expect(out).toEqual({
          path: 'c.js',
          line: 2,
          body: 'a note',
          side: 'LEFT',
          isFileLevel: false
        });
      });

      it('degrades that same LEFT comment when the left coordinate system is not vouched for', () => {
        // The two left columns are only the same file when the two bases are
        // the same commit — stacked PRs, a base changed on GitHub, and the
        // never-persisted in-UI base override all break that.
        const [out] = fmt({
          comments: [leftComment()],
          diffContent: DELETION_DIFF,
          trustLeftAnchors: false
        });
        expect(out).toEqual({ path: 'c.js', body: '(Ref Line 2) a note', isFileLevel: true });
      });

      it('degrades a LEFT comment whose line exists only on the RIGHT side, trust or not', () => {
        // `a.js` right-side line 4 has no left-side counterpart, so the ordinary
        // outside-the-diff check catches this one on its own.
        for (const trustLeftAnchors of [true, false]) {
          const [out] = fmt({
            comments: [comment({ file: 'a.js', side: 'LEFT', line_start: 4, line_end: 4 })],
            diffContent: DIFF,
            trustLeftAnchors
          });
          expect(out).toEqual({ path: 'a.js', body: '(Ref Line 4) a note', isFileLevel: true });
        }
      });

      it('degrades a LEFT RANGE with both endpoints in the diff, spelling out both lines', () => {
        const params = {
          comments: [leftComment({ line_start: 2, line_end: 3 })],
          diffContent: DELETION_DIFF
        };
        const [trusted] = fmt(params);
        expect(trusted).toMatchObject({ start_line: 2, line: 3, side: 'LEFT', isFileLevel: false });

        const [degraded] = fmt({ ...params, trustLeftAnchors: false });
        expect(degraded).toEqual({ path: 'c.js', body: '(Ref Lines 2-3) a note', isFileLevel: true });
      });

      it('leaves RIGHT-side comments untouched when LEFT anchors are distrusted', () => {
        // Only the old-side coordinate system is in question; refusing the
        // whole submission over it would be the wrong trade.
        const out = fmt({
          comments: [comment(), leftComment({ id: 2 })],
          diffContent: `${DIFF}${DELETION_DIFF}`,
          trustLeftAnchors: false
        });
        expect(out[0]).toMatchObject({ path: 'a.js', line: 2, side: 'RIGHT', isFileLevel: false });
        expect(out[1].isFileLevel).toBe(true);
      });

      it('trusts LEFT anchors by default, so PR mode is unchanged', () => {
        const [out] = fmt({ comments: [leftComment()], diffContent: DELETION_DIFF });
        expect(out.isFileLevel).toBe(false);
      });
    });
  });

  describe('filesNotInDiff', () => {
    const lineSet = () => require('../../src/utils/diff-annotator').buildDiffLineSet(DIFF);

    it('finds a commented file the pull request never touches', () => {
      const comments = [comment(), comment({ id: 2, file: 'untouched.js' })];
      expect(filesNotInDiff(comments, lineSet(), DIFF)).toEqual(['untouched.js']);
    });

    it('reports each missing file once, in the order first seen', () => {
      const comments = [
        comment({ id: 1, file: 'zeta.js' }),
        comment({ id: 2, file: 'alpha.js' }),
        comment({ id: 3, file: 'zeta.js' })
      ];
      expect(filesNotInDiff(comments, lineSet(), DIFF)).toEqual(['zeta.js', 'alpha.js']);
    });

    it('answers nothing for a file that is in the diff but outside every hunk', () => {
      // That comment is DEGRADED, not refused — it posts at file level.
      expect(filesNotInDiff([comment({ line_start: 99, line_end: 99 })], lineSet(), DIFF)).toEqual([]);
    });

    it('answers nothing when the diff is empty — unknown is not "no"', () => {
      const empty = require('../../src/utils/diff-annotator').buildDiffLineSet('');
      expect(filesNotInDiff([comment({ file: 'anything.js' })], empty, '')).toEqual([]);
    });
  });

  describe('checkSubmitPreconditions', () => {
    const target = { owner: 'o', repo: 'r', prNumber: 7, credential: 'tok' };

    function clientReturning(prData, { throws = null } = {}) {
      return {
        GitHubClient: class {
          async fetchPullRequest() {
            if (throws) throw throws;
            return prData;
          }
        },
        logger: silentLogger
      };
    }

    it('passes when the PR is open and its head is the local HEAD', async () => {
      const result = await checkSubmitPreconditions(
        { ...target, localHeadSha: 'sha-head' },
        clientReturning({ head_sha: 'sha-head', state: 'open', merged: false, node_id: 'PR_1' })
      );
      expect(result.ok).toBe(true);
      expect(result.prData.node_id).toBe('PR_1');
    });

    it('refuses with 409 head_drift when local HEAD is not the PR head', async () => {
      const result = await checkSubmitPreconditions(
        { ...target, localHeadSha: 'aaaaaaa1111' },
        clientReturning({ head_sha: 'bbbbbbb2222', state: 'open', merged: false })
      );
      expect(result).toMatchObject({ ok: false, status: 409, code: 'head_drift' });
      // Both SHAs named, so the message says what to reconcile.
      expect(result.error).toContain('aaaaaaa');
      expect(result.error).toContain('bbbbbbb');
    });

    it('refuses with 409 when the local HEAD could not be read', async () => {
      const result = await checkSubmitPreconditions(
        { ...target, localHeadSha: null },
        clientReturning({ head_sha: 'sha-head', state: 'open' })
      );
      expect(result).toMatchObject({ ok: false, status: 409, code: 'local_head_unknown' });
    });

    it('refuses with 410 for a merged PR, before the drift check', async () => {
      const result = await checkSubmitPreconditions(
        { ...target, localHeadSha: 'sha-head' },
        clientReturning({ head_sha: 'moved-on', state: 'closed', merged: true })
      );
      expect(result).toMatchObject({ ok: false, status: 410, code: 'pr_merged' });
    });

    it('refuses with 410 for a closed (unmerged) PR', async () => {
      const result = await checkSubmitPreconditions(
        { ...target, localHeadSha: 'sha-head' },
        clientReturning({ head_sha: 'sha-head', state: 'closed', merged: false })
      );
      expect(result).toMatchObject({ ok: false, status: 410, code: 'pr_closed' });
    });

    it('FAILS CLOSED when GitHub cannot be read', async () => {
      // Every other PR-side check in local mode fails open. This one authorises
      // a write, so "we do not know whether the PR moved" is a refusal.
      const result = await checkSubmitPreconditions(
        { ...target, localHeadSha: 'sha-head' },
        clientReturning(null, { throws: new Error('socket hang up') })
      );
      expect(result).toMatchObject({ ok: false, status: 502, code: 'pr_state_unknown' });
      expect(result.error).toContain('socket hang up');
    });

    it('refuses when GitHub reports no head commit at all', async () => {
      const result = await checkSubmitPreconditions(
        { ...target, localHeadSha: 'sha-head' },
        clientReturning({ head_sha: null, state: 'open', merged: false })
      );
      expect(result).toMatchObject({ ok: false, status: 502, code: 'pr_state_unknown' });
    });

    describe('classifying a REJECTED read', () => {
      // `fetchPullRequest` rejects with `GitHubApiError`; it does not resolve
      // null. Flattening those into 502 `pr_state_unknown` told the user to
      // retry a request that can never succeed.
      const classify = async (thrown) => checkSubmitPreconditions(
        { ...target, localHeadSha: 'sha-head' },
        clientReturning(null, { throws: thrown })
      );

      it('maps 401 to auth_failed', async () => {
        const result = await classify(apiError(401, 'Bad credentials'));
        expect(result).toMatchObject({ ok: false, status: 401, code: 'auth_failed' });
        expect(result.error).toContain('Bad credentials');
      });

      it('maps 403 to insufficient_permissions', async () => {
        const result = await classify(apiError(403, 'Resource not accessible'));
        expect(result).toMatchObject({ ok: false, status: 403, code: 'insufficient_permissions' });
      });

      it('maps 404 to pr_not_found — the branch the blanket catch made unreachable', async () => {
        const result = await classify(apiError(404, 'Not Found'));
        expect(result).toMatchObject({ ok: false, status: 404, code: 'pr_not_found' });
        expect(result.error).toContain('#7');
      });

      it('maps 429 to rate_limited', async () => {
        const result = await classify(apiError(429, 'API rate limit exceeded'));
        expect(result).toMatchObject({ ok: false, status: 429, code: 'rate_limited' });
      });

      it('leaves a status-less failure as 502 pr_state_unknown', async () => {
        const result = await classify(new Error('ECONNRESET'));
        expect(result).toMatchObject({ ok: false, status: 502, code: 'pr_state_unknown' });
      });

      it('leaves an unclassified status as 502 pr_state_unknown — state really is unknown', async () => {
        const result = await classify(apiError(500, 'Internal Server Error'));
        expect(result).toMatchObject({ ok: false, status: 502, code: 'pr_state_unknown' });
      });

      it('still answers 404 for a client that RESOLVES null instead of rejecting', async () => {
        // A mock or an alt-host transport may report a missing PR that way.
        const result = await checkSubmitPreconditions(
          { ...target, localHeadSha: 'sha-head' },
          clientReturning(null)
        );
        expect(result).toMatchObject({ ok: false, status: 404, code: 'pr_not_found' });
      });
    });

    describe('lifecycle is per-event', () => {
      // GitHub accepts a COMMENT review, and inline review comments, on a
      // settled pull request. Only the approving events and a new draft are
      // meaningless once it is merged or closed.
      const merged = { head_sha: 'sha-head', state: 'closed', merged: true };
      const closed = { head_sha: 'sha-head', state: 'closed', merged: false };

      it('lets a COMMENT review through on a MERGED pull request', async () => {
        const result = await checkSubmitPreconditions(
          { ...target, localHeadSha: 'sha-head', event: 'COMMENT' },
          clientReturning(merged)
        );
        expect(result.ok).toBe(true);
      });

      it('lets a COMMENT review through on a CLOSED pull request', async () => {
        const result = await checkSubmitPreconditions(
          { ...target, localHeadSha: 'sha-head', event: 'COMMENT' },
          clientReturning(closed)
        );
        expect(result.ok).toBe(true);
      });

      it('still refuses APPROVE on a merged pull request, and says Comment is available', async () => {
        const result = await checkSubmitPreconditions(
          { ...target, localHeadSha: 'sha-head', event: 'APPROVE' },
          clientReturning(merged)
        );
        expect(result).toMatchObject({ ok: false, status: 410, code: 'pr_merged' });
        expect(result.error).toContain('Comment review');
      });

      it('still refuses REQUEST_CHANGES on a merged pull request', async () => {
        const result = await checkSubmitPreconditions(
          { ...target, localHeadSha: 'sha-head', event: 'REQUEST_CHANGES' },
          clientReturning(merged)
        );
        expect(result).toMatchObject({ ok: false, status: 410, code: 'pr_merged' });
      });

      it('still refuses DRAFT on a closed pull request', async () => {
        const result = await checkSubmitPreconditions(
          { ...target, localHeadSha: 'sha-head', event: 'DRAFT' },
          clientReturning(closed)
        );
        expect(result).toMatchObject({ ok: false, status: 410, code: 'pr_closed' });
        expect(result.error).toContain('Comment review');
      });

      it('refuses everything when the caller names no event — conservative default', async () => {
        const result = await checkSubmitPreconditions(
          { ...target, localHeadSha: 'sha-head' },
          clientReturning(merged)
        );
        expect(result).toMatchObject({ ok: false, status: 410, code: 'pr_merged' });
      });

      it('does NOT exempt a permitted COMMENT from the head-drift refusal', async () => {
        // The lifecycle branch got softer; the anchor guarantee did not.
        const result = await checkSubmitPreconditions(
          { ...target, localHeadSha: 'aaaaaaa1111', event: 'COMMENT' },
          clientReturning({ ...merged, head_sha: 'bbbbbbb2222' })
        );
        expect(result).toMatchObject({ ok: false, status: 409, code: 'head_drift' });
      });
    });

    it('does NOT strip the credential refresh closure', async () => {
      // The advisory stale check strips it (a 1200ms budget cannot afford a
      // token_command); a user-initiated write must be able to refresh an
      // expired cached token instead of refusing.
      const credential = { token: 't', host: null, refresh: () => 'fresh' };
      let seen;
      await checkSubmitPreconditions(
        { ...target, credential, localHeadSha: 'sha-head' },
        {
          GitHubClient: class {
            constructor(cred) { seen = cred; }
            async fetchPullRequest() { return { head_sha: 'sha-head', state: 'open' }; }
          },
          logger: silentLogger
        }
      );
      expect(typeof seen.refresh).toBe('function');
    });
  });

  describe('submitReview', () => {
    function run(overrides = {}) {
      const {
        clientOptions = {},
        dbOptions = {},
        repoOptions = {},
        params = {}
      } = overrides;
      const { FakeClient, calls: clientCalls } = makeClient(clientOptions);
      const { deps: dbDeps, statements } = makeDb(dbOptions);
      const { FakeReviewRepository, FakeGitHubReviewRepository, calls: repoCalls } = makeRepos(repoOptions);
      const promise = submitReview({
        db: {},
        reviewId: 42,
        owner: 'o',
        repo: 'r',
        prNumber: 7,
        event: 'COMMENT',
        body: 'looks good',
        credential: 'tok',
        prNodeId: 'PR_node',
        headSha: 'sha-head',
        diffContent: DIFF,
        hostName: 'Meteorite',
        ...params,
        _deps: {
          GitHubClient: FakeClient,
          ReviewRepository: FakeReviewRepository,
          GitHubReviewRepository: FakeGitHubReviewRepository,
          logger: silentLogger,
          ...dbDeps
        }
      });
      return { promise, clientCalls, repoCalls, statements };
    }

    it('submits the review and reports the resolved host name', async () => {
      const { promise, clientCalls } = run({
        dbOptions: { comments: [comment()] }
      });
      const result = await promise;

      expect(clientCalls.create).toHaveLength(1);
      expect(clientCalls.create[0].event).toBe('COMMENT');
      expect(clientCalls.create[0].comments[0]).toMatchObject({ path: 'a.js', line: 2 });
      expect(result).toMatchObject({
        success: true,
        message: 'Review submitted successfully to Meteorite',
        github_url: 'https://github.com/o/r/pull/7#pullrequestreview-555',
        comments_submitted: 1,
        event: 'COMMENT'
      });
      // Only drafts report a state.
      expect(result.status).toBeUndefined();
    });

    it('creates a draft through the draft mutation and reports its state', async () => {
      const { promise, clientCalls, repoCalls } = run({
        params: { event: 'DRAFT' },
        dbOptions: { comments: [comment()] }
      });
      const result = await promise;

      expect(clientCalls.draft).toHaveLength(1);
      expect(clientCalls.create).toHaveLength(0);
      expect(result.status).toBe('PENDING');
      expect(result.message).toBe('Draft review created successfully on Meteorite');
      expect(repoCalls.upsert[0].data.state).toBe('pending');
      expect(repoCalls.upsert[0].data.submitted_at).toBeNull();
    });

    it('adds to an existing draft, keeping its URL and total comment count', async () => {
      const { promise } = run({
        params: { event: 'DRAFT' },
        dbOptions: { comments: [comment()] },
        clientOptions: {
          existingDraft: {
            id: 'PRR_existing',
            databaseId: 999,
            url: 'https://github.com/o/r/pull/7#pullrequestreview-999',
            comments: { totalCount: 3 }
          },
          draftResult: {
            id: 'PRR_existing',
            databaseId: null,
            html_url: null,
            comments_count: 1,
            state: 'PENDING'
          }
        }
      });
      const result = await promise;
      expect(result.github_url).toBe('https://github.com/o/r/pull/7#pullrequestreview-999');
      expect(result.comments_submitted).toBe(4);
    });

    it('reuses the existing draft ids so the mirror row is UPDATED, not duplicated', async () => {
      // Migration 57's unique indexes make a second insert a hard error;
      // `upsertFromGitHub` is the one writer, and a submitted draft keeps its
      // GitHub ids.
      const { promise, repoCalls } = run({
        clientOptions: {
          existingDraft: { id: 'PRR_existing', databaseId: 999, url: 'u', comments: { totalCount: 0 } },
          createResult: {
            id: 'PRR_existing',
            databaseId: null,
            html_url: 'https://github.com/o/r/pull/7#pullrequestreview-999',
            comments_count: 0,
            state: 'COMMENTED'
          }
        }
      });
      await promise;
      expect(repoCalls.upsert[0].data).toMatchObject({
        github_node_id: 'PRR_existing',
        github_review_id: '999',
        state: 'submitted',
        event: 'COMMENT'
      });
    });

    it('stores an absent numeric id as SQL NULL, never the string "null"', async () => {
      const { promise, repoCalls } = run({
        clientOptions: {
          createResult: {
            id: 'PRR_node1',
            databaseId: null,
            html_url: 'https://x',
            comments_count: 0,
            state: 'COMMENTED'
          }
        }
      });
      await promise;
      expect(repoCalls.upsert[0].data.github_review_id).toBeNull();
    });

    it('marks submitted comments and commits in one transaction', async () => {
      const { promise, statements } = run({
        dbOptions: { comments: [comment({ id: 11 }), comment({ id: 12, file: 'b.js', line_start: 3, line_end: 3 })] }
      });
      await promise;

      const sql = statements.map(s => s.sql);
      expect(sql[0]).toContain('FROM comments');
      expect(sql).toContain('BEGIN TRANSACTION');
      expect(sql[sql.length - 1]).toBe('COMMIT');
      const updates = statements.filter(s => s.sql.startsWith('UPDATE comments'));
      expect(updates).toHaveLength(2);
      expect(updates.map(u => u.params[0])).toEqual(['submitted', 'submitted']);
      expect(updates.map(u => u.params[2])).toEqual([11, 12]);
    });

    it('marks comments as draft — not submitted — for a DRAFT event', async () => {
      const { promise, statements } = run({
        params: { event: 'DRAFT' },
        dbOptions: { comments: [comment({ id: 11 })] }
      });
      await promise;
      const update = statements.find(s => s.sql.startsWith('UPDATE comments'));
      expect(update.params[0]).toBe('draft');
    });

    it('rolls back and rethrows when a database write fails after the GitHub call', async () => {
      const { promise, statements } = run({
        dbOptions: { comments: [comment()], failOn: 'UPDATE comments' }
      });
      await expect(promise).rejects.toThrow('db exploded');
      expect(statements.map(s => s.sql)).toContain('ROLLBACK');
      expect(statements.map(s => s.sql)).not.toContain('COMMIT');
    });

    it('opens the transaction only AFTER the GitHub round-trip', async () => {
      // A SQLite write lock must never be held across the network.
      const { promise, statements } = run({ dbOptions: { comments: [comment()] } });
      await promise;
      const beginIndex = statements.findIndex(s => s.sql === 'BEGIN TRANSACTION');
      const selectIndex = statements.findIndex(s => s.sql.includes('FROM comments'));
      expect(selectIndex).toBeLessThan(beginIndex);
    });

    it('refuses with 409 BEFORE any GitHub call when a comment is on a file outside the PR', async () => {
      // GitHub refuses such a path inline or file-level, and the client then
      // deletes the pending review it created and throws. Catching it here
      // costs no round trip and names the file.
      const { promise, clientCalls, statements } = run({
        params: { refuseCommentsOutsideDiff: true },
        dbOptions: { comments: [comment({ file: 'never-in-the-pr.js' })] }
      });
      await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
      await promise.catch((error) => {
        expect(error.status).toBe(409);
        expect(error.code).toBe('comments_outside_pr');
        expect(error.message).toContain('never-in-the-pr.js');
      });
      expect(clientCalls.pending).toHaveLength(0);
      expect(statements.map(s => s.sql)).not.toContain('BEGIN TRANSACTION');
    });

    it('does NOT refuse when the diff is unavailable — nothing is known about any path', async () => {
      const { promise } = run({
        params: { refuseCommentsOutsideDiff: true, diffContent: '' },
        dbOptions: { comments: [comment({ file: 'never-in-the-pr.js' })] }
      });
      await expect(promise).resolves.toMatchObject({ success: true });
    });

    it('does NOT ask the question in PR mode, whose comments were authored on THIS diff', async () => {
      // 5a is an extraction: PR mode keeps whatever GitHub answers for a path
      // outside its own diff, exactly as before.
      const { promise, clientCalls } = run({
        dbOptions: { comments: [comment({ file: 'never-in-the-pr.js' })] }
      });
      await expect(promise).resolves.toMatchObject({ success: true });
      expect(clientCalls.create[0].comments[0].path).toBe('never-in-the-pr.js');
    });

    it('refuses with 400 when a GraphQL host has no PR node id', async () => {
      const { promise } = run({
        params: { prNodeId: null },
        dbOptions: { comments: [comment()] }
      });
      await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
      await promise.catch((error) => {
        expect(error.status).toBe(400);
        expect(error.code).toBe('missing_pr_node_id');
      });
    });

    it('does NOT require a PR node id when the host uses REST lifecycle and host comments', async () => {
      const { promise, clientCalls } = run({
        params: { prNodeId: null },
        dbOptions: { comments: [comment()] },
        clientOptions: {
          features: { review_lifecycle: 'rest', pending_review_comments: 'host' }
        }
      });
      await expect(promise).resolves.toMatchObject({ success: true });
      expect(clientCalls.create[0].prNodeId).toBeNull();
    });

    it('does NOT require a PR node id when reusing an existing draft with no comments', async () => {
      const { promise } = run({
        params: { prNodeId: null },
        dbOptions: { comments: [] },
        clientOptions: {
          existingDraft: { id: 'PRR_existing', databaseId: 5, url: 'u', comments: { totalCount: 0 } }
        }
      });
      await expect(promise).resolves.toMatchObject({ success: true });
    });

    it('threads the PR head sha and existing draft id into the host comment context', async () => {
      const { promise, clientCalls } = run({
        dbOptions: { comments: [comment()] },
        clientOptions: {
          existingDraft: { id: 'PRR_existing', databaseId: 4242, url: 'u', comments: { totalCount: 0 } }
        }
      });
      await promise;
      expect(clientCalls.create[0].prContext).toEqual({
        owner: 'o',
        repo: 'r',
        prNumber: 7,
        reviewId: 4242,
        headSha: 'sha-head'
      });
    });

    it('warns rather than refusing when the PR head sha is unknown', async () => {
      const warn = vi.fn();
      const { FakeClient } = makeClient();
      const { deps: dbDeps } = makeDb({ comments: [comment()] });
      const { FakeReviewRepository, FakeGitHubReviewRepository } = makeRepos();
      await submitReview({
        db: {},
        reviewId: 42,
        owner: 'o',
        repo: 'r',
        prNumber: 7,
        event: 'COMMENT',
        body: '',
        credential: 'tok',
        prNodeId: 'PR_node',
        headSha: null,
        diffContent: DIFF,
        _deps: {
          GitHubClient: FakeClient,
          ReviewRepository: FakeReviewRepository,
          GitHubReviewRepository: FakeGitHubReviewRepository,
          logger: { ...silentLogger, warn },
          ...dbDeps
        }
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('head SHA is missing'));
    });

    it('defaults the host name to GitHub when the caller resolves none', async () => {
      const { promise } = run({ params: { hostName: undefined } });
      await expect(promise).resolves.toMatchObject({
        message: 'Review submitted successfully to GitHub'
      });
    });

    it('lets a GitHub failure propagate unchanged for the route ladder to classify', async () => {
      const { promise, statements } = run({
        clientOptions: { pendingError: new Error('GitHub authentication failed') }
      });
      await expect(promise).rejects.toThrow('GitHub authentication failed');
      // Nothing was written — the failure happened before the transaction.
      expect(statements.map(s => s.sql)).not.toContain('BEGIN TRANSACTION');
    });

    describe('LEFT anchor trust threading', () => {
      const leftComment = comment({ file: 'c.js', side: 'LEFT', line_start: 2, line_end: 2 });

      it('sends a LEFT comment inline by default — PR mode is unchanged', async () => {
        const { promise, clientCalls } = run({
          params: { diffContent: DELETION_DIFF },
          dbOptions: { comments: [leftComment] }
        });
        await promise;
        expect(clientCalls.create[0].comments[0]).toMatchObject({ line: 2, side: 'LEFT', isFileLevel: false });
      });

      it('degrades LEFT comments to file level when the caller withholds trust', async () => {
        const { promise, clientCalls } = run({
          params: { diffContent: DELETION_DIFF, trustLeftAnchors: false },
          dbOptions: { comments: [leftComment] }
        });
        await promise;
        expect(clientCalls.create[0].comments[0]).toEqual({
          path: 'c.js',
          body: '(Ref Line 2) a note',
          isFileLevel: true
        });
      });

      it('leaves RIGHT comments inline when the caller withholds LEFT trust', async () => {
        const { promise, clientCalls } = run({
          params: { trustLeftAnchors: false },
          dbOptions: { comments: [comment()] }
        });
        await promise;
        expect(clientCalls.create[0].comments[0]).toMatchObject({ line: 2, isFileLevel: false });
      });
    });

    /**
     * RESIDUE CLASSIFICATION — what a failed write left on the pull request.
     *
     * The facts come from the orchestration, not from this layer:
     * `GitHubClient` stamps `error.reviewWriteProgress` on every failure it
     * flattens (`newReviewWriteProgress` in src/github/client.js). These tests
     * feed the provider that record and pin the four outcomes the old
     * outside-in guess (`existingDraft && sentComments > 0`) got wrong in one
     * direction or the other.
     *
     * EVERY CASE RUNS IN BOTH MODES. The provider is the single write shared by
     * `POST /api/pr/...` and `POST /api/local/...`; the mode shows up only as
     * input flags (`refuseCommentsOutsideDiff`, `trustLeftAnchors`,
     * `filesWithLocalEdits`). Running the matrix proves the classification does
     * not quietly depend on them — a mode-sniffing regression would show up
     * here as one column failing.
     */
    describe('write-residue classification', () => {
      /**
       * An error shaped like the ones `GitHubClient` really throws: a flattened
       * message that no longer describes state, plus the structured record that
       * does.
       */
      const writeFailure = (message, progress = {}) => {
        const error = new Error(message);
        error.reviewWriteProgress = {
          phase: 'add_comments',
          reviewPreExisted: false,
          reviewId: 'PRR_new',
          reviewUrl: null,
          commentsSent: 2,
          commentsWritten: 0,
          commentsWrittenExact: true,
          cleanupAttempted: false,
          cleanupSucceeded: null,
          ...progress
        };
        return error;
      };

      const reusedDraft = {
        id: 'PRR_existing',
        databaseId: 999,
        url: 'https://github.com/o/r/pull/7#pullrequestreview-999',
        comments: { totalCount: 0 }
      };

      /** Two comments, both inside `DIFF`, so local mode's extra gate passes. */
      const twoComments = () => [
        comment({ id: 11 }),
        comment({ id: 12, file: 'b.js', line_start: 3, line_end: 3 })
      ];

      const MODES = [
        ['PR mode', {}],
        ['local mode', {
          refuseCommentsOutsideDiff: true,
          trustLeftAnchors: false,
          filesWithLocalEdits: new Set()
        }]
      ];

      for (const [modeName, modeParams] of MODES) {
        describe(modeName, () => {
          const failWith = (thrown, clientOptions = {}) => run({
            params: modeParams,
            dbOptions: { comments: twoComments() },
            clientOptions: { createError: thrown, ...clientOptions }
          });

          it('keeps an AUTH failure that wrote nothing as itself, not partially_posted', async () => {
            // The regression: reusing the user's draft used to relabel EVERY
            // failure 409 `partially_posted`, so the route ladder never saw the
            // 401 it maps and the user was told not to retry a request that
            // only needed a working token.
            const thrown = writeFailure('GitHub authentication failed', {
              reviewPreExisted: true,
              commentsWritten: 0,
              commentsWrittenExact: true
            });
            const { promise } = failWith(thrown, { existingDraft: reusedDraft });

            await expect(promise).rejects.toBe(thrown);
            await promise.catch((error) => {
              expect(error).not.toBeInstanceOf(SubmitReviewError);
            });
          });

          it('keeps a RATE LIMIT failure that wrote nothing as itself', async () => {
            const thrown = writeFailure('You have exceeded a secondary rate limit', {
              reviewPreExisted: true,
              commentsWritten: 0
            });
            const { promise } = failWith(thrown, { existingDraft: reusedDraft });
            await expect(promise).rejects.toBe(thrown);
          });

          it('warns partially_posted when a MID-BATCH failure confirmed writes', async () => {
            const thrown = writeFailure('Failed to add 1 of 2 comments to GitHub.', {
              reviewPreExisted: true,
              commentsWritten: 1,
              commentsSent: 2
            });
            const { promise, statements } = failWith(thrown, { existingDraft: reusedDraft });

            await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
            await promise.catch((error) => {
              expect(error.code).toBe('partially_posted');
              expect(error.status).toBe(409);
              // The confirmed count, not a vague "some".
              expect(error.message).toContain('1 of these 2 comments is already');
              expect(error.message).toContain(reusedDraft.url);
              expect(error.cause).toBe(thrown);
            });
            // Not one comment row moved: a retry must find the same set.
            expect(statements.map(s => s.sql)).not.toContain('BEGIN TRANSACTION');
          });

          it('warns when the comment transport THREW, so the count is a floor', async () => {
            // The request may have been applied and only the response lost.
            // "0 confirmed" is not "0 written".
            const thrown = writeFailure('comment batch threw before completion: socket hang up', {
              reviewPreExisted: true,
              commentsWritten: 0,
              commentsWrittenExact: false
            });
            const { promise } = failWith(thrown, { existingDraft: reusedDraft });

            await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
            await promise.catch((error) => {
              expect(error.code).toBe('partially_posted');
              expect(error.message).toContain('some of these 2 comments may already be');
            });
          });

          it('keeps a FINAL-SUBMIT failure as itself when the created review was deleted', async () => {
            // Every comment was on GitHub when the submit mutation failed, but
            // the client deleted the review it had created, so they went with
            // it: a retry is clean and the underlying classification stands.
            const thrown = writeFailure('GitHub authentication failed', {
              phase: 'submit_review',
              reviewPreExisted: false,
              commentsWritten: 2,
              commentsSent: 2,
              cleanupAttempted: true,
              cleanupSucceeded: true
            });
            const { promise } = failWith(thrown);

            await expect(promise).rejects.toBe(thrown);
          });

          it('warns with explicit residue when the created review could NOT be deleted', async () => {
            // The case that used to produce no warning at all: a pending review
            // we created is still on the PR holding every comment.
            const thrown = writeFailure('Failed to submit review (GraphQL): 502 Bad Gateway', {
              phase: 'submit_review',
              reviewPreExisted: false,
              reviewId: 'PRR_orphan',
              commentsWritten: 2,
              commentsSent: 2,
              cleanupAttempted: true,
              cleanupSucceeded: false
            });
            const { promise } = failWith(thrown);

            await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
            await promise.catch((error) => {
              expect(error.code).toBe('partially_posted');
              expect(error.status).toBe(409);
              expect(error.message).toContain('could NOT be deleted');
              expect(error.message).toContain('pending review PRR_orphan');
              expect(error.message).toContain('2 of these 2 comments are already');
              // The original failure is still readable, and still the cause.
              expect(error.message).toContain('502 Bad Gateway');
              expect(error.cause).toBe(thrown);
            });
          });

          it('keeps a CREATE-phase failure as itself — nothing existed to leave behind', async () => {
            const thrown = writeFailure('Insufficient permissions', {
              phase: 'create_review',
              reviewPreExisted: false,
              reviewId: null,
              commentsWritten: 0
            });
            const { promise } = failWith(thrown);
            await expect(promise).rejects.toBe(thrown);
          });

          it('classifies a DRAFT write by the same rules', async () => {
            const thrown = writeFailure('Failed to add 1 of 2 comments to existing draft review.', {
              reviewPreExisted: true,
              commentsWritten: 1
            });
            const { promise } = run({
              params: { ...modeParams, event: 'DRAFT' },
              dbOptions: { comments: twoComments() },
              clientOptions: { existingDraft: reusedDraft, draftError: thrown }
            });

            await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
            await promise.catch((error) => expect(error.code).toBe('partially_posted'));
          });
        });
      }

      it('names an orphaned DRAFT by its URL when the create mutation returned one', async () => {
        // Only the draft-create mutation returns a URL; the submit path's
        // pending review has none until it is submitted.
        const thrown = writeFailure('Failed to add comments to draft review', {
          phase: 'add_comments',
          reviewPreExisted: false,
          reviewId: 'PRR_orphan',
          reviewUrl: 'https://github.com/o/r/pull/7#pullrequestreview-4242',
          commentsWritten: 1,
          cleanupAttempted: true,
          cleanupSucceeded: false
        });
        const { promise } = run({
          params: { event: 'DRAFT' },
          dbOptions: { comments: twoComments() },
          clientOptions: { draftError: thrown }
        });

        await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
        await promise.catch((error) => {
          expect(error.message).toContain('https://github.com/o/r/pull/7#pullrequestreview-4242');
        });
      });
    });

    /**
     * THE CROSS-LAYER CONTRACT. The provider reads a record only
     * `src/github/client.js` writes, so the two halves are pinned together here
     * with a REAL `GitHubClient` whose transport fails — field names on both
     * sides of the seam, not two independent fakes agreeing with themselves.
     */
    describe('report produced by the real GitHubClient', () => {
      const { GitHubClient } = require('../../src/github/client');
      const { describePartialWriteRisk } = require('../../src/providers/review-submit')._internals;

      /** A pending review is created, comments land, the submit mutation dies. */
      async function failAtSubmit({ deleteSucceeds }) {
        const client = new GitHubClient('test-token');
        client.octokit.graphql = vi.fn()
          .mockResolvedValueOnce({ addPullRequestReview: { pullRequestReview: { id: 'PRR_real', databaseId: 31 } } })
          .mockResolvedValueOnce({ comment0: { thread: { id: 'thread-0' } } })
          .mockRejectedValueOnce(new Error('submit mutation exploded'));
        vi.spyOn(client, 'deletePendingReview').mockResolvedValue(deleteSucceeds);

        try {
          await client.createReviewGraphQL('PR_node', 'COMMENT', 'body', [
            { path: 'a.js', line: 2, side: 'RIGHT', body: 'note', isFileLevel: false }
          ]);
          throw new Error('expected the write to fail');
        } catch (error) {
          return error;
        }
      }

      it('passes the error through when the client deleted the review it created', async () => {
        const error = await failAtSubmit({ deleteSucceeds: true });
        expect(error.reviewWriteProgress).toMatchObject({
          phase: 'submit_review',
          reviewPreExisted: false,
          commentsWritten: 1,
          cleanupAttempted: true,
          cleanupSucceeded: true
        });
        expect(describePartialWriteRisk(error, {
          existingDraft: null, sentComments: 1, prNumber: 7, hostName: 'GitHub'
        })).toBe(error);
      });

      it('warns about explicit residue when that delete failed', async () => {
        const error = await failAtSubmit({ deleteSucceeds: false });
        expect(error.reviewWriteProgress).toMatchObject({
          phase: 'submit_review',
          commentsWritten: 1,
          cleanupSucceeded: false,
          reviewId: 'PRR_real'
        });
        const relabelled = describePartialWriteRisk(error, {
          existingDraft: null, sentComments: 1, prNumber: 7, hostName: 'GitHub'
        });
        expect(relabelled).toBeInstanceOf(SubmitReviewError);
        expect(relabelled.code).toBe('partially_posted');
        expect(relabelled.message).toContain('pending review PRR_real');
      });
    });

    describe('partial write into a REUSED pending draft (uninstrumented client)', () => {
      // These drive a client that reports NO `reviewWriteProgress` — a test
      // double, or a future transport that has not been taught to. With no
      // report there is nothing to read, so the old structural guess is the
      // fallback: it errs toward warning, which is the safe direction.
      //
      // The shape `GitHubClient` produces when an early comment batch landed and
      // a later one did not: it skips cleanup of a draft it did not create
      // ("comments may be partially added") and throws this flattened message.
      const partialBatchFailure = () => new Error(
        'Failed to submit review (GraphQL): Failed to add 2 of 5 comments to GitHub.'
      );
      const reusedDraft = {
        id: 'PRR_existing',
        databaseId: 999,
        url: 'https://github.com/o/r/pull/7#pullrequestreview-999',
        comments: { totalCount: 0 }
      };

      it('reports partially_posted, names the draft, and changes no comment row', async () => {
        // Retrying blindly would resend the complete active set into the same
        // draft and duplicate whatever landed.
        const thrown = partialBatchFailure();
        const { promise, statements } = run({
          dbOptions: { comments: [comment({ id: 11 }), comment({ id: 12, file: 'b.js', line_start: 3, line_end: 3 })] },
          clientOptions: { existingDraft: reusedDraft, createError: thrown }
        });

        await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
        await promise.catch((error) => {
          expect(error.status).toBe(409);
          expect(error.code).toBe('partially_posted');
          expect(error.message).toContain('https://github.com/o/r/pull/7#pullrequestreview-999');
          expect(error.message).toContain('Failed to add 2 of 5 comments');
          expect(error.message).toMatch(/before submitting\s+again/);
          expect(error.cause).toBe(thrown);
        });

        const sql = statements.map(s => s.sql);
        expect(sql).not.toContain('BEGIN TRANSACTION');
        expect(sql.some(s => s.startsWith('UPDATE comments'))).toBe(false);
      });

      it('reports partially_posted for a DRAFT write into the same reused draft', async () => {
        const { promise } = run({
          params: { event: 'DRAFT' },
          dbOptions: { comments: [comment()] },
          clientOptions: { existingDraft: reusedDraft, draftError: partialBatchFailure() }
        });
        await promise.catch((error) => {
          expect(error.code).toBe('partially_posted');
        });
        await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
      });

      it('names the draft by its numeric id when GitHub reported no URL', async () => {
        const { promise } = run({
          dbOptions: { comments: [comment()] },
          clientOptions: {
            existingDraft: { ...reusedDraft, url: null },
            createError: partialBatchFailure()
          }
        });
        await promise.catch((error) => {
          expect(error.message).toContain('pending review 999');
        });
        await expect(promise).rejects.toBeInstanceOf(SubmitReviewError);
      });

      it('does NOT re-label when there was no pre-existing draft — cleanup deleted it, a retry is clean', async () => {
        const thrown = partialBatchFailure();
        const { promise } = run({
          dbOptions: { comments: [comment()] },
          clientOptions: { createError: thrown }
        });
        await expect(promise).rejects.toBe(thrown);
      });

      it('does NOT re-label when no comments were sent — nothing could have landed', async () => {
        const thrown = new Error('Failed to submit review (GraphQL): upstream exploded');
        const { promise } = run({
          dbOptions: { comments: [] },
          clientOptions: { existingDraft: reusedDraft, createError: thrown }
        });
        await expect(promise).rejects.toBe(thrown);
      });
    });

    /**
     * PROMOTION IS NOT MODE-SPECIFIC, and these run on `run()`'s defaults —
     * which are PR mode's parameters (no `refuseCommentsOutsideDiff`, LEFT
     * anchors trusted, no dirty-file set). So finalising an existing GitHub
     * draft promotes this review's `draft` rows and folds the draft's total
     * into the count in PR mode as much as in local mode. The route-level half
     * of that claim is pinned in tests/integration/routes.test.js.
     */
    describe('finalising a draft this review already saved', () => {
      const consumedDraft = {
        id: 'PRR_existing',
        databaseId: 999,
        url: 'https://github.com/o/r/pull/7#pullrequestreview-999',
        comments: { totalCount: 3 }
      };
      const promotionSql = (statements) => statements.find(
        s => s.sql.startsWith('UPDATE comments') && s.sql.includes("status = 'draft'")
      );

      it('promotes the rows an earlier DRAFT pass left behind, and counts the draft\'s comments', async () => {
        // GitHub submits the WHOLE pending review, so the comments the draft
        // already holds are submitted too — locally they were still `draft`.
        const { promise, statements } = run({
          dbOptions: { comments: [comment({ id: 11 })] },
          clientOptions: { existingDraft: consumedDraft }
        });
        const result = await promise;

        const promotion = promotionSql(statements);
        expect(promotion).toBeDefined();
        expect(promotion.sql).toContain("SET status = 'submitted'");
        expect(promotion.sql).toContain("source = 'user'");
        expect(promotion.params[1]).toBe(42);

        // One submission, one stamp: the promotion shares the active rows'.
        const activeUpdate = statements.find(s => s.sql.startsWith('UPDATE comments') && s.params[2] === 11);
        expect(promotion.params[0]).toBe(activeUpdate.params[1]);

        // Inside the same transaction as everything else.
        const sql = statements.map(s => s.sql);
        expect(sql.indexOf('BEGIN TRANSACTION')).toBeLessThan(sql.indexOf(promotion.sql));
        expect(sql[sql.length - 1]).toBe('COMMIT');

        // 3 already on the draft + the 1 this call added.
        expect(result.comments_submitted).toBe(4);
      });

      it('does NOT promote for a DRAFT event — those comments are still pending', async () => {
        const { promise, statements } = run({
          params: { event: 'DRAFT' },
          dbOptions: { comments: [comment({ id: 11 })] },
          clientOptions: { existingDraft: consumedDraft }
        });
        await promise;
        expect(promotionSql(statements)).toBeUndefined();
      });

      it('does NOT promote when no draft was consumed — there is nothing to finalise', async () => {
        const { promise, statements } = run({
          dbOptions: { comments: [comment({ id: 11 })] }
        });
        await promise;
        expect(promotionSql(statements)).toBeUndefined();
      });

      it('records the finalised total on the mirrored review row too', async () => {
        const { promise, repoCalls } = run({
          dbOptions: { comments: [comment({ id: 11 })] },
          clientOptions: { existingDraft: consumedDraft }
        });
        await promise;
        expect(repoCalls.update[0].data.reviewData.comments_count).toBe(4);
      });
    });

    /**
     * `commentsOverride` — the seam the headless `--ai-review` / `--ai-draft`
     * flow uses (src/main.js `submitHeadlessAIReview`). It answers three
     * questions the default path answers for itself: which rows, what their
     * bodies say, and what status they land at.
     */
    describe('commentsOverride', () => {
      const aiRow = (over = {}) => comment({ id: 501, body: '\u{1F41B} **Bug**: off by one', ...over });

      it('sends the SUPPLIED rows and never runs the default comment query', async () => {
        const { promise, clientCalls, statements } = run({
          // The default query would have returned this, and must not be asked.
          dbOptions: { comments: [comment({ id: 999, body: 'a reviewer note' })] },
          params: { commentsOverride: { comments: [aiRow()], status: 'submitted' } }
        });
        await promise;

        expect(clientCalls.create[0].comments).toEqual([
          { path: 'a.js', line: 2, body: '\u{1F41B} **Bug**: off by one', side: 'RIGHT', isFileLevel: false }
        ]);
        // No SELECT ... FROM comments went out at all.
        expect(statements.some(s => s.sql.includes('FROM comments'))).toBe(false);
      });

      it('applies the caller’s status, not the event-derived one', async () => {
        // A COMMENT event would derive 'submitted'; the override says otherwise
        // and must win, because the caller owns these rows.
        const { promise, statements } = run({
          params: {
            event: 'COMMENT',
            commentsOverride: { comments: [aiRow()], status: 'draft' }
          }
        });
        await promise;

        const update = statements.find(s => s.sql.startsWith('UPDATE comments SET status'));
        expect(update.params[0]).toBe('draft');
        expect(update.params[2]).toBe(501);
      });

      it('still runs the diff-line validation — an out-of-hunk row degrades to file level', async () => {
        // The headless flow used to post this line number unchecked.
        const { promise, clientCalls } = run({
          params: {
            commentsOverride: {
              comments: [aiRow({ line_start: 99, line_end: 99 })],
              status: 'submitted'
            }
          }
        });
        await promise;

        expect(clientCalls.create[0].comments).toEqual([
          { path: 'a.js', body: '(Ref Line 99) \u{1F41B} **Bug**: off by one', isFileLevel: true }
        ]);
      });

      it('threads headSha into the host prContext exactly as the default path does', async () => {
        const { promise, clientCalls } = run({
          params: {
            headSha: 'alt-host-head',
            commentsOverride: { comments: [aiRow()], status: 'submitted' }
          }
        });
        await promise;
        expect(clientCalls.create[0].prContext).toMatchObject({
          owner: 'o', repo: 'r', prNumber: 7, headSha: 'alt-host-head'
        });
      });

      it('accepts an EMPTY row set — a review body with no inline comments', async () => {
        const { promise, clientCalls, statements } = run({
          params: { commentsOverride: { comments: [], status: 'submitted' } }
        });
        const result = await promise;
        expect(clientCalls.create[0].comments).toEqual([]);
        expect(result.success).toBe(true);
        expect(statements.some(s => s.sql.startsWith('UPDATE comments SET status'))).toBe(false);
      });

      it('does NOT promote the review’s other draft rows — it owns only what it was handed', async () => {
        const { promise, statements } = run({
          params: {
            event: 'COMMENT',
            commentsOverride: { comments: [aiRow()], status: 'submitted' }
          },
          clientOptions: {
            existingDraft: { id: 'PRR_existing', databaseId: 999, url: 'u', comments: { totalCount: 3 } }
          }
        });
        await promise;
        expect(statements.some(s => s.sql.includes("status = 'draft'"))).toBe(false);
      });

      it('rejects a malformed override rather than guessing at it', async () => {
        await expect(run({ params: { commentsOverride: { status: 'submitted' } } }).promise)
          .rejects.toThrow(/commentsOverride.comments must be an array/);
        await expect(run({ params: { commentsOverride: { comments: [] } } }).promise)
          .rejects.toThrow(/commentsOverride.status must be/);
      });

      it('leaves the DEFAULT path untouched when no override is given', async () => {
        // The regression guard for the whole seam: adding it must not have
        // changed what the two web routes do.
        const { promise, clientCalls, statements } = run({
          dbOptions: { comments: [comment({ id: 11 })] }
        });
        await promise;

        expect(statements.some(s => s.sql.includes('FROM comments'))).toBe(true);
        expect(clientCalls.create[0].comments).toEqual([
          { path: 'a.js', line: 2, body: 'a note', side: 'RIGHT', isFileLevel: false }
        ]);
        const update = statements.find(s => s.sql.startsWith('UPDATE comments SET status'));
        expect(update.params[0]).toBe('submitted');
      });
    });
  });
});
