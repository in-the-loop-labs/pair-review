// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

/**
 * `POST /api/local/:reviewId/submit-review` — Phase 5 of
 * plans/bridge-local-and-pr-modes.md.
 *
 * The one endpoint in local mode that WRITES to GitHub. What is pinned here is
 * the refusal ladder that runs BEFORE the write (association, host, credential,
 * lifecycle, HEAD drift) and what the write leaves behind in the database.
 * The write itself is `src/providers/review-submit.js`, pinned in
 * tests/unit/review-submit.test.js.
 *
 * GitHub is reached through `GitHubClient.prototype`, so spying the prototype
 * intercepts every call without a module-level `vi.mock` — the provider
 * captures the class at require time and sees this same prototype. Nothing
 * here touches the network or a real checkout.
 */

const localRoutes = require('../../src/routes/local');
const localReview = require('../../src/local-review');
const { GitHubClient } = require('../../src/github/client');
const { GitWorktreeManager } = require('../../src/git/worktree');
const { run, query, queryOne } = require('../../src/database');
// The captured-diff cache the snapshot gate reads BEFORE the database. It is a
// process-wide Map keyed by review id, and every test here starts a fresh
// database whose ids restart at 1 — so an entry one test leaves behind is an
// entry the next test's review inherits. Cleared around every test.
const { localReviewDiffs } = require('../../src/routes/shared');

const LOCAL_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CAPTURE_DIGEST = 'digest-at-capture';

const OPEN_PR = {
  number: 77,
  node_id: 'PR_node77',
  title: 'A pull request',
  state: 'open',
  merged: false,
  base_sha: 'basebasebase',
  head_sha: LOCAL_HEAD,
  html_url: 'https://github.com/owner/repo/pull/77'
};

const DIFF = [
  'diff --git a/a.js b/a.js',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1,3 +1,4 @@',
  ' one',
  '+two',
  ' three',
  ' four',
  ''
].join('\n');

function createTestApp(db, { token = 'test-token', config } = {}) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('githubToken', token);
  app.set('config', config || {
    github_token: token,
    port: 7247,
    theme: 'light',
    external_comments: false
  });
  app.use('/', localRoutes);
  return app;
}

/**
 * Insert a LOCAL review row, optionally with a persisted PR association.
 *
 * `capturedHeadSha` is `reviews.local_head_sha` — the commit the diff was
 * CAPTURED at, deliberately distinct from whatever `getHeadSha` reports now.
 * The two are equal for a session nobody has committed under; the snapshot
 * gate exists for when they are not.
 *
 * A captured diff WITH a baseline digest is inserted by default, because the
 * submit gate now refuses anything it cannot COMPARE: a row with no
 * `local_diffs` entry never reaches the write, so it is useless as a fixture
 * for anything except the refusal itself. Tests that mean to exercise an
 * uncomparable snapshot opt out with `storeDiff: false` / `capturedDigest:
 * null`.
 */
async function insertLocal(db, {
  associatedPrNumber = 77,
  associatedPrRepository = 'owner/repo',
  localRepository = 'owner/checkout',
  localPath = '/checkout/local',
  capturedHeadSha = LOCAL_HEAD,
  baseBranch = null,
  scopeStart = 'unstaged',
  scopeEnd = 'untracked',
  storeDiff = true,
  capturedDigest = CAPTURE_DIGEST
} = {}) {
  const result = await run(db, `
    INSERT INTO reviews (
      repository, status, review_type, local_path, local_head_sha,
      local_base_branch, local_scope_start, local_scope_end,
      associated_pr_number, associated_pr_repository
    )
    VALUES (?, 'draft', 'local', ?, ?, ?, ?, ?, ?, ?)
  `, [localRepository, localPath, capturedHeadSha, baseBranch, scopeStart, scopeEnd,
    associatedPrNumber, associatedPrNumber ? associatedPrRepository : null]);
  if (storeDiff) {
    await storeCapturedDiff(db, result.lastID, capturedDigest);
  }
  return result.lastID;
}

/** Persist the baseline digest a captured diff leaves behind. */
async function storeCapturedDiff(db, reviewId, digest = CAPTURE_DIGEST) {
  await run(db, `
    INSERT INTO local_diffs (review_id, diff_text, stats, digest)
    VALUES (?, ?, '{}', ?)
  `, [reviewId, DIFF, digest]);
}

async function insertComment(db, reviewId, overrides = {}) {
  const c = {
    file: 'a.js',
    line_start: 2,
    line_end: 2,
    body: 'a note',
    side: 'RIGHT',
    is_file_level: 0,
    status: 'active',
    source: 'user',
    ...overrides
  };
  const result = await run(db, `
    INSERT INTO comments (review_id, source, file, line_start, line_end, body, side, is_file_level, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [reviewId, c.source, c.file, c.line_start, c.line_end, c.body, c.side, c.is_file_level, c.status]);
  return result.lastID;
}

describe('POST /api/local/:reviewId/submit-review', () => {
  let db;
  let app;
  let server;
  let savedToken;
  let fetchPRSpy;
  let pendingSpy;
  let createSpy;
  let draftSpy;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    server = await listenOnLoopback(app);
    // `resolveHostBinding` consults process.env.GITHUB_TOKEN first, so an
    // exported token in the developer's shell would change what the
    // "no credential" case resolves. Control it explicitly.
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    // No real network, no real checkout, ever (tests/CONVENTIONS.md).
    fetchPRSpy = vi.spyOn(GitHubClient.prototype, 'fetchPullRequest')
      .mockResolvedValue({ ...OPEN_PR });
    pendingSpy = vi.spyOn(GitHubClient.prototype, 'getPendingReviewForUser')
      .mockResolvedValue(null);
    createSpy = vi.spyOn(GitHubClient.prototype, 'createReviewGraphQL')
      .mockImplementation(async (_node, _event, _body, comments) => ({
        id: 'PRR_submitted',
        databaseId: 4242,
        html_url: 'https://github.com/owner/repo/pull/77#pullrequestreview-4242',
        comments_count: comments.length,
        state: 'COMMENTED'
      }));
    draftSpy = vi.spyOn(GitHubClient.prototype, 'createDraftReviewGraphQL')
      .mockImplementation(async (_node, _body, comments) => ({
        id: 'PRR_draft',
        databaseId: 9090,
        html_url: 'https://github.com/owner/repo/pull/77#pullrequestreview-9090',
        comments_count: comments.length,
        state: 'PENDING'
      }));
    vi.spyOn(localReview, 'getHeadSha').mockResolvedValue(LOCAL_HEAD);
    vi.spyOn(localReview, 'listFilesModifiedVsHead').mockResolvedValue(new Set());
    // The snapshot gate walks the working tree; no test here has one. Default
    // to "nothing changed since capture" so only the tests that mean to
    // simulate drift do.
    vi.spyOn(localReview, 'computeScopedDigest').mockResolvedValue(CAPTURE_DIGEST);
    vi.spyOn(localReview, 'findMergeBase').mockResolvedValue(null);
    vi.spyOn(GitWorktreeManager.prototype, 'generateUnifiedDiff').mockResolvedValue(DIFF);

    localRoutes._hostBindingCache.clear();
    localReviewDiffs.clear();
  });

  afterEach(async () => {
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
    else delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
    localRoutes._hostBindingCache.clear();
    localReviewDiffs.clear();
    await closeServer(server);
    if (db) await closeTestDatabase(db);
  });

  const post = (id, payload = { event: 'COMMENT', body: 'looks good' }) =>
    request(server).post(`/api/local/${id}/submit-review`).send(payload);

  describe('the refusal ladder', () => {
    it('400s on a malformed review id', async () => {
      const response = await post('not-a-number');
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review ID');
    });

    it('400s on an event outside the accepted four', async () => {
      const reviewId = await insertLocal(db);
      const response = await post(reviewId, { event: 'LGTM', body: '' });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid review event');
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('404s for a review that does not exist', async () => {
      const response = await post(99999);
      expect(response.status).toBe(404);
    });

    it('403s when the review has no PR association', async () => {
      const reviewId = await insertLocal(db, { associatedPrNumber: null });
      const response = await post(reviewId);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('no_association');
      expect(fetchPRSpy).not.toHaveBeenCalled();
    });

    it('401s when no credential is configured for the repository', async () => {
      const reviewId = await insertLocal(db);
      const noTokenServer = await listenOnLoopback(
        createTestApp(db, { token: '', config: { port: 7247, external_comments: false } })
      );
      try {
        const response = await request(noTokenServer)
          .post(`/api/local/${reviewId}/submit-review`)
          .send({ event: 'COMMENT', body: '' });
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('no_credential');
        expect(fetchPRSpy).not.toHaveBeenCalled();
      } finally {
        await closeServer(noTokenServer);
      }
    });

    it('409s for a dual-host repository whose PR host is unknown, before any GitHub call', async () => {
      // Asking the wrong host about "PR #77" answers about a different pull
      // request that merely shares a number — and this endpoint POSTS.
      const reviewId = await insertLocal(db);
      const dualHostServer = await listenOnLoopback(createTestApp(db, {
        config: {
          github_token: 'test-token',
          port: 7247,
          external_comments: false,
          repos: {
            'owner/repo': {
              api_host: 'https://ghe.example.com/api/v3',
              token: 'alt-token',
              exclusive: false
            }
          }
        }
      }));
      try {
        const response = await request(dualHostServer)
          .post(`/api/local/${reviewId}/submit-review`)
          .send({ event: 'COMMENT', body: '' });
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('host_ambiguous');
        expect(fetchPRSpy).not.toHaveBeenCalled();
        expect(createSpy).not.toHaveBeenCalled();
      } finally {
        await closeServer(dualHostServer);
      }
    });

    it('409s when the stored host no longer matches config, without touching GitHub', async () => {
      // The rung above catches an UNKNOWN host. This one catches a host that is
      // known and no longer resolvable (`api_host` renamed, `repos` entry
      // deleted). Explicit-host resolution FAILS OPEN one layer down —
      // `resolveHostBinding` throws, the wrapper answers `null`, and
      // `resolveFetchCredential(null, globalToken)` reads that as "plain
      // github.com". Without this refusal the review would be POSTED to a
      // same-named repository on github.com, with the global token, against a
      // PR #77 that is a different pull request entirely.
      const reviewId = await insertLocal(db, { localPath: '/definitely/not/a/checkout' });
      await insertComment(db, reviewId);
      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, host)
        VALUES (77, 'owner/repo', 'Stamped', 'https://ghe.example/api/v3')
      `);
      const renamedHostServer = await listenOnLoopback(createTestApp(db, {
        config: {
          github_token: 'test-token',
          port: 7247,
          external_comments: false,
          repos: {
            'owner/repo': {
              exclusive: false,
              // The stamp above names the OLD host; config has since been renamed.
              api_host: 'https://new-ghe.example/api/v3',
              token: 'ghe-token'
            }
          }
        }
      }));
      try {
        const response = await request(renamedHostServer)
          .post(`/api/local/${reviewId}/submit-review`)
          .send({ event: 'COMMENT', body: '' });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('host_binding_failed');
        expect(response.body.error).toContain('no longer matches your configuration');
        // Nothing was asked of, or written to, any host.
        expect(fetchPRSpy).not.toHaveBeenCalled();
        expect(createSpy).not.toHaveBeenCalled();
      } finally {
        await closeServer(renamedHostServer);
      }
    });

    it('submits to the ALT host when pr_metadata stamps one, not to github.com', async () => {
      // The positive direction of the two rungs above: a stored host IS
      // authoritative evidence, so a dual-host repo whose PR host is stamped
      // submits — and it must submit to THAT host with THAT token. Asserting
      // only the refusals would leave "always refuse" passing.
      const reviewId = await insertLocal(db, { localPath: '/definitely/not/a/checkout' });
      await insertComment(db, reviewId);
      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title, host)
        VALUES (77, 'owner/repo', 'Stamped', 'https://ghe.example/api/v3')
      `);
      const altHostServer = await listenOnLoopback(createTestApp(db, {
        config: {
          github_token: 'test-token',
          port: 7247,
          external_comments: false,
          repos: {
            'owner/repo': {
              exclusive: false,
              api_host: 'https://ghe.example/api/v3',
              token: 'ghe-token'
            }
          }
        }
      }));
      try {
        const response = await request(altHostServer)
          .post(`/api/local/${reviewId}/submit-review`)
          .send({ event: 'COMMENT', body: 'looks good' });

        expect(response.status).toBe(200);
        expect(createSpy).toHaveBeenCalledTimes(1);
        // The client that carried the write was built for the stamped host,
        // with the per-repo token — never api.github.com / the global token.
        expect(createSpy.mock.instances[0].apiHost).toBe('https://ghe.example/api/v3');
        expect(createSpy.mock.instances[0].token).toBe('ghe-token');
      } finally {
        await closeServer(altHostServer);
      }
    });

    it('409s on HEAD drift and writes nothing', async () => {
      // The PR moved, not this checkout: local HEAD is still the commit the
      // diff was captured at (so the snapshot gate above is satisfied and
      // `head_drift` is reachable), while someone pushed to the PR.
      //
      // The two refusals are deliberately separable. Moving LOCAL HEAD instead
      // would trip the snapshot gate first — see 'the snapshot gate' below,
      // which covers that scenario under its own code.
      const reviewId = await insertLocal(db);
      const commentId = await insertComment(db, reviewId);
      fetchPRSpy.mockResolvedValue({ ...OPEN_PR, head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });

      const response = await post(reviewId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('head_drift');
      expect(createSpy).not.toHaveBeenCalled();
      const comment = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [commentId]);
      expect(comment.status).toBe('active');
    });

    it('409s when the local HEAD cannot be read', async () => {
      const reviewId = await insertLocal(db);
      localReview.getHeadSha.mockRejectedValue(new Error('not a git repository'));

      const response = await post(reviewId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('local_head_unknown');
      expect(createSpy).not.toHaveBeenCalled();
    });

    // Lifecycle is PER EVENT. GitHub takes a COMMENT review, and inline review
    // comments, on a settled pull request; only the approving events and a new
    // pending review are meaningless once it is merged or closed.
    it('410s for an APPROVE on a merged pull request', async () => {
      const reviewId = await insertLocal(db);
      fetchPRSpy.mockResolvedValue({ ...OPEN_PR, state: 'closed', merged: true });

      const response = await post(reviewId, { event: 'APPROVE', body: 'ship it' });

      expect(response.status).toBe(410);
      expect(response.body.code).toBe('pr_merged');
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('410s for a DRAFT on a closed pull request', async () => {
      const reviewId = await insertLocal(db);
      fetchPRSpy.mockResolvedValue({ ...OPEN_PR, state: 'closed', merged: false });

      const response = await post(reviewId, { event: 'DRAFT', body: 'wip' });

      expect(response.status).toBe(410);
      expect(response.body.code).toBe('pr_closed');
      expect(draftSpy).not.toHaveBeenCalled();
    });

    it('accepts a COMMENT review on a merged pull request', async () => {
      // Post-merge feedback is legitimate, and refusing it diverged from PR
      // mode, which has no lifecycle check at all.
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      fetchPRSpy.mockResolvedValue({ ...OPEN_PR, state: 'closed', merged: true });

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0][1]).toBe('COMMENT');
    });

    it('accepts a COMMENT review on a closed pull request', async () => {
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      fetchPRSpy.mockResolvedValue({ ...OPEN_PR, state: 'closed', merged: false });

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('502s — fails CLOSED — when GitHub cannot be read', async () => {
      const reviewId = await insertLocal(db);
      fetchPRSpy.mockRejectedValue(new Error('rate limit exceeded'));

      const response = await post(reviewId);

      expect(response.status).toBe(502);
      expect(response.body.code).toBe('pr_state_unknown');
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  /**
   * The snapshot gate — `local_diff_stale`.
   *
   * Distinct from `head_drift`, which compares the LIVE local HEAD with the
   * PR's. This compares the live tree with what the SESSION CAPTURED, because
   * that capture is the coordinate system every stored comment's line number
   * belongs to. Both drifts below leave `head_drift` perfectly happy.
   */
  describe('the snapshot gate', () => {
    it('409s when a commit landed after the diff was captured, before any GitHub call', async () => {
      // Comment, then commit and push. Local HEAD now equals the PR head, so
      // the PR-side precondition sees an aligned checkout — while every stored
      // line number describes the pre-commit tree.
      const reviewId = await insertLocal(db, { capturedHeadSha: 'cccccccccccccccccccccccccccccccccccccccc' });
      const commentId = await insertComment(db, reviewId);

      const response = await post(reviewId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('local_diff_stale');
      expect(response.body.error).toContain('Refresh the diff');
      // Local-only check: it must not spend a GitHub round trip to refuse.
      expect(fetchPRSpy).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
      // Nothing consumed — the comment is still there to re-anchor.
      const comment = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [commentId]);
      expect(comment.status).toBe('active');
    });

    it('409s when the working tree changed and was reverted under an unmoved HEAD', async () => {
      // The mirror image: HEAD never moved, so `head_drift` and the captured
      // HEAD both agree — and the content under the anchors changed anyway.
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      localReview.computeScopedDigest.mockResolvedValue('digest-after-the-edit');

      const response = await post(reviewId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('local_diff_stale');
      expect(fetchPRSpy).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('submits when the captured HEAD and the captured digest both still hold', async () => {
      // The positive control for every refusal in this block: a gate that
      // always fired would pass all of them.
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('reads the in-memory captured diff, not only the persisted one', async () => {
      // The session's diff usually lives in the process cache and is written
      // through to `local_diffs`; a gate that consulted only the database
      // would miss the drift on a freshly captured session.
      const reviewId = await insertLocal(db, { storeDiff: false });
      await insertComment(db, reviewId);
      localReviewDiffs.set(reviewId, { diff: DIFF, stats: {}, digest: CAPTURE_DIGEST });
      localReview.computeScopedDigest.mockResolvedValue('digest-after-the-edit');

      const response = await post(reviewId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('local_diff_stale');
    });

    /**
     * UNKNOWN IS NOT "NO" — the three statuses `evaluateLocalSnapshotDrift`
     * reports when it could not COMPARE at all.
     *
     * These used to submit: the gate read only `headMoved` / `digestMoved`,
     * which the helper leaves false on every one of them, so "never compared"
     * arrived at the write indistinguishable from "compared and clean" and the
     * comments kept precise line anchors. `listFilesModifiedVsHead` does not
     * cover it — that compares the tree with HEAD, never with the historical
     * snapshot the comments were authored against — so a legacy session whose
     * dirty content was later reset presents a clean tree and posts a
     * numerically valid inline comment against unrelated PR content.
     *
     * All three share one code and must reach NO GitHub call whatsoever.
     */
    describe('an uncomparable snapshot (regression: used to submit)', () => {
      const expectRefusedWithoutTouchingGitHub = (response, snapshotStatus) => {
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('local_diff_unverified');
        expect(response.body.snapshotStatus).toBe(snapshotStatus);
        // The remedy has to be one click, and the message has to name it.
        expect(response.body.error).toContain('Refresh the diff');
        expect(response.body.error).toContain('keeps your comments');
        expect(fetchPRSpy).not.toHaveBeenCalled();
        expect(createSpy).not.toHaveBeenCalled();
      };

      it('409s when the session never persisted a diff at all', async () => {
        const reviewId = await insertLocal(db, { storeDiff: false });
        const commentId = await insertComment(db, reviewId);

        const response = await post(reviewId);

        expectRefusedWithoutTouchingGitHub(response, 'no-stored-diff');
        // Nothing consumed — the comments survive the refusal, which is what
        // makes "refresh and re-check" a real escape hatch.
        const comment = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [commentId]);
        expect(comment.status).toBe('active');
      });

      it('409s for a legacy session with a diff but no baseline digest', async () => {
        const reviewId = await insertLocal(db, { capturedDigest: null });
        await insertComment(db, reviewId);

        const response = await post(reviewId);

        expectRefusedWithoutTouchingGitHub(response, 'no-baseline-digest');
      });

      it('409s when the working tree cannot be walked for a current digest', async () => {
        const reviewId = await insertLocal(db);
        await insertComment(db, reviewId);
        // `computeScopedDigest` resolves null rather than rejecting for an
        // unreadable checkout — the 'digest-unavailable' case.
        localReview.computeScopedDigest.mockResolvedValue(null);

        const response = await post(reviewId);

        expectRefusedWithoutTouchingGitHub(response, 'digest-unavailable');
      });

      it('refuses a comment-free review too — the gate is not per-comment', async () => {
        // A session with nothing stored still submits a review BODY, and the
        // gate is about whether this checkout is the one that was reviewed.
        const reviewId = await insertLocal(db, { storeDiff: false });

        const response = await post(reviewId, { event: 'APPROVE', body: 'ship it' });

        expectRefusedWithoutTouchingGitHub(response, 'no-stored-diff');
      });
    });
  });

  /**
   * LEFT-side anchors — UNCONDITIONALLY degraded in local mode.
   *
   * A LEFT line number is a coordinate in the old-side file of whatever base
   * the reviewer was looking at WHEN THEY WROTE IT. Nothing persisted with the
   * comment records that base, so the handler can only see the review's CURRENT
   * one — and the two diverge routinely: a transient in-UI base override, or a
   * `set-scope` that moved the stored base after the comment existed. Neither
   * transition touches the working tree, so the snapshot digest cannot see them
   * either. A stale LEFT number does not fail loudly: `buildDiffLineSet` records
   * a LEFT entry for every deleted AND context line, so it lands inside some
   * hunk and posts silently against content nobody pointed at.
   *
   * This block previously asserted the opposite for the matching-base case —
   * that a local merge-base equal to the PR base bought a precise LEFT anchor.
   * That is no longer the contract: base AGREEMENT is not base PROVENANCE. The
   * precision comes back only once each comment's authored old-side sha is
   * persisted, which needs a migration this branch cannot take.
   */
  describe('LEFT-side anchors always degrade to file level', () => {
    const insertBranchScoped = (overrides = {}) => insertLocal(db, {
      baseBranch: 'main',
      scopeStart: 'branch',
      scopeEnd: 'untracked',
      ...overrides
    });

    it('degrades even when the local merge-base IS the PR base', async () => {
      // The regression case. Agreement between the review's CURRENT base and
      // the PR's says nothing about the base the comment was authored under.
      const reviewId = await insertBranchScoped();
      await insertComment(db, reviewId, { side: 'LEFT' });
      localReview.findMergeBase.mockResolvedValue(OPEN_PR.base_sha);

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy.mock.calls[0][3][0]).toEqual({
        path: 'a.js',
        body: '(Ref Line 2) a note',
        isFileLevel: true
      });
    });

    it('degrades when the two bases diverge', async () => {
      // A stacked PR, or a base changed on GitHub after the branch was cut.
      const reviewId = await insertBranchScoped();
      await insertComment(db, reviewId, { side: 'LEFT' });
      localReview.findMergeBase.mockResolvedValue('some-other-merge-base');

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy.mock.calls[0][3][0]).toEqual({
        path: 'a.js',
        body: '(Ref Line 2) a note',
        isFileLevel: true
      });
    });

    it('degrades when the scope excludes the branch', async () => {
      // Without the branch in scope the local diff's left column is HEAD or the
      // index — not a merge-base at all.
      const reviewId = await insertLocal(db, { baseBranch: 'main' });
      await insertComment(db, reviewId, { side: 'LEFT' });

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy.mock.calls[0][3][0].isFileLevel).toBe(true);
    });

    it('degrades a LEFT RANGE with the plural (Ref Lines N-M) form', async () => {
      const reviewId = await insertBranchScoped();
      await insertComment(db, reviewId, { side: 'LEFT', line_start: 2, line_end: 4 });
      localReview.findMergeBase.mockResolvedValue(OPEN_PR.base_sha);

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy.mock.calls[0][3][0]).toEqual({
        path: 'a.js',
        body: '(Ref Lines 2-4) a note',
        isFileLevel: true
      });
    });

    it('no longer spends a merge-base lookup on the question', async () => {
      // The computation is gone, not merely ignored: a value computed and then
      // discarded is the shape the next reader re-wires by accident.
      const reviewId = await insertBranchScoped();
      await insertComment(db, reviewId, { side: 'LEFT' });

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(localReview.findMergeBase).not.toHaveBeenCalled();
    });

    it('leaves RIGHT-side comments inline', async () => {
      // The degradation is per-side: an untrusted left column says nothing
      // about the right one, which is the PR's own new-side coordinates.
      const reviewId = await insertBranchScoped();
      await insertComment(db, reviewId);
      localReview.findMergeBase.mockResolvedValue('some-other-merge-base');

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy.mock.calls[0][3][0]).toMatchObject({ line: 2, side: 'RIGHT', isFileLevel: false });
    });

    /**
     * The three provenance transitions the current-base check could never see.
     * Each one leaves the review's persisted base AGREEING with the PR while
     * the comment's own old-side coordinates belong to a different diff.
     */
    describe('authored-base provenance the snapshot digest cannot detect', () => {
      it('degrades a comment authored under a transient in-UI base override', async () => {
        // The reviewer flipped the base in the UI, commented on the old side of
        // THAT diff, and the override was never persisted. The row still says
        // `main`, and `main` is the PR's base.
        const reviewId = await insertBranchScoped();
        await insertComment(db, reviewId, { side: 'LEFT' });
        localReview.findMergeBase.mockResolvedValue(OPEN_PR.base_sha);

        const response = await post(reviewId);

        expect(response.status).toBe(200);
        expect(createSpy.mock.calls[0][3][0].isFileLevel).toBe(true);
        expect(createSpy.mock.calls[0][3][0].line).toBeUndefined();
      });

      it('degrades a comment that outlived a reload of the override', async () => {
        // Same as above after a page reload: the override is gone from the UI
        // entirely, so not even the frontend knows the comment is off-base.
        const reviewId = await insertBranchScoped();
        await insertComment(db, reviewId, { side: 'LEFT' });
        localReview.findMergeBase.mockResolvedValue(OPEN_PR.base_sha);

        const response = await post(reviewId);

        expect(response.status).toBe(200);
        expect(createSpy.mock.calls[0][3][0].isFileLevel).toBe(true);
      });

      it('degrades a comment created BEFORE set-scope changed the stored base', async () => {
        // `PATCH /api/local/:id/set-scope` rewrites `local_base_branch` and
        // re-captures the diff — the digest matches the NEW snapshot, and the
        // comment's number belongs to the old one.
        const reviewId = await insertBranchScoped({ baseBranch: 'release/v1' });
        await insertComment(db, reviewId, { side: 'LEFT' });
        await run(db, 'UPDATE reviews SET local_base_branch = ? WHERE id = ?', ['main', reviewId]);
        localReview.findMergeBase.mockResolvedValue(OPEN_PR.base_sha);

        const response = await post(reviewId);

        expect(response.status).toBe(200);
        expect(createSpy.mock.calls[0][3][0]).toEqual({
          path: 'a.js',
          body: '(Ref Line 2) a note',
          isFileLevel: true
        });
      });
    });
  });

  describe('the write', () => {
    it('submits active user comments and records the result', async () => {
      const reviewId = await insertLocal(db);
      const commentId = await insertComment(db, reviewId);

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        github_url: 'https://github.com/owner/repo/pull/77#pullrequestreview-4242',
        comments_submitted: 1,
        event: 'COMMENT'
      });

      // The PR was addressed by the ASSOCIATION, not by the checkout's own
      // repository name (deliberately different in `insertLocal`).
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0][0]).toBe('PR_node77');
      expect(createSpy.mock.calls[0][5]).toMatchObject({ owner: 'owner', repo: 'repo', prNumber: 77 });

      const comment = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [commentId]);
      expect(comment.status).toBe('submitted');

      const mirror = await query(db, 'SELECT * FROM github_reviews WHERE review_id = ?', [reviewId]);
      expect(mirror).toHaveLength(1);
      expect(mirror[0]).toMatchObject({
        github_node_id: 'PRR_submitted',
        github_review_id: '4242',
        state: 'submitted'
      });

      const review = await queryOne(db, 'SELECT status, submitted_at FROM reviews WHERE id = ?', [reviewId]);
      expect(review.status).toBe('submitted');
      expect(review.submitted_at).toBeTruthy();
    });

    it('leaves AI suggestions and already-submitted comments out of the review', async () => {
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      await insertComment(db, reviewId, { source: 'ai', body: 'an unadopted suggestion' });
      await insertComment(db, reviewId, { status: 'submitted', body: 'sent last time' });

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy.mock.calls[0][3]).toHaveLength(1);
      expect(createSpy.mock.calls[0][3][0].body).toBe('a note');
    });

    it('creates a DRAFT through the draft mutation and mirrors it as pending', async () => {
      const reviewId = await insertLocal(db);
      const commentId = await insertComment(db, reviewId);

      const response = await post(reviewId, { event: 'DRAFT', body: 'wip' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('PENDING');
      expect(draftSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).not.toHaveBeenCalled();

      const comment = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [commentId]);
      expect(comment.status).toBe('draft');
      const mirror = await queryOne(db, 'SELECT state FROM github_reviews WHERE review_id = ?', [reviewId]);
      expect(mirror.state).toBe('pending');
    });

    it('UPDATES the mirror row a draft sync already created, rather than duplicating it', async () => {
      // Migration 57's partial unique indexes make a second insert a hard
      // error; submitting a draft reuses its GitHub ids, so this is the same
      // row. `upsertFromGitHub` is the one writer.
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      await run(db, `
        INSERT INTO github_reviews (review_id, github_review_id, github_node_id, state, body, github_url)
        VALUES (?, '4242', 'PRR_submitted', 'pending', 'wip', 'https://github.com/owner/repo/pull/77')
      `, [reviewId]);

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      const mirror = await query(db, 'SELECT * FROM github_reviews WHERE review_id = ?', [reviewId]);
      expect(mirror).toHaveLength(1);
      expect(mirror[0].state).toBe('submitted');
    });

    it('degrades comments in locally-edited files to file level', async () => {
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      localReview.listFilesModifiedVsHead.mockResolvedValue(new Set(['a.js']));

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy.mock.calls[0][3][0]).toEqual({
        path: 'a.js',
        body: '(Ref Line 2) a note',
        isFileLevel: true
      });
    });

    it('degrades EVERY comment when the locally-edited files cannot be determined', async () => {
      // An empty set would read as "the working tree is clean", which is the
      // claim that buys a comment its line number. Unknown means degrade.
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      localReview.listFilesModifiedVsHead.mockRejectedValue(new Error('git exploded'));

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(GitWorktreeManager.prototype.generateUnifiedDiff).not.toHaveBeenCalled();
      expect(createSpy.mock.calls[0][3][0].isFileLevel).toBe(true);
    });

    it('degrades to file level when the PR diff cannot be generated locally', async () => {
      // Routine: the PR's base commit is simply not fetched into this checkout.
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      GitWorktreeManager.prototype.generateUnifiedDiff.mockRejectedValue(
        new Error('Base SHA not available locally')
      );

      const response = await post(reviewId);

      expect(response.status).toBe(200);
      expect(createSpy.mock.calls[0][3][0].isFileLevel).toBe(true);
    });

    it('generates the diff from the association PR data, in the local checkout', async () => {
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);

      await post(reviewId);

      expect(GitWorktreeManager.prototype.generateUnifiedDiff).toHaveBeenCalledWith(
        '/checkout/local',
        expect.objectContaining({ head_sha: LOCAL_HEAD, base_sha: 'basebasebase' })
      );
    });

    it('maps a GitHub auth failure onto 401 with the shared vocabulary', async () => {
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      pendingSpy.mockRejectedValue(new Error('GitHub authentication failed'));

      const response = await post(reviewId);

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('auth_failed');
    });

    it('refuses with 400 when the PR record carries no GraphQL node id', async () => {
      const reviewId = await insertLocal(db);
      await insertComment(db, reviewId);
      fetchPRSpy.mockResolvedValue({ ...OPEN_PR, node_id: null });

      const response = await post(reviewId);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('missing_pr_node_id');
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('409s when a comment targets a file the pull request does not touch', async () => {
      // A local scope can include a file that was never committed, so it is in
      // no PR diff. GitHub refuses such a path, inline or file-level.
      const reviewId = await insertLocal(db);
      const commentId = await insertComment(db, reviewId, { file: 'only-local.js' });

      const response = await post(reviewId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('comments_outside_pr');
      expect(response.body.error).toContain('only-local.js');
      expect(createSpy).not.toHaveBeenCalled();
      // Nothing was consumed — the comment is still there to act on.
      const comment = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [commentId]);
      expect(comment.status).toBe('active');
    });

    it('submits a review with no comments at all', async () => {
      const reviewId = await insertLocal(db);

      const response = await post(reviewId, { event: 'APPROVE', body: 'ship it' });

      expect(response.status).toBe(200);
      expect(createSpy.mock.calls[0][1]).toBe('APPROVE');
      expect(createSpy.mock.calls[0][3]).toEqual([]);
    });
  });
});
